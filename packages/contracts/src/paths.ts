import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface MeridianPaths {
  configDir: string;
  dataDir: string;
  stateDir: string;
  runtimeDir: string;
  logDir: string;
  socketDir: string;
  runtimeDescriptorDir: string;
  workRoot: string;
  taskSpecRoot?: string;
  docsRoot?: string;
  hubSocketPath: string;
  hubStatePath: string;
}

export type MeridianPathOverrides = Partial<MeridianPaths>;

export interface PathResolverOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  tempDir?: string;
  uid?: number | string;
  cwd?: string;
  overrides?: MeridianPathOverrides;
  userConfig?: MeridianPathOverrides;
}

type RequiredPathKey = Exclude<keyof MeridianPaths, "taskSpecRoot" | "docsRoot">;

const ENV_BY_KEY: Record<keyof MeridianPaths, string> = {
  configDir: "MERIDIAN_CONFIG_DIR",
  dataDir: "MERIDIAN_DATA_DIR",
  stateDir: "MERIDIAN_STATE_DIR",
  runtimeDir: "MERIDIAN_RUNTIME_DIR",
  logDir: "MERIDIAN_LOG_DIR",
  socketDir: "MERIDIAN_SOCKET_DIR",
  runtimeDescriptorDir: "MERIDIAN_RUNTIME_DESCRIPTOR_DIR",
  workRoot: "MERIDIAN_WORK_ROOT",
  taskSpecRoot: "MERIDIAN_TASKSPEC_ROOT",
  docsRoot: "MERIDIAN_DOCS_ROOT",
  hubSocketPath: "MERIDIAN_HUB_SOCKET_PATH",
  hubStatePath: "MERIDIAN_STATE_PATH"
};

/**
 * Resolves every Meridian-owned filesystem location without consulting the
 * repository layout. Priority is explicit override, environment, user config,
 * then the platform default.
 */
export class PathResolver {
  private readonly platform: NodeJS.Platform;
  private readonly env: NodeJS.ProcessEnv;
  private readonly homeDir: string;
  private readonly tempDir: string;
  private readonly uid: string;
  private readonly overrides: MeridianPathOverrides;
  private readonly userConfig: MeridianPathOverrides;

  constructor(options: PathResolverOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.env = options.env ?? process.env;
    this.homeDir = validateAbsolutePath(options.homeDir ?? this.env.HOME ?? os.homedir(), "homeDir");
    this.tempDir = validateAbsolutePath(options.tempDir ?? os.tmpdir(), "tempDir");
    this.uid = String(options.uid ?? process.getuid?.() ?? "user");
    this.overrides = options.overrides ?? {};
    this.userConfig = options.userConfig ?? {};
  }

  resolve(): MeridianPaths {
    const defaults = this.platformDefaults();
    const configDir = this.required("configDir", defaults.configDir);
    const dataDir = this.required("dataDir", defaults.dataDir);
    const stateDir = this.required("stateDir", defaults.stateDir);
    const runtimeDir = this.required("runtimeDir", defaults.runtimeDir);
    const logDir = this.required("logDir", path.join(stateDir, "logs"));
    const socketDir = this.required("socketDir", path.join(runtimeDir, "sockets"));
    const runtimeDescriptorDir = this.required(
      "runtimeDescriptorDir",
      path.join(runtimeDir, "services")
    );
    const workRoot = this.required("workRoot", this.homeDir);
    const taskSpecRoot = this.optional("taskSpecRoot");
    const docsRoot = this.optional("docsRoot");
    const hubSocketPath = this.required(
      "hubSocketPath",
      this.env.HUB_SOCKET_PATH ?? path.join(socketDir, "hub-core.sock")
    );
    const hubStatePath = this.required("hubStatePath", path.join(stateDir, "hub-state.json"));

    return {
      configDir,
      dataDir,
      stateDir,
      runtimeDir,
      logDir,
      socketDir,
      runtimeDescriptorDir,
      workRoot,
      ...(taskSpecRoot ? { taskSpecRoot } : {}),
      ...(docsRoot ? { docsRoot } : {}),
      hubSocketPath,
      hubStatePath
    };
  }

