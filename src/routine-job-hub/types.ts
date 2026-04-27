export interface HubEntry {
  id: string;
  name: string;
  url: string;
  health_path: string;
  description?: string;
}

export type HubProbeStatus = "up" | "down" | "disabled";

export interface ProbedHubEntry extends HubEntry {
  status: HubProbeStatus;
  health_url?: string;
  status_code?: number;
  status_message?: string;
}

export interface HubRegistryResult {
  entries: HubEntry[];
  sourcePath: string | null;
  expectedPaths: string[];
  missing?: boolean;
  error?: string;
}
