export class DiffEngine {
  private lastSnapshot = new Map<string, string>();

  // 输入全量 snapshot，输出增量 delta（可为空字符串）
  diff(traceId: string, snapshot: string): string {
    const prev = this.lastSnapshot.get(traceId) ?? "";
    if (snapshot.startsWith(prev)) {
      const delta = snapshot.slice(prev.length);
      this.lastSnapshot.set(traceId, snapshot);
      return delta;
    }

    // snapshot 非连续（如 agent 重启），全量推送并重置
    this.lastSnapshot.set(traceId, snapshot);
    return snapshot;
  }

  clear(traceId: string): void {
    this.lastSnapshot.delete(traceId);
  }
}
