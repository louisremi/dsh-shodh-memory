/**
 * Unit tests for the cleanup module's pure logic: the proposal parser and the
 * corpus renderer.
 *
 * The parser is where an untrusted model output becomes a list of store edits,
 * so it is pinned hard: valid JSONL parses, prose and fences are skipped,
 * proposals that would drop required fields are rejected, and `into` can never
 * point at an id the proposal does not actually cover.
 *
 * The corpus renderer is where the input budget lives: memory order must
 * survive, oversized scans drop the OLDEST lines, and a truncated preview must
 * stay visibly marked so the model can be told to be conservative about it.
 *
 * Run: `pnpm test`
 */

import assert from 'node:assert/strict';
import {
  applyCleanup,
  CLEANUP_REPORT_TTL_MS,
  type CleanupDeps,
  parseProposals,
  parseSelection,
  rankKeepers,
  renderCorpus,
} from '../src/cleanup.js';
import type { ShodhClient } from '../src/client.js';
import { normalizeConfig } from '../src/config.js';
import type { CleanupReport, ListMemoryItem, PluginState } from '../src/types.js';

let passed = 0;
function check(label: string, condition: unknown): void {
  assert.ok(condition, label);
  passed += 1;
  console.log(`  ✓ ${label}`);
}

console.log('\n[cleanup] parseProposals');

const clean = parseProposals(
  [
    '{"op":"merge","ids":["a","b"],"into":"a","text":"kept text","reason":"dupes"}',
    'some prose the model slipped in',
    '{"op":"delete","ids":["c"],"reason":"stale"}',
  ].join('\n'),
);
check('two proposals parsed', clean.length === 2);
check(
  'merge fields survive',
  clean[0]?.op === 'merge' && clean[0]?.into === 'a' && clean[0]?.text === 'kept text',
);
check('delete fields survive', clean[1]?.op === 'delete' && clean[1]?.ids.join() === 'c');

const fenced = parseProposals('```json\n{"op":"delete","ids":["x"],"reason":"r"}\n```');
check('code fences are skipped', fenced.length === 1 && fenced[0]?.ids[0] === 'x');

const pretty = parseProposals('[{"op":"delete","ids":["y"],"reason":"r"}]');
check('a pretty-printed array parses', pretty.length === 1 && pretty[0]?.ids[0] === 'y');

check('prose-only output parses to nothing', parseProposals('I found no issues.').length === 0);
check(
  'a truncated tail line is skipped',
  parseProposals('{"op":"delete","ids":["z"]}\n{"op":"merge","ids":["q"]').length === 1,
);

const defaults = parseProposals('{"op":"merge","ids":["a","b"],"text":"t"}');
check('merge defaults into to the first id', defaults[0]?.into === 'a');
const hinted = parseProposals('{"op":"merge","ids":["a","b"],"into":"b","text":"t"}');
check(
  "the model's into moves to the front, as the tie-break",
  hinted[0]?.ids.join() === 'b,a' && hinted[0]?.into === 'b',
);

check(
  'merge without text is rejected',
  parseProposals('{"op":"merge","ids":["a"],"into":"a"}').length === 0,
);
check('unknown op is rejected', parseProposals('{"op":"nuke","ids":["a"]}').length === 0);
check('empty ids is rejected', parseProposals('{"op":"delete","ids":[]}').length === 0);
check(
  'into outside ids is coerced, not trusted',
  parseProposals('{"op":"merge","ids":["a"],"into":"evil","text":"t"}')[0]?.into === 'a',
);
check(
  'duplicate ids are collapsed',
  parseProposals('{"op":"delete","ids":["d","d"],"reason":"r"}')[0]?.ids.join() === 'd',
);

console.log('\n[cleanup] renderCorpus');

const item = (id: string, content: string, over: Partial<ListMemoryItem> = {}): ListMemoryItem => ({
  id,
  content,
  truncated: false,
  type: 'Decision',
  importance: 0.5,
  tags: ['t'],
  ...over,
});

