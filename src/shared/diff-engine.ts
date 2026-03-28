export class DiffEngine {
  private readonly lastSnapshot = new Map<string, string>();

  diff(traceId: string, snapshot: string): string {
    const previousSnapshot = this.lastSnapshot.get(traceId) ?? "";
    if (snapshot.startsWith(previousSnapshot)) {
      const delta = snapshot.slice(previousSnapshot.length);
      this.lastSnapshot.set(traceId, snapshot);
      return delta;
    }

    this.lastSnapshot.set(traceId, snapshot);
    return snapshot;
  }

  clear(traceId: string): void {
    this.lastSnapshot.delete(traceId);
  }
}
