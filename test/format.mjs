/**
 * Unit tests for the two rendering budgets.
 *
 * The always-on recall block and the on-demand `memory_search` tool both render
 * through `memoryLine`, but they must not share a *budget*. The block is context
 * the model never asked for and is paid for on every turn; a search result is
 * context the model explicitly requested, usually precisely because the block was
 * not enough.
 *
 * These tests pin both halves so neither side can silently inflate the other:
 * search results arrive whole, the injected block stays capped.
 *
 * Run: `node test/format.mjs`
 */

import assert from 'node:assert/strict';
import { memoryLine, renderRecallBlock, renderResults, RECALL_LINE_MAX_CHARS } from '../src/format.js';
import { normalizeConfig } from '../src/config.js';

let passed = 0;
function check(label, condition) {
  assert.ok(condition, label);
  passed += 1;
  console.log(`  ✓ ${label}`);
}

// Long enough that the recall block's 220-char cap visibly clips it. This is the
// shape that made `memory_search` unable to answer "what exactly did that memory
// say" — which drove agents to read shodh's store out from under the plugin.
const LONG =
  'CANONICAL tailnet SSH from the DSH harness container. ' +
  'The container key authenticates on nasbrico only; every other tailnet peer gates behind Tailscale SSH. '.repeat(3);
const memory = { id: 'abc-123', content: LONG, type: 'Decision', score: 0.9, tags: [] };
const flat = LONG.replace(/\s+/g, ' ').trim();

// Derived, not hardcoded: the `- [Type NN%] ` decoration that sits in front of
// the body and is NOT counted against the cap.
const prefix = memoryLine({ id: '', content: 'body', type: 'Decision', score: 0.9 }).slice(0, -'body'.length);

console.log('\n[1] memory_search results arrive whole');
const out = renderResults([memory]);
check('fixture is longer than the recall-block cap', flat.length > 220);
check('full content survives renderResults', out.includes(flat));
check('no truncation marker in an uncapped render', !out.includes('…'));
check('rendered line is longer than the old cap', out.length > 220);
check('id still appended', out.endsWith('(abc-123)'));
check('still one line per memory', out.split('\n').length === 1);
check('empty result still renders the notice', renderResults([]) === 'No matching memories.');

console.log('\n[2] whitespace is flattened without losing text');
const multiline = { id: 'm', content: 'first line\n\nsecond line   spaced\nthird', type: 'Learning', score: 0 };
const flatMulti = renderResults([multiline]);
check('newlines collapsed to single spaces', flatMulti.includes('first line second line spaced third'));
check('zero score renders no percentage', flatMulti.startsWith('- [Learning] '));

console.log('\n[3] an explicit cap still truncates');
const capped = renderResults([memory], 100);
check('capped output is shorter than uncapped', capped.length < out.length);
check('capped body carries the marker before the id', capped.includes('… (abc-123)'));
check('the cap covers the body, not the decoration', capped.length <= 100 + prefix.length + ' (abc-123)'.length);

console.log('\n[4] the always-on recall block keeps its budget');
const many = Array.from({ length: 12 }, (_, i) => ({ id: `m${i}`, content: LONG, type: 'Decision', score: 0.9 }));
const block = renderRecallBlock(many, 1200);
check('block starts with the header', block.startsWith('Relevant memories (shodh):'));
check('block respects its total cap', block.length <= 1200);
check('every block line body is still clipped to the cap', block.split('\n').slice(1).every((line) => line.length <= RECALL_LINE_MAX_CHARS + prefix.length));
check('block never carries the full long memory', !block.includes(flat));
check('empty recall renders no block', renderRecallBlock([], 1200) === '');

console.log('\n[5] memoryLine keeps its default for the caller that needs it');
check('default call still clips the body at the cap', memoryLine(memory).length <= RECALL_LINE_MAX_CHARS + prefix.length && memoryLine(memory).includes('…'));
check('zero means uncapped', memoryLine(memory, 0).length === prefix.length + flat.length);

console.log('\n[6] the search budget is configurable, and uncapped by default');
const def = normalizeConfig({});
check('uncapped by default', def.tools.searchResultMaxChars === 0);
check('clamped to the ceiling', normalizeConfig({ tools: { searchResultMaxChars: 999999 } }).tools.searchResultMaxChars === 8000);
check('negative clamps back to uncapped', normalizeConfig({ tools: { searchResultMaxChars: -5 } }).tools.searchResultMaxChars === 0);
check('garbage falls back to uncapped', normalizeConfig({ tools: { searchResultMaxChars: 'lots' } }).tools.searchResultMaxChars === 0);
check('recall block default untouched by the new knob', def.autoRecall.maxChars === 1200);

console.log(`\n${passed} format checks passed\n`);
