/**
 * Browser half of @louisremi/dsh-shodh-memory: a "Shodh memory" card on the
 * right panel's start page. Clicking it runs `/shodh tui` for the session,
 * exactly as typing it would; the Host then opens the TUI in a terminal tab.
 * A failure shows the command's message on the card.
 *
 * Hand-written in the Client module-loader format (no build step); it requires
 * only `react`, a baseline module.
 */
(function register(root) {
  const PACKAGE = '@louisremi/dsh-shodh-memory';
  /** Tab-type identity; the guide card registers under the same key. */
  const TYPE_ID = `${PACKAGE}/tui`;
  const KIND = 'shodh-tui';
  const COMMAND = '/shodh tui';

  const en = {
    title: 'Shodh memory',
    description: 'Open the shodh TUI in a terminal',
    starting: 'Starting…',
    hidden: 'Run /shodh tui in the conversation to open the shodh TUI.',
  };

  /**
   * Run `/shodh tui` and reduce the outcome to an error message, if any.
   * @param {(line: string) => Promise<any>} execute - session-bound `remote.commands.execute`.
   * @returns {Promise<string | undefined>} the error text, or undefined on success.
   */
  async function openTui(execute) {
    try {
      const response = await execute(COMMAND);
      if (response?.ok !== true) return response?.error?.message || 'The command failed.';
      const result = response.value?.result;
      if (!result) return 'The /shodh command is not available in this session.';
      return result.kind === 'success' ? undefined : result.text || 'The command failed.';
    } catch (error) {
      return typeof error?.message === 'string' ? error.message : String(error);
    }
  }

  root.__ModuleLoader__.load({
    id: PACKAGE,
    factory(require) {
      const React = require('react');
      const h = React.createElement;

      function ShodhIcon(props) {
        const size = props?.size ?? 24;
        return h(
          'svg',
          {
            width: size,
            height: size,
            viewBox: '0 0 24 24',
            fill: 'none',
            stroke: 'currentColor',
            strokeWidth: 1.6,
            strokeLinejoin: 'round',
            'aria-hidden': true,
          },
          h('rect', { x: 3, y: 4, width: 18, height: 16, rx: 3 }),
          h('path', { d: 'M8 10.5 12 8l4 2.5M8 10.5l4 5 4-5' }),
        );
      }

      // Hover and focus rings need selectors, which inline styles cannot express.
      const css = `
.shodh-tui-card{box-sizing:border-box;display:flex;align-items:center;gap:14px;width:100%;min-height:56px;padding:14px 20px;border:0.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsl-guide-entry-radius);background:var(--dsw-alias-bg-layer-1);color:inherit;font:inherit;text-align:left;cursor:pointer}
.shodh-tui-card:hover{background:var(--dsw-alias-interactive-bg-hover)}
.shodh-tui-card:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:-2px}
.shodh-tui-card[aria-busy=true]{cursor:progress}
.shodh-tui-icon{display:flex;flex:none;color:var(--dsw-alias-label-secondary)}
.shodh-tui-text{display:flex;flex-direction:column;gap:3px;min-width:0}
.shodh-tui-title{color:var(--dsw-alias-label-primary);font-size:14px;line-height:1.4}
.shodh-tui-sub{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:1.4}
.shodh-tui-error{color:var(--dsw-alias-label-error);white-space:pre-wrap;overflow-wrap:anywhere}`;

      /** The start-page card: one click, one `/shodh tui`. */
      function TuiCard({ title, description, execute }) {
        const [busy, setBusy] = React.useState(false);
        const [error, setError] = React.useState(undefined);
        const onClick = () => {
          if (busy || !execute) return;
          setBusy(true);
          setError(undefined);
          void openTui(execute).then((message) => {
            setBusy(false);
            setError(message);
          });
        };
        const sub = busy ? en.starting : (error ?? description);
        return h(
          'button',
          {
            type: 'button',
            className: 'shodh-tui-card',
            onClick,
            'aria-busy': busy,
            disabled: !execute,
          },
          h('style', null, css),
          h('span', { className: 'shodh-tui-icon' }, h(ShodhIcon, { size: description ? 26 : 22 })),
          h(
            'span',
            { className: 'shodh-tui-text' },
            h('span', { className: 'shodh-tui-title' }, title),
            sub &&
              h(
                'span',
                {
                  className: error ? 'shodh-tui-sub shodh-tui-error' : 'shodh-tui-sub',
                  role: 'status',
                },
                sub,
              ),
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
          const inject = (sessionId) => ({
            execute: sessionId
              ? (line) => ctx.remote.commands.execute(sessionId, line, [])
              : undefined,
          });
          ctx.effect(
            () =>
              ctx.slots.inject('sidebar.right.tab.guide.entry', () =>
                ctx.slots.register(
                  { name: 'sidebar.right.tab.guide.entry', key: TYPE_ID, inject },
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
        __test: { openTui, TYPE_ID, KIND, COMMAND, en },
      };
    },
  });
})(globalThis);
