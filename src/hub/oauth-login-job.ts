import { spawn, ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { CredentialStore, OAuthSlot } from "./credential-store";
import { extractCodexLoginUrl } from "./oauth-url-extract";

export type OAuthLoginStatus =
  | "pending"
  | "awaiting_browser"
  | "completed"
  | "failed"
  | "cancelled"
  | "timeout";

export interface OAuthLoginJobOptions {
  credentialStore: CredentialStore;
  owner_caller_id: string;
  credential_label: string;
  codexLoginCommand?: string;
  codexLoginArgs?: string[];
  timeoutMs?: number;
  urlCaptureWindowMs?: number;
}

export class OAuthLoginJob {
  public status: OAuthLoginStatus = "pending";
  public login_url: string | null = null;
  public expires_at: string | null = null;
  public credential_id: string | null = null;
  public error_code: string | null = null;
  public error_message: string | null = null;
  public readonly logBuffer: string[] = [];

  private readonly opts: Required<OAuthLoginJobOptions>;
  private slot: OAuthSlot | null = null;
  private child: ChildProcess | null = null;
  private timeoutHandle: NodeJS.Timeout | null = null;
  private urlCaptureHandle: NodeJS.Timeout | null = null;
  private watcher: fs.FSWatcher | null = null;

  constructor(opts: OAuthLoginJobOptions) {
    this.opts = {
      codexLoginCommand: "codex",
      codexLoginArgs: ["login"],
      timeoutMs: 10 * 60 * 1000,
      urlCaptureWindowMs: 30_000,
      ...opts
    } as Required<OAuthLoginJobOptions>;
  }

  async start(): Promise<void> {
    this.slot = this.opts.credentialStore.createOAuthSlot();

    this.child = spawn(this.opts.codexLoginCommand, this.opts.codexLoginArgs, {
      env: { ...process.env, CODEX_HOME: this.slot.codex_home },
      stdio: ["ignore", "pipe", "pipe"]
    });

    const onLine = (line: string) => {
      if (!line) return;
      this.appendLog(line);
      if (!this.login_url) {
        const url = extractCodexLoginUrl(line);
        if (url) {
          this.login_url = url;
          this.expires_at = new Date(Date.now() + this.opts.timeoutMs).toISOString();
          if (this.status === "pending") this.status = "awaiting_browser";
        }
      }
    };
    const splitLines = (buf: Buffer) => buf.toString().split(/\r?\n/);

    this.child.stdout?.on("data", (buf: Buffer) => splitLines(buf).forEach(onLine));
    this.child.stderr?.on("data", (buf: Buffer) => splitLines(buf).forEach(onLine));

    this.watcher = fs.watch(this.slot.codex_home, (_event, file) => {
      if (file === "auth.json") this.tryComplete().catch(() => {});
    });

    this.timeoutHandle = setTimeout(() => this.handleTimeout(), this.opts.timeoutMs);
    this.urlCaptureHandle = setTimeout(() => {
      if (this.status === "pending" && !this.login_url) {
        this.fail("login_url_not_captured", "no recognizable URL printed within window");
      }
    }, this.opts.urlCaptureWindowMs);

    this.child.on("exit", (code) => {
      if (this.status === "pending" || this.status === "awaiting_browser") {
        if (code !== 0) this.fail("subprocess_exit", `codex login exited ${code}`);
      }
    });
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
    try { this.child?.kill("SIGTERM"); } catch {}
    setTimeout(() => { try { this.child?.kill("SIGKILL"); } catch {} }, 5000).unref();
    try { this.watcher?.close(); } catch {}
    if (this.timeoutHandle) clearTimeout(this.timeoutHandle);
    if (this.urlCaptureHandle) clearTimeout(this.urlCaptureHandle);
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