  ensurePrivateDirectories(paths: MeridianPaths = this.resolve()): void {
    const directories = [
      paths.configDir,
      paths.dataDir,
      paths.stateDir,
      paths.runtimeDir,
      paths.logDir,
      paths.socketDir,
      paths.runtimeDescriptorDir
    ];
    for (const directory of directories) {
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      if (this.platform !== "win32") {
        fs.chmodSync(directory, 0o700);
      }
    }
  }

  private required(key: RequiredPathKey, fallback: string): string {
    return this.resolveValue(key, fallback, true) as string;
  }

  private optional(key: "taskSpecRoot" | "docsRoot"): string | undefined {
    return this.resolveValue(key, undefined, false);
  }

  private resolveValue(
    key: keyof MeridianPaths,
    fallback: string | undefined,
    required: boolean
  ): string | undefined {
    const envName = ENV_BY_KEY[key];
    const candidate =
      this.overrides[key] ??
      nonEmpty(this.env[envName]) ??
      this.userConfig[key] ??
      fallback;
    if (candidate === undefined) {
      if (required) {
        throw new Error(`${envName} is required`);
      }
      return undefined;
    }
    return validateAbsolutePath(candidate, this.sourceLabel(key));
  }

  private sourceLabel(key: keyof MeridianPaths): string {
    if (this.overrides[key] !== undefined) {
      return `explicit ${key}`;
    }
    const envName = ENV_BY_KEY[key];
    if (nonEmpty(this.env[envName]) !== undefined) {
      return envName;
    }
    if (this.userConfig[key] !== undefined) {
      return `user config ${key}`;
    }
    return key;
  }

  private platformDefaults(): Pick<MeridianPaths, "configDir" | "dataDir" | "stateDir" | "runtimeDir"> {
    if (this.platform === "darwin") {
      const applicationSupport = path.join(
        this.homeDir,
        "Library",
        "Application Support",
        "Meridian"
      );
      return {
        configDir: path.join(applicationSupport, "config"),
        dataDir: path.join(applicationSupport, "data"),
        stateDir: path.join(applicationSupport, "state"),
        runtimeDir: path.join(this.tempDir, `meridian-${this.uid}`)
      };
    }

    if (this.platform === "win32") {
      const appData = nonEmpty(this.env.APPDATA) ?? path.join(this.homeDir, "AppData", "Roaming");
      const localAppData =
        nonEmpty(this.env.LOCALAPPDATA) ?? path.join(this.homeDir, "AppData", "Local");
      return {
        configDir: path.join(appData, "Meridian", "config"),
        dataDir: path.join(localAppData, "Meridian", "data"),
        stateDir: path.join(localAppData, "Meridian", "state"),
        runtimeDir: path.join(this.tempDir, `meridian-${this.uid}`)
      };
    }

    const configRoot = nonEmpty(this.env.XDG_CONFIG_HOME) ?? path.join(this.homeDir, ".config");
    const dataRoot = nonEmpty(this.env.XDG_DATA_HOME) ?? path.join(this.homeDir, ".local", "share");
    const stateRoot = nonEmpty(this.env.XDG_STATE_HOME) ?? path.join(this.homeDir, ".local", "state");
    const xdgRuntimeRoot = nonEmpty(this.env.XDG_RUNTIME_DIR);
    return {
      configDir: path.join(configRoot, "meridian"),
      dataDir: path.join(dataRoot, "meridian"),
      stateDir: path.join(stateRoot, "meridian"),
      runtimeDir: xdgRuntimeRoot
        ? path.join(xdgRuntimeRoot, "meridian")
        : path.join(this.tempDir, `meridian-${this.uid}`)
    };
  }
}

export function resolveMeridianPaths(options: PathResolverOptions = {}): MeridianPaths {
  return new PathResolver(options).resolve();
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function validateAbsolutePath(value: string, label: string): string {
  if (value.includes("\u0000")) {
    throw new Error(`${label} contains a NUL byte`);
  }
  const trimmed = value.trim();
  if (!trimmed || !path.isAbsolute(trimmed)) {
    throw new Error(`${label} must be an absolute path`);
  }
  return path.normalize(trimmed);
}
