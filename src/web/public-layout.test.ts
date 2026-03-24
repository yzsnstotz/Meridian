import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

const publicDir = path.resolve(__dirname, "public");
const terminalHtmlPath = path.join(publicDir, "terminal.html");

async function readTerminalHtml(): Promise<string> {
  return fs.promises.readFile(terminalHtmlPath, "utf8");
}

function extractFunctionSource(source: string, name: string): string {
  const marker = `function ${name}(`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `Expected terminal.html to define ${name}()`);

  const bodyStart = source.indexOf("{", start);
  assert.notEqual(bodyStart, -1, `Expected terminal.html to include a body for ${name}()`);

  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  let inTemplate = false;
  let inLineComment = false;
  let inBlockComment = false;
  let escaped = false;

  for (let index = bodyStart; index < source.length; index++) {
    const char = source[index];
    const next = source[index + 1] ?? "";

    if (inLineComment) {
      if (char === "\n") {
        inLineComment = false;
      }
      continue;
    }

    if (inBlockComment) {
      if (char === "*" && next === "/") {
        inBlockComment = false;
        index++;
      }
      continue;
    }

    if (inSingle) {
      if (!escaped && char === "'") {
        inSingle = false;
      }
      escaped = !escaped && char === "\\";
      continue;
    }

    if (inDouble) {
      if (!escaped && char === "\"") {
        inDouble = false;
      }
      escaped = !escaped && char === "\\";
      continue;
    }

    if (inTemplate) {
      if (!escaped && char === "`") {
        inTemplate = false;
      }
      escaped = !escaped && char === "\\";
      continue;
    }

    escaped = false;

    if (char === "/" && next === "/") {
      inLineComment = true;
      index++;
      continue;
    }

    if (char === "/" && next === "*") {
      inBlockComment = true;
      index++;
      continue;
    }

    if (char === "'") {
      inSingle = true;
      continue;
    }

    if (char === "\"") {
      inDouble = true;
      continue;
    }

    if (char === "`") {
      inTemplate = true;
      continue;
    }

    if (char === "{") {
      depth++;
      continue;
    }

    if (char === "}") {
      depth--;
      if (depth === 0) {
        return source.slice(start, index + 1);
      }
    }
  }

  throw new Error(`Failed to extract ${name}() from terminal.html`);
}

function bindTerminalFunctions(html: string, context: Record<string, unknown>, names: string[]): void {
  const functionSources = names.map((name) => extractFunctionSource(html, name)).join("\n\n");
  const attachSource = names.map((name) => `context.${name} = ${name};`).join("\n");
  const factory = new Function(
    "context",
    `
      with (context) {
        ${functionSources}
        ${attachSource}
      }
    `
  ) as (context: Record<string, unknown>) => void;
  factory(context);
}

class FakeClassList {
  private readonly tokens = new Set<string>();

  constructor(private readonly owner: FakeElement) {}

  replaceFromString(value: string): void {
    this.tokens.clear();
    for (const token of value.split(/\s+/).filter(Boolean)) {
      this.tokens.add(token);
    }
  }

  add(...values: string[]): void {
    for (const value of values) {
      if (value) {
        this.tokens.add(value);
      }
    }
    this.owner.syncClassName(this.toString());
  }

  remove(...values: string[]): void {
    for (const value of values) {
      this.tokens.delete(value);
    }
    this.owner.syncClassName(this.toString());
  }

  contains(value: string): boolean {
    return this.tokens.has(value);
  }

  toggle(value: string, force?: boolean): boolean {
    if (force === true) {
      this.tokens.add(value);
    } else if (force === false) {
      this.tokens.delete(value);
    } else if (this.tokens.has(value)) {
      this.tokens.delete(value);
    } else {
      this.tokens.add(value);
    }
    this.owner.syncClassName(this.toString());
    return this.tokens.has(value);
  }

  toString(): string {
    return Array.from(this.tokens.values()).join(" ");
  }
}

class FakeElement {
  readonly children: FakeElement[] = [];
  readonly attributes = new Map<string, string>();
  readonly classList = new FakeClassList(this);
  readonly style: Record<string, string | number> = {};
  parentNode: FakeElement | null = null;
  scrollTop = 0;
  scrollHeight = 0;
  clientHeight = 0;
  private classNameValue = "";
  private textValue = "";

