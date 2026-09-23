/** Keeps asynchronously discovered models bound to the connection that requested them. */
export class ModelDiscoveryRevision {
  private readonly revisions = new Map<string, number>();

  begin(scope: string): number {
    const revision = (this.revisions.get(scope) ?? 0) + 1;
    this.revisions.set(scope, revision);
    return revision;
  }

  invalidate(scope: string): void {
    this.revisions.set(scope, (this.revisions.get(scope) ?? 0) + 1);
  }

  invalidateAll(): void {
    for (const scope of this.revisions.keys()) this.invalidate(scope);
  }

  isCurrent(scope: string, revision: number): boolean {
    return (this.revisions.get(scope) ?? 0) === revision;
  }
}
