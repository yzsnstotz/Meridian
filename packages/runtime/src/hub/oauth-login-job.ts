import { spawn, ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { CredentialStore, OAuthSlot } from "./credential-store";
import { extractCodexDeviceCode, extractCodexLoginUrl } from "./oauth-url-extract";

export type OAuthLoginStatus =
  | "pending"
  | "awaiting_browser"
  | "completed"
  | "failed"
  | "cancelled"
  | "timeout";

export type OAuthLoginMode = "browser" | "device";

export interface OAuthLoginJobOptions {
  credentialStore: CredentialStore;
  owner_caller_id: string;
  credential_label: string;
  codexLoginCommand?: string;
  codexLoginArgs?: string[];
  /**
   * "browser" (default): codex prints a localhost callback URL and runs a
   * loopback listener; this only works when the user's browser can reach the
   * codex process. "device": codex prints a verification URL + short user
   * code and polls the IdP — works headlessly, including when the hub is
   * deployed on a remote box (AWS, etc.) the user's browser can't reach.
   */
  mode?: OAuthLoginMode;
  timeoutMs?: number;
  urlCaptureWindowMs?: number;
  /**
   * Periodic poll interval (ms) for the fs.watch fallback. While the job is in
   * `pending` or `awaiting_browser`, tryComplete() is also driven by this
   * timer in case fs.watch drops the auth.json create event (known to happen
   * on some Linux kernel/fs combos). Default 500ms.
   */
  pollIntervalMs?: number;
  /**
   * How many times to kill+respawn `codex login` if it produces no URL
   * within `urlCaptureWindowMs`. Codex CLI is observably flaky on this path:
   * stdio-piped invocations sometimes hang silently with zero output for
   * many seconds even on a healthy install. The same binary works on a
   * subsequent attempt. Default 2 retries (so 3 total attempts) — pure
   * client-side robustness, no codex change required.
   */
  urlCaptureRetries?: number;
}

export class OAuthLoginJob {
  public status: OAuthLoginStatus = "pending";
  public login_url: string | null = null;
  public expires_at: string | null = null;
  public credential_id: string | null = null;
  public error_code: string | null = null;
  public error_message: string | null = null;
  public readonly logBuffer: string[] = [];
  /**
   * Device-flow output. Both fields stay null in browser mode. `login_url` is
   * also mirrored to `verification_uri` so existing UI / poll consumers that
   * only look at `login_url` keep showing a usable URL in device mode.
   */
  public mode: OAuthLoginMode = "browser";
  public user_code: string | null = null;
  public verification_uri: string | null = null;

  private readonly opts: Required<OAuthLoginJobOptions>;
  private slot: OAuthSlot | null = null;
  private child: ChildProcess | null = null;
  private timeoutHandle: NodeJS.Timeout | null = null;
  private urlCaptureHandle: NodeJS.Timeout | null = null;
  private watcher: fs.FSWatcher | null = null;
  private pollHandle: NodeJS.Timeout | null = null;
  /**
   * Per-stream tail buffers so URL extraction is robust to a URL arriving
   * fragmented across multiple `data` events. The previous implementation
   * split each chunk on `\n` and ran the extractor per line — if codex
   * flushed the URL across two chunks (or with no trailing newline before
   * the URL capture window expired), the regex never matched a complete URL
   * and the job failed with `login_url_not_captured` even though codex had
   * actually printed it. Capped at MAX_STREAM_BUF chars to keep memory
   * bounded if the subprocess emits a single very long line.
   */
  private stdoutBuf = "";
  private stderrBuf = "";
  private static readonly MAX_STREAM_BUF = 64 * 1024;
  /**
   * Number of `codex login` attempts that have been started (1-indexed once
   * start() runs). Exposed for diagnostics; included in the failure
   * `error_message` when all retries are exhausted.
   */
  public attemptCount = 0;

  constructor(opts: OAuthLoginJobOptions) {
    // Per-field `??` rather than `{ ...defaults, ...opts }`: an explicit
    // `undefined` in opts (e.g. router forwarding an unset
    // `defaultCodexLoginCommand`) would otherwise override the default with
    // `undefined`, and `spawn(undefined, ...)` throws synchronously — which the
    // registry's fire-and-forget `.catch(() => {})` swallows, leaving the job
    // stuck on `status="pending"` forever.
    this.opts = {
      credentialStore: opts.credentialStore,
      owner_caller_id: opts.owner_caller_id,
      credential_label: opts.credential_label,
      codexLoginCommand: opts.codexLoginCommand ?? "codex",
      codexLoginArgs: opts.codexLoginArgs ?? ["login"],
      mode: opts.mode ?? "browser",
      timeoutMs: opts.timeoutMs ?? 10 * 60 * 1000,
      urlCaptureWindowMs: opts.urlCaptureWindowMs ?? 30_000,
      pollIntervalMs: opts.pollIntervalMs ?? 500,
      urlCaptureRetries: opts.urlCaptureRetries ?? 2
    };
    this.mode = this.opts.mode;
  }

  /**
   * Mark a job that failed during start() (synchronous spawn throw, fs.watch
   * EACCES, etc.) as failed instead of leaving it stuck on `pending`. Called
   * by the registry from its `.catch` on `job.start()`.
   */
  markStartupFailure(message: string): void {
    if (this.status !== "pending" && this.status !== "awaiting_browser") return;
    this.fail("startup_failed", message);
  }

  async start(): Promise<void> {
    this.slot = this.opts.credentialStore.createOAuthSlot();

    // fs.watch + pollHandle + global timeout are job-level (not per-attempt):
    // a retry shouldn't reset the 10-minute global deadline or stop watching
    // for auth.json. Only the codex subprocess restarts per attempt.
    this.watcher = fs.watch(this.slot.codex_home, (_event, file) => {
      if (file === "auth.json") this.tryComplete().catch(() => {});
    });

    // Belt-and-suspenders poll fallback for fs.watch event drops. Stops itself
    // once the job transitions out of pending/awaiting_browser; cleanup()
    // clears the handle unconditionally as a safety net.
    this.pollHandle = setInterval(() => {
      if (this.status !== "pending" && this.status !== "awaiting_browser") {
        if (this.pollHandle) {
          clearInterval(this.pollHandle);
          this.pollHandle = null;
        }
        return;
      }
      this.tryComplete().catch(() => {});
    }, this.opts.pollIntervalMs);
    this.pollHandle.unref();

    this.timeoutHandle = setTimeout(() => this.handleTimeout(), this.opts.timeoutMs);

    this.startCodexAttempt();
  }

  /**
   * Spawn `codex login` and wire stdout/stderr/error/exit + the URL-capture
   * window timer. Called once on start() and again on each retry. All event
   * handlers are closure-guarded against `this.child` reassignment so a
   * killed-for-retry subprocess can't fire `exit` and call
   * `fail("subprocess_exit", ...)` after we already moved on.
   */
  private startCodexAttempt(): void {
    if (!this.slot) return;
    this.attemptCount += 1;
    this.stdoutBuf = "";
    this.stderrBuf = "";
    if (this.attemptCount > 1) {
      this.appendLog(`[retry ${this.attemptCount}/${this.opts.urlCaptureRetries + 1}] respawning codex login`);
    }

    // Device mode flips on `codex login --device-auth`. Tests / advanced callers
    // can pre-include the flag; don't duplicate it if so.
    const baseArgs = this.opts.codexLoginArgs;
    const argv =
      this.opts.mode === "device" && !baseArgs.includes("--device-auth")
        ? [...baseArgs, "--device-auth"]
        : baseArgs;

    const thisChild = spawn(this.opts.codexLoginCommand, argv, {
      env: { ...process.env, CODEX_HOME: this.slot.codex_home },
      stdio: ["ignore", "pipe", "pipe"]
    });
    this.child = thisChild;

    const tryExtractFromBuffer = (combined: string) => {
      if (this.login_url) return;
      if (this.opts.mode === "device") {
        const dc = extractCodexDeviceCode(combined);
        if (!dc) return;
        this.verification_uri = dc.verification_uri;
        this.user_code = dc.user_code;
        // Mirror onto login_url so existing UI / poll consumers that only
        // look at login_url still get a usable URL in device mode.
        this.login_url = dc.verification_uri;
      } else {
        const url = extractCodexLoginUrl(combined);
        if (!url) return;
        this.login_url = url;
      }
      this.expires_at = new Date(Date.now() + this.opts.timeoutMs).toISOString();
      if (this.status === "pending") this.status = "awaiting_browser";
    };

    const feedStream = (chunk: Buffer, which: "out" | "err") => {
      // Closure guard: a killed-for-retry child may still flush a buffered
      // chunk after we've replaced this.child with a fresh attempt. Ignore.
      if (this.child !== thisChild) return;
      const text = chunk.toString();
      let combined = (which === "out" ? this.stdoutBuf : this.stderrBuf) + text;
      if (combined.length > OAuthLoginJob.MAX_STREAM_BUF) {
        combined = combined.slice(-OAuthLoginJob.MAX_STREAM_BUF);
      }
      tryExtractFromBuffer(combined);
      const newlineIdx = combined.lastIndexOf("\n");
      if (newlineIdx >= 0) {
        const completeBlock = combined.slice(0, newlineIdx);
        const remainder = combined.slice(newlineIdx + 1);
        for (const line of completeBlock.split(/\r?\n/)) {
          if (line) this.appendLog(line);
        }
        if (which === "out") this.stdoutBuf = remainder;
        else this.stderrBuf = remainder;
      } else {
        if (which === "out") this.stdoutBuf = combined;
        else this.stderrBuf = combined;
      }
    };

    thisChild.stdout?.on("data", (buf: Buffer) => feedStream(buf, "out"));
    thisChild.stderr?.on("data", (buf: Buffer) => feedStream(buf, "err"));

    if (this.urlCaptureHandle) clearTimeout(this.urlCaptureHandle);
    this.urlCaptureHandle = setTimeout(() => this.handleUrlCaptureExpiry(), this.opts.urlCaptureWindowMs);

    thisChild.on("error", (err) => {
      // Closure guard: stale child's spawn error after retry — ignore.
      if (this.child !== thisChild) return;
      if (this.status !== "pending" && this.status !== "awaiting_browser") return;
      const code = (err as NodeJS.ErrnoException).code ?? "spawn_error";
      this.fail(
        "subprocess_spawn_error",
        `failed to spawn ${this.opts.codexLoginCommand}: ${code} ${err.message}`
      );
    });

    thisChild.on("exit", (code) => {
      // Closure guard: if we already spawned a replacement (retry), the old
      // child's SIGTERM-induced exit is not a real subprocess failure.
      if (this.child !== thisChild) return;
      if (this.status !== "pending" && this.status !== "awaiting_browser") return;
      if (code !== 0) this.fail("subprocess_exit", `codex login exited ${code}`);
    });
  }

  /**
   * The URL-capture window expired. If we have retries remaining, kill the
   * current (apparently-hung) codex and spawn a fresh attempt. Codex CLI is
   * observably flaky: stdio-piped invocations occasionally produce zero
   * bytes for many seconds and then never emit. Same binary, same env, fine
   * on the next try.
   */
  private handleUrlCaptureExpiry(): void {
    if (this.status !== "pending" || this.login_url) return;
    const maxAttempts = this.opts.urlCaptureRetries + 1;
    if (this.attemptCount < maxAttempts) {
      const stale = this.child;
      this.child = null;
      if (stale && stale.exitCode === null && stale.signalCode === null) {
        try { stale.kill("SIGTERM"); } catch {}
        setTimeout(() => {
          if (stale.exitCode === null && stale.signalCode === null) {
            try { stale.kill("SIGKILL"); } catch {}
          }
        }, 2000).unref();
      }
      // Spawn next attempt on next tick to let the old child's signal land.
      setTimeout(() => {
        if (this.status === "pending" && !this.login_url) {
          this.startCodexAttempt();
        }
      }, 100);
      return;
    }
    // Out of retries — surface the cumulative failure.
    const recent = this.logBuffer.slice(-8).join(" | ");
    const snippet = recent.length > 400 ? recent.slice(0, 400) + "…" : recent;
    const secs = Math.round(this.opts.urlCaptureWindowMs / 1000);
    const base = `no recognizable URL printed after ${maxAttempts} codex attempts of ${secs}s each`;
    const detail = snippet
      ? `${base}. Last codex output: ${snippet}`
      : `${base}. codex produced no output (check that the codex binary is on the hub process's PATH).`;
    this.fail("login_url_not_captured", detail);
  }

  async cancel(): Promise<void> {
    if (this.status === "completed" || this.status === "failed" || this.status === "timeout" || this.status === "cancelled") return;
    this.status = "cancelled";
    this.cleanup({ deleteDir: true });
  }

  private async tryComplete(): Promise<void> {
    if (this.status === "completed" || !this.slot) return;
    const authPath = path.join(this.slot.codex_home, "auth.json");
    if (!fs.existsSync(authPath)) return;
    try {
      JSON.parse(fs.readFileSync(authPath, "utf8"));
    } catch {
      return; // partial write — wait for next fire
    }

    const credentialId = await this.opts.credentialStore.completeOAuth({
      slot: this.slot,
      credential_label: this.opts.credential_label,
      owner_caller_id: this.opts.owner_caller_id
    });

    // RACE GUARD: state may have changed during the await above. If
    // cancel()/handleTimeout()/fail() fired while completeOAuth was in flight,
    // the slot dir has already been rm -rf'd via abandonOAuthSlot — but
    // completeOAuth still inserted a record into the store. Resurrecting that
    // record as a healthy credential would leak a CredentialRecord pointing at
    // a non-existent codex_home_path. Undo the registration instead.
    if (this.status !== "pending" && this.status !== "awaiting_browser") {
      try {
        await this.opts.credentialStore.revoke(credentialId);
      } catch {
        // Best effort. The slot dir is already gone so revoke()'s rm -rf will
        // be a no-op; the record gets marked revoked which is the correct
        // post-condition for an aborted job.
      }
      return;
    }

    this.credential_id = credentialId;
    this.status = "completed";
    this.cleanup({ deleteDir: false });
  }

  private fail(code: string, message: string): void {
    if (this.status === "completed") return;
    this.status = "failed";
    this.error_code = code;
    this.error_message = message;
    this.cleanup({ deleteDir: true });
  }

  private handleTimeout(): void {
    if (this.status === "completed") return;
    this.status = "timeout";
    this.cleanup({ deleteDir: true });
  }

  private cleanup(opts: { deleteDir: boolean }): void {
    // Only signal the subprocess if it's still running. On the happy completion
    // path the child has already exited cleanly; spinning up an unused SIGKILL
    // timer (even with .unref()) adds avoidable timer churn and obscures the
    // intent of cleanup() — kills are not free, they were defensive fallbacks
    // for stuck children.
    if (this.child && this.child.exitCode === null && this.child.signalCode === null) {
      try { this.child.kill("SIGTERM"); } catch {}
      setTimeout(() => {
        if (this.child && this.child.exitCode === null && this.child.signalCode === null) {
          try { this.child.kill("SIGKILL"); } catch {}
        }
      }, 5000).unref();
    }
    try { this.watcher?.close(); } catch {}
    if (this.timeoutHandle) clearTimeout(this.timeoutHandle);
    if (this.urlCaptureHandle) clearTimeout(this.urlCaptureHandle);
    if (this.pollHandle) {
      clearInterval(this.pollHandle);
      this.pollHandle = null;
    }
    if (opts.deleteDir && this.slot && this.status !== "completed") {
      try { this.opts.credentialStore.abandonOAuthSlot(this.slot); } catch {}
    }
  }

  private appendLog(line: string): void {
    this.logBuffer.push(line);
    while (this.logBuffer.length > 200) this.logBuffer.shift();
  }

  get log_excerpt(): string {
    return this.logBuffer.join("\n");
  }
}
