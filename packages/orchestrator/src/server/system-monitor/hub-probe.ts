import net from "node:net";
import { performance } from "node:perf_hooks";

export interface HubProbeResult {
  reachable: boolean;
  latency_ms: number | null;
  error?: string;
}

export function probeHubSocket(socketPath: string, timeoutMs = 1_000): Promise<HubProbeResult> {
  const startedAt = performance.now();

  return new Promise((resolve) => {
    const socket = net.createConnection(socketPath);
    let settled = false;

    const finish = (result: HubProbeResult) => {
      if (settled) {
        return;
      }
      settled = true;
      socket.removeAllListeners();
      socket.destroy();
      resolve(result);
    };

    socket.setTimeout(timeoutMs);
    socket.once("connect", () => {
      finish({
        reachable: true,
        latency_ms: Math.max(0, Math.round(performance.now() - startedAt))
      });
    });
    socket.once("timeout", () => {
      finish({ reachable: false, latency_ms: null, error: "timeout" });
    });
    socket.once("error", (error) => {
      finish({ reachable: false, latency_ms: null, error: error.message });
    });
  });
}