const corpus = renderCorpus(
  [item('n1', 'newest memory', { tags: [] }), item('n2', 'second', { truncated: true })],
  100_000,
);
check('no lines dropped under budget', corpus.dropped === 0);
check('ids lead their lines', corpus.corpus.startsWith('n1 '));
check('newest stays first', corpus.corpus.indexOf('n1') < corpus.corpus.indexOf('n2'));
check('truncation is marked for the model', corpus.corpus.includes('(truncated)'));
check('importance is rendered as a percentage', corpus.corpus.includes('[Decision 50%]'));
check('tags are rendered', corpus.corpus.includes('#t'));
check('both memories were seen', corpus.seenIds.has('n1') && corpus.seenIds.has('n2'));
check('a whole memory is merge-eligible', corpus.fullIds.has('n1'));
check('an unfilled server preview is not merge-eligible', !corpus.fullIds.has('n2'));

// The list endpoint returns newest first: m0 is the NEWEST here.
const fat = Array.from({ length: 6 }, (_, i) =>
  item(`m${i}`, `memory number ${i} ${'x'.repeat(400)}`),
);
const capped = renderCorpus(fat, 900);
check('oversized scans drop lines', capped.dropped > 0);
check(
  'the newest memories are kept, the oldest dropped',
  capped.corpus.startsWith('m0 ') && !capped.corpus.includes('m5 '),
);
check('the corpus respects the byte budget', Buffer.byteLength(capped.corpus, 'utf8') <= 900);
check(
  'dropped memories are neither seen nor merge-eligible',
  !capped.seenIds.has('m5') && !capped.fullIds.has('m5'),
);
check(
  'the drop count matches what is missing',
  capped.dropped === fat.length - capped.seenIds.size,
);

const lone = renderCorpus([item('big', 'y'.repeat(800))], 10);
check('the first line always goes in, even over budget', lone.seenIds.has('big'));

// LINE_CAP: an over-long memory is still shown (deletable) but marked cut,
// and it can never be merged — its tail never reached the model.
const long = renderCorpus([item('l1', `${'word '.repeat(400)}TAIL-ONLY`)], 100_000);
check('an over-long memory is marked (cut)', long.corpus.includes('(cut)'));
check('its tail is not in the corpus', !long.corpus.includes('TAIL-ONLY'));
check('a cut memory is seen', long.seenIds.has('l1'));
check('a cut memory is not merge-eligible', !long.fullIds.has('l1'));

console.log('\n[cleanup] rankKeepers');

const imp = (entries: [string, number][]) => new Map(entries);
check(
  'highest importance is kept',
  rankKeepers(
    ['a', 'b', 'c'],
    imp([
      ['a', 0.2],
      ['b', 0.9],
      ['c', 0.5],
    ]),
    new Map(),
  )[0] === 'b',
);
check(
  'importance beats access count',
  rankKeepers(
    ['a', 'b'],
    imp([
      ['a', 0.9],
      ['b', 0.8],
    ]),
    imp([
      ['a', 1],
      ['b', 50],
    ]),
  )[0] === 'a',
);
check(
  'equal importance: more accesses wins',
  rankKeepers(
    ['a', 'b'],
    imp([
      ['a', 0.5],
      ['b', 0.5],
    ]),
    imp([
      ['a', 2],
      ['b', 9],
    ]),
  )[0] === 'b',
);
check(
  'an unknown access count ranks below a known zero',
  rankKeepers(
    ['a', 'b'],
    imp([
      ['a', 0.5],
      ['b', 0.5],
    ]),
    imp([['b', 0]]),
  )[0] === 'b',
);
check(
  'a full tie keeps the given order (the model hint first)',
  rankKeepers(
    ['b', 'a'],
    imp([
      ['a', 0.5],
      ['b', 0.5],
    ]),
    new Map(),
  )[0] === 'b',
);
check(
  'the ranking covers every id, best first',
  rankKeepers(
    ['a', 'b', 'c'],
    imp([
      ['a', 0.1],
      ['b', 0.3],
      ['c', 0.2],
    ]),
    new Map(),
  ).join() === 'b,c,a',
);

console.log('\n[cleanup] parseSelection');

