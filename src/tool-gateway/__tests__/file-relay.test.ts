import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { resolveRelayDir } from "../file-relay";

const originalRelayDir = process.env.MERIDIAN_FILE_RELAY_DIR;
const originalHubSocketPath = process.env.HUB_SOCKET_PATH;

afterEach(() => {
  if (originalRelayDir === undefined) {
    delete process.env.MERIDIAN_FILE_RELAY_DIR;
  } else {
    process.env.MERIDIAN_FILE_RELAY_DIR = originalRelayDir;
  }

  if (originalHubSocketPath === undefined) {
    delete process.env.HUB_SOCKET_PATH;
  } else {
    process.env.HUB_SOCKET_PATH = originalHubSocketPath;
  }
});

describe("resolveRelayDir", () => {
  it("honors MERIDIAN_FILE_RELAY_DIR when provided", () => {
    process.env.MERIDIAN_FILE_RELAY_DIR = "/tmp/custom-relay";

    expect(resolveRelayDir()).toBe("/tmp/custom-relay");
  });

  it("derives a shared temp relay directory from the hub socket path", () => {
    delete process.env.MERIDIAN_FILE_RELAY_DIR;
    process.env.HUB_SOCKET_PATH = "/tmp/hub-socks/hub-a.sock";
    const relayDirA = resolveRelayDir();

    process.env.HUB_SOCKET_PATH = "/tmp/hub-socks/hub-b.sock";
    const relayDirB = resolveRelayDir();

    expect(path.dirname(relayDirA)).toBe(path.resolve(os.tmpdir()));
    expect(path.basename(relayDirA)).toMatch(/^hub-relay-[0-9a-f]{12}$/);
    expect(relayDirA).not.toBe(relayDirB);
  });
});
