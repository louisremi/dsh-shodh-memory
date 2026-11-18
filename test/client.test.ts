/**
 * Tests for the browser half (`client/index.js`): the start-page card.
 *
 * The module is loaded through a fake `__ModuleLoader__` and applied against
 * fake Client services. Pinned: what it registers, that the card runs exactly
 * `/shodh tui` in its own session, and how command outcomes become the card's
 * error text. React rendering itself is not exercised.
 *
 * Run: `pnpm test`
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

let passed = 0;
function check(label: string, condition: unknown): void {
  assert.ok(condition, label);
  passed += 1;
  console.log(`  ✓ ${label}`);
}

// biome-ignore lint/suspicious/noExplicitAny: the module under test is untyped JavaScript.
type Anything = Record<string, any>;

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const source = await readFile(join(root, 'client', 'index.js'), 'utf8');
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));

const loaded: Anything[] = [];
const sandbox: Anything = { __ModuleLoader__: { load: (row: Anything) => loaded.push(row) } };
sandbox.globalThis = sandbox;
vm.runInNewContext(source, sandbox, { filename: 'client/index.js' });

console.log('module');
check(
  'registers one factory, named after the package',
  loaded.length === 1 && loaded[0]?.id === pkg.name,
);
check(
  'package exports ./client and declares a web client',
  pkg.exports['./client'] === './client/index.js' && pkg.dsh.client.platform === 'web',
);
check('client/ is published', pkg.files.includes('client'));

const requested: string[] = [];
const mod = loaded[0]?.factory((name: string) => {
  requested.push(name);
  return { createElement: () => null, useState: () => [] };
}) as Anything;
check('requires only react', requested.join() === 'react');

console.log('apply');
const types: Anything[] = [];
const slots: Anything[] = [];
const executed: unknown[][] = [];
mod.apply({
  effect: (fn: () => unknown) => fn(),
  sidebarRightTabs: {
    register: (definition: Anything) => {
      types.push(definition);
      return () => {};
    },
  },
  slots: {
    inject: (_name: string, fn: () => unknown) => fn(),
    register: (options: Anything) => {
      slots.push(options);
      return () => {};
    },
  },
  remote: {
    commands: {
      execute: async (...args: unknown[]) => {
        executed.push(args);
        return { ok: true, value: { result: { kind: 'success' } } };
      },
    },
  },
});
const { openTui, TYPE_ID, COMMAND } = mod.__test;

const type = types[0] as Anything;
check('one tab type with one guide card', types.length === 1 && type.guide.length === 1);
check('card title is "Shodh memory"', type.guide[0].title() === 'Shodh memory');
check('card sorts after the built-in cards', type.guide[0].order > 30);
const card = slots.find((s) => s.name === 'sidebar.right.tab.guide.entry') as Anything;
check('custom card is keyed by the tab type id', card?.key === TYPE_ID && type.id === TYPE_ID);
check(
  'a page fallback is registered for the same id',
  slots.some((s) => s.name === 'sidebar.right.pane.tab' && s.key === TYPE_ID),
);

await card.inject('session-1').execute(COMMAND);
check(
  'the card runs /shodh tui in its own session, without attachments',
  JSON.stringify(executed) === JSON.stringify([['session-1', '/shodh tui', []]]),
);
check('no session, no runner', card.inject(undefined).execute === undefined);

console.log('outcomes');
const reply = (value: unknown) => async () => value;
const result = (kind: string, text?: string) => ({ ok: true, value: { result: { kind, text } } });

check('success → no error', (await openTui(reply(result('success', 'Opened')))) === undefined);
check(
  'command error → its text',
  (await openTui(reply(result('error', 'No shodh-tui binary found.')))) ===
    'No shodh-tui binary found.',
);
check(
  'unknown command → explained',
  /not available/.test(await openTui(reply({ ok: true, value: undefined }))),
);
check(
  'transport failure → its message',
  (await openTui(reply({ ok: false, error: { message: 'session closed' } }))) === 'session closed',
);
check(
  'thrown → its message',
  (await openTui(async () => {
    throw new Error('disconnected');
  })) === 'disconnected',
);

console.log(`\n${passed} checks passed.`);
