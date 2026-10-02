/**
 * Serialize async work per key.
 *
 * Used for agent runs (one turn at a time per workspace/notebook): onboarding
 * rebuilds its session from `onboarding_transcript.json` on each turn and
 * notebook sessions share one cached transcript, so overlapping turns would
 * read the same file and the last writer would silently win.
 *
 * A rejection on one task never poisons the queue -- the next task still runs.
 */
export class KeyedQueue {
  private readonly chains = new Map<string, Promise<unknown>>();

  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(key) ?? Promise.resolve();
    // Run `fn` whether the previous task resolved or rejected.
    const next = previous.then(fn, fn);
    this.chains.set(
      key,
      next.catch(() => undefined),
    );
    return next;
  }
}
