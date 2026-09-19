// Live check: real ShodhClient against the real shodh-memory container on nasbrico.
// Run from inside the harness container where shodh-memory:3030 resolves.
import { ShodhClient } from '/workspace/shodh-memory-dsh-integration/src/client.js';
import { normalizeMemory, renderRecallBlock, extractText } from '/workspace/shodh-memory-dsh-integration/src/format.js';

const baseUrl = process.env.SHODH_BASE ?? 'http://shodh-memory:3030';
const apiKey = process.env.SHODH_API_KEY ?? '';
const userId = 'e2e-verify';

const log = (...a) => console.log('[live]', ...a);
const client = new ShodhClient({
  baseUrl, apiKey, userId,
  requestTimeoutMs: 5000, failureThreshold: 3, failureCooldownMs: 30000,
  logger: { warn: (...a) => log('WARN', ...a), info: () => {}, error: (...a) => log('ERR', ...a) },
});

let pass = 0, fail = 0;
const check = (name, ok, extra = '') => {
  if (ok) { pass++; log('PASS', name); } else { fail++; log('FAIL', name, extra); }
};

// 1. health
const h = await client.health();
check('health responds', h?.status === 'healthy', JSON.stringify(h).slice(0, 120));

// 2. remember
const marker = 'harness-e2e-marker-' + Date.now();
const rem = await client.remember({ content: marker, memoryType: 'Decision', tags: ['e2e'] });
check('remember succeeds', rem?.success === true || rem?.id, JSON.stringify(rem).slice(0, 160));

// 3. recall finds it
const rec = await client.recall({ query: 'harness e2e marker', limit: 5 });
const items = rec?.memories ?? rec?.results ?? [];
const found = items.map(normalizeMemory).filter(Boolean);
check('recall returns memories', found.length > 0, JSON.stringify(rec).slice(0, 200));
check('recall contains our marker', found.some((m) => String(m.content).includes(marker)),
  found.map((m) => String(m.content).slice(0, 60)).join(' | '));

// 4. render block is non-empty and within cap
const block = renderRecallBlock(found, { maxChars: 1200 });
check('renderRecallBlock produces text', typeof block === 'string' && block.length > 0, String(block).slice(0, 80));
check('rendered block within cap', block.length <= 1200, 'len=' + block.length);

// 5. stats
const st = await client.stats();
check('stats responds', st && typeof st === 'object', JSON.stringify(st).slice(0, 120));

// 6. forget the marker memory
const target = found.find((m) => String(m.content).includes(marker));
if (target?.id) {
  const fg = await client.forget(target.id);
  check('forget succeeds', fg?.success === true || fg?.deleted === true || !fg?.error, JSON.stringify(fg).slice(0, 160));
} else {
  check('forget succeeds', false, 'no target id');
}

log(`RESULT pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
