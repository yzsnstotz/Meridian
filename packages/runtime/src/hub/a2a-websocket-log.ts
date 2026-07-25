import fs from "node:fs";
import path from "node:path";

/**
 * Append one JSON line (same payload string as sent on the terminal WebSocket) to
 * LOG_DIR/GUI/a2a-{threadId}.log for auditing and GUI log inventory.
 */
export function appendA2AWebSocketLog(logDir: string, threadId: string, payloadJsonLine: string): void {
  if (!threadId.trim() || !payloadJsonLine) {
    return;
  }
  try {
    const guiLogDir = path.join(logDir, "GUI");
    fs.mkdirSync(guiLogDir, { recursive: true });
    const logPath = path.join(guiLogDir, `a2a-${threadId}.log`);
    fs.appendFileSync(logPath, `${payloadJsonLine}\n`, "utf8");
  } catch {
    // Do not fail Hub dispatch on log write errors (e.g. disk full, permissions).
  }
}
