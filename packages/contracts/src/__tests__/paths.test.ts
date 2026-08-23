import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { PathResolver } from "../paths";

test("resolves macOS paths without depending on the repository cwd", () => {
  const paths = new PathResolver({
    platform: "darwin",
    homeDir: "/Users/tester",
    tempDir: "/private/tmp",
    uid: 501,
    cwd: "/checkout/meridian"
  }).resolve();

  const applicationSupport = "/Users/tester/Library/Application Support/Meridian";
  assert.equal(paths.configDir, path.join(applicationSupport, "config"));
  assert.equal(paths.dataDir, path.join(applicationSupport, "data"));
  assert.equal(paths.stateDir, path.join(applicationSupport, "state"));
  assert.equal(paths.logDir, path.join(applicationSupport, "state", "logs"));
  assert.equal(paths.runtimeDir, "/private/tmp/meridian-501");
  assert.equal(paths.socketDir, "/private/tmp/meridian-501/sockets");
  assert.equal(paths.runtimeDescriptorDir, "/private/tmp/meridian-501/services");
  assert.equal(
    paths.serviceDeclarationDir,
    "/Users/tester/Library/Application Support/Meridian/data/services/declarations"
  );
  assert.equal(paths.workRoot, "/Users/tester");
  assert.equal(paths.taskSpecRoot, undefined);
  assert.equal(paths.docsRoot, undefined);
});

test("resolves Linux defaults from HOME and the temporary directory", () => {
  const paths = new PathResolver({
    platform: "linux",
    homeDir: "/home/tester",
    tempDir: "/tmp",
    uid: 1000,
    env: {}
  }).resolve();

  assert.equal(paths.configDir, "/home/tester/.config/meridian");
  assert.equal(paths.dataDir, "/home/tester/.local/share/meridian");
  assert.equal(paths.stateDir, "/home/tester/.local/state/meridian");
  assert.equal(paths.runtimeDir, "/tmp/meridian-1000");
});

test("honors XDG roots and scopes the runtime directory to Meridian", () => {
  const paths = new PathResolver({
    platform: "linux",
    homeDir: "/home/tester",
    tempDir: "/tmp",
    uid: 1000,
    env: {
      XDG_CONFIG_HOME: "/xdg/config",
      XDG_DATA_HOME: "/xdg/data",
      XDG_STATE_HOME: "/xdg/state",
      XDG_RUNTIME_DIR: "/run/user/1000"
    }
  }).resolve();

  assert.equal(paths.configDir, "/xdg/config/meridian");
  assert.equal(paths.dataDir, "/xdg/data/meridian");
  assert.equal(paths.stateDir, "/xdg/state/meridian");
  assert.equal(paths.runtimeDir, "/run/user/1000/meridian");
});

test("explicit Meridian environment paths override all platform defaults", () => {
  const paths = new PathResolver({
    platform: "linux",
    homeDir: "/home/tester",
    tempDir: "/tmp",
    uid: 1000,
    env: {
      MERIDIAN_CONFIG_DIR: "/opt/meridian/config",
      MERIDIAN_DATA_DIR: "/opt/meridian/data",
      MERIDIAN_STATE_DIR: "/opt/meridian/state",
      MERIDIAN_RUNTIME_DIR: "/run/meridian",
      MERIDIAN_LOG_DIR: "/var/log/meridian",
      MERIDIAN_SOCKET_DIR: "/run/meridian-sockets",
      MERIDIAN_RUNTIME_DESCRIPTOR_DIR: "/run/meridian-services",
      MERIDIAN_SERVICE_DECLARATION_DIR: "/opt/meridian/declarations",
      MERIDIAN_WORK_ROOT: "/work",
      MERIDIAN_TASKSPEC_ROOT: "/specs",
      MERIDIAN_DOCS_ROOT: "/docs",
      MERIDIAN_HUB_SOCKET_PATH: "/run/meridian-hub.sock",
      MERIDIAN_STATE_PATH: "/var/lib/meridian/hub.json"
    }
  }).resolve();

  assert.deepEqual(paths, {
    configDir: "/opt/meridian/config",
    dataDir: "/opt/meridian/data",
    stateDir: "/opt/meridian/state",
    runtimeDir: "/run/meridian",
    logDir: "/var/log/meridian",
    socketDir: "/run/meridian-sockets",
    runtimeDescriptorDir: "/run/meridian-services",
    serviceDeclarationDir: "/opt/meridian/declarations",
    workRoot: "/work",
    taskSpecRoot: "/specs",
    docsRoot: "/docs",
    hubSocketPath: "/run/meridian-hub.sock",
    hubStatePath: "/var/lib/meridian/hub.json"
  });
});

test("temporary HOME changes defaults while cwd remains irrelevant", () => {
  const first = new PathResolver({
    platform: "linux",
    homeDir: "/tmp/home-a",
    tempDir: "/tmp",
    uid: 123,
    cwd: "/repo-a",
    env: {}
  }).resolve();
  const second = new PathResolver({
    platform: "linux",
    homeDir: "/tmp/home-b",
    tempDir: "/tmp",
    uid: 123,
    cwd: "/repo-b",
    env: {}
  }).resolve();

  assert.equal(first.stateDir, "/tmp/home-a/.local/state/meridian");
  assert.equal(second.stateDir, "/tmp/home-b/.local/state/meridian");
  assert.equal(first.runtimeDir, second.runtimeDir);
});

test("rejects relative, empty-home, and NUL-containing path inputs", () => {
  assert.throws(
    () =>
      new PathResolver({
        platform: "linux",
        homeDir: "/home/tester",
        tempDir: "/tmp",
        uid: 1000,
        env: { MERIDIAN_STATE_DIR: "relative/state" }
      }).resolve(),
    /MERIDIAN_STATE_DIR must be an absolute path/
  );
  assert.throws(
    () =>
      new PathResolver({
        platform: "linux",
        homeDir: "",
        tempDir: "/tmp",
        uid: 1000,
        env: {}
      }).resolve(),
    /homeDir must be an absolute path/
  );
  assert.throws(
    () =>
      new PathResolver({
        platform: "linux",
        homeDir: "/home/tester",
        tempDir: "/tmp",
        uid: 1000,
        env: { MERIDIAN_LOG_DIR: "/tmp/bad\u0000path" }
      }).resolve(),
    /MERIDIAN_LOG_DIR contains a NUL byte/
  );
});

test("explicit overrides beat environment and user config, and private directories use 0700", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "meridian-paths-"));
  try {
    const resolver = new PathResolver({
      platform: "linux",
      homeDir: path.join(root, "home"),
      tempDir: path.join(root, "tmp"),
      uid: 1000,
      env: { MERIDIAN_STATE_DIR: path.join(root, "env-state") },
      userConfig: { stateDir: path.join(root, "config-state") },
      overrides: { stateDir: path.join(root, "explicit-state") }
    });
    const paths = resolver.resolve();

    assert.equal(paths.stateDir, path.join(root, "explicit-state"));
    resolver.ensurePrivateDirectories(paths);
    assert.equal(fs.statSync(paths.stateDir).mode & 0o777, 0o700);
    assert.equal(fs.statSync(paths.runtimeDescriptorDir).mode & 0o777, 0o700);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
