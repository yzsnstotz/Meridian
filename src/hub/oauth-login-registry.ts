import crypto from "node:crypto";
import { OAuthLoginJob, OAuthLoginJobOptions, OAuthLoginStatus } from "./oauth-login-job";

export class OAuthLoginCapExceededError extends Error {
  constructor(public readonly caller_id: string) {
    super(`OAuth login cap exceeded for caller ${caller_id}`);
    this.name = "OAuthLoginCapExceededError";
  }
}

const IN_FLIGHT: OAuthLoginStatus[] = ["pending", "awaiting_browser"];

export class OAuthLoginJobRegistry {
  private jobs = new Map<string, OAuthLoginJob>();
  private idsByCaller = new Map<string, Set<string>>();
  private readonly perCallerCap = 3;

  start(callerId: string, opts: OAuthLoginJobOptions): { job_id: string; job: OAuthLoginJob } {
    const inflightIds = this.idsByCaller.get(callerId) ?? new Set<string>();
    const liveCount = Array.from(inflightIds).filter((id) => {
      const j = this.jobs.get(id);
      return j && IN_FLIGHT.includes(j.status);
    }).length;

    if (liveCount >= this.perCallerCap) throw new OAuthLoginCapExceededError(callerId);

    const jobId = crypto.randomUUID();
    const job = new OAuthLoginJob(opts);
    this.jobs.set(jobId, job);
    inflightIds.add(jobId);
    this.idsByCaller.set(callerId, inflightIds);
    job.start().catch(() => {});
    return { job_id: jobId, job };
  }

  get(jobId: string): OAuthLoginJob | undefined {
    return this.jobs.get(jobId);
  }

  async cancel(jobId: string): Promise<void> {
    await this.jobs.get(jobId)?.cancel();
  }
}
