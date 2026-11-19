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
import { parseProposals, renderCorpus } from '../src/cleanup.js';
import type { ListMemoryItem } from '../src/types.js';

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
check(
  'ids lead their lines',
  /^n1\b/m.test(`\n${corpus.corpus}`) && corpus.corpus.startsWith('n1 '),
);
check('newest stays first', corpus.corpus.indexOf('n1') < corpus.corpus.indexOf('n2'));
check('truncation is marked for the model', corpus.corpus.includes('(truncated)'));
check('importance is rendered as a percentage', corpus.corpus.includes('[Decision 50%]'));
check('tags are rendered', corpus.corpus.includes('#t'));

const fat = Array.from({ length: 6 }, (_, i) =>
  item(`m${i}`, `memory number ${i} ${'x'.repeat(400)}`),
);
const capped = renderCorpus(fat, 900);
check('oversized scans drop lines', capped.dropped > 0);
check(
  'the oldest memories are the ones dropped',
  !capped.corpus.includes('m0 ') && capped.corpus.includes('m5 '),
);
check(
  'the corpus respects the byte budget',
  Buffer.byteLength(capped.corpus, 'utf8') <= 900 || capped.dropped === fat.length - 1,
);

const flat = renderCorpus([item('w1', 'line one\nline two   folded')], 100_000);
check(
  'newlines are folded for the one-line index',
  flat.corpus.includes('line one line two folded'),
);

console.log(`\n${passed} cleanup unit checks passed.\n`);
