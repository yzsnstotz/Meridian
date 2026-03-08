import fs from "node:fs";
import net from "node:net";
import path from "node:path";

import { config } from "../config";
import {
  PaneOutputChunkSchema,
  PaneOutputNotAvailableSchema,
  type AgentInstance,
  type PaneOutputChunk,
  type PaneOutputNotAvailable,
  type PaneSubscribeRequest
} from "../types";

interface ThreadSubscription {
  socket: net.Socket;
  replayLines: number;
}

interface ThreadWatcher {
  basename: string;
  logPath: string;
  lastSize: number;
  lastChunkHash: string;
  nextFlushAtMs: number;
  flushing: boolean;
  pendingFlush: boolean;
  scheduledFlushTimer: NodeJS.Timeout | null;
  subscriptions: Set<ThreadSubscription>;
  watcher: fs.FSWatcher | null;
}

export interface PaneBroadcasterOptions {
  logDir?: string;
  now?: () => Date;
  watchFactory?: typeof fs.watch;
  throttleMs?: number;
}

export type PaneSubscriptionResult =
  | { kind: "subscribed" }
  | { kind: "not_available"; payload: PaneOutputNotAvailable };

export class PaneBroadcaster {
  private readonly logDir: string;
  private readonly now: () => Date;
  private readonly watchFactory: typeof fs.watch;
  private readonly throttleMs: number;
  private readonly watchersByThread = new Map<string, ThreadWatcher>();
  private readonly socketCloseBound = new WeakSet<net.Socket>();
  private pushCallback: ((threadId: string, chunk: string) => void) | null = null;

  constructor(options: PaneBroadcasterOptions = {}) {
    this.logDir = options.logDir ?? config.LOG_DIR;
    this.now = options.now ?? (() => new Date());
    this.watchFactory = options.watchFactory ?? fs.watch;
    this.throttleMs = Math.max(0, options.throttleMs ?? config.PANE_BROADCAST_THROTTLE_MS);
  }

  registerPushCallback(callback: (threadId: string, chunk: string) => void): void {
    this.pushCallback = callback;
  }

  async subscribe(
    socket: net.Socket,
    instance: AgentInstance | null,
    request: PaneSubscribeRequest
  ): Promise<PaneSubscriptionResult> {
    if (!instance || instance.mode !== "pane_bridge" || !instance.tmux_pane) {
      return {
        kind: "not_available",
        payload: PaneOutputNotAvailableSchema.parse({
          type: "not_available",
          thread_id: request.thread_id,
          reason: "pane output is unavailable for bridge mode"
        })
      };
    }

    const state = this.getOrCreateWatcher(request.thread_id);
    const subscription: ThreadSubscription = {
      socket,
      replayLines: request.replay_lines ?? 0
    };
    state.subscriptions.add(subscription);
    this.bindSocketCleanup(socket);

    if (subscription.replayLines > 0) {
      const replayChunk = await this.readReplayChunk(state.logPath, subscription.replayLines);
      if (replayChunk) {
        this.write(socket, this.buildChunk(request.thread_id, replayChunk));
      }
    }

    await this.ensureWatcher(request.thread_id, state);
    return { kind: "subscribed" };
  }

  unsubscribe(socket: net.Socket, threadId: string): boolean {
    const state = this.watchersByThread.get(threadId);
    if (!state) {
      return false;
    }

    let removed = false;
    for (const subscription of [...state.subscriptions]) {
      if (subscription.socket !== socket) {
        continue;
      }
      state.subscriptions.delete(subscription);
      removed = true;
    }

    this.disposeWatcherIfUnused(threadId, state);
    return removed;
  }

  cleanupSocket(socket: net.Socket): void {
    for (const [threadId, state] of this.watchersByThread.entries()) {
      for (const subscription of [...state.subscriptions]) {
        if (subscription.socket !== socket) {
          continue;
        }
        state.subscriptions.delete(subscription);
      }
      this.disposeWatcherIfUnused(threadId, state);
    }
  }

  close(): void {
    for (const state of this.watchersByThread.values()) {
      if (state.scheduledFlushTimer) {
        clearTimeout(state.scheduledFlushTimer);
      }
      state.watcher?.close();
    }
    this.watchersByThread.clear();
  }

  private getOrCreateWatcher(threadId: string): ThreadWatcher {
    const existing = this.watchersByThread.get(threadId);
    if (existing) {
      return existing;
    }

    const logPath = path.join(this.logDir, `pane-${threadId}.log`);
    const created: ThreadWatcher = {
      basename: path.basename(logPath),
      logPath,
      lastSize: 0,
      lastChunkHash: "",
      nextFlushAtMs: 0,
      flushing: false,
      pendingFlush: false,
      scheduledFlushTimer: null,
      subscriptions: new Set<ThreadSubscription>(),
      watcher: null
    };
    this.watchersByThread.set(threadId, created);
    return created;
  }

  private bindSocketCleanup(socket: net.Socket): void {
    if (this.socketCloseBound.has(socket)) {
      return;
    }
    this.socketCloseBound.add(socket);
    socket.once("close", () => {
      this.cleanupSocket(socket);
    });
  }

  private async ensureWatcher(threadId: string, state: ThreadWatcher): Promise<void> {
    if (state.watcher) {
      return;
    }

    state.lastSize = await this.readCurrentSize(state.logPath);
    state.watcher = this.createFileWatcher(threadId, state);
  }