const sel = (spec: string, count = 3) => parseSelection(spec, count);
const indexes = (spec: string, count = 3) => {
  const result = sel(spec, count);
  return 'indexes' in result ? result.indexes.join() : `error:${result.error}`;
};
check('all selects every proposal', indexes('all') === '0,1,2');
check('ALL is case-insensitive', indexes('ALL') === '0,1,2');
check('commas and spaces both separate', indexes('3, 1 2') === '0,1,2');
check('duplicates collapse', indexes('2,2') === '1');
check('a non-number is refused, not ignored', indexes('1,x').startsWith('error:'));
check('zero is refused', indexes('0').startsWith('error:'));
check('out of range is refused', indexes('4').startsWith('error:'));
check('a fraction is refused', indexes('1.5').startsWith('error:'));
check('a negative is refused', indexes('-1').startsWith('error:'));
check('an empty selection is refused', indexes('').startsWith('error:'));
check(
  'the refusal names the bad token and says nothing was applied',
  indexes('1,x').includes('x') && indexes('1,x').includes('Nothing was applied'),
);

const flat = renderCorpus([item('w1', 'line one\nline two   folded')], 100_000);
check(
  'newlines are folded for the one-line index',
  flat.corpus.includes('line one line two folded'),
);

console.log('\n[cleanup] applyCleanup re-checks a stored report');

// A report is long-lived state. These tamper with one directly, as if
// something had minted entries into it, and assert that apply still refuses
// every write the analysis did not justify.
const writes: string[] = [];
const fakeClient = {
  updateMemory: async (id: string) => {
    writes.push(`PUT ${id}`);
    return {};
  },
  soft: async (path: string, _body: unknown, options: { method?: string }) => {
    writes.push(`${options.method} ${path}`);
    return {};
  },
} as unknown as ShodhClient;
const state = {
  capturedHashes: new Set<string>(),
  injectedTurns: new Map(),
  activity: {} as PluginState['activity'],
  cleanupReports: new Map(),
} as PluginState;
const deps: CleanupDeps = {
  ctx: {} as CleanupDeps['ctx'],
  client: fakeClient,
  cfg: normalizeConfig({}),
  state,
};
const tamper = (proposals: CleanupReport['proposals']): void => {
  state.cleanupReports.set('t', {
    tenant: 't',
    proposals,
    seenIds: new Set(['seen', 'whole', 'whole2']),
    fullIds: new Set(['whole', 'whole2']),
    created: Date.now(),
    applied: new Set(),
  });
};

tamper([{ op: 'delete', ids: ['never-seen'] }]);
let out = await applyCleanup(deps, 't', 'all');
check('a delete of an id the model never saw is refused', out.includes('#1 skipped'));
check('…with no write', writes.length === 0);

tamper([{ op: 'merge', ids: ['whole', 'seen'], into: 'whole', text: 'x' }]);
out = await applyCleanup(deps, 't', 'all');
check('a merge naming a cut/truncated memory is refused', out.includes('#1 skipped'));
check('…with no write', writes.length === 0);

tamper([{ op: 'merge', ids: ['whole', 'whole2'], into: 'elsewhere', text: 'x' }]);
out = await applyCleanup(deps, 't', 'all');
check('a merge whose target is outside its ids is refused', out.includes('#1 skipped'));
check('…with no write', writes.length === 0);

tamper([{ op: 'delete', ids: ['seen'] }]);
out = await applyCleanup(deps, 'someone-else', 'all');
check("another tenant's report is invisible", out.includes('nothing to apply'));
check('…with no write', writes.length === 0);

tamper([{ op: 'delete', ids: ['seen'] }]);
const stale = state.cleanupReports.get('t');
if (stale) stale.created = Date.now() - CLEANUP_REPORT_TTL_MS - 1;
out = await applyCleanup(deps, 't', 'all');
check('an expired report is refused', out.includes('older than'));
check('…with no write', writes.length === 0);
check('…and dropped', !state.cleanupReports.has('t'));

tamper([{ op: 'delete', ids: ['seen'] }]);
out = await applyCleanup(deps, 't', 'all');
check('a legitimate delete goes through', out.includes('#1 deleted 1'));
check(
  '…as exactly one DELETE in the report tenant',
  writes.join() === 'DELETE /api/memory/seen?user_id=t',
);

console.log(`\n${passed} cleanup unit checks passed.\n`);
