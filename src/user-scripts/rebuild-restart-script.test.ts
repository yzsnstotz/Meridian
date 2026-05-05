import fs from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

describe("user_scripts/rebuild_restart.sh", () => {
  it("exports and health-checks the Meridian Hub socket before declaring roles healthy", async () => {
    const script = await fs.readFile(path.resolve(__dirname, "../../user_scripts/rebuild_restart.sh"), "utf8");

    expect(script).toContain('HUB_SOCKET_PATH="${HUB_SOCKET_PATH:-/tmp/hub-core.sock}"');
    expect(script).toContain("export HUB_SOCKET_PATH");
    expect(script).toContain("hub_socket_reachable");
    expect(script).toContain("ensure_meridian_hub_socket");
    expect(script).toContain('if hub_socket_reachable; then');
    expect(script).toContain("HUB_SOCKET_PATH=$(shell_escape");
  });
});