  private createFileWatcher(threadId: string, state: ThreadWatcher): fs.FSWatcher {
    const triggerFlush = (): void => {
      this.scheduleFlush(threadId, state);
    };

    try {
      return this.watchFactory(state.logPath, { persistent: false }, triggerFlush);
    } catch {
      return this.watchFactory(this.logDir, { persistent: false }, (_eventType, filename) => {
        if (!filename || String(filename) === state.basename) {
          triggerFlush();
        }
      });
    }
  }

  private scheduleFlush(threadId: string, state: ThreadWatcher): void {
    if (state.flushing) {
      state.pendingFlush = true;
      return;
    }

    const nowMs = Date.now();
    const delayMs = Math.max(0, state.nextFlushAtMs - nowMs);
    if (delayMs <= 0) {
      void this.flushThread(threadId);
      return;
    }
    if (state.scheduledFlushTimer) {
      return;
    }
    state.scheduledFlushTimer = setTimeout(() => {
      state.scheduledFlushTimer = null;
      void this.flushThread(threadId);
    }, delayMs);
    state.scheduledFlushTimer.unref();
  }

  private async flushThread(threadId: string): Promise<void> {
    const state = this.watchersByThread.get(threadId);
    if (!state) {
      return;
    }

    if (state.flushing) {
      state.pendingFlush = true;
      return;
    }
    state.flushing = true;
    state.nextFlushAtMs = Date.now() + this.throttleMs;

    try {
      do {
        state.pendingFlush = false;
        const buffer = await fs.promises.readFile(state.logPath).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") {
            return Buffer.alloc(0);
          }
          throw error;
        });

        const previousSize = state.lastSize;
        const nextSize = buffer.length;
        const start = nextSize < previousSize ? 0 : previousSize;
        state.lastSize = nextSize;

        if (nextSize <= start) {
          continue;
        }

        const chunk = buffer.subarray(start).toString("utf8");
        if (!chunk) {
          continue;
        }
        const chunkHash = this.computeChunkHash(chunk);
        if (chunkHash === state.lastChunkHash) {
          continue;
        }
        state.lastChunkHash = chunkHash;

        const payload = this.buildChunk(threadId, chunk);
        for (const subscription of [...state.subscriptions]) {
          if (!this.write(subscription.socket, payload)) {
            state.subscriptions.delete(subscription);
          }
        }
        this.appendGuiLog(threadId, chunk);
        if (this.pushCallback) {
          this.pushCallback(threadId, chunk);
        }
        this.disposeWatcherIfUnused(threadId, state);
      } while (state.pendingFlush);
    } finally {
      state.flushing = false;
    }
  }

  private computeChunkHash(chunk: string): string {
    let hash = 0;
    for (let index = 0; index < chunk.length; index += 1) {
      hash = (hash * 31 + chunk.charCodeAt(index)) | 0;
    }
    return String(hash);
  }

  private write(socket: net.Socket, payload: PaneOutputChunk | PaneOutputNotAvailable): boolean {
    if (socket.destroyed || !socket.writable) {
      return false;
    }
    socket.write(`${JSON.stringify(payload)}\n`);
    return true;
  }

  private buildChunk(threadId: string, chunk: string): PaneOutputChunk {
    return PaneOutputChunkSchema.parse({
      type: "pane_output",
      thread_id: threadId,
      chunk,
      timestamp: this.now().toISOString()
    });
  }

  /**
   * Append the same chunk sent to GUI clients to LOG_DIR/GUI/gui-pane-{threadId}.log
   * so there is a linear stream log that matches what the Web GUI receives.
   */
  private appendGuiLog(threadId: string, chunk: string): void {
    try {
      const guiLogDir = path.join(this.logDir, "GUI");
      fs.mkdirSync(guiLogDir, { recursive: true });
      const guiLogPath = path.join(guiLogDir, `gui-pane-${threadId}.log`);
      fs.appendFileSync(guiLogPath, chunk, "utf8");
    } catch {
      // Do not fail the broadcaster on log write errors (e.g. disk full, permissions).
    }
  }

  private disposeWatcherIfUnused(threadId: string, state: ThreadWatcher): void {
    if (state.subscriptions.size > 0) {
      return;
    }
    if (state.scheduledFlushTimer) {
      clearTimeout(state.scheduledFlushTimer);
      state.scheduledFlushTimer = null;
    }
    state.watcher?.close();
    this.watchersByThread.delete(threadId);
  }

  private async readCurrentSize(logPath: string): Promise<number> {
    try {
      const stats = await fs.promises.stat(logPath);
      return stats.size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return 0;
      }
      throw error;
    }
  }

  private async readReplayChunk(logPath: string, replayLines: number): Promise<string> {
    if (replayLines <= 0) {
      return "";
    }

    const buffer = await fs.promises.readFile(logPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        return Buffer.alloc(0);
      }
      throw error;
    });
    if (buffer.length === 0) {
      return "";
    }

    const lines = buffer.toString("utf8").split(/\r?\n/);
    const trimmed = lines[lines.length - 1] === "" ? lines.slice(0, -1) : lines;
    return trimmed.slice(-replayLines).join("\n");
  }
}
