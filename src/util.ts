/**
 * Small helpers shared by the `/shodh tui` modules, with no shodh knowledge.
 *
 * @module util
 */

/**
 * One signal that aborts on the caller's signal or after a timeout.
 * (`AbortSignal.any` needs Node 20.3; the plugin supports 18.)
 * @param outer - the caller's signal, if any.
 * @param timeoutMs - delay after which the signal aborts on its own.
 * @returns the linked signal, and `dispose` to release the timer and listener.
 */
export function linkedSignal(
  outer: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; dispose(): void } {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const timer = setTimeout(abort, timeoutMs);
  if (outer?.aborted) abort();
  else outer?.addEventListener('abort', abort, { once: true });
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer);
      outer?.removeEventListener('abort', abort);
    },
  };
}

/**
 * The message of a thrown value.
 * @param error - anything caught.
 * @returns its `message` for an `Error`, else its string form.
 */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
