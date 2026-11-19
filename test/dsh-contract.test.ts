/**
 * The browser card against the DSH it plugs into.
 *
 * client/index.js is hand-written and talks to DSH through names, not imports:
 * two slot names, the tab registry's definition fields, and the theme's CSS
 * variables. client.test.ts runs it against fakes, which agree with whatever
 * the card says. This suite reads the real DSH packages instead (dev
 * dependencies, pinned, moved by Dependabot), so a DSH release that renames
 * one of them fails here rather than as a missing or unstyled card.
 *
 * Run: pnpm test (after the build).
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

let passed = 0;
function check(label: string, condition: boolean): void {
  assert.ok(condition, label);
  passed += 1;
  console.log(`  ✓ ${label}`);
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(join(root, 'package.json'));
const card = await readFile(join(root, 'client', 'index.js'), 'utf8');
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));

/** A DSH package's directory, its version, and one of its files as text. */
async function dsh(name: string) {
  const dir = dirname(require.resolve(`${name}/package.json`));
  const { version } = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
  return { version: version as string, read: (file: string) => readFile(join(dir, file), 'utf8') };
}

const sidebar = await dsh('@deepseek-ai/dsh-client-ui-sidebar-right');
const theme = await dsh('@deepseek-ai/dsh-client-ui-theme');
console.log(`DSH sidebar-right ${sidebar.version}, theme ${theme.version}`);

console.log('slots');
const slotTypes = await sidebar.read('lib/types/client/contract/slots.d.ts');
const sidebarRuntime = await sidebar.read('lib/client.js');
for (const slot of ['sidebar.right.tab.guide.entry', 'sidebar.right.pane.tab']) {
  check(`the card uses ${slot}`, card.includes(`'${slot}'`));
  check(`…which DSH declares`, slotTypes.includes(`'${slot}': {`));
  check(`…and registers at runtime`, sidebarRuntime.includes(`"${slot}"`));
}
check(
  'the guide-entry slot is keyed per session, as cardProps(sessionId) assumes',
  /'sidebar\.right\.tab\.guide\.entry': \{\s*kind: 'keyed';\s*scope: 'session';/.test(slotTypes),
);

console.log('tab registry');
const registry = await sidebar.read('lib/types/client/tab-registry.d.ts');
const index = await sidebar.read('lib/types/client/index.d.ts');
check(
  'the service is ctx.sidebarRightTabs',
  /sidebarRightTabs: SidebarRightTabRegistry;/.test(index),
);
check(
  'it has register(definition)',
  /register\(definition: SidebarRightTabDefinition\)/.test(registry),
);
/** The fields an interface declares, from its `readonly name` lines. */
function fields(name: string): Set<string> {
  const body = new RegExp(`interface ${name}[^{]*\\{([\\s\\S]*?)\\n\\}`).exec(registry)?.[1] ?? '';
  return new Set([...body.matchAll(/^\s+readonly (\w+)\??:/gm)].map((m) => m[1] as string));
}
const definition = fields('SidebarRightTabDefinition');
for (const field of ['id', 'kind', 'priority', 'title', 'guide']) {
  check(`a tab definition has ${field}`, definition.has(field));
}
const entry = fields('SidebarRightGuideEntry');
for (const field of ['id', 'order', 'title', 'description', 'icon']) {
  check(`a guide entry has ${field}`, entry.has(field));
}
check(
  "'extension' is a priority band",
  /SidebarRightTabPriority = [^;]*'extension'/.test(registry),
);

console.log('theme');
const themeRuntime = await theme.read('lib/client.js');
const used = [...new Set([...card.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1] as string))];
check('the card reads theme variables', used.length > 0);
for (const name of used) {
  // --dsl-* are layout tokens the sidebar defines; --dsw-* come from the theme.
  const source = name.startsWith('--dsl-') ? sidebarRuntime : themeRuntime;
  check(`${name} is defined`, source.includes(`${name}:`));
}

console.log('package');
check(
  'the client injects the sidebar package it registers into',
  pkg.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-sidebar-right'),
);

console.log(`\n${passed} checks passed.\n`);
