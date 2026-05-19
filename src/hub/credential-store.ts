import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { CredentialRecord } from "./state-store";
import type { CallerIdentity } from "../types";

export interface CredentialStoreOptions {
  initialRecords: CredentialRecord[];
  credentialsRoot: string;
  onChange?: (records: CredentialRecord[]) => Promise<void> | void;
}

export class CredentialNotFoundError extends Error {
  constructor(public readonly credential_id: string) {
    super(`credential not found: ${credential_id}`);
    this.name = "CredentialNotFoundError";
  }
}

export class CredentialRevokedError extends Error {
  constructor(public readonly credential_id: string) {
    super(`credential revoked: ${credential_id}`);
    this.name = "CredentialRevokedError";
  }
}

export class CredentialForbiddenError extends Error {
  constructor(
    public readonly credential_id: string,
    public readonly caller_id: string
  ) {
    super(`credential ${credential_id} is owned by another caller`);
    this.name = "CredentialForbiddenError";
  }
}

export interface ResolvedCredential {
  codex_home: string;
  env_overrides: Record<string, string>;
  credential_id: string;
}

export interface OAuthSlot {
  credential_id: string;
  codex_home: string;
}

export class CredentialStore {
  private readonly records: Map<string, CredentialRecord>;
  private readonly credentialsRoot: string;
  private onChange: (records: CredentialRecord[]) => Promise<void> | void;

  constructor(opts: CredentialStoreOptions) {
    this.records = new Map(opts.initialRecords.map((r) => [r.credential_id, r]));
    this.credentialsRoot = opts.credentialsRoot;
    this.onChange = opts.onChange ?? (() => {});
  }

  /**
   * Install or replace the onChange callback. Needed because HubServer
   * constructs the store BEFORE the router (which owns persistStateSafely),
   * but the callback needs to call back into the router. Without this, every
   * credential mutation lived only in memory until an unrelated handler
   * triggered persistStateSafely — a restart in between caused silent data
   * loss and reconcile() then rm -rf'd the orphan dirs.
   */
  setOnChange(callback: (records: CredentialRecord[]) => Promise<void> | void): void {
    this.onChange = callback;
  }

  list(): CredentialRecord[] {
    return Array.from(this.records.values());
  }

  get(credentialId: string): CredentialRecord | undefined {
    return this.records.get(credentialId);
  }

  /**
   * Single chokepoint for owner-or-admin ACL on a specific credential id.
   * Throws on missing, revoked, or forbidden access; returns void on success.
   * Mirror the same precedence used by resolve(): not-found → revoked → forbidden.
   */
  assertOwnerOrAdmin(
    credentialId: string | null | undefined,
    caller: CallerIdentity
  ): void {
    if (!credentialId) throw new CredentialNotFoundError(String(credentialId));
    const rec = this.records.get(credentialId);
    if (!rec) throw new CredentialNotFoundError(credentialId);
    if (rec.revoked_at) throw new CredentialRevokedError(credentialId);
    if (!this.canCallerAccess(rec, caller)) {
      throw new CredentialForbiddenError(credentialId, caller.caller_id);
    }
  }

  /**
   * Predicate form of the owner-or-admin check, suitable for filtering lists
   * where we want to skip records the caller cannot see (instead of throwing).
   * Does NOT consider revoked_at — listing handlers may want to surface
   * revoked entries to their owners; throwing forms enforce revoked separately.
   */
  canCallerAccess(record: CredentialRecord, caller: CallerIdentity): boolean {
    if (caller.caller_authority === "admin") return true;
    return record.owner_caller_id === caller.caller_id;
  }

