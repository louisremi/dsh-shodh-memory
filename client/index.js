/**
 * Browser half of @louisremi/dsh-shodh-memory: a "Shodh memory" card on the
 * right panel's start page. Clicking it runs `/shodh tui` for the session,
 * exactly as typing it would; the Host then opens the TUI in a terminal tab.
 * The command's reply (which profile to pick, or why it failed) is shown on
 * the card, as typing the command would show it in the conversation. When the
 * failure is a
 * missing binary, the card also offers Install, which runs `/shodh tui install`
 * and then opens the TUI.
 *
 * Hand-written in the Client module-loader format (no build step); it requires
 * only `react`, a baseline module.
 */
(function register(root) {
  const PACKAGE = '@louisremi/dsh-shodh-memory';
  /** Tab-type identity; the guide card registers under the same key. */
  const TYPE_ID = `${PACKAGE}/tui`;
  const KIND = 'shodh-tui';
  const OPEN = '/shodh tui';
  const INSTALL = '/shodh tui install';
  /** First line of the Host's no-binary error (MISSING_BINARY in src/tui.ts). */
  const MISSING_BINARY = 'No shodh-tui binary found.';
  /** rgb(240, 136, 62). */
  const LOGO_COLOR = '#f0883e';
  const LOGO_PATH =
    'M12 0L22 0L22 1L23 1L23 2L25 2L25 5L26 5L26 8L27 8L27 14L28 14L28 15L31 15L31 16L30 16L30 17L26 17L26 16L25 16L25 14L24 14L24 11L22 11L22 12L23 12L23 13L21 13L21 11L20 11L20 10L19 10L19 18L20 18L20 20L15 20L15 16L14 16L14 15L10 15L10 16L8 16L8 17L7 17L7 20L0 20L0 19L1 19L1 8L2 8L2 7L3 7L3 6L4 6L4 5L5 5L5 4L7 4L7 3L8 3L8 2L11 2L11 1L12 1Z';

  const en = {
    title: 'Shodh memory',
    description: 'Open the shodh TUI in a terminal',
    starting: 'Starting…',
    installing: 'Installing shodh-tui…',
    install: 'Install',
    hidden: 'Run /shodh tui in the conversation to open the shodh TUI.',
  };

  /**
   * Run one Host command and reduce the response to what the card shows.
   * @param {(line: string) => Promise<any>} execute - session-bound `remote.commands.execute`.
   * @param {string} line - the command line.
   * @returns {Promise<{ ok: boolean, text: string }>} success or failure, and the
   *   command's reply (empty when a successful command said nothing).
   */
  async function run(execute, line) {
    const failed = (text) => ({ ok: false, text: text || 'The command failed.' });
    try {
      const response = await execute(line);
      if (response?.ok !== true) return failed(response?.error?.message);
      const result = response.value?.result;
      if (!result) return failed('The /shodh command is not available in this session.');
      return result.kind === 'success'
        ? { ok: true, text: result.text ?? '' }
        : failed(result.text);
    } catch (error) {
      return failed(typeof error?.message === 'string' ? error.message : String(error));
    }
  }

  /**
   * Open the TUI, installing it first when asked.
   * @param {(line: string) => Promise<any>} execute - session-bound command runner.
   * @param {boolean} install - run `/shodh tui install` first.
   * @returns {Promise<{ ok: boolean, text: string }>} the outcome of the last command run.
   */
  async function openTui(execute, install) {
    if (install) {
      const installed = await run(execute, INSTALL);
      if (!installed.ok) return installed;
    }
    return run(execute, OPEN);
  }

  /**
   * @param {{ ok: boolean, text: string } | undefined} outcome - from {@link openTui}.
   * @returns {boolean} whether it failed for want of a binary.
   */
  function isMissingBinary(outcome) {
    return outcome?.ok === false && outcome.text.startsWith(MISSING_BINARY);
  }

  root.__ModuleLoader__.load({
    id: PACKAGE,
    factory(require) {
      const React = require('react');
      const h = React.createElement;

      /**
       * The shodh logo, traced dot for dot from the Braille-art version shodh
       * prints (31×20 dots, one SVG unit per dot), in shodh orange.
       */
      function ShodhIcon(props) {
        const size = props?.size ?? 24;
        return h(
          'svg',
          {
            width: size,
            height: size,
            viewBox: '0 -5.5 31 31',
            fill: LOGO_COLOR,
            shapeRendering: 'crispEdges',
            'aria-hidden': true,
          },
          h('path', { d: LOGO_PATH }),
        );
      }

      // Hover and focus rings need selectors, which inline styles cannot express.
      const css = `
.shodh-tui-card{position:relative;box-sizing:border-box;display:flex;align-items:center;gap:14px;width:100%;min-height:56px;padding:14px 20px;overflow:hidden;border:0.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsl-guide-entry-radius);background:var(--dsw-alias-bg-layer-1)}
.shodh-tui-card:hover{background:var(--dsw-alias-interactive-bg-hover)}
.shodh-tui-main{position:absolute;inset:0;width:100%;height:100%;padding:0;border:0;border-radius:inherit;background:none;cursor:pointer}
.shodh-tui-main:disabled,.shodh-tui-card[aria-busy=true] .shodh-tui-main{cursor:progress}
.shodh-tui-main:focus-visible,.shodh-tui-install:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:-2px}
.shodh-tui-icon,.shodh-tui-text{position:relative;pointer-events:none}
.shodh-tui-icon{display:flex;flex:none;color:var(--dsw-alias-label-secondary)}
.shodh-tui-text{flex:1;display:flex;flex-direction:column;gap:3px;min-width:0}
.shodh-tui-install{position:relative;flex:none;height:28px;padding:0 12px;border:0.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;cursor:pointer}
.shodh-tui-install:hover{background:var(--dsw-alias-interactive-bg-hover)}
.shodh-tui-title{color:var(--dsw-alias-label-primary);font-size:14px;line-height:1.4}
.shodh-tui-sub{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:1.4}
.shodh-tui-reply{white-space:pre-wrap;overflow-wrap:anywhere}
.shodh-tui-error{color:var(--dsw-alias-state-error-primary)}`;

      /**
       * The start-page card: one click, one `/shodh tui`. When that fails for
       * want of a binary, an Install button installs it and opens the TUI.
       */
      function TuiCard({ title, description, execute }) {
        /** `undefined` when idle, else `'starting'` or `'installing'`. */
        const [busy, setBusy] = React.useState(undefined);
        /** The last command reply, `{ ok, text }`, until the next click. */
        const [outcome, setOutcome] = React.useState(undefined);
        /** False once the card is gone; an install can outlive it by minutes. */
        const mounted = React.useRef(true);
        React.useEffect(
          () => () => {
            mounted.current = false;
          },
          [],
        );
        const start = (install) => {
          if (busy || !execute) return;
          setBusy(install ? 'installing' : 'starting');
          setOutcome(undefined);
          void openTui(execute, install).then((next) => {
            if (!mounted.current) return;
            setBusy(undefined);
            setOutcome(next);
          });
        };
        const reply = !busy && outcome?.text ? outcome : undefined;
        const busyText = busy === 'installing' ? en.installing : en.starting;
        const sub = busy ? busyText : (reply?.text ?? description);
        const subClass = !reply
          ? 'shodh-tui-sub'
          : reply.ok
            ? 'shodh-tui-sub shodh-tui-reply'
            : 'shodh-tui-sub shodh-tui-reply shodh-tui-error';
        return h(
          'div',
          { className: 'shodh-tui-card', 'aria-busy': busy !== undefined },
          h('style', null, css),
          h('button', {
            type: 'button',
            className: 'shodh-tui-main',
            'aria-label': sub ? `${title}. ${sub}` : title,
            disabled: !execute || busy !== undefined,
            onClick: () => start(false),
          }),
          h('span', { className: 'shodh-tui-icon' }, h(ShodhIcon, { size: description ? 26 : 22 })),
          h(
            'span',
            { className: 'shodh-tui-text' },
            h('span', { className: 'shodh-tui-title' }, title),
            sub &&
              h(
                'span',
                {
                  className: subClass,
                  role: 'status',
                },
                sub,
              ),
          ),
          !busy &&
            isMissingBinary(outcome) &&
            h(
              'button',
              { type: 'button', className: 'shodh-tui-install', onClick: () => start(true) },
              en.install,
            ),
        );
      }

      /** Shown only if the card is opened as a page (More tools, after unpinning it). */
      function HiddenPage() {
        return h(
          'p',
          { style: { padding: 24, color: 'var(--dsw-alias-label-secondary)', fontSize: 13 } },
          en.hidden,
        );
      }

      return {
        inject: ['slots', 'sidebarRightTabs', 'remote', 'remote.commands'],
        apply(ctx) {
          ctx.effect(
            () =>
              ctx.sidebarRightTabs.register({
                id: TYPE_ID,
                kind: KIND,
                priority: 'extension',
                title: () => en.title,
                guide: [
                  {
                    id: 'tui',
                    order: 40,
                    title: () => en.title,
                    description: () => en.description,
                    icon: ShodhIcon,
                  },
                ],
              }),
            'shodh-memory: tab type',
          );
          /** Per-session props for the card: a command runner bound to that session. */
          const cardProps = (sessionId) => ({
            execute: sessionId
              ? (line) => ctx.remote.commands.execute(sessionId, line, [])
              : undefined,
          });
          ctx.effect(
            () =>
              ctx.slots.inject('sidebar.right.tab.guide.entry', () =>
                ctx.slots.register(
                  { name: 'sidebar.right.tab.guide.entry', key: TYPE_ID, inject: cardProps },
                  TuiCard,
                ),
              ),
            'shodh-memory: guide card',
          );
          ctx.effect(
            () =>
              ctx.slots.inject('sidebar.right.pane.tab', () =>
                ctx.slots.register({ name: 'sidebar.right.pane.tab', key: TYPE_ID }, HiddenPage),
              ),
            'shodh-memory: page fallback',
          );
        },
        // Exposed for the test suite only.
        __test: { openTui, isMissingBinary, TYPE_ID, KIND, OPEN, INSTALL, MISSING_BINARY, en },
      };
    },
  });
})(globalThis);
