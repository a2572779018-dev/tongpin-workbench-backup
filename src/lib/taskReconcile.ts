/** Join concurrent reads, but never let a late acknowledgement swallow a newer
 * task event. A correction's own event causes one harmless no-op follow-up. */
export class TaskReconcileGate {
  private version = 0;
  private verified = new Map<string, number>();
  private pending = new Map<string, Promise<void>>();
  invalidate() { this.version++; }
  ensure(key: string, operation: () => Promise<unknown>): Promise<void> {
    if (this.verified.get(key) === this.version) return Promise.resolve();
    const existing = this.pending.get(key);
    if (existing) return existing;
    const promise = (async () => {
      while (true) {
        const version = this.version;
        await operation();
        if (version === this.version) { this.verified.set(key, version); return; }
      }
    })().finally(() => this.pending.delete(key));
    this.pending.set(key, promise);
    return promise;
  }
}
