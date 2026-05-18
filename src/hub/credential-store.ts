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

export class CredentialStore {
  private readonly records: Map<string, CredentialRecord>;
  private readonly credentialsRoot: string;
  private readonly onChange: (records: CredentialRecord[]) => Promise<void> | void;

  constructor(opts: CredentialStoreOptions) {
    this.records = new Map(opts.initialRecords.map((r) => [r.credential_id, r]));
    this.credentialsRoot = opts.credentialsRoot;
    this.onChange = opts.onChange ?? (() => {});
  }

  list(): CredentialRecord[] {
    return Array.from(this.records.values());
  }

  get(credentialId: string): CredentialRecord | undefined {
    return this.records.get(credentialId);
  }

  resolve(
    credentialId: string | null | undefined,
    caller: CallerIdentity
  ): ResolvedCredential | null {
    if (!credentialId) return null;
    const rec = this.records.get(credentialId);
    if (!rec) throw new CredentialNotFoundError(credentialId);
    if (rec.revoked_at) throw new CredentialRevokedError(credentialId);
    const isOwner = rec.owner_caller_id === caller.caller_id;
    const isAdmin = caller.caller_authority === "admin";
    if (!isOwner && !isAdmin) {
      throw new CredentialForbiddenError(credentialId, caller.caller_id);
    }
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
