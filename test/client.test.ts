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
const { openTui, isMissingBinary, TYPE_ID, OPEN, INSTALL } = mod.__test;

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

await card.inject('session-1').execute(OPEN);
check(
  'the card runs /shodh tui in its own session, without attachments',
  JSON.stringify(executed) === JSON.stringify([['session-1', '/shodh tui', []]]),
);
check('no session, no runner', card.inject(undefined).execute === undefined);

console.log('outcomes');
const reply = (value: unknown) => async () => value;
const result = (kind: string, text?: string) => ({ ok: true, value: { result: { kind, text } } });
const same = (actual: Anything, ok: boolean, text: string) =>
  actual?.ok === ok && actual?.text === text;
const opened = 'Opened "Shodh memory" in the right panel.\nPick the profile "dsh-x" there.';
const missing = { ok: false, text: 'No shodh-tui binary found.\nRun `/shodh tui install` …' };

check(
  'success → its reply, shown on the card',
  same(await openTui(reply(result('success', opened))), true, opened),
);
check(
  'already open → that reply',
  same(
    await openTui(reply(result('success', '"Shodh memory" is already open in the right panel.'))),
    true,
    '"Shodh memory" is already open in the right panel.',
  ),
);
check('a silent success → empty text', same(await openTui(reply(result('success'))), true, ''));
check(
  'command error → its text',
  same(
    await openTui(reply(result('error', 'Cannot open a terminal.'))),
    false,
    'Cannot open a terminal.',
  ),
);
check(
  'unknown command → explained',
  /not available/.test((await openTui(reply({ ok: true, value: undefined }))).text),
);
check(
  'transport failure → its message',
  same(
    await openTui(reply({ ok: false, error: { message: 'session closed' } })),
    false,
    'session closed',
  ),
);
check(
  'thrown → its message',
  same(
    await openTui(async () => {
      throw new Error('disconnected');
    }),
    false,
    'disconnected',
  ),
);

console.log('install button');
check('a missing binary offers Install', isMissingBinary(missing));
check(
  'other errors do not',
  !isMissingBinary({ ok: false, text: 'Cannot open a terminal.' }) && !isMissingBinary(undefined),
);
check('a success never does, whatever it says', !isMissingBinary({ ok: true, text: missing.text }));
check('the commands it runs', OPEN === '/shodh tui' && INSTALL === '/shodh tui install');

const ran: string[] = [];
const scripted = (results: Record<string, unknown>) => async (line: string) => {
  ran.push(line);
  return results[line];
};
const installed = await openTui(
  scripted({ [INSTALL]: result('success', 'Installed'), [OPEN]: result('success', opened) }),
  true,
);
check(
  'Install runs install, then open',
  installed.ok && ran.join('|') === '/shodh tui install|/shodh tui',
);
check('…and the card shows the open reply', installed.text === opened);

ran.length = 0;
const failedInstall = await openTui(
  scripted({ [INSTALL]: result('error', 'Could not install shodh-tui v0.2.0: offline') }),
  true,
);
check(
  'a failed install reports its text',
  !failedInstall.ok && failedInstall.text.includes('offline'),
);
check('…and does not try to open', ran.join('|') === '/shodh tui install');

ran.length = 0;
await openTui(scripted({ [OPEN]: result('success', opened) }), false);
check('a plain click runs open only', ran.join('|') === '/shodh tui');

console.log(`\n${passed} checks passed.`);