  resolve(
    credentialId: string | null | undefined,
    caller: CallerIdentity
  ): ResolvedCredential | null {
    if (!credentialId) return null;
    this.assertOwnerOrAdmin(credentialId, caller);
    // assertOwnerOrAdmin guarantees the record exists and is not revoked.
    const rec = this.records.get(credentialId)!;
    const env_overrides =
      rec.kind === "api_key" ? this.readSecretEnv(rec) : {};
    this.touchLastUsed(rec.credential_id).catch(() => {});
    return {
      codex_home: rec.codex_home_path,
      env_overrides,
      credential_id: rec.credential_id
    };
  }

  private readSecretEnv(rec: CredentialRecord): Record<string, string> {
    const envJsonPath = path.join(rec.codex_home_path, "env.json");
    const raw = fs.readFileSync(envJsonPath, "utf8");
    return JSON.parse(raw) as Record<string, string>;
  }

  private async touchLastUsed(credentialId: string): Promise<void> {
    const rec = this.records.get(credentialId);
    if (!rec) return;
    rec.last_used_at = new Date().toISOString();
    await this.onChange(this.list());
  }

  async createApiKey(args: {
    credential_label: string;
    owner_caller_id: string;
    base_url: string;
    model_id: string;
    env_var: string;
    key_value: string;
  }): Promise<string> {
    const credentialId = crypto.randomUUID();
    const dir = path.join(this.credentialsRoot, credentialId);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

    try {
      const configToml = this.generateApiKeyConfigToml({
        base_url: args.base_url,
        model_id: args.model_id,
        env_var: args.env_var
      });
      fs.writeFileSync(path.join(dir, "config.toml"), configToml, { mode: 0o600 });
      fs.writeFileSync(
        path.join(dir, "env.json"),
        JSON.stringify({ [args.env_var]: args.key_value }),
        { mode: 0o600 }
      );

      const rec: CredentialRecord = {
        credential_id: credentialId,
        credential_label: args.credential_label,
        provider: "codex",
        kind: "api_key",
        owner_caller_id: args.owner_caller_id,
        codex_home_path: dir,
        is_default: false,
        created_at: new Date().toISOString(),
        last_used_at: null,
        revoked_at: null,
        api_key_metadata: {
          base_url: args.base_url,
          model_id: args.model_id,
          env_var: args.env_var
        }
      };
      this.records.set(credentialId, rec);
      await this.onChange(this.list());
      return credentialId;
    } catch (err) {
      fs.rmSync(dir, { recursive: true, force: true });
      this.records.delete(credentialId);
      throw err;
    }
  }

  createOAuthSlot(): OAuthSlot {
    const credentialId = crypto.randomUUID();
    const dir = path.join(this.credentialsRoot, credentialId);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    return { credential_id: credentialId, codex_home: dir };
  }

  async completeOAuth(args: {
    slot: OAuthSlot;
    credential_label: string;
    owner_caller_id: string;
  }): Promise<string> {
    const authPath = path.join(args.slot.codex_home, "auth.json");
    if (!fs.existsSync(authPath)) {
      throw new Error(`auth.json missing in slot ${args.slot.credential_id}`);
    }
    JSON.parse(fs.readFileSync(authPath, "utf8")); // throws on malformed

    const rec: CredentialRecord = {
      credential_id: args.slot.credential_id,
      credential_label: args.credential_label,
      provider: "codex",
      kind: "oauth",
      owner_caller_id: args.owner_caller_id,
      codex_home_path: args.slot.codex_home,
      is_default: false,
      created_at: new Date().toISOString(),
      last_used_at: null,
      revoked_at: null,
      api_key_metadata: null
    };
    this.records.set(rec.credential_id, rec);
    await this.onChange(this.list());
    return rec.credential_id;
  }

  abandonOAuthSlot(slot: OAuthSlot): void {
    fs.rmSync(slot.codex_home, { recursive: true, force: true });
  }

  async revoke(credentialId: string): Promise<void> {
    const rec = this.records.get(credentialId);
    if (!rec) throw new CredentialNotFoundError(credentialId);
    fs.rmSync(rec.codex_home_path, { recursive: true, force: true });
    rec.revoked_at = new Date().toISOString();
    await this.onChange(this.list());
  }

