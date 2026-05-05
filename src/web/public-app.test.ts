import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import test from "node:test";

type MeridianWebFull = {
  getToken: () => string;
  loadCallers: () => Promise<unknown>;
  mintCaller: (id: string, label: string) => Promise<unknown>;
  rotateCaller: (id: string) => Promise<unknown>;
  revokeCaller: (id: string) => Promise<unknown>;
};

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

test("hub auth preserves the query token while persisting it to session storage", () => {
  const harness = createHarness({
    pathname: "/",
    search: "?thread_id=codex_01&token=secret-token"
  });

  assert.equal(harness.storageState.meridian_web_token, "secret-token");
  assert.equal(harness.location.search, "?thread_id=codex_01&token=secret-token");
  assert.deepEqual(harness.replaceStateCalls, []);
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

// Caller registry helpers — app.js N-05

type CapturedRequest = { url: string; method: string; headers: Record<string, string>; body?: string };

function createCallerApiHarness(token: string): {
  mw: MeridianWebFull;
  captured: CapturedRequest[];
  respondWith: (body: unknown, ok?: boolean, status?: number) => void;
} {
  const source = fs.readFileSync(path.resolve(__dirname, "public", "app.js"), "utf8");
  const captured: CapturedRequest[] = [];
  let nextResponse: { body: unknown; ok: boolean; status: number } = { body: {}, ok: true, status: 200 };

  const mockFetch = (url: string, opts?: RequestInit) => {
    const headers = (opts?.headers as Record<string, string>) ?? {};
    captured.push({ url, method: opts?.method ?? "GET", headers, body: opts?.body as string | undefined });
    const snap = nextResponse;
    return Promise.resolve({
      ok: snap.ok,
      status: snap.status,
      json: () => Promise.resolve(snap.body)
    });
  };

  const storageState: StorageState = {};
  const location = { origin: "http://127.0.0.1:3000", pathname: "/", search: `?token=${token}` };
  const sessionStorage = createStorage(storageState, false);
  const localStorage = createStorage({}, false);
  const window = { location } as Record<string, unknown>;
  window.window = window;

  const context = { URL, console, fetch: mockFetch, sessionStorage, localStorage, window };
  vm.runInNewContext(source, context, { filename: "app.js" });

  return {
    mw: window.MeridianWeb as MeridianWebFull,
    captured,
    respondWith(body, ok = true, status = 200) {
      nextResponse = { body, ok, status };
    }
  };
}

test("MeridianWeb exposes loadCallers, mintCaller, rotateCaller, revokeCaller", () => {
  const { mw } = createCallerApiHarness("tok");
  assert.equal(typeof mw.loadCallers, "function");
  assert.equal(typeof mw.mintCaller, "function");
  assert.equal(typeof mw.rotateCaller, "function");
  assert.equal(typeof mw.revokeCaller, "function");
});

test("loadCallers makes an authenticated GET to /api/callers", async () => {
  const { mw, captured } = createCallerApiHarness("mytoken");
  await mw.loadCallers();
  assert.equal(captured.length, 1);
  assert.match(captured[0]!.url, /\/api\/callers$/);
  assert.equal(captured[0]!.method, "GET");
  assert.equal(captured[0]!.headers["Authorization"], "Bearer mytoken");
});

test("mintCaller posts to /api/callers with authenticated JSON body", async () => {
  const { mw, captured } = createCallerApiHarness("mytoken");
  await mw.mintCaller("my-service", "My Service");
  assert.equal(captured.length, 1);
  assert.match(captured[0]!.url, /\/api\/callers$/);
  assert.equal(captured[0]!.method, "POST");
  assert.equal(captured[0]!.headers["Authorization"], "Bearer mytoken");
  const sent = JSON.parse(captured[0]!.body ?? "{}");
  assert.equal(sent.caller_id, "my-service");
  assert.equal(sent.caller_label, "My Service");
});

test("rotateCaller posts to /api/callers/:id/rotate with auth header", async () => {
  const { mw, captured } = createCallerApiHarness("mytoken");
  await mw.rotateCaller("my-service");
  assert.equal(captured.length, 1);
  assert.match(captured[0]!.url, /\/api\/callers\/my-service\/rotate$/);
  assert.equal(captured[0]!.method, "POST");
  assert.equal(captured[0]!.headers["Authorization"], "Bearer mytoken");
});

test("revokeCaller sends DELETE to /api/callers/:id with auth header", async () => {
  const { mw, captured } = createCallerApiHarness("mytoken");
  await mw.revokeCaller("my-service");
  assert.equal(captured.length, 1);
  assert.match(captured[0]!.url, /\/api\/callers\/my-service$/);
  assert.equal(captured[0]!.method, "DELETE");
  assert.equal(captured[0]!.headers["Authorization"], "Bearer mytoken");
});

test("loadCallers rejects with server error message on non-ok response", async () => {
  const { mw, respondWith } = createCallerApiHarness("mytoken");
  respondWith({ error: "forbidden" }, false, 403);
  await assert.rejects(mw.loadCallers(), /forbidden/);
});
