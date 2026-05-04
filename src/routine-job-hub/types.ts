export interface HubEntry {
  id: string;
  name: string;
  url: string;
  health_path: string;
  description?: string;
  public_url?: string;
  gui_port?: number;
  action_label?: string;
  restart_script?: string;
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

export interface HubRestartResult {
  id: string;
  status: "ok" | "failed" | "rejected";
  exit_code: number | null;
  duration_ms: number;
  stdout: string;
  stderr: string;
  error?: string;
}