  async update(
    credentialId: string,
    patch: {
      credential_label?: string;
      base_url?: string;
      model_id?: string;
      env_var?: string;
      key_value?: string;
    }
  ): Promise<void> {
    const rec = this.records.get(credentialId);
    if (!rec) throw new CredentialNotFoundError(credentialId);
    if (rec.revoked_at) throw new CredentialRevokedError(credentialId);

    const FORBIDDEN = [
      "credential_id",
      "owner_caller_id",
      "kind",
      "provider",
      "created_at",
      "revoked_at",
      "is_default",
      "api_key_metadata",
      "codex_home_path",
      "last_used_at"
    ];
    for (const k of Object.keys(patch)) {
      if (FORBIDDEN.includes(k)) {
        throw new Error(`field ${k} is immutable`);
      }
    }

    const isApiKeyChange =
      patch.base_url !== undefined ||
      patch.model_id !== undefined ||
      patch.env_var !== undefined ||
      patch.key_value !== undefined;
    if (isApiKeyChange && rec.kind !== "api_key") {
      throw new Error(`cannot modify api_key fields on a ${rec.kind} credential`);
    }

    if (patch.credential_label !== undefined) {
      rec.credential_label = patch.credential_label;
    }

    if (rec.kind === "api_key" && rec.api_key_metadata) {
      const merged = {
        base_url: patch.base_url ?? rec.api_key_metadata.base_url,
        model_id: patch.model_id ?? rec.api_key_metadata.model_id,
        env_var: patch.env_var ?? rec.api_key_metadata.env_var
      };

      if (
        patch.base_url !== undefined ||
        patch.model_id !== undefined ||
        patch.env_var !== undefined
      ) {
        const toml = this.generateApiKeyConfigToml(merged);
        const tmp = path.join(rec.codex_home_path, "config.toml.tmp");
        fs.writeFileSync(tmp, toml, { mode: 0o600 });
        fs.renameSync(tmp, path.join(rec.codex_home_path, "config.toml"));
        rec.api_key_metadata = merged;
      }

      if (patch.key_value !== undefined) {
        const envJsonPath = path.join(rec.codex_home_path, "env.json");
        const envVarName = merged.env_var;
        const tmp = path.join(rec.codex_home_path, "env.json.tmp");
        fs.writeFileSync(
          tmp,
          JSON.stringify({ [envVarName]: patch.key_value }),
          { mode: 0o600 }
        );
        fs.renameSync(tmp, envJsonPath);
      }
    }

    await this.onChange(this.list());
  }

  async setDefault(credentialId: string): Promise<void> {
    const rec = this.records.get(credentialId);
    if (!rec) throw new CredentialNotFoundError(credentialId);
    if (rec.revoked_at) throw new CredentialRevokedError(credentialId);
    for (const r of this.records.values()) {
      if (r.owner_caller_id === rec.owner_caller_id) {
        r.is_default = r.credential_id === credentialId;
      }
    }
    await this.onChange(this.list());
  }

  reconcile(): void {
    if (!fs.existsSync(this.credentialsRoot)) return;
    const onDisk = fs.readdirSync(this.credentialsRoot);
    for (const name of onDisk) {
      if (!this.records.has(name)) {
        fs.rmSync(path.join(this.credentialsRoot, name), { recursive: true, force: true });
      }
    }
  }

  private generateApiKeyConfigToml(args: {
    base_url: string;
    model_id: string;
    env_var: string;
  }): string {
    const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    return [
      `model = "${esc(args.model_id)}"`,
      `model_provider = "meridian-managed"`,
      ``,
      `[model_providers.meridian-managed]`,
      `name = "meridian-managed"`,
      `base_url = "${esc(args.base_url)}"`,
      `wire_api = "chat"`,
      `env_key = "${esc(args.env_var)}"`,
      ``
    ].join("\n");
  }
}
