/** Join concurrent reads, but never let a late acknowledgement swallow a newer
 * task event. A correction's own event causes one harmless no-op follow-up. */
export class TaskReconcileGate {
  private version = 0;
  private corrections = 0;
  get revision() { return this.corrections; }
  private verified = new Map<string, number>();
  private pending = new Map<string, Promise<void>>();
  invalidate() { this.version++; }
  isVerified(key: string) { return this.verified.get(key) === this.version; }
  ensure(key: string, operation: () => Promise<boolean | void>): Promise<void> {
    if (this.isVerified(key)) return Promise.resolve();
    const existing = this.pending.get(key);
    if (existing) return existing;
    const promise = (async () => {
      while (true) {
        const version = this.version;
        if (await operation()) this.corrections++;
        if (version === this.version) { this.verified.set(key, version); return; }
      }
    })().finally(() => this.pending.delete(key));
    this.pending.set(key, promise);
    return promise;
  }
}