  constructor(readonly tagName: string) {}

  get className(): string {
    return this.classNameValue;
  }

  set className(value: string) {
    this.classNameValue = value;
    this.classList.replaceFromString(value);
  }

  get textContent(): string {
    return this.textValue;
  }

  set textContent(value: string) {
    this.textValue = value;
  }

  get lastElementChild(): FakeElement | null {
    return this.children.length > 0 ? this.children[this.children.length - 1] : null;
  }

  get previousElementSibling(): FakeElement | null {
    if (!this.parentNode) {
      return null;
    }
    const index = this.parentNode.children.indexOf(this);
    return index > 0 ? this.parentNode.children[index - 1] ?? null : null;
  }

  get lastChild(): FakeElement | null {
    return this.lastElementChild;
  }

  syncClassName(value: string): void {
    this.classNameValue = value;
  }

  appendChild(child: FakeElement): FakeElement {
    child.parentNode = this;
    this.children.push(child);
    this.scrollHeight = this.children.length;
    return child;
  }

  removeChild(child: FakeElement): FakeElement {
    const index = this.children.indexOf(child);
    if (index >= 0) {
      this.children.splice(index, 1);
      child.parentNode = null;
      this.scrollHeight = this.children.length;
    }
    return child;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  addEventListener(): void {}

  querySelectorAll(): FakeElement[] {
    return [];
  }

  closest(): FakeElement | null {
    return null;
  }
}

function collectRenderedText(element: FakeElement): string {
  return [element.textContent, ...element.children.map((child) => collectRenderedText(child))]
    .filter(Boolean)
    .join("\n")
    .trim();
}

function createTerminalBehaviorHarness(html: string): {
  chatMessagesEl: FakeElement;
  context: Record<string, unknown>;
} {
  const chatMessagesEl = new FakeElement("div");
  chatMessagesEl.classList.add("chat-messages-empty");

  const context: Record<string, unknown> = {
    threadId: "codex_01",
    token: "secret-token",
    chatMessagesEl,
    chatAutoScroll: true,
    bubbleElementsByKey: Object.create(null),
    seenBubbleFingerprintAtMs: Object.create(null),
    chatHistoryHydrating: false,
    activeProgressMessageKey: "",
    activeProgressTraceId: "",
    lastFlushedContent: "",
    lastRunResultAtMs: 0,
    document: {
      body: new FakeElement("body"),
      createElement(tagName: string) {
        return new FakeElement(tagName);
      }
    },
    navigator: {
      clipboard: {
        writeText: async () => undefined
      }
    },
    readChatHistory: () => [],
    writeChatHistory: () => undefined,
    appendChatHistoryEntry: () => undefined,
    removeChatHistoryEntryByKey: () => undefined,
    cacheServerHistory(entries: unknown) {
      context.cachedHistory = entries;
    },
    clearBubbleByKey(messageKey: string) {
      const bubbleElementsByKey = context.bubbleElementsByKey as Record<string, FakeElement>;
      const bubble = bubbleElementsByKey[messageKey];
      if (bubble?.parentNode) {
        bubble.parentNode.removeChild(bubble);
      }
      delete bubbleElementsByKey[messageKey];
      if (chatMessagesEl.children.length === 0) {
        chatMessagesEl.classList.add("chat-messages-empty");
      }
    },
    clearActiveProgressBubble() {
      const messageKey = context.activeProgressMessageKey as string;
      if (messageKey) {
        (context.clearBubbleByKey as (messageKey: string) => void)(messageKey);
      }
      context.activeProgressMessageKey = "";
      context.activeProgressTraceId = "";
    },
    makeBubbleFingerprint(content: string, type: string, detailsText: string) {
      return [type || "agent", content || "", detailsText || ""].join("\n---\n");
    },
    makeBubbleContentFingerprint(content: string, type: string) {
      return `${type || "agent"}::${String(content || "").trim().toLowerCase()}`;
    },
    hasRecentBubbleWithContentFingerprint(contentFingerprint: string, maxToScan: number, excludedBubble?: FakeElement) {
      if (!contentFingerprint) {
        return false;
      }
      let scanned = 0;
      for (
        let bubble = chatMessagesEl.lastElementChild;
        bubble && scanned < maxToScan;
        bubble = bubble.previousElementSibling
      ) {
        if (bubble !== excludedBubble && bubble.getAttribute("data-content-fingerprint") === contentFingerprint) {
          return true;
        }
        scanned++;
      }
      return false;
    },
    syncApprovalStateWithBubble: () => undefined,
    shouldSuppressMessage: () => false,
    detectApprovalPrompt: () => false,
    parseApprovalOptionsFromText: () => [],
    detectOptions: () => [],
    detectYesNo: () => false,
    stripAnsi: (value: string) => value,
    showChatTyping: () => undefined,
    refreshSessionList: () => undefined,
    setTimeout,
    clearTimeout,
    Date,
    console
  };

  bindTerminalFunctions(html, context, [
    "buildTraceMessageKey",
    "buildHistoryMessageKey",
    "buildProgressMessageKey",
    "findLatestPendingHistoryEntry",
    "findLatestFinalHistoryEntry",
    "restoreServerChatHistory",
    "renderProgressSnapshot",
    "maybeResolveProgressFromServerHistory",
    "addChatBubble"
  ]);

  return { chatMessagesEl, context };
}

function createReconnectHarness(html: string): {
  context: Record<string, unknown>;
  urls: string[];
} {
  const urls: string[] = [];

  class FakeWebSocket {
    onopen: (() => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    onerror: (() => void) | null = null;
    onclose: ((event: { code: number }) => void) | null = null;

    constructor(readonly url: string) {
      urls.push(url);
    }
  }

  const context: Record<string, unknown> = {
    threadId: "codex_01",
    token: "secret-token",
    base: "http://127.0.0.1:3000",
    ws: null,
    wsConnected: false,
    wsReconnectAttempts: 1,
    wsReconnectTimer: null,
    WS_MAX_RECONNECT_ATTEMPTS: 20,
    initialReplayLines: 200,
    serverHistoryRestored: true,
    WebSocket: FakeWebSocket,
    handleWsMessage: () => undefined,
    addChatBubble: () => undefined,
    updateAgentStatusIndicator: () => undefined,
    scheduleWsReconnect: () => undefined
  };

  bindTerminalFunctions(html, context, ["connectWebSocket"]);
  return { context, urls };
}

test("shared layout baseline css enforces full-width and full-height viewport", async () => {
  const layoutCss = await fs.promises.readFile(path.join(publicDir, "layout-base.css"), "utf8");

  assert.match(layoutCss, /html,\s*body\s*\{[\s\S]*width:\s*100%/);
  assert.match(layoutCss, /html,\s*body\s*\{[\s\S]*min-height:\s*100%/);
  assert.match(layoutCss, /body\s*\{[\s\S]*min-height:\s*100vh/);
  assert.match(layoutCss, /body\s*\{[\s\S]*min-height:\s*100dvh/);
});

test("hub layout does not hard-cap content width on large screens", async () => {
  const indexHtml = await fs.promises.readFile(path.join(publicDir, "index.html"), "utf8");

  assert.match(indexHtml, /<link\s+rel="stylesheet"\s+href="layout-base\.css"\s*\/?>/);
  assert.match(indexHtml, /#app\s*\{[\s\S]*width:\s*100%/);
  assert.doesNotMatch(indexHtml, /#app\s*\{[\s\S]*max-width:\s*80rem/);
});

test("hub layout pulls viewport baseline from shared css", async () => {
  const indexHtml = await fs.promises.readFile(path.join(publicDir, "index.html"), "utf8");

  assert.match(indexHtml, /<link\s+rel="stylesheet"\s+href="layout-base\.css"\s*\/?>/);
});

test("hub layout exposes provider selection and persists spawn preferences", async () => {
  const indexHtml = await fs.promises.readFile(path.join(publicDir, "index.html"), "utf8");

  assert.match(indexHtml, /id="spawn-provider"/);
  assert.match(indexHtml, /SPAWN_PROVIDER_STORAGE_KEY/);
  assert.match(indexHtml, /SPAWN_AUTO_APPROVE_STORAGE_KEY/);
  assert.match(indexHtml, /type:\s*providerEl && providerEl\.value \? providerEl\.value : "codex"/);
});

test("hub layout renders log footprint monitoring from the main page", async () => {
  const indexHtml = await fs.promises.readFile(path.join(publicDir, "index.html"), "utf8");

  assert.match(indexHtml, /id="log-overview"/);
  assert.match(indexHtml, /id="log-list"/);
  assert.match(indexHtml, /\/api\/logs/);
  assert.match(indexHtml, /function renderLogInventory\(payload\)/);
});

test("bridge layout does not hard-cap content width on large screens", async () => {
  const bridgeHtml = await fs.promises.readFile(path.join(publicDir, "bridge.html"), "utf8");

  assert.match(bridgeHtml, /<link\s+rel="stylesheet"\s+href="layout-base\.css"\s*\/?>/);
  assert.match(bridgeHtml, /#app\s*\{[\s\S]*width:\s*100%/);
  assert.doesNotMatch(bridgeHtml, /#app\s*\{[\s\S]*max-width:\s*42rem/);
  assert.doesNotMatch(bridgeHtml, /#app\s*\{[\s\S]*margin:\s*0\s*auto/);
});

test("terminal layout references shared viewport baseline css", async () => {
  const terminalHtml = await readTerminalHtml();

  assert.match(terminalHtml, /<link\s+rel="stylesheet"\s+href="layout-base\.css"\s*\/?>/);
});

test("terminal explorer does not call find via /api/run", async () => {
  const terminalHtml = await readTerminalHtml();

  assert.doesNotMatch(terminalHtml, /runCommand\("find \\. -maxdepth 2 -not -path '\*\/\.\*'"\)/);
  assert.match(terminalHtml, /\/api\/files\?thread_id=/);
});

test("terminal view wires fit addon for full-size terminal rendering", async () => {
  const terminalHtml = await readTerminalHtml();

  assert.match(terminalHtml, /xterm-addon-fit@\d/);
  assert.match(terminalHtml, /new window\.FitAddon\.FitAddon\(\)/);
  assert.match(terminalHtml, /term\.loadAddon\(fitAddon\)/);
  assert.match(terminalHtml, /fitAddon\.fit\(\)/);
});

test("terminal approval actions use dedicated terminal_input API", async () => {
  const terminalHtml = await readTerminalHtml();

  assert.match(terminalHtml, /\/api\/terminal_input/);
  assert.match(terminalHtml, /Allow for this session/);
  assert.match(terminalHtml, /sendTerminalText\(opt\.(submit|key)\)/);
});

test("terminal explorer renders a collapsible directory tree", async () => {
  const terminalHtml = await readTerminalHtml();

  assert.match(terminalHtml, /expandedDirs/);
  assert.match(terminalHtml, /renderFileTree/);
  assert.match(terminalHtml, /tree-toggle/);
});

test("terminal explorer persists expanded directories in session storage", async () => {
  const terminalHtml = await readTerminalHtml();

  assert.match(terminalHtml, /EXPANDED_DIRS_STORAGE_KEY/);
  assert.match(terminalHtml, /sessionStorage\.getItem\(EXPANDED_DIRS_STORAGE_KEY/);
  assert.match(terminalHtml, /sessionStorage\.setItem\(EXPANDED_DIRS_STORAGE_KEY/);
});

test("terminal chat history restores from local storage and disables replay when present", async () => {
  const terminalHtml = await readTerminalHtml();

  assert.match(terminalHtml, /CHAT_HISTORY_STORAGE_KEY/);
  assert.match(terminalHtml, /restoreChatHistory\(\)/);
  assert.match(terminalHtml, /restoreServerChatHistory\(entries\)/);
  assert.match(terminalHtml, /serverHistoryRestored = restoreServerChatHistory\(entries\)/);
  assert.match(terminalHtml, /replay_lines=/);
});

test("terminal canonical restore polls durable progress and suppresses reconnect replay when history is authoritative", async () => {
  const terminalHtml = await readTerminalHtml();

  assert.match(terminalHtml, /\/api\/progress\//);
  assert.match(terminalHtml, /buildProgressMessageKey/);
  assert.match(terminalHtml, /activeProgressMessageKey/);
  assert.match(terminalHtml, /clearActiveProgressBubble/);
  assert.match(terminalHtml, /maybeResolveProgressFromServerHistory/);
  assert.match(terminalHtml, /findLatestPendingHistoryEntry/);
  assert.match(terminalHtml, /display_text/);
  assert.match(terminalHtml, /runPending \|\| activeProgressMessageKey/);
  assert.match(terminalHtml, /serverHistoryRestored \? 0 : 100/);
});

test("terminal accessibility markup keeps labeled controls and tab semantics", async () => {
  const terminalHtml = await fs.promises.readFile(path.join(publicDir, "terminal.html"), "utf8");

  assert.match(terminalHtml, /<button[^>]*id="menu-toggle"[^>]*aria-label="Toggle menu"/);
  assert.match(terminalHtml, /<button[^>]*id="overflow-menu-btn"[^>]*aria-label="More actions"/);
  assert.match(terminalHtml, /<button[^>]*id="refresh-files"[^>]*aria-label="Refresh files"/);
  assert.match(terminalHtml, /<div class="tabs"[^>]*role="tablist"[^>]*aria-label="Workspace views"/);
  assert.match(terminalHtml, /<div class="tab active"[^>]*data-view="terminal"[^>]*role="tab"[^>]*aria-selected="true"/);
  assert.match(terminalHtml, /<div class="tab"[^>]*data-view="editor"[^>]*role="tab"[^>]*aria-selected="false"/);
  assert.match(terminalHtml, /<nav class="mobile-nav"[^>]*role="tablist"[^>]*aria-label="Mobile views"/);
  assert.match(terminalHtml, /<div class="nav-item active"[^>]*data-view="chat"[^>]*role="tab"[^>]*aria-selected="true"/);
  assert.match(terminalHtml, /<div class="nav-item"[^>]*data-view="editor"[^>]*role="tab"[^>]*aria-selected="false"/);
  assert.match(terminalHtml, /setAttribute\("aria-selected", isActive \? "true" : "false"\)/);
});

test("terminal chat keeps a content-fingerprint dedupe safety net for replayed agent bubbles", async () => {
  const terminalHtml = await readTerminalHtml();
 
  assert.match(terminalHtml, /makeBubbleContentFingerprint/);
  assert.match(terminalHtml, /hasRecentBubbleWithContentFingerprint/);
  assert.match(terminalHtml, /data-content-fingerprint/);
});

test("terminal restore keeps canonical pending state and resolves it to one final bubble", async () => {
  const terminalHtml = await readTerminalHtml();
  const { chatMessagesEl, context } = createTerminalBehaviorHarness(terminalHtml);
  const restoreServerChatHistory = context.restoreServerChatHistory as (entries: unknown[]) => boolean;
  const maybeResolveProgressFromServerHistory = context.maybeResolveProgressFromServerHistory as (entries: unknown[]) => boolean;

  const traceId = "2f461d95-0157-4f90-bb4d-a63f2bfb1ed8";
  const restored = restoreServerChatHistory([
    {
      id: "history-user-1",
      event_kind: "user_send",
      type: "user",
      content: "ship it",
      details_text: "",
      trace_id: traceId
    },
    {
      id: "history-progress-1",
      event_kind: "progress",
      type: "agent",
      content: "Still running...",
      details_text: "",
      trace_id: traceId
    }
  ]);

  assert.equal(restored, true);
  assert.equal(chatMessagesEl.children.length, 2);
  assert.equal(context.activeProgressMessageKey, "history:history-progress-1");
  assert.equal(context.activeProgressTraceId, traceId);

  const resolved = maybeResolveProgressFromServerHistory([
    {
      id: "history-user-1",
      event_kind: "user_send",
      type: "user",
      content: "ship it",
      details_text: "",
      trace_id: traceId
    },
    {
      id: "history-final-1",
      event_kind: "final_reply",
      type: "agent",
      content: "done",
      details_text: "",
      trace_id: traceId
    }
  ]);

  assert.equal(resolved, true);
  assert.equal(context.activeProgressMessageKey, "");
  assert.equal(chatMessagesEl.children.length, 2);
  assert.equal(chatMessagesEl.children[1]?.getAttribute("data-message-key"), "history:history-final-1");
  assert.equal(collectRenderedText(chatMessagesEl.children[1] as FakeElement), "done");
});

test("terminal quiet-period liveness updates a single keyed progress bubble in place", async () => {
  const terminalHtml = await readTerminalHtml();
  const { chatMessagesEl, context } = createTerminalBehaviorHarness(terminalHtml);
  const renderProgressSnapshot = context.renderProgressSnapshot as (snapshot: Record<string, unknown>) => void;

  renderProgressSnapshot({
    trace_id: "2f461d95-0157-4f90-bb4d-a63f2bfb1ed8",
    content: "Task is running...",
    display_text: "Task is running..."
  });
  renderProgressSnapshot({
    trace_id: "2f461d95-0157-4f90-bb4d-a63f2bfb1ed8",
    content: "Still running...",
    display_text: "Still running..."
  });

  assert.equal(chatMessagesEl.children.length, 1);
  assert.equal(context.activeProgressMessageKey, "progress:2f461d95-0157-4f90-bb4d-a63f2bfb1ed8");
  assert.equal(
    collectRenderedText(chatMessagesEl.children[0] as FakeElement),
    "Still running..."
  );
});

test("terminal reconnect requests zero replay lines after authoritative history restore", async () => {
  const terminalHtml = await readTerminalHtml();
  const { context, urls } = createReconnectHarness(terminalHtml);
  const connectWebSocket = context.connectWebSocket as () => void;

  connectWebSocket();
  assert.match(urls[0] ?? "", /replay_lines=0/);

  context.serverHistoryRestored = false;
  context.wsReconnectAttempts = 1;
  connectWebSocket();
  assert.match(urls[1] ?? "", /replay_lines=100/);
});

test("terminal layout includes sidebar session history and model picker", async () => {
  const terminalHtml = await readTerminalHtml();

  assert.match(terminalHtml, /data-sidebar-tab="sessions"/);
  assert.match(terminalHtml, /id="session-list"/);
  assert.match(terminalHtml, /\/api\/history_threads/);
  assert.match(terminalHtml, /id="model-select"/);
  assert.match(terminalHtml, /\/api\/models\?thread_id=/);
  assert.match(terminalHtml, /fetchWithAuth\("\/api\/models",\s*\{/);
  assert.match(terminalHtml, /Model: unavailable/);
  assert.match(terminalHtml, /Model: Custom\.\.\./);
  assert.match(terminalHtml, /window\.prompt\("Enter provider model id:"/);
});

test("terminal mobile header keeps overflow menu on the top-right and renders current-model fallback", async () => {
  const terminalHtml = await readTerminalHtml();

  assert.match(terminalHtml, /\.header-right > \.header-overflow\s*\{[\s\S]*order:\s*3/);
  assert.match(terminalHtml, /\.header-overflow \.overflow-dropdown\s*\{[\s\S]*left:\s*auto/);
  assert.match(terminalHtml, /function renderCurrentOnly\(modelLabelOrId\)/);
  assert.match(terminalHtml, /if \(currentModelId\) \{\s*renderCurrentOnly\(currentModelId\);/);
});

test("terminal chat prioritizes structured /api/run result to avoid pane replay mixing", async () => {
  const terminalHtml = await readTerminalHtml();

  assert.match(terminalHtml, /runCommand\(cmd\)\s*\.then/);
  assert.match(terminalHtml, /renderAgentContent\(resultContent\)/);
  assert.match(terminalHtml, /lastFlushedContent = stripAnsi\(resultContent\)/);
  assert.match(terminalHtml, /chatBuffer = ""/);
});

test("terminal explorer directory rows expose keyboard accessible toggles", async () => {
  const terminalHtml = await readTerminalHtml();

  assert.match(terminalHtml, /row\.setAttribute\("role", "button"\)/);
  assert.match(terminalHtml, /row\.setAttribute\("tabindex", "0"\)/);
  assert.match(terminalHtml, /row\.setAttribute\("aria-expanded"/);
});
