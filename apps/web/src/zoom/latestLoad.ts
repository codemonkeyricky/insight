// The latest load per parent: a chart that loads after a click opens only when no later click on the same parent started
// another load. Two quick clicks on two rows of one callers box (or two call steps of one chart) open the second, whichever
// chart arrives last. Pure, so the rule is unit tested (test/flowCallers.test.tsx).

export class LatestLoad {
  private readonly seq = new Map<string, number>();

  /** Starts a load from `parent`: it supersedes every load started from `parent` before it. Returns its token. */
  start(parent: string): number {
    const n = (this.seq.get(parent) ?? 0) + 1;
    this.seq.set(parent, n);
    return n;
  }

  /** Whether the load `token` from `parent` is still the latest one, so it may open. */
  isLatest(parent: string, token: number): boolean {
    return this.seq.get(parent) === token;
  }
}
