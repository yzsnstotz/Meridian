import type { CredentialRecord } from "./state-store";

export interface CredentialStoreOptions {
  initialRecords: CredentialRecord[];
  credentialsRoot: string;
  onChange?: (records: CredentialRecord[]) => Promise<void> | void;
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
}
