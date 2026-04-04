import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import test from "node:test";

type StorageState = Record<string, string>;

type BrowserHarnessOptions = {
  pathname?: string;
  search?: string;
  sessionStorageThrows?: boolean;
};

function createStorage(state: StorageState, shouldThrow: boolean) {
  return {
    getItem(key: string): string | null {
      if (shouldThrow) {
        throw new Error("storage unavailable");
      }
      return Object.prototype.hasOwnProperty.call(state, key) ? state[key] : null;
    },
    setItem(key: string, value: string): void {
      if (shouldThrow) {
        throw new Error("storage unavailable");
      }
      state[key] = String(value);
    },
    removeItem(key: string): void {
      if (shouldThrow) {
        throw new Error("storage unavailable");
      }
      delete state[key];
    }
  };
}

function createHarness(options: BrowserHarnessOptions = {}) {
  const source = fs.readFileSync(path.resolve(__dirname, "public", "app.js"), "utf8");
  const storageState: StorageState = {};
  const replaceStateCalls: string[] = [];
  const location = {
    origin: "http://127.0.0.1:3000",
    pathname: options.pathname ?? "/",
    search: options.search ?? ""
  };
  const sessionStorage = createStorage(storageState, Boolean(options.sessionStorageThrows));
  const localStorage = createStorage({}, false);
  const history = {
    replaceState(_state: unknown, _title: string, url: string) {
      replaceStateCalls.push(url);
      const parsed = new URL(url, location.origin);
      location.pathname = parsed.pathname;
      location.search = parsed.search;
    }
  };
  const window = {
    location,
    history
  } as Record<string, unknown>;

  const context = {
    URL,
    console,
    fetch: () => Promise.resolve({}),
    sessionStorage,
    localStorage,
    window
  };
  window.window = window;

  vm.runInNewContext(source, context, { filename: "app.js" });

  return {
    location,
    replaceStateCalls,
    storageState,
    meridianWeb: window.MeridianWeb as {
      getToken: () => string;
    }
  };
}

test("hub auth strips token from the URL after persisting it to session storage", () => {
  const harness = createHarness({
    pathname: "/",
    search: "?thread_id=codex_01&token=secret-token"
  });

  assert.equal(harness.storageState.meridian_web_token, "secret-token");
  assert.equal(harness.location.search, "?thread_id=codex_01");
  assert.deepEqual(harness.replaceStateCalls, ["/?thread_id=codex_01"]);
  assert.equal(harness.meridianWeb.getToken(), "secret-token");
});

test("hub auth keeps the token in the URL when session storage is unavailable", () => {
  const harness = createHarness({
    pathname: "/",
    search: "?thread_id=codex_01&token=secret-token",
    sessionStorageThrows: true
  });

  assert.equal(harness.location.search, "?thread_id=codex_01&token=secret-token");
  assert.deepEqual(harness.replaceStateCalls, []);
  assert.equal(harness.meridianWeb.getToken(), "secret-token");
});
