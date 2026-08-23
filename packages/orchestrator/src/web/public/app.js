const POLL_INTERVAL_MS = 3000;
// When this GUI is mounted behind the ADS gateway card at /roles-gui/,
// links like /role/<id> need the /roles-gui prefix or the browser
// navigates to a path the gateway does not recognize and falls back to
// the service-card-router SPA (i.e. clicking "Open detail" bounces the
// user back to /ads).
const GATEWAY_PATH_PREFIX = (() => {
  if (typeof window === "undefined") {
    return "";
  }
  const match = window.location.pathname.match(/^(\/roles-gui)(?:\/|$)/u);
  return match ? match[1] : "";
})();
const WORKER_MODEL_OPTIONS = [
  "CODEX",
  "CODEX-HIGH",
  "CODEX-XHIGH",
  "OPUS",
  "SONNET",
  "GEMINI",
  "gpt-5.5 medium",
  "gpt-5.5 high",
  "gpt-5.5 xhigh",
  "gpt-5.4 medium",
  "gpt-5.4 high",
  "gpt-5.4 xhigh",
  "claude-opus-4-7",
  "claude-opus-4-6",
  "claude-sonnet-4-6",
  "gemini-2.5-pro"
];
const WORKER_REASONING_EFFORT_OPTIONS = ["low", "medium", "high", "xhigh"];

document.addEventListener("DOMContentLoaded", () => {
  const page = document.body.dataset.page;

  setupMonitorNavAlarm();

  if (page !== "dashboard") {
    void refreshGlobalNavCounts();
  }

  if (page === "dashboard") {
    void setupDashboard();
    return;
  }

  if (page === "role-detail") {
    void setupRoleDetail();
    return;
  }

  if (page === "scheduler-detail") {
    setupSchedulerDetail();
    return;
  }

  if (page === "prompt-editor") {
    void setupPromptEditor();
    return;
  }

  if (page === "config-editor") {
    void setupConfigEditor();
  }
});

/* ═══════════════════════════════════════════════════════════════
   Tab Navigation
   ═══════════════════════════════════════════════════════════════ */

function activateTab(target) {
  const tabs = document.querySelectorAll(".nav-tab[data-tab]");
  const panels = document.querySelectorAll(".tab-panel");

  tabs.forEach((t) => t.classList.remove("active"));
  panels.forEach((p) => p.classList.remove("active"));

  const tab = Array.from(tabs).find((candidate) => candidate.dataset.tab === target);
  const panel = document.getElementById(`tab-${target}`);
  if (!tab || !panel) return;

  tab.classList.add("active");
  panel.classList.add("active");
}

function setupTabNavigation() {
  const tabs = document.querySelectorAll(".nav-tab[data-tab]");

  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      activateTab(tab.dataset.tab);
    });
  });

  const initialTab = new URLSearchParams(window.location.search).get("tab");
  if (initialTab) {
    activateTab(initialTab);
  }
}

function setupCreateRoleMenu() {
  const root = document.getElementById("create-role-menu");
  if (!root) return;

  const trigger = root.querySelector(".nav-dropdown-trigger");
  const list = root.querySelector(".nav-dropdown-list");
  if (!trigger || !list) return;

  const close = () => {
    root.classList.remove("open");
    list.hidden = true;
    trigger.setAttribute("aria-expanded", "false");
  };

  const open = () => {
    root.classList.add("open");
    list.hidden = false;
    trigger.setAttribute("aria-expanded", "true");
    const first = list.querySelector('[role="menuitem"]');
    if (first) first.focus();
  };

  const toggle = () => (list.hidden ? open() : close());

  trigger.addEventListener("click", (e) => {
    e.stopPropagation();
    toggle();
  });

  document.addEventListener("click", (e) => {
    if (!root.contains(e.target)) close();
  });

  root.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      close();
      trigger.focus();
    }
  });

  list.addEventListener("click", (e) => {
    const item = e.target.closest('[role="menuitem"]');
    if (!item) return;

    if (item.tagName === "A") {
      close();
      return;
    }

    const targetTab = item.dataset.targetTab;
    const targetForm = item.dataset.targetForm;
    close();

    if (targetTab) activateTab(targetTab);
    if (targetForm) {
      requestAnimationFrame(() => {
        const form = document.getElementById(targetForm);
        if (!form) return;
        form.scrollIntoView({ behavior: "smooth", block: "start" });
        const firstField = form.querySelector("input, textarea, select");
        if (firstField) firstField.focus({ preventScroll: true });
      });
    }
  });
}

function updateTabCounts(roles) {
  const dispatchers = roles.filter((r) => r.role_type === "agent-dispatcher");
  const schedulers = roles.filter((r) => r.role_type === "scheduler");
  const otherRoles = roles;

  setTabCount("nav-dispatcher-count", dispatchers.length);
  setTabCount("nav-scheduler-count", schedulers.length);
  setTabCount("nav-role-count", otherRoles.length);
}

function setTabCount(elementId, count) {
  const el = document.getElementById(elementId);
  if (!el) return;
  if (count > 0) {
    el.textContent = String(count);
    el.hidden = false;
  } else {
    el.hidden = true;
  }
}

async function refreshGlobalNavCounts() {
  try {
    const roles = await fetchJson("/api/roles");
    if (Array.isArray(roles)) {
      updateTabCounts(roles);
    }
  } catch {
    // Navigation counts are non-critical on detail pages.
  }
}

function setupMonitorNavAlarm() {
  const dot = document.getElementById("nav-monitor-red-dot");
  if (!dot) {
    return;
  }

  async function refresh() {
    try {
      const data = await fetchJson("/api/system-monitor");
      dot.hidden = !data?.any_red;
    } catch {
      // The monitor page itself shows connection failures. Other pages keep
      // the nav unobtrusive unless the endpoint provides a real red state.
      dot.hidden = true;
    }
  }

  refresh();
  if (typeof window !== "undefined" && typeof window.setInterval === "function") {
    window.setInterval(refresh, 5000);
  } else if (typeof setInterval === "function") {
    setInterval(refresh, 5000);
  }
}

/* ═══════════════════════════════════════════════════════════════
   Validator Toggle (dispatcher creation form)
   ═══════════════════════════════════════════════════════════════ */

/* ═══════════════════════════════════════════════════════════════
   Live agentapi process monitor (tab: Processes)
   ═══════════════════════════════════════════════════════════════ */

const PROCESS_POLL_INTERVAL_MS = 3000;
// Browser-session-scoped cap on the per-tab history list. Plenty for normal
// debugging and bounded so an op leaving the tab open for hours can't OOM the
// page.
const PROCESS_HISTORY_CAP = 100;

function setupProcessMonitor() {
  const tableShell = document.getElementById("processes-table-shell");
  const tableBody = document.getElementById("processes-table-body");
  const empty = document.getElementById("processes-empty");
  const feedback = document.getElementById("processes-feedback");
  const summaryEl = document.getElementById("process-summary");
  const navLeakDot = document.getElementById("nav-process-leak-dot");
  const hideExternalToggle = document.getElementById("process-hide-external");
  if (!tableShell || !tableBody) {
    return;
  }

  let lastProcesses = [];
  // pid -> last observed total_tokens. On each poll, a PID whose total grew
  // since the previous tick (or first appears with tokens already attached)
  // is flagged with `_tokenIncreased` so the row gets a one-shot green flash.
  const prevTokenTotals = new Map();
  // pid -> history entry { entry, finalUsage, lastSeenAt }. Populated on each
  // poll for any PID that appeared in the previous snapshot but is gone in
  // the current one. Browser-session-scoped only; cleared on reload. Capped
  // at PROCESS_HISTORY_CAP to bound memory.
  const processHistory = new Map();

  function applyTokenFlashing(processes) {
    const livePids = new Set();
    for (const p of processes) {
      if (!Number.isFinite(p.pid)) continue;
      livePids.add(p.pid);
      const cur = p.token_usage ? Number(p.token_usage.total_tokens) : null;
      const prev = prevTokenTotals.get(p.pid);
      p._tokenIncreased = (cur !== null && Number.isFinite(cur) && (prev === undefined || cur > prev));
      if (cur !== null && Number.isFinite(cur)) {
        prevTokenTotals.set(p.pid, cur);
      }
    }
    for (const pid of [...prevTokenTotals.keys()]) {
      if (!livePids.has(pid)) prevTokenTotals.delete(pid);
    }
  }

  function captureDepartedProcesses(currentProcesses, previousProcesses) {
    if (!Array.isArray(previousProcesses) || previousProcesses.length === 0) return;
    const curPids = new Set(currentProcesses
      .filter((p) => Number.isFinite(p.pid))
      .map((p) => p.pid));
    const nowIso = new Date().toISOString();
    for (const prev of previousProcesses) {
      if (!Number.isFinite(prev.pid)) continue;
      if (curPids.has(prev.pid)) continue;
      processHistory.set(prev.pid, {
        entry: prev,
        finalUsage: prev.token_usage ?? null,
        lastSeenAt: nowIso
      });
    }
    while (processHistory.size > PROCESS_HISTORY_CAP) {
      const oldestKey = processHistory.keys().next().value;
      processHistory.delete(oldestKey);
    }
  }

  function render() {
    const hideExternal = hideExternalToggle ? hideExternalToggle.checked : false;
    const visible = hideExternal
      ? lastProcesses.filter((p) => p.origin !== "external")
      : lastProcesses;

    if (visible.length === 0) {
      tableShell.hidden = true;
      if (empty) {
        empty.hidden = false;
        empty.textContent = lastProcesses.length === 0
          ? "No agentapi/codex/claude processes detected on the host."
          : "Only external (non-meridian-roles) processes — hidden by filter. Uncheck the box to see them.";
      }
    } else {
      if (empty) empty.hidden = true;
      tableShell.hidden = false;
      // Group rows by their actual owner (worker / dispatcher / validator /
      // pm-resolver / stateless Hub-direct call / orphan / external). This
      // collapses the 2- or 3-PID agentapi→codex_shim→codex_native chain into
      // a single visual block with ONE deduped token total in the group header,
      // so the operator can read "this worker is using N tokens across these M
      // PIDs" instead of staring at duplicate numbers across sibling rows. It
      // also gives stateless Hub-direct validator/PM turns a header row that
      // says exactly that, instead of looking like an unattached "leak".
      const groups = buildProcessGroups(visible);
      tableBody.innerHTML = groups.map(renderGroup).join("");
    }

    renderHistory();
  }

  function renderHistory() {
    const historyShell = document.getElementById("processes-history-shell");
    const historyBody = document.getElementById("processes-history-body");
    const historyEmpty = document.getElementById("processes-history-empty");
    const historyTable = document.getElementById("processes-history-table");
    if (!historyShell || !historyBody) return;
    historyShell.hidden = false;
    if (processHistory.size === 0) {
      if (historyEmpty) historyEmpty.hidden = false;
      if (historyTable) historyTable.hidden = true;
      historyBody.innerHTML = "";
      return;
    }
    if (historyEmpty) historyEmpty.hidden = true;
    if (historyTable) historyTable.hidden = false;
    // Sort newest-departed first.
    const rows = [...processHistory.values()]
      .sort((a, b) => (b.lastSeenAt || "").localeCompare(a.lastSeenAt || ""));
    historyBody.innerHTML = rows.map(renderHistoryRow).join("");
  }

  function renderHistoryRow(h) {
    const entry = h.entry || {};
    const finalUsage = h.finalUsage;
    const tokens = finalUsage
      ? `<code>${formatTokens(finalUsage.input_tokens)}</code> in / <code>${formatTokens(finalUsage.output_tokens)}</code> out / <code>${formatTokens(finalUsage.total_tokens)}</code> total`
      : '<span class="muted">—</span>';
    const sessionFile = finalUsage?.session_file
      ? `<span class="muted history-session-file" title="${escapeHtml(finalUsage.session_file)}">${escapeHtml(truncateMiddle(finalUsage.session_file, 60))}</span>`
      : '<span class="muted">—</span>';
    const cmd = entry.command || "";
    const lastSeenLocal = h.lastSeenAt ? new Date(h.lastSeenAt).toLocaleTimeString() : "—";
    return '<tr class="row-history">'
      + `<td><code>${entry.pid ?? "—"}</code></td>`
      + `<td>${escapeHtml(entry.origin ?? "—")}</td>`
      + `<td>${escapeHtml(entry.agent_type ?? "?")}</td>`
      + `<td>${entry.thread_id ? `<code>${escapeHtml(entry.thread_id)}</code>` : '<span class="muted">—</span>'}</td>`
      + `<td>${tokens}</td>`
      + `<td>${sessionFile}</td>`
      + `<td><span class="muted">${escapeHtml(lastSeenLocal)}</span></td>`
      + `<td title="${escapeHtml(cmd)}"><code class="history-cmd">${escapeHtml(truncateMiddle(cmd, 70))}</code></td>`
      + "</tr>";
  }

  async function refresh() {
    try {
      const data = await fetchJson("/api/agentapi-processes");
      if (!data || !Array.isArray(data.processes)) {
        return;
      }
      const previousSnapshot = lastProcesses;
      applyTokenFlashing(data.processes);
      captureDepartedProcesses(data.processes, previousSnapshot);
      lastProcesses = data.processes;

      if (summaryEl) {
        const total = Number(data.total ?? data.processes.length);
        const managedBound = Number(data.managed_bound ?? 0);
        const managedLeak = Number(data.managed_leak ?? 0);
        const hubManaged = Number(data.hub_managed ?? 0);
        const orphan = Number(data.orphan ?? 0);
        const external = Number(data.external ?? 0);
        const leak = Number(data.leak ?? 0);
        const tokenTotals = data.token_totals || null;
        const tokenSpan = tokenTotals && tokenTotals.sessions > 0
          ? `<span class="muted" title="cumulative tokens across ${tokenTotals.sessions} active session(s); paired shim+native rows counted once">tokens: ${formatTokens(tokenTotals.input_tokens)} in / ${formatTokens(tokenTotals.output_tokens)} out / ${formatTokens(tokenTotals.total_tokens)} total</span>`
          : "";
        summaryEl.innerHTML =
          `<span>total: <strong>${total}</strong></span>`
          + `<span class="muted">meridian-roles bound: ${managedBound}</span>`
          + (hubManaged > 0 ? `<span class="muted">meridian-hub unbound: ${hubManaged}</span>` : "")
          + `<span class="${leak > 0 ? "leak-callout" : "muted"}">leak: ${leak}</span>`
          + `<span class="muted">orphan: ${orphan}</span>`
          + `<span class="muted">external: ${external}</span>`
          + tokenSpan;
        setTabCount("nav-process-count", total);
        if (navLeakDot) navLeakDot.hidden = leak === 0;
      }

      render();
      if (feedback) feedback.textContent = "";
    } catch (err) {
      if (feedback) feedback.textContent = `Failed to refresh: ${(err && err.message) || err}`;
    }
  }

  // Group processes by their actual owner. The rules mirror the binding
  // classification produced by /api/agentapi-processes — see
  // src/server/process-handlers.ts buildSnapshot() — so what the operator
  // sees in this tab matches the structure the dispatcher/Hub already use
  // internally. Output is an array of group descriptors:
  //   { key, kind, title, subtitle, processes, tokenTotals, isLeak }
  // sorted leaks-first then by kind-priority.
  function buildProcessGroups(processes) {
    const byPid = new Map(processes
      .filter((p) => Number.isFinite(p.pid))
      .map((p) => [p.pid, p]));

    function provisionalKey(p) {
      if (p.binding) {
        // Collapse a worker's worker / validator / pm-resolver / dispatcher
        // process trees into ONE group keyed on (dispatcher_role_id, worker_id).
        // Pre-this-change the validator/PM landed in their own groups even when
        // their binding.worker_id matched a bound worker above — so the live
        // session that the operator wants to see "as a single thing" was split
        // across two visually unrelated rows. Distinct binding.role values
        // still show inside the group via per-thread sub-headers.
        const ownerId = p.binding.role === "dispatcher"
          ? `DISPATCHER:${p.binding.dispatcher_role_id}`
          : `${p.binding.dispatcher_role_id}:${p.binding.worker_id}`;
        return `bound:${ownerId}`;
      }
      if (p.is_leak) {
        return `leak:${p.thread_id ?? p.pid}`;
      }
      if (p.origin === "hub") {
        return `hub:${p.thread_id ?? p.pid ?? "hub"}`;
      }
      if (p.origin === "orphan") {
        return `orphan:${p.thread_id ?? p.pid}`;
      }
      if (p.origin === "external") {
        return `external:${p.pid}`;
      }
      // managed + no binding + no thread_id = stateless Hub-direct call.
      // Group all PIDs in the same ancestry chain together so the agentapi-less
      // codex shim + native pair (e.g. PID 4232 + PID 82106 spawned by Hub for
      // a stateless validator turn) become one block instead of two orphans.
      return null;
    }

    const provisional = new Map();
    const statelessPids = new Set();
    for (const p of processes) {
      const k = provisionalKey(p);
      if (k !== null) {
        provisional.set(p, k);
      } else if (Number.isFinite(p.pid)) {
        statelessPids.add(p.pid);
      }
    }
    function statelessRoot(p) {
      let cur = p;
      for (let i = 0; i < 12; i += 1) {
        const parent = byPid.get(cur.ppid);
        if (!parent || !statelessPids.has(parent.pid)) return cur;
        cur = parent;
      }
      return cur;
    }
    for (const p of processes) {
      if (Number.isFinite(p.pid) && statelessPids.has(p.pid)) {
        provisional.set(p, `stateless:${statelessRoot(p).pid}`);
      }
    }

    const buckets = new Map();
    for (const p of processes) {
      const k = provisional.get(p) ?? `untracked:${p.thread_id ?? p.pid ?? "hub"}`;
      if (!buckets.has(k)) buckets.set(k, []);
      buckets.get(k).push(p);
    }

    const groups = [];
    for (const [key, members] of buckets) {
      // Sort members parent→child so an agentapi row comes before its codex
      // child, and the codex node shim comes before the native binary.
      const memberPids = new Set(members
        .filter((p) => Number.isFinite(p.pid))
        .map((p) => p.pid));
      function depth(p) {
        if (!Number.isFinite(p.pid) || !Number.isFinite(p.ppid)) return 0;
        let d = 0;
        let cur = p;
        while (d < 12) {
          const parent = byPid.get(cur.ppid);
          if (!parent || !memberPids.has(parent.pid)) return d;
          d += 1;
          cur = parent;
        }
        return d;
      }
      // Within a bound-by-worker group multiple threads can coexist (the
      // worker thread + its validator thread + its pm-resolver thread). Sort
      // by (role-order, thread_id, depth) so the operator reads the worker
      // tree first, then the validator/PM trees inside the same block.
      const roleOrder = { worker: 0, dispatcher: 0, validator: 1, pm_resolver: 2 };
      members.sort((a, b) => {
        const ra = a.binding ? (roleOrder[a.binding.role] ?? 9) : 9;
        const rb = b.binding ? (roleOrder[b.binding.role] ?? 9) : 9;
        if (ra !== rb) return ra - rb;
        const ta = a.thread_id ?? "";
        const tb = b.thread_id ?? "";
        if (ta !== tb) return ta < tb ? -1 : 1;
        const da = depth(a);
        const db = depth(b);
        if (da !== db) return da - db;
        return a.pid - b.pid;
      });
      for (const m of members) m._tree_depth = depth(m);

      // Dedupe tokens across the group by session_file so the header shows the
      // real cumulative spend (agentapi shim + codex shim + codex native always
      // resolve to the same session file via cwd + start-time match — they
      // must be counted once).
      const seen = new Set();
      let inTok = 0;
      let outTok = 0;
      let totTok = 0;
      let sessions = 0;
      for (const m of members) {
        const u = m.token_usage;
        if (!u || seen.has(u.session_file)) continue;
        seen.add(u.session_file);
        sessions += 1;
        inTok += Number(u.input_tokens || 0);
        outTok += Number(u.output_tokens || 0);
        totTok += Number(u.total_tokens || 0);
      }
      const tokenTotals = sessions > 0
        ? { input_tokens: inTok, output_tokens: outTok, total_tokens: totTok, sessions }
        : null;

      const head = members[0];
      let kind;
      let title;
      let subtitle;
      if (key.startsWith("bound:")) {
        const role = head.binding ? head.binding.role : "worker";
        kind = role;
        if (role === "worker") {
          title = `Worker ${head.binding.worker_id}`;
        } else if (role === "dispatcher") {
          title = `Dispatcher ${head.binding.worker_id}`;
        } else if (role === "validator") {
          // After the cross-role grouping change, a "validator" head can only
          // appear here when no worker thread for the same worker_id was
          // present in the snapshot (e.g. the worker terminated but its
          // validator process is still running). Keep the title pointing back
          // at the worker so the operator still sees the linkage.
          title = `Validator (for worker ${head.binding.worker_id})`;
        } else if (role === "pm_resolver") {
          title = `PM-resolver (for worker ${head.binding.worker_id})`;
        } else {
          title = `${role} ${head.binding.worker_id}`;
        }
        // Subtitle now describes the group as a whole, not just the head's
        // thread, because a bound group can contain the worker thread plus
        // its validator / pm-resolver threads (each PID block is broken out
        // by the per-thread sub-header below).
        const distinctThreadsForSubtitle = new Set(
          members
            .map((m) => (m.binding && m.thread_id ? `${m.binding.role}:${m.thread_id}` : null))
            .filter((t) => t !== null)
        );
        const parts = [];
        if (head.binding.dispatcher_role_id) parts.push(`dispatcher <code>${escapeHtml(head.binding.dispatcher_role_id)}</code>`);
        if (distinctThreadsForSubtitle.size > 1) {
          const labels = [...distinctThreadsForSubtitle].map((rt) => {
            const [r, tid] = rt.split(":");
            const rl = r === "pm_resolver" ? "pm-resolver" : r;
            return `${escapeHtml(rl)} <code>${escapeHtml(tid)}</code>`;
          });
          parts.push(`threads: ${labels.join(", ")}`);
        } else if (head.thread_id) {
          parts.push(`thread <code>${escapeHtml(head.thread_id)}</code>`);
        }
        if (head.binding.status) parts.push(`worker status ${escapeHtml(head.binding.status)}`);
        subtitle = parts.join(" · ");
      } else if (key.startsWith("leak:")) {
        kind = "managed-leak";
        title = `LEAK — no dispatcher claim`;
        subtitle = head.thread_id
          ? `thread <code>${escapeHtml(head.thread_id)}</code> · investigate before killing`
          : `unbindable managed process · investigate before killing`;
      } else if (key.startsWith("orphan:")) {
        kind = "orphan";
        title = `ORPHAN — agentapi parent died, ${escapeHtml(head.agent_type ?? "agent")} survived`;
        subtitle = head.thread_id
          ? `thread <code>${escapeHtml(head.thread_id)}</code> · reparented to init`
          : `reparented to init`;
      } else if (key.startsWith("hub:")) {
        kind = "hub-managed";
        title = `Hub-managed ${escapeHtml(head.agent_type ?? "agent")} thread`;
        const parts = [];
        if (head.thread_id) parts.push(`thread <code>${escapeHtml(head.thread_id)}</code>`);
        parts.push("live in Meridian Hub but not claimed by this Meridian-roles state");
        subtitle = parts.join(" · ");
      } else if (key.startsWith("stateless:")) {
        kind = "stateless";
        const rootPid = key.slice("stateless:".length);
        title = `Stateless ${escapeHtml(head.agent_type ?? "agent")} call (root PID ${escapeHtml(rootPid)})`;
        subtitle = `Hub-direct short-lived turn — validator / PM / scheduler. No worker binding by design, NOT a leak.`;
      } else {
        kind = "external";
        title = `External ${escapeHtml(head.agent_type ?? "agent")} session`;
        subtitle = `Not spawned by meridian-roles — terminal, Claude Code, or other tool`;
      }

      groups.push({
        key,
        kind,
        title,
        subtitle,
        processes: members,
        tokenTotals,
        isLeak: members.some((m) => m.is_leak)
      });
    }

    const kindOrder = {
      "managed-leak": 0,
      orphan: 1,
      dispatcher: 2,
      worker: 3,
      validator: 4,
      pm_resolver: 5,
      "hub-managed": 6,
      stateless: 7,
      external: 8
    };
    groups.sort((a, b) => {
      const oa = kindOrder[a.kind] ?? 9;
      const ob = kindOrder[b.kind] ?? 9;
      if (oa !== ob) return oa - ob;
      const ap = processSortPid(a);
      const bp = processSortPid(b);
      return ap - bp;
    });

    return groups;
  }

  function processSortPid(group) {
    const numeric = group.processes
      .map((p) => p.pid)
      .filter((pid) => Number.isFinite(pid));
    return numeric.length > 0 ? Math.min(...numeric) : Number.MAX_SAFE_INTEGER;
  }

  function renderGroup(group) {
    const rows = [renderGroupHeader(group)];
    // A bound group can hold the worker thread plus its validator / pm-resolver
    // threads (each with its own thread_id, its own session file, its own PID
    // tree). When more than one distinct thread is present, insert a small
    // sub-header before each thread's PIDs so the operator can see "this
    // codex_05 is the worker; this codex_08 below is the validator working on
    // the same A2 worker". Single-thread groups skip the sub-header for
    // visual quiet.
    const distinctThreads = new Set(
      group.processes
        .map((p) => p.thread_id)
        .filter((t) => t !== null && t !== undefined)
    );
    const showThreadSubheaders = distinctThreads.size > 1;
    let lastThreadKey = "__unset__";
    for (const p of group.processes) {
      const threadKey = `${p.binding ? p.binding.role : "?"}:${p.thread_id ?? "(none)"}`;
      if (showThreadSubheaders && threadKey !== lastThreadKey) {
        rows.push(renderThreadSubheader(p, group));
        lastThreadKey = threadKey;
      }
      rows.push(renderProcessRow(p, group));
    }
    return rows.join("");
  }

  function renderThreadSubheader(entry, group) {
    const role = entry.binding ? entry.binding.role : "?";
    const roleLabel = role === "pm_resolver" ? "pm-resolver" : role;
    const tid = entry.thread_id
      ? `<code>${escapeHtml(entry.thread_id)}</code>`
      : '<span class="muted">no thread_id</span>';
    // Per-thread token total: deduped across the rows that belong to THIS
    // thread within the group. Gives the operator a clean per-thread number
    // alongside the group-wide total in the main header.
    const seen = new Set();
    let inTok = 0;
    let outTok = 0;
    let totTok = 0;
    for (const p of group.processes) {
      if (p.thread_id !== entry.thread_id) continue;
      const u = p.token_usage;
      if (!u || seen.has(u.session_file)) continue;
      seen.add(u.session_file);
      inTok += Number(u.input_tokens || 0);
      outTok += Number(u.output_tokens || 0);
      totTok += Number(u.total_tokens || 0);
    }
    const tokensHtml = seen.size > 0
      ? `<code>${formatTokens(inTok)}</code> in / <code>${formatTokens(outTok)}</code> out / <strong><code>${formatTokens(totTok)}</code></strong> total`
      : `<span class="muted">no tokens yet</span>`;
    return `<tr class="row-thread-subheader">`
      + `<td colspan="10">`
      + `<span class="thread-subheader-role">${escapeHtml(roleLabel)}</span>`
      + ` thread ${tid}`
      + (entry.binding && entry.binding.status
        ? ` <span class="muted">· status ${escapeHtml(entry.binding.status)}</span>`
        : "")
      + ` <span class="muted">· ${tokensHtml}</span>`
      + `</td>`
      + `</tr>`;
  }

  function renderGroupHeader(group) {
    const kindLabel = {
      worker: "worker",
      dispatcher: "dispatcher",
      validator: "validator",
      pm_resolver: "pm-resolver",
      "hub-managed": "hub",
      "managed-leak": "LEAK",
      orphan: "orphan",
      stateless: "stateless",
      external: "external"
    }[group.kind] || group.kind;
    const tokensHtml = group.tokenTotals
      ? `<code>${formatTokens(group.tokenTotals.input_tokens)}</code> in / `
        + `<code>${formatTokens(group.tokenTotals.output_tokens)}</code> out / `
        + `<strong><code>${formatTokens(group.tokenTotals.total_tokens)}</code></strong> total`
        + ` <span class="muted">(${group.tokenTotals.sessions} session${group.tokenTotals.sessions === 1 ? "" : "s"}, deduped across ${group.processes.length} PID${group.processes.length === 1 ? "" : "s"})</span>`
      : `<span class="muted">— no token usage detected yet (codex session file may still be warming up)</span>`;
    return `<tr class="row-group-header row-group-${escapeHtml(group.kind)}">`
      + `<td colspan="10">`
      + `<div class="group-row">`
      + `<div class="group-row-left">`
      + `<span class="group-kind-badge group-kind-${escapeHtml(group.kind)}">${escapeHtml(kindLabel)}</span>`
      + `<span class="group-title">${escapeHtml(group.title)}</span>`
      + (group.subtitle ? `<span class="group-subtitle muted">${group.subtitle}</span>` : "")
      + `</div>`
      + `<div class="group-row-right">`
      + `<span class="group-tokens">${tokensHtml}</span>`
      + `</div>`
      + `</div>`
      + `</td>`
      + `</tr>`;
  }

  function renderProcessRow(entry, group) {
    const dot = entry.is_leak
      ? '<span class="leak-dot" title="LEAK — meridian-roles spawned this process but no dispatcher claims its thread_id"></span>'
      : entry.origin === "managed"
        ? '<span class="ok-dot" title="meridian-roles managed; bound to a running worker"></span>'
        : entry.origin === "hub"
          ? '<span class="warn-dot" title="meridian-hub managed; no local Meridian-roles dispatcher binding"></span>'
        : entry.origin === "orphan"
          ? '<span class="leak-dot" title="ORPHAN — codex/claude survived after its agentapi parent died"></span>'
          : '<span class="external-dot" title="external — not spawned by meridian-roles (terminal session, Claude Code, etc.)"></span>';

    const originTag = entry.origin === "managed"
      ? '<span class="origin-tag origin-managed">meridian-roles</span>'
      : entry.origin === "hub"
        ? '<span class="origin-tag origin-hub">meridian-hub</span>'
      : entry.origin === "orphan"
        ? '<span class="origin-tag origin-orphan">orphan</span>'
        : '<span class="origin-tag origin-external">external</span>';

    // Tree-indent the agent_type so the operator can see at a glance which row
    // is the parent (agentapi shim) and which are its descendants (codex node
    // shim → codex native). Depth comes from buildProcessGroups().
    const indent = entry._tree_depth || 0;
    const treeGlyph = indent > 0
      ? `<span class="tree-indent">${"&nbsp;&nbsp;".repeat(indent)}↳ </span>`
      : "";

    const worker = entry.binding
      ? `<code>${escapeHtml(entry.binding.worker_id)}</code> <span class="muted">(${escapeHtml(entry.binding.role)})</span>`
      : entry.is_leak
        ? '<span class="leak-callout">— no dispatcher claim —</span>'
        : '<span class="muted">—</span>';
    const dispatcher = entry.binding
      ? `<code>${escapeHtml(entry.binding.dispatcher_role_id)}</code>`
      : '<span class="muted">—</span>';
    const threadId = entry.thread_id
      ? `<code>${escapeHtml(entry.thread_id)}</code>`
      : '<span class="muted">—</span>';
    const baseClass = entry.is_leak
      ? "row-leak row-in-group"
      : entry.origin === "hub"
        ? "row-hub row-in-group"
      : entry.origin === "external"
        ? "row-external row-in-group"
        : "row-in-group";
    // One-shot green flash when total_tokens grew vs the previous tick. The
    // CSS animation runs once on row mount; since the tbody is re-rendered
    // per poll, each new increase naturally restarts it (no manual reset).
    const flashClass = entry._tokenIncreased ? "row-token-flash" : "";
    const klass = [baseClass, flashClass].filter(Boolean).join(" ");

    const tokens = renderTokenCell(entry, group);

    return `<tr class="${klass}">`
      + `<td>${dot}</td>`
      + `<td>${originTag}</td>`
      + `<td>${renderPid(entry.pid)}</td>`
      + `<td>${renderPid(entry.ppid, true)}</td>`
      + `<td>${treeGlyph}${escapeHtml(entry.agent_type ?? "?")}</td>`
      + `<td>${threadId}</td>`
      + `<td>${worker}</td>`
      + `<td>${dispatcher}</td>`
      + `<td>${escapeHtml(entry.etime ?? "")}</td>`
      + `<td>${tokens}</td>`
      + "</tr>";
  }

  function renderPid(pid, muted) {
    if (Number.isFinite(pid)) {
      return `<code${muted ? ' class="muted"' : ""}>${pid}</code>`;
    }
    return '<span class="muted">hub</span>';
  }

  function renderTokenCell(entry, group) {
    const u = entry.token_usage;
    if (!u) {
      // Empty cell would be misread as "I haven't measured this yet" — make
      // the reason explicit so the operator stops second-guessing whether the
      // worker is idle or whether the resolver is broken. agentapi rows are
      // never expected to carry tokens; codex/claude rows without tokens are
      // either pre-warmup (session file not yet on disk) or stripped because
      // a bound peer in the group already claimed the session_file.
      if (entry.agent_type === "agentapi") {
        return '<span class="muted token-cell-note" title="agentapi shim does not consume tokens itself — its child codex/claude does">shim (no tokens)</span>';
      }
      if (group && group.tokenTotals) {
        return '<span class="muted token-cell-note" title="tokens for this group are on the session-anchor PID; this row is part of the same group but is not the file owner">↑ see group total</span>';
      }
      return '<span class="muted">—</span>';
    }
    const inn = formatTokens(u.input_tokens);
    const out = formatTokens(u.output_tokens);
    const tot = formatTokens(u.total_tokens);
    const cached = u.cached_input_tokens > 0 ? ` <span class="muted">(${formatTokens(u.cached_input_tokens)} cached)</span>` : "";
    const tip = `source: ${u.source}\nsession_id: ${u.session_id || "(n/a)"}\nfile: ${u.session_file}\ninput: ${u.input_tokens}\ncached_input: ${u.cached_input_tokens}\noutput: ${u.output_tokens}\nreasoning_output: ${u.reasoning_output_tokens}\ntotal: ${u.total_tokens}`;
    // Session-anchor annotation: when more than one PID in the group resolves
    // to the same on-disk session file (agentapi shim + codex shim + codex
    // native all do, by design), only the first PID is the "session anchor";
    // the others show the same numbers but mark themselves as shared so it's
    // visually obvious those two cells are not double-counting.
    let sessionTag = "";
    if (group) {
      const anchor = group.processes.find(
        (p) => p.token_usage && p.token_usage.session_file === u.session_file
      );
      if (anchor && anchor.pid !== entry.pid) {
        sessionTag = ` <span class="session-shared muted" title="same session_file as PID ${anchor.pid}; the group total counts it once">↑ same session as PID ${anchor.pid}</span>`;
      } else if (group.processes.length > 1) {
        sessionTag = ` <span class="session-anchor" title="session anchor — this PID&apos;s session file drives the group total">session anchor</span>`;
      }
    }
    return `<span title="${escapeHtml(tip)}"><code>${inn}</code> in / <code>${out}</code> out / <code>${tot}</code> total${cached}</span>${sessionTag}`;
  }

  if (hideExternalToggle) {
    hideExternalToggle.addEventListener("change", render);
  }

  refresh();
  window.setInterval(refresh, PROCESS_POLL_INTERVAL_MS);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function truncateMiddle(value, max) {
  const s = String(value ?? "");
  if (s.length <= max || max < 6) return s;
  const keep = max - 1;
  const head = Math.ceil(keep / 2);
  const tail = Math.floor(keep / 2);
  return s.slice(0, head) + "…" + s.slice(s.length - tail);
}

function formatTokens(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return "0";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 10_000) return `${(n / 1_000).toFixed(1)}k`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(2)}k`;
  return String(Math.round(n));
}

function setupValidatorToggle() {
  const toggle = document.getElementById("agent-dispatcher-validator-enabled");
  const fields = document.getElementById("agent-dispatcher-validator-fields");
  if (!toggle || !fields) return;

  toggle.addEventListener("change", () => {
    fields.hidden = !toggle.checked;
  });
}

function collectValidatorConfig() {
  const toggle = document.getElementById("agent-dispatcher-validator-enabled");
  if (!toggle || !toggle.checked) return undefined;
  const agentType = document.getElementById("agent-dispatcher-validator-agent-type")?.value || "codex";
  const requestedMode = document.getElementById("agent-dispatcher-validator-mode")?.value;

  return {
    enabled: true,
    agent_type: agentType,
    mode: normalizeValidatorMode(agentType, requestedMode),
    model_id: document.getElementById("agent-dispatcher-validator-model-id")?.value?.trim() || undefined,
    credential_id: document.getElementById("agent-dispatcher-validator-credential-id")?.value?.trim() || undefined,
    threshold_type: document.getElementById("agent-dispatcher-validator-threshold-type")?.value || "score",
    pass_threshold: parseFloat(document.getElementById("agent-dispatcher-validator-pass-threshold")?.value) || 0.7,
    max_fix_cycles: parseInt(document.getElementById("agent-dispatcher-validator-max-fix-cycles")?.value, 10) || 3,
    base_branch: document.getElementById("agent-dispatcher-validator-base-branch")?.value?.trim() || "main"
  };
}

function normalizeValidatorMode(agentType, mode) {
  const normalizedMode = mode || (agentType === "codex" ? "stateless_call" : "bridge");
  if (normalizedMode === "stateless_call" && agentType !== "codex") {
    return "bridge";
  }
  return normalizedMode;
}

function setupPmResolverToggle(toggleId, fieldsId) {
  const toggle = document.getElementById(toggleId);
  const fields = document.getElementById(fieldsId);
  if (!toggle || !fields) return;

  const apply = () => {
    fields.hidden = !readBooleanControl(toggle, true);
  };
  toggle.addEventListener("change", apply);
  apply();
}

function collectPmResolverConfig(prefix) {
  const enabledControl = document.getElementById(`${prefix}-enabled`);
  const autoApproveControl = document.getElementById(`${prefix}-auto-approve`);
  const config = {
    enabled: readBooleanControl(enabledControl, true),
    agent_type: document.getElementById(`${prefix}-agent-type`)?.value || "codex",
    mode: document.getElementById(`${prefix}-mode`)?.value || "bridge",
    model_id: document.getElementById(`${prefix}-model-id`)?.value?.trim() || undefined,
    credential_id: document.getElementById(`${prefix}-credential-id`)?.value?.trim() || undefined,
    auto_approve: readBooleanControl(autoApproveControl, false)
  };
  const replyChannels = parseReplyChannelsTextarea(`${prefix}-reply-channels`);
  if (replyChannels) {
    config.user_reply_channels = replyChannels;
  }
  return config;
}

function collectParallelDispatchConfig(prefix, options = {}) {
  const enabledElement = document.getElementById(`${prefix}-enabled`);
  const maxElement = document.getElementById(`${prefix}-max-concurrency`);
  const enabled = enabledElement?.type === "checkbox"
    ? enabledElement.checked === true
    : enabledElement?.value === "true";
  const rawMax = parseInt(maxElement?.value, 10);
  const maxConcurrency = Number.isFinite(rawMax) && rawMax > 0 ? rawMax : 1;
  const minEnabledConcurrency = options.minEnabledConcurrency ?? 2;

  if (enabled && maxConcurrency < minEnabledConcurrency) {
    throw new Error(`max_concurrency must be at least ${minEnabledConcurrency} when parallel dispatch is enabled.`);
  }

  return {
    enabled,
    max_concurrency: enabled ? maxConcurrency : 1
  };
}

function setupParallelDispatchToggle(prefix) {
  const enabled = document.getElementById(`${prefix}-enabled`);
  const fields = document.getElementById(`${prefix}-fields`);
  if (!enabled || !fields) {
    return;
  }

  const refresh = () => {
    fields.hidden = enabled.checked !== true;
  };
  enabled.addEventListener("change", refresh);
  refresh();
}

function collectPmResolverElements(prefix) {
  return [
    `${prefix}-enabled`,
    `${prefix}-agent-type`,
    `${prefix}-mode`,
    `${prefix}-model-id`,
    `${prefix}-auto-approve`,
    `${prefix}-reply-channels`
  ].map((id) => document.getElementById(id)).filter(Boolean);
}

function readBooleanControl(control, defaultValue) {
  if (!control) return defaultValue;
  if (typeof control.checked === "boolean" && control.type === "checkbox") {
    return control.checked;
  }
  if (typeof control.value === "string") {
    return control.value === "true";
  }
  return defaultValue;
}

function parseReplyChannelsTextarea(id) {
  const value = document.getElementById(id)?.value?.trim();
  if (!value) return undefined;

  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("pm user_reply_channels must be a JSON array.");
  }
  if (!Array.isArray(parsed)) {
    throw new Error("pm user_reply_channels must be a JSON array.");
  }
  return parsed;
}

/* ═══════════════════════════════════════════════════════════════
   Credential selectors (multi-codex credentials)
   ═══════════════════════════════════════════════════════════════
   Populates every `<select data-credential-select>` on the current
   page with the operator-visible credential list returned by
   meridian-hub's `GET /api/credentials`. Revoked credentials are
   filtered out client-side so operators can't pick a dead entry.
   The default option ("Use default codex login (~/.codex)") is
   preserved at value `""`; the form serializers map blank to
   omission of `credential_id` so the Hub keeps its default path. */
async function loadCredentialSelectors() {
  const selects = Array.from(document.querySelectorAll("select[data-credential-select]"));
  if (selects.length === 0) return;

  let credentials;
  try {
    const payload = await fetchJson("/api/credentials");
    credentials = Array.isArray(payload?.credentials) ? payload.credentials : [];
  } catch (error) {
    // Surfacing the failure in a feedback element is left to each page; for
    // now we leave the selects with just the "default" option so spawn still
    // works. Logging keeps the failure visible in devtools.
    console.warn("Failed to load /api/credentials:", error);
    return;
  }

  const usable = credentials.filter((entry) => entry && entry.revoked_at === null);

  for (const select of selects) {
    const preserved = select.value;
    // Remove every option except the leading "default" placeholder (value "")
    Array.from(select.querySelectorAll("option")).forEach((option, index) => {
      if (index === 0 && option.value === "") {
        return;
      }
      option.remove();
    });

    for (const cred of usable) {
      const option = document.createElement("option");
      option.value = cred.credential_id;
      const label = typeof cred.credential_label === "string" && cred.credential_label.trim().length > 0
        ? cred.credential_label
        : cred.credential_id;
      option.textContent = cred.is_default ? `${label} (default)` : label;
      select.appendChild(option);
    }

    // Restore previously-selected value if it still exists; otherwise keep default
    if (preserved && Array.from(select.options).some((opt) => opt.value === preserved)) {
      select.value = preserved;
    }
  }
}

/* ═══════════════════════════════════════════════════════════════
   Scheduler Creation (taskspec-compatible)
   ═══════════════════════════════════════════════════════════════ */

function setupSchedulerCreation() {
  const form = document.getElementById("create-scheduler-form");
  const feedback = document.getElementById("create-scheduler-feedback");
  const taskspecDirInput = document.getElementById("new-scheduler-taskspec-dir");
  const planPathInput = document.getElementById("new-scheduler-plan-path");
  const reportDirInput = document.getElementById("new-scheduler-report-dir");

  if (!form || !feedback) return;

  // Auto-fill plan path from taskspec_dir
  if (taskspecDirInput && planPathInput) {
    taskspecDirInput.addEventListener("change", () => {
      const dir = taskspecDirInput.value.trim();
      if (dir && !planPathInput.value.trim()) {
        const normalized = dir.endsWith("/") ? dir.slice(0, -1) : dir;
        const projectRoot = normalized.endsWith("/taskspec") ? normalized.slice(0, -"/taskspec".length) : normalized;
        const projectName = projectRoot.split("/").filter(Boolean).pop() || "dispatch";
        planPathInput.value = `${normalized}/${projectName}-plan.md`;
        if (reportDirInput && !reportDirInput.value.trim()) {
          reportDirInput.value = `${projectRoot}/reports`;
        }
      }
    });

    taskspecDirInput.addEventListener("blur", () => {
      taskspecDirInput.dispatchEvent(new Event("change"));
    });
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    feedback.textContent = "Creating scheduler...";

    const config = {};
    const mode = form.scheduler_mode?.value;
    config.scheduler_mode = mode || "none";

    const planPath = form.dispatch_plan_path?.value?.trim();
    if (!planPath) {
      feedback.textContent = "dispatch_plan_path is required.";
      return;
    }
    config.dispatch_plan_path = planPath;

    const reportBaseDir = form.report_base_dir?.value?.trim();
    if (!reportBaseDir) {
      feedback.textContent = "report_base_dir is required.";
      return;
    }

    // Derive command_file_path from plan path
    const planDir = planPath.substring(0, planPath.lastIndexOf("/"));
    config.command_file_path = `${planDir}/agent_dispatch_command.md`;

    if (form.cron_expression?.value) config.cron_expression = form.cron_expression.value;
    if (form.timezone?.value) config.timezone = form.timezone.value;
    if (form.interval_seconds?.value) config.interval_seconds = parseInt(form.interval_seconds.value, 10);
    if (form.max_cycles?.value) config.max_cycles = parseInt(form.max_cycles.value, 10);
    if (form.delay_between_cycles_seconds?.value) {
      config.delay_between_cycles_seconds = parseInt(form.delay_between_cycles_seconds.value, 10);
    }
    if (form.scan_run_id_strategy?.value && form.scan_run_id_strategy.value !== "none") {
      config.scan_run_id_strategy = form.scan_run_id_strategy.value;
      if (form.scan_run_id_prefix?.value?.trim()) {
        config.scan_run_id_prefix = form.scan_run_id_prefix.value.trim();
      }
    }
    if (form.dispatch_repo_root?.value) config.dispatch_repo_root = form.dispatch_repo_root.value;
    if (form.docs_root?.value) config.docs_root = form.docs_root.value;
    if (form.agent_type?.value) config.agent_type = form.agent_type.value;
    if (form.model_id?.value?.trim()) config.model_id = form.model_id.value.trim();
    config.mode = form.mode?.value || "bridge";
    config.auto_approve = form.auto_approve?.checked === true;
    try {
      config.pm_resolver = collectPmResolverConfig("new-scheduler-pm");
    } catch (error) {
      feedback.textContent = getErrorMessage(error);
      return;
    }

    config.report_base_dir = reportBaseDir;
    if (form.catch_up_policy?.value) config.catch_up_policy = form.catch_up_policy.value;

    // Default reply channel for scheduler
    config.user_reply_channels = [{ channel: "web", chat_id: "web:ops" }];

    try {
      const result = await fetchJson("/api/scheduler", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ config })
      });

      const schedulerId = result?.scheduler_id || result?.thread_id || "unknown";
      feedback.textContent = `Scheduler ${schedulerId} created.`;
      form.reset();
    } catch (error) {
      feedback.textContent = getErrorMessage(error);
    }
  });
}

function setupSchedulerDetail() {
  const schedulerId = window.location.pathname.split("/").filter(Boolean).pop();
  if (!schedulerId) {
    return;
  }

  let configFormDirty = false;
  let configFormSaving = false;
  let workerActionsBound = false;

  const poll = async () => {
    try {
      const data = await fetchJson(`/api/scheduler/${encodeURIComponent(schedulerId)}`);
      renderSchedulerDetail(data, {
        configFormDirty,
        configFormSaving
      });
    } catch (error) {
      const feedback = document.getElementById("control-feedback");
      if (feedback) {
        feedback.textContent = getErrorMessage(error);
      }
    }
  };

  bindSchedulerControls(schedulerId);
  bindSchedulerConfigForm(schedulerId, poll, {
    setDirty: (dirty) => {
      configFormDirty = dirty;
    },
    setSaving: (saving) => {
      configFormSaving = saving;
    }
  });

  if (!workerActionsBound) {
    workerActionsBound = true;
    const dispatchPlanBody = document.getElementById("dispatch-progress-body")
      || document.getElementById("dispatch-plan-body");
    const dispatchPlanFeedback = document.getElementById("dispatch-progress-feedback")
      || document.getElementById("dispatch-plan-feedback");
    if (dispatchPlanBody) {
      bindDispatchDetailActions(dispatchPlanBody, dispatchPlanFeedback, {
        humanResolveUrl: (workerId) =>
          `/api/scheduler/${encodeURIComponent(schedulerId)}/worker/${encodeURIComponent(workerId)}/human-resolve`,
        hubRelayUrl: () => `/api/hub-relay`,
        afterAction: poll
      });
    }
    bindSchedulerWorkerActions(schedulerId, poll);
  }

  void poll();
  setInterval(poll, POLL_INTERVAL_MS);
}

function renderSchedulerDetail(data, state) {
  if (!data || !data.ok) {
    return;
  }

  const config = data.config || {};
  const runState = data.run_state || {};
  const status = runState.status || "idle";
  const statusLabel = status.replace(/_/g, " ");

  setElementText("scheduler-title", `Scheduler: ${data.scheduler_id}`);
  setElementText("scheduler-plan-path", config.dispatch_plan_path || "---");
  setElementText("s-id", data.scheduler_id);
  setElementText("s-mode", config.scheduler_mode || "none");
  setElementText("s-status", status);
  setElementText("s-status-val", statusLabel);
  setElementText("s-completed-cycles", runState.completed_cycles ?? 0);
  setElementText("s-next-run-val", formatTimeShort(runState.next_run_at));
  setElementText("s-last-outcome-val", runState.last_run_outcome || "---");
  setElementText("s-next-run", runState.next_run_at || "---");
  setElementText("s-active-run", runState.current_run_id || "---");
  setElementText("s-active-run-report-dir", runState.current_run_report_dir || "---");
  setElementText("s-dispatcher-thread", runState.current_dispatcher_thread_id || "---");
  setElementText("s-last-report", runState.last_report_path || "---");

  const badge = document.getElementById("scheduler-status-badge");
  if (badge) {
    badge.textContent = statusLabel;
    badge.className = `status-badge ${statusClass(status)}`;
  }

  if (!state.configFormDirty && !state.configFormSaving) {
    setElementValue("cfg-mode", config.scheduler_mode);
    setElementValue("cfg-cron", config.cron_expression);
    setElementValue("cfg-timezone", config.timezone);
    setElementValue("cfg-interval", config.interval_seconds);
    setElementValue("cfg-max-cycles", config.max_cycles);
    setElementValue("cfg-delay", config.delay_between_cycles_seconds);
    setElementValue("cfg-scan-run-id-strategy", config.scan_run_id_strategy || "none");
    setElementValue("cfg-scan-run-id-prefix", config.scan_run_id_prefix || "");
    setElementValue("cfg-dispatch-repo-root", config.dispatch_repo_root);
    setElementValue("cfg-docs-root", config.docs_root);
    setElementValue("cfg-agent-type", config.agent_type || "claude");
    setElementValue("cfg-model-id", config.model_id || "");
    setElementValue("cfg-agent-mode", config.mode || "bridge");
    setElementValue("cfg-report-dir", config.report_base_dir);
    setElementValue("cfg-catchup", config.catch_up_policy);
    const pm = config.pm_resolver || {};
    setElementValue("cfg-pm-enabled", String(pm.enabled !== false));
    setElementValue("cfg-pm-agent-type", pm.agent_type || "codex");
    setElementValue("cfg-pm-mode", pm.mode || "bridge");
    setElementValue("cfg-pm-model-id", pm.model_id || "");
    setElementValue("cfg-pm-auto-approve", String(pm.auto_approve === true));
    setElementValue("cfg-pm-reply-channels", pm.user_reply_channels ? JSON.stringify(pm.user_reply_channels, null, 2) : "");
  }

  setElementText(
    "next-run-preview",
    data.next_run_preview ? `Next cron preview: ${data.next_run_preview}` : ""
  );

  renderSchedulerDispatchProgress(data);
  renderSchedulerRunHistory(runState.run_history || []);
}

function bindSchedulerControls(schedulerId) {
  document.querySelectorAll("[data-action]").forEach((button) => {
    button.addEventListener("click", async () => {
      const action = button.dataset.action;
      const feedback = document.getElementById("control-feedback");
      if (!action || !feedback) {
        return;
      }

      feedback.textContent = "";

      try {
        const data = await fetchJson(`/api/scheduler/${encodeURIComponent(schedulerId)}/${action}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}"
        });
        feedback.textContent = data?.ok ? `${action}: OK` : (data?.error || "Failed");
      } catch (error) {
        feedback.textContent = getErrorMessage(error);
      }
    });
  });
}

function bindSchedulerConfigForm(schedulerId, poll, state) {
  const configForm = document.getElementById("config-form");
  if (!configForm) {
    return;
  }

  configForm.addEventListener("input", () => {
    state.setDirty(true);
  });
  configForm.addEventListener("change", () => {
    state.setDirty(true);
  });
  configForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const feedback = document.getElementById("config-feedback");
    if (feedback) {
      feedback.textContent = "";
    }

    const form = event.target;
    const body = {};
    const mode = form.scheduler_mode.value;
    body.scheduler_mode = mode;
    if (form.cron_expression.value) body.cron_expression = form.cron_expression.value;
    if (form.timezone.value) body.timezone = form.timezone.value;
    if (form.interval_seconds.value) body.interval_seconds = parseInt(form.interval_seconds.value, 10);
    if (form.max_cycles.value) body.max_cycles = parseInt(form.max_cycles.value, 10);
    if (form.delay_between_cycles_seconds.value) {
      body.delay_between_cycles_seconds = parseInt(form.delay_between_cycles_seconds.value, 10);
    }
    body.scan_run_id_strategy = form.scan_run_id_strategy.value || "none";
    body.scan_run_id_prefix = form.scan_run_id_prefix.value.trim() || null;
    if (form.dispatch_repo_root.value) body.dispatch_repo_root = form.dispatch_repo_root.value;
    if (form.docs_root.value) body.docs_root = form.docs_root.value;
    if (form.agent_type.value) body.agent_type = form.agent_type.value;
    body.model_id = form.model_id.value.trim() || null;
    if (form.mode.value) body.mode = form.mode.value;
    if (form.report_base_dir.value) body.report_base_dir = form.report_base_dir.value;
    if (form.catch_up_policy.value) body.catch_up_policy = form.catch_up_policy.value;
    try {
      body.pm_resolver = collectPmResolverConfig("cfg-pm");
    } catch (error) {
      if (feedback) {
        feedback.textContent = getErrorMessage(error);
      }
      return;
    }

    state.setSaving(true);
    try {
      const data = await fetchJson(`/api/scheduler/${encodeURIComponent(schedulerId)}/config`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      });
      if (feedback) {
        feedback.textContent = data?.ok ? "Config saved" : (data?.error || "Failed");
      }
      if (data?.ok) {
        state.setDirty(false);
        state.setSaving(false);
        await poll();
      }
    } catch (error) {
      if (feedback) {
        feedback.textContent = getErrorMessage(error);
      }
    } finally {
      state.setSaving(false);
    }
  });
}

function bindSchedulerWorkerActions(schedulerId, poll) {
  const dispatchPlanBody = document.getElementById("dispatch-progress-body");
  const dispatchPlanFeedback = document.getElementById("dispatch-progress-feedback");
  if (!dispatchPlanBody) {
    return;
  }

  dispatchPlanBody.addEventListener("click", async (event) => {
    const actionTarget = event.target instanceof Element
      ? event.target.closest("[data-continue-worker], [data-resume-action], [data-status-apply]")
      : null;
    if (!(actionTarget instanceof HTMLButtonElement)) {
      return;
    }

    const workerId = actionTarget.getAttribute("data-worker-id");
    if (!workerId) {
      return;
    }

    const resumeAction = actionTarget.getAttribute("data-resume-action");
    const isContinueWorker = actionTarget.hasAttribute("data-continue-worker");
    const isStatusApply = actionTarget.hasAttribute("data-status-apply");
    if (!isContinueWorker && !resumeAction && !isStatusApply) {
      return;
    }

    if (
      resumeAction === "force-complete"
      && !window.confirm(
        `Force Complete will mark ${workerId} as complete and may unblock downstream workers on incomplete output. Continue?`
      )
    ) {
      return;
    }

    setDispatchPlanControlsDisabled(dispatchPlanBody, true);

    try {
      if (isContinueWorker) {
        if (dispatchPlanFeedback) {
          dispatchPlanFeedback.textContent = `Continuing ${workerId}...`;
        }

        const continued = await fetchJson(
          `/api/scheduler/${encodeURIComponent(schedulerId)}/worker/${encodeURIComponent(workerId)}/continue`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: "{}"
          }
        );

        if (dispatchPlanFeedback) {
          dispatchPlanFeedback.textContent = formatContinueResult(continued);
        }
      } else if (resumeAction) {
        if (dispatchPlanFeedback) {
          dispatchPlanFeedback.textContent = `${formatResumeActionLabel(resumeAction)} ${workerId}...`;
        }

        const payload = resumeAction === "force-complete"
          ? { action: resumeAction, force: true }
          : { action: resumeAction };

        await fetchJson(
          `/api/scheduler/${encodeURIComponent(schedulerId)}/worker/${encodeURIComponent(workerId)}/resume`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
          }
        );

        if (dispatchPlanFeedback) {
          dispatchPlanFeedback.textContent = `${workerId} ${formatResumeActionSuccess(resumeAction)}.`;
        }
            } else if (isStatusApply) {
              const rowElement = actionTarget.closest("tr");
              const statusSelect = rowElement?.querySelector("[data-worker-status]");
              const modelSelect = rowElement?.querySelector("[data-worker-model]");
              const effortSelect = rowElement?.querySelector("[data-worker-effort]");
              if (!(statusSelect instanceof HTMLSelectElement)) {
                throw new Error(`No status selector found for ${workerId}`);
              }
              const statusValue = statusSelect.value;
              const modelOverride = modelSelect instanceof HTMLSelectElement && modelSelect.value.trim()
                ? modelSelect.value.trim()
                : null;
              const effortOverride = effortSelect instanceof HTMLSelectElement && effortSelect.value.trim()
                ? effortSelect.value.trim()
                : null;

              if (dispatchPlanFeedback) {
                dispatchPlanFeedback.textContent = `Updating ${workerId} to ${formatDispatchStatusLabel(statusValue)}...`;
              }

              // Reset-to-pending must clear hub_result, otherwise the lifecycle
              // store re-derives ⛔ BLOCKED from the stale signal and overwrites
              // the plan markdown back. resume-worker (action=retry) clears it;
              // update-status does not.
              if (statusValue === "pending") {
                await fetchJson(
                  `/api/scheduler/${encodeURIComponent(schedulerId)}/worker/${encodeURIComponent(workerId)}/resume`,
                  {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ action: "retry" })
                  }
                );
              }

              if (statusValue !== "pending" || modelOverride || effortOverride) {
                const payload = { status: statusValue };
                if (modelOverride) {
                  payload.model = modelOverride;
                }
                if (effortOverride) {
                  payload.reasoning_effort = effortOverride;
                }
                await fetchJson(
                  `/api/scheduler/${encodeURIComponent(schedulerId)}/worker/${encodeURIComponent(workerId)}/status`,
                  {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(payload)
                  }
                );
              }

              if (dispatchPlanFeedback) {
                dispatchPlanFeedback.textContent = `${workerId} ${formatDispatchStatusSuccess(statusValue)}.`;
              }
            }

      await poll();
    } catch (error) {
      if (dispatchPlanFeedback) {
        dispatchPlanFeedback.textContent = getErrorMessage(error);
      }
    } finally {
      setDispatchPlanControlsDisabled(dispatchPlanBody, false);
    }
  });
}

function bindDispatchDetailActions(rootEl, feedbackEl, options) {
  if (!rootEl || rootEl.dataset.detailActionsBound === "true") {
    return;
  }
  rootEl.dataset.detailActionsBound = "true";

  const setFeedback = (message) => {
    if (feedbackEl) {
      feedbackEl.textContent = message;
    }
  };

  rootEl.addEventListener("click", async (event) => {
    const button = event.target instanceof Element
      ? event.target.closest("button[data-detail-action='human-resolve']")
      : null;
    if (!(button instanceof HTMLButtonElement)) {
      return;
    }
    event.preventDefault();
    const workerId = button.getAttribute("data-detail-worker-id");
    if (!workerId) {
      return;
    }
    const note = window.prompt(
      `Mark ${workerId} as HUMAN-resolved? This sets the worker to running, reconciles any failed PM resolver entries, and stamps a HUMAN-resolved badge. Optional note:`,
      ""
    );
    if (note === null) {
      return;
    }
    button.disabled = true;
    setFeedback(`Marking ${workerId} HUMAN-resolved...`);
    try {
      await fetchJson(options.humanResolveUrl(workerId), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ note: note.trim() ? note.trim() : undefined })
      });
      setFeedback(`${workerId} marked HUMAN-resolved.`);
      if (typeof options.afterAction === "function") {
        await options.afterAction();
      }
    } catch (error) {
      setFeedback(getErrorMessage(error));
    } finally {
      button.disabled = false;
    }
  });

  rootEl.addEventListener("submit", async (event) => {
    const form = event.target instanceof Element
      ? event.target.closest("form[data-detail-action='talk']")
      : null;
    if (!(form instanceof HTMLFormElement)) {
      return;
    }
    event.preventDefault();
    const threadIdAttr = form.getAttribute("data-detail-thread-id");
    const detailKind = form.getAttribute("data-detail-kind") || "worker";
    const textarea = form.querySelector("textarea[name='content']");
    const submitBtn = form.querySelector("button[type='submit']");
    const localFeedback = form.querySelector("[data-talk-feedback]");
    const transcriptEl = form.querySelector("[data-talk-transcript]");
    const talkKey = form.getAttribute("data-talk-key") || `${detailKind}:${threadIdAttr}`;
    if (!threadIdAttr || !(textarea instanceof HTMLTextAreaElement)) {
      return;
    }
    const content = textarea.value.trim();
    if (!content) {
      if (localFeedback) {
        localFeedback.textContent = "Type a message before sending.";
      }
      return;
    }
    if (submitBtn instanceof HTMLButtonElement) {
      submitBtn.disabled = true;
    }
    if (localFeedback) {
      localFeedback.textContent = `Waiting for ${detailKind} reply...`;
    }
    setFeedback(`Sending message to ${detailKind} thread ${threadIdAttr}...`);
    const sentAt = new Date().toISOString();
    try {
      const result = await sendDirectHubMessage({
        hubRelayUrl: options.hubRelayUrl,
        threadId: threadIdAttr,
        content
      });
      textarea.value = "";
      const entries = appendDirectTalkTranscript(options.directTalkTranscripts, talkKey, {
        sentAt,
        targetLabel: formatOwnerKindLabel(detailKind),
        targetThread: threadIdAttr,
        request: content,
        reply: result
      });
      renderDirectTalkTranscriptContainer(transcriptEl, entries);
      if (localFeedback) {
        localFeedback.textContent = "Reply received.";
      }
      setFeedback(`Reply received from ${detailKind} thread ${threadIdAttr}.`);
    } catch (error) {
      const msg = getErrorMessage(error);
      const entries = appendDirectTalkTranscript(options.directTalkTranscripts, talkKey, {
        sentAt,
        targetLabel: formatOwnerKindLabel(detailKind),
        targetThread: threadIdAttr,
        request: content,
        error: msg
      });
      renderDirectTalkTranscriptContainer(transcriptEl, entries);
      if (localFeedback) {
        localFeedback.textContent = msg;
      }
      setFeedback(msg);
    } finally {
      if (submitBtn instanceof HTMLButtonElement) {
        submitBtn.disabled = false;
      }
    }
  });
}

async function sendDirectHubMessage({ hubRelayUrl, threadId, content }) {
  const message = {
    trace_id: createHubTraceId(),
    thread_id: threadId,
    actor_id: "service:meridian-roles",
    intent: "run",
    target: threadId,
    priority: 5,
    mode: "bridge",
    reply_channel: { channel: "web", chat_id: "service:meridian-roles" },
    payload: { content, attachments: [] }
  };

  return fetchJson(hubRelayUrl(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(message)
  });
}

function createHubTraceId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  const hex = () => Math.floor(Math.random() * 0x10000).toString(16).padStart(4, "0");
  const variant = (8 + Math.floor(Math.random() * 4)).toString(16);
  return `${hex()}${hex()}-${hex()}-4${hex().slice(1)}-${variant}${hex().slice(1)}-${hex()}${hex()}${hex()}`;
}

function appendDirectTalkTranscript(transcripts, key, entry) {
  if (!transcripts || !key) {
    return [entry];
  }

  const entries = transcripts.get(key) ?? [];
  const nextEntries = [...entries, entry].slice(-6);
  transcripts.set(key, nextEntries);
  return nextEntries;
}

function hydrateDirectTalkTranscripts(rootEl, transcripts) {
  if (!rootEl || !transcripts) {
    return;
  }

  rootEl.querySelectorAll("[data-talk-transcript][data-talk-key]").forEach((container) => {
    const key = container.getAttribute("data-talk-key");
    renderDirectTalkTranscriptContainer(container, key ? transcripts.get(key) ?? [] : []);
  });
}

function renderDirectTalkTranscriptContainer(container, entries) {
  if (!container) {
    return;
  }

  const safeEntries = Array.isArray(entries) ? entries : [];
  container.hidden = safeEntries.length === 0;
  container.innerHTML = safeEntries.length > 0
    ? safeEntries.map(renderDirectTalkTranscriptEntry).join("")
    : "";
}

function renderDirectTalkTranscriptEntry(entry) {
  const sentAt = formatTimestamp(entry.sentAt);
  const targetLabel = entry.targetLabel || "thread";
  const targetThread = entry.targetThread || "---";
  const status = entry.error
    ? "error"
    : [entry.reply?.status, entry.reply?.run_state].filter(Boolean).join(" / ") || "reply";
  const replyLabel = entry.error ? "No Reply Captured" : "Reply";
  const replyContent = entry.error
    ? entry.error
    : formatDirectTalkReplyContent(entry.reply);

  return `
    <article class="dispatch-direct-reply ${entry.error ? "dispatch-direct-reply-error" : ""}">
      <div class="dispatch-direct-reply-meta">
        <span>${escapeHtml(targetLabel)} <code>${escapeHtml(targetThread)}</code></span>
        <span>${escapeHtml(sentAt)} / ${escapeHtml(status)}</span>
      </div>
      <div class="dispatch-direct-reply-grid">
        <div class="dispatch-direct-message">
          <p>You</p>
          <pre>${escapeHtml(entry.request || "")}</pre>
        </div>
        <div class="dispatch-direct-message">
          <p>${escapeHtml(replyLabel)}</p>
          <pre>${escapeHtml(replyContent)}</pre>
        </div>
      </div>
    </article>
  `;
}

function formatDirectTalkReplyContent(reply) {
  if (!reply) {
    return "Reply returned without content.";
  }

  const content = normalizeText(reply.content);
  if (content) {
    return content;
  }

  return [
    normalizeText(reply.summary_text),
    normalizeText(reply.details_text)
  ].filter(Boolean).join("\n\n") || "Reply returned without content.";
}

function renderSchedulerDispatchProgress(data) {
  const summaryEl = document.getElementById("dispatch-progress-summary");
  const errorEl = document.getElementById("dispatch-progress-error");
  const emptyEl = document.getElementById("dispatch-progress-empty");
  const table = document.getElementById("dispatch-progress-table");
  const tbody = document.getElementById("dispatch-progress-body");

  if (!summaryEl || !errorEl || !emptyEl || !table || !tbody) {
    return;
  }

  const error = data.dispatch_status_error;
  if (error) {
    errorEl.hidden = false;
    errorEl.textContent = `Dispatch status error: ${error}`;
  } else {
    errorEl.hidden = true;
    errorEl.textContent = "";
  }

  const report = data.dispatch_status || {};
  const workers = Array.isArray(report.workers) ? report.workers : [];
  const rows = Array.isArray(data.dispatch_plan?.rows) && data.dispatch_plan.rows.length > 0
    ? data.dispatch_plan.rows
    : workers.map(schedulerWorkerStatusToDispatchRow);
  const details = Array.isArray(data.dispatch_details) ? data.dispatch_details : [];

  if (rows.length === 0 && details.length === 0) {
    table.hidden = true;
    emptyEl.hidden = false;
    summaryEl.textContent = error ? "Unable to load dispatch plan progress." : "No dispatch rows loaded.";
    tbody.innerHTML = "";
    return;
  }

  table.hidden = false;
  emptyEl.hidden = true;

  const summary = report.summary || {};
  const generated = formatTimestamp(report.generated_at);
  summaryEl.textContent =
    `${summary.total ?? rows.length} total, ${summary.pending ?? 0} pending, ${summary.running ?? 0} running, ` +
    `${summary.completed ?? 0} completed, ${summary.failed ?? 0} failed, ${summary.skipped ?? 0} skipped, ` +
    `${summary.stale ?? 0} stale. Updated ${generated}.`;

  tbody.innerHTML = renderSchedulerDispatchProgressRows(rows, details, workers);
}

function renderSchedulerDispatchProgressRows(rows, dispatchDetails, workers) {
  const detailByWorker = groupDispatchDetailsByWorker(dispatchDetails);
  const workerStatusByWorker = indexSchedulerWorkerStatusByWorker(workers);
  const renderedRows = [];

  rows.forEach((row) => {
    const normalizedRow = normalizeSchedulerDispatchRow(row, workerStatusByWorker);
    const workerKey = normalizeDispatchWorkerKey(normalizedRow.worker);
    const inlineDetails = workerKey ? detailByWorker.get(workerKey) ?? [] : [];
    if (workerKey) {
      detailByWorker.delete(workerKey);
    }
    renderedRows.push(renderSchedulerDispatchProgressRow(normalizedRow, inlineDetails));
  });

  detailByWorker.forEach((details) => {
    const primaryDetail = getPrimaryDispatchDetail(details);
    const syntheticRow = normalizeSchedulerDispatchRow(buildDispatchPlanSyntheticRow(primaryDetail), workerStatusByWorker);
    renderedRows.push(renderSchedulerDispatchProgressRow(syntheticRow, details, true));
  });

  return renderedRows.join("");
}

function renderSchedulerDispatchProgressRow(row, details = [], orphan = false) {
  const inlineDetails = normalizeDispatchDetailList(details);
  const issue = row.failure_reason || row.issue || row.stale_duration_human || "---";
  const issueLabel = row.stale && !row.failure_reason ? `stale ${issue}` : issue;
  const rowClassName = [
    "dispatch-plan-row",
    inlineDetails.length > 0 ? "dispatch-plan-row-with-detail" : "",
    orphan ? "dispatch-plan-row-orphan" : ""
  ].filter(Boolean).join(" ");

  return `
    <tr class="${rowClassName}">
      <td>${renderDispatchPlanStatus(row)}</td>
      <td><span class="status-badge ${statusClass(row.lifecycle_status || row.lifecycle || row.status)}">${escapeHtml(row.lifecycle_status || row.lifecycle || row.status || "---")}</span></td>
      <td>${escapeHtml(row.batch || "---")}</td>
      <td><code>${escapeHtml(row.worker || "---")}</code></td>
      <td>${escapeHtml(row.task || "---")}</td>
      <td>${formatToolProgress(row.progress)}</td>
      <td>${escapeHtml(row.model || "---")}</td>
      <td>${escapeHtml(formatDepends(row.depends_on))}</td>
      <td>${renderActiveOwner(row)}</td>
      <td>${escapeHtml(issueLabel)}</td>
      <td>${renderDispatchPlanActions(row)}</td>
    </tr>
    ${inlineDetails.length > 0 ? renderDispatchPlanDetailRow(inlineDetails, 11) : ""}
  `;
}

function indexSchedulerWorkerStatusByWorker(workers) {
  const byWorker = new Map();
  workers.forEach((worker) => {
    const workerKey = normalizeDispatchWorkerKey(worker?.worker_id || worker?.worker);
    if (workerKey && !byWorker.has(workerKey)) {
      byWorker.set(workerKey, worker);
    }
  });
  return byWorker;
}

function normalizeSchedulerDispatchRow(row, workerStatusByWorker) {
  const workerId = row?.worker || row?.worker_id || "";
  const workerStatus = workerStatusByWorker.get(normalizeDispatchWorkerKey(workerId)) || {};
  return {
    ...workerStatus,
    ...row,
    worker: workerId,
    status: row?.status || workerStatus.status || "pending",
    lifecycle_status: row?.lifecycle_status || workerStatus.lifecycle_status || workerStatus.lifecycle || row?.status || "pending",
    batch: row?.batch || workerStatus.batch || "---",
    task: row?.task || workerStatus.task || "---",
    progress: row?.progress || workerStatus.progress || null,
    model: row?.model || workerStatus.model || "---",
    depends_on: row?.depends_on ?? workerStatus.depends_on,
    thread_id: row?.thread_id || row?.worker_thread_id || workerStatus.thread_id || workerStatus.worker_thread_id || "",
    active_owner_kind: row?.active_owner_kind ?? workerStatus.active_owner_kind ?? null,
    active_owner_thread_id: row?.active_owner_thread_id ?? workerStatus.active_owner_thread_id ?? "",
    failure_reason: row?.failure_reason || workerStatus.failure_reason || "",
    stale: Boolean(row?.stale || workerStatus.stale),
    stale_duration_human: row?.stale_duration_human || workerStatus.stale_duration_human || "",
    show_status_editor: true
  };
}

function schedulerWorkerStatusToDispatchRow(worker) {
  return {
    status: worker?.status || "pending",
    lifecycle_status: worker?.lifecycle_status || worker?.lifecycle || worker?.status || "pending",
    batch: worker?.batch || "---",
    worker: worker?.worker || worker?.worker_id || "",
    task: worker?.task || "---",
    progress: worker?.progress || null,
    model: worker?.model || "---",
    depends_on: worker?.depends_on,
    thread_id: worker?.thread_id || worker?.worker_thread_id || "",
    active_owner_kind: worker?.active_owner_kind ?? null,
    active_owner_thread_id: worker?.active_owner_thread_id ?? "",
    failure_reason: worker?.failure_reason || "",
    stale: Boolean(worker?.stale),
    stale_duration_human: worker?.stale_duration_human || "",
    show_status_editor: true
  };
}

function renderSchedulerRunHistory(runHistory) {
  const runs = Array.isArray(runHistory) ? runHistory.slice().reverse() : [];
  const tbody = document.getElementById("run-history-body");
  const table = document.getElementById("run-history-table");
  const empty = document.getElementById("run-history-empty");
  if (!tbody || !table || !empty) {
    return;
  }

  if (runs.length === 0) {
    table.hidden = true;
    empty.hidden = false;
    tbody.innerHTML = "";
    return;
  }

  table.hidden = false;
  empty.hidden = true;
  tbody.innerHTML = runs.map((run) => {
    const outcome = run.terminal_outcome || "";
    const outcomeClass = outcome.includes("completed") ? "outcome-completed"
      : outcome.includes("failed") ? "outcome-failed"
        : "outcome-cancelled";
    return `<tr>
      <td title="${escapeHtml(run.run_id || "")}"><code>${escapeHtml((run.run_id || "").slice(0, 8))}</code></td>
      <td>${escapeHtml(formatTimestamp(run.actual_start_time))}</td>
      <td>${escapeHtml(formatTimestamp(run.completed_time))}</td>
      <td>${run.duration_seconds != null ? `${escapeHtml(run.duration_seconds)}s` : "---"}</td>
      <td class="${outcomeClass}">${escapeHtml(outcome || "---")}</td>
    </tr>`;
  }).join("");
}

/* ═══════════════════════════════════════════════════════════════
   Dashboard Setup
   ═══════════════════════════════════════════════════════════════ */

async function setupDashboard() {
  setupTabNavigation();
  setupCreateRoleMenu();
  setupValidatorToggle();
  setupParallelDispatchToggle("agent-dispatcher-parallel");
  setupPmResolverToggle("agent-dispatcher-pm-enabled", "agent-dispatcher-pm-fields");
  setupPmResolverToggle("new-scheduler-pm-enabled", "new-scheduler-pm-fields");
  setupSchedulerCreation();
  setupProcessMonitor();
  // Fire-and-forget: populates every credential selector on the dashboard
  // (dispatcher main + validator + pm_resolver). Failure leaves the default
  // option in place so spawn still works against ~/.codex.
  void loadCredentialSelectors();

  const list = document.getElementById("roles-list");
  const empty = document.getElementById("roles-empty");
  const agentDispatcherList = document.getElementById("agent-dispatchers-list");
  const agentDispatcherEmpty = document.getElementById("agent-dispatchers-empty");
  const agentDispatcherForm = document.getElementById("start-agent-dispatcher-form");
  const agentDispatcherFeedback = document.getElementById("agent-dispatcher-feedback");
  const manualChannelSelect = document.getElementById("agent-dispatcher-manual-channel");
  const manualTelegramUserField = document.getElementById("agent-dispatcher-manual-telegram-user-field");
  const manualTelegramUserSelect = document.getElementById("agent-dispatcher-manual-telegram-user");
  const manualBotField = document.getElementById("agent-dispatcher-manual-bot-field");
  const manualBotSelect = document.getElementById("agent-dispatcher-manual-bot-id");
  const manualChatIdField = document.getElementById("agent-dispatcher-manual-chat-id-field");
  const manualChatIdInput = document.getElementById("agent-dispatcher-manual-chat-id");
  const dispatchPlanPathInput = document.getElementById("agent-dispatcher-dispatch-plan-path");
  const commandFilePathInput = document.getElementById("agent-dispatcher-command-file-path");
  const dispatchRepoRootInput = document.getElementById("agent-dispatcher-dispatch-repo-root");
  const docsRootInput = document.getElementById("agent-dispatcher-docs-root");
  const agentTypeSelect = document.getElementById("agent-dispatcher-agent-type");
  const agentModelInput = document.getElementById("agent-dispatcher-model-id");
  const modeSelect = document.getElementById("agent-dispatcher-mode");
  const killPolicySelect = document.getElementById("agent-dispatcher-kill-policy");
  const autoApproveInput = document.getElementById("agent-dispatcher-auto-approve");
  const agentDispatcherPromptInput = document.getElementById("agent-dispatcher-system-prompt");
  const agentDispatcherPromptReset = document.getElementById("agent-dispatcher-prompt-reset");
  const refreshButton = document.querySelector('[data-action="refresh-roles"]');

  if (
    !list
    || !empty
    || !agentDispatcherList
    || !agentDispatcherEmpty
    || !agentDispatcherForm
    || !agentDispatcherFeedback
    || !manualChannelSelect
    || !manualTelegramUserField
    || !manualTelegramUserSelect
    || !manualBotField
    || !manualBotSelect
    || !manualChatIdField
    || !manualChatIdInput
    || !dispatchPlanPathInput
    || !commandFilePathInput
    || !dispatchRepoRootInput
    || !docsRootInput
    || !agentTypeSelect
    || !agentModelInput
    || !modeSelect
    || !killPolicySelect
    || !autoApproveInput
    || !agentDispatcherPromptInput
    || !agentDispatcherPromptReset
  ) {
    return;
  }

  const agentDispatcherDetailCache = new Map();
  let lastAgentDispatcherPromptPreview = "";
  let agentDispatcherPromptDirty = false;

  async function refreshRoles() {
    const roles = await fetchJson("/api/roles");

    if (!Array.isArray(roles) || roles.length === 0) {
      list.replaceChildren();
      agentDispatcherList.replaceChildren();
      list.dataset.renderSignature = "";
      agentDispatcherList.dataset.renderSignature = "";
      agentDispatcherDetailCache.clear();
      empty.hidden = false;
      agentDispatcherEmpty.hidden = false;
      updateTabCounts([]);

      const schedulerListEl = document.getElementById("schedulers-list");
      const schedulerEmptyEl = document.getElementById("schedulers-empty");
      if (schedulerListEl) schedulerListEl.replaceChildren();
      if (schedulerEmptyEl) schedulerEmptyEl.hidden = false;
      return;
    }

    updateTabCounts(roles);
    empty.hidden = true;
    const roleSignature = JSON.stringify(roles.map((role) => ({
      thread_id: role.thread_id,
      role_type: role.role_type,
      status: role.status,
      task_count: role.task_count
    })));

    if (list.dataset.renderSignature !== roleSignature) {
      list.replaceChildren();

      roles.forEach((role) => {
        const detailHref = role.role_type === "scheduler"
          ? `/scheduler/${encodeURIComponent(role.thread_id)}`
          : `/role/${encodeURIComponent(role.thread_id)}`;
        const card = document.createElement("article");
        card.className = "role-card";
        card.innerHTML = `
          <div class="role-card-header">
            <code>${escapeHtml(role.thread_id)}</code>
            <span class="status-pill status-${escapeHtml(role.status)}">${escapeHtml(role.status)}</span>
          </div>
          <dl class="meta-grid">
            <div><dt>type</dt><dd>${escapeHtml(role.role_type)}</dd></div>
            <div><dt>tasks</dt><dd>${escapeHtml(String(role.task_count))}</dd></div>
          </dl>
          <div class="card-actions">
            <a class="ghost-link" href="${detailHref}">Open detail</a>
            <button type="button" class="danger-button" data-thread="${escapeHtml(role.thread_id)}">Deactivate</button>
          </div>
        `;
        bindLocationNavigation(card.querySelector("a.ghost-link"));
        list.appendChild(card);
      });

      list.querySelectorAll("[data-thread]").forEach((button) => {
        button.addEventListener("click", async () => {
          const threadId = button.getAttribute("data-thread");
          if (!threadId) {
            return;
          }

          try {
            agentDispatcherFeedback.textContent = "Deactivating role...";
            await fetchJson(`/api/role/${encodeURIComponent(threadId)}`, { method: "DELETE" });
            agentDispatcherFeedback.textContent = `Role ${threadId} deactivated.`;
            await refreshRoles();
          } catch (error) {
            agentDispatcherFeedback.textContent = getErrorMessage(error);
          }
        });
      });

      list.dataset.renderSignature = roleSignature;
    }

    // Render schedulers
    const schedulerListEl = document.getElementById("schedulers-list");
    const schedulerEmptyEl = document.getElementById("schedulers-empty");
    if (schedulerListEl && schedulerEmptyEl) {
      const schedulerRoles = roles.filter((role) => role.role_type === "scheduler");
      if (schedulerRoles.length === 0) {
        schedulerEmptyEl.hidden = false;
        schedulerListEl.replaceChildren();
      } else {
        schedulerEmptyEl.hidden = true;
        schedulerListEl.replaceChildren();
        schedulerRoles.forEach((role) => {
          const card = document.createElement("article");
          card.className = "role-card";
          card.innerHTML = `
            <div class="role-card-header">
              <code>${escapeHtml(role.thread_id)}</code>
              <span class="status-pill status-${escapeHtml(role.status)}">${escapeHtml(role.status)}</span>
            </div>
            <dl class="meta-grid">
              <div><dt>type</dt><dd>scheduler</dd></div>
              <div><dt>tasks</dt><dd>${escapeHtml(String(role.task_count ?? 0))}</dd></div>
            </dl>
            <div class="card-actions">
              <a class="ghost-link" href="${GATEWAY_PATH_PREFIX}/scheduler/${encodeURIComponent(role.thread_id)}">Open detail</a>
              <button type="button" class="danger-button" data-scheduler-thread="${escapeHtml(role.thread_id)}">Deactivate</button>
            </div>
          `;
          bindLocationNavigation(card.querySelector("a.ghost-link"));
          schedulerListEl.appendChild(card);
        });
        schedulerListEl.querySelectorAll("[data-scheduler-thread]").forEach((button) => {
          button.addEventListener("click", async () => {
            const threadId = button.getAttribute("data-scheduler-thread");
            if (!threadId) return;
            try {
              await fetchJson(`/api/scheduler/${encodeURIComponent(threadId)}`, { method: "DELETE" });
              await refreshRoles();
            } catch (error) {
              agentDispatcherFeedback.textContent = getErrorMessage(error);
            }
          });
        });
      }
    }

    const agentDispatcherRoles = roles.filter((role) => role.role_type === "agent-dispatcher");
    if (agentDispatcherRoles.length === 0) {
      agentDispatcherEmpty.hidden = false;
      agentDispatcherList.replaceChildren();
      agentDispatcherList.dataset.renderSignature = "";
      agentDispatcherDetailCache.clear();
      return;
    }

    pruneAgentDispatcherDetailCache(agentDispatcherDetailCache, agentDispatcherRoles.map((role) => role.thread_id));
    const details = await Promise.all(agentDispatcherRoles.map(async (role) => {
      try {
        const detail = await fetchJson(`/api/role/${encodeURIComponent(role.thread_id)}`);
        agentDispatcherDetailCache.set(role.thread_id, detail);
        return detail;
      } catch {
        const cachedDetail = agentDispatcherDetailCache.get(role.thread_id);
        if (cachedDetail) {
          return {
            ...cachedDetail,
            status: role.status,
            dispatcher_thread_id: role.status === "needs_reactivation"
              ? null
              : cachedDetail.dispatcher_thread_id
          };
        }

        return {
          ...role,
          dispatcher_thread_id: null,
          current_worker: null,
          last_log_line: "Dispatcher detail unavailable."
        };
      }
    }));

    agentDispatcherEmpty.hidden = true;
        const dispatcherSignature = JSON.stringify(details.map((detail) => ({
          thread_id: detail.thread_id,
          status: detail.status,
          dispatcher_thread_id: detail.dispatcher_thread_id,
          continue_worker: detail.continue_worker,
          current_worker: detail.current_worker,
          live_worker: resolveLiveRunningWorker(detail),
          task_context_label: resolveDispatcherTaskContext(detail).label,
          task_context_summary: resolveDispatcherTaskContext(detail).summary,
          agent_type: detail.agent_type,
          model_id: detail.model_id,
          auto_approve: detail.auto_approve === true,
          last_log_line: detail.last_log_line
        })));

    if (agentDispatcherList.dataset.renderSignature !== dispatcherSignature) {
      agentDispatcherList.replaceChildren();

      details.forEach((detail) => {
        const control = resolveDispatcherCardControl(detail);
        const taskContext = resolveDispatcherTaskContext(detail);
        const card = document.createElement("article");
        card.className = "role-card";
        card.innerHTML = `
          <div class="role-card-header">
            <div class="role-card-stack">
              <code>${escapeHtml(detail.thread_id)}</code>
              <span class="muted">dispatcher_thread_id: ${escapeHtml(detail.dispatcher_thread_id || "pending")}</span>
            </div>
            <span class="status-pill status-${escapeHtml(detail.status)}">${escapeHtml(detail.status)}</span>
          </div>
          <dl class="meta-grid">
            <div><dt>current worker</dt><dd>${escapeHtml(detail.current_worker || "idle")}</dd></div>
            <div><dt>${escapeHtml(taskContext.label)}</dt><dd>${escapeHtml(taskContext.summary)}</dd></div>
            <div><dt>agent</dt><dd>${escapeHtml(detail.agent_type || "---")}</dd></div>
            <div><dt>model</dt><dd>${escapeHtml(detail.model_id || "provider default")}</dd></div>
            <div><dt>auto_approve</dt><dd>${detail.auto_approve === true ? "true" : "false"}</dd></div>
          </dl>
          <p class="role-card-preview">${escapeHtml(detail.last_log_line || "No dispatcher activity yet.")}</p>
          <div class="card-actions dispatcher-card-actions">
            <a class="ghost-link" href="${GATEWAY_PATH_PREFIX}/role/${encodeURIComponent(detail.thread_id)}">Open detail</a>
            <button
              type="button"
              class="primary-button"
              data-dispatcher-id="${escapeHtml(detail.thread_id)}"
              data-dispatcher-action="start-hub"
              ${control.showStartHub ? "" : "hidden"}
            >Start hub session</button>
            <button
              type="button"
              class="ghost-button"
              data-dispatcher-id="${escapeHtml(detail.thread_id)}"
              data-dispatcher-action="${control.action}"
              ${control.disabled ? "disabled" : ""}
            >${control.label}</button>
          </div>
        `;
        bindLocationNavigation(card.querySelector("a.ghost-link"));
        agentDispatcherList.appendChild(card);
      });

      agentDispatcherList.querySelectorAll("[data-dispatcher-id]").forEach((button) => {
        button.addEventListener("click", async () => {
          const threadId = button.getAttribute("data-dispatcher-id");
          const action = button.getAttribute("data-dispatcher-action");
          if (!threadId || !action) {
            return;
          }

          try {
            if (action === "start-hub") {
              agentDispatcherFeedback.textContent = `Starting Hub session for ${threadId}...`;
              const started = await fetchJson(`/api/agent-dispatcher/${encodeURIComponent(threadId)}/start-hub`, {
                method: "POST"
              });
              agentDispatcherFeedback.textContent = `Hub session started (${started.dispatcher_thread_id}).`;
              await refreshRoles();
              return;
            }

            agentDispatcherFeedback.textContent = formatDispatcherControlProgress(action, threadId);
            const response = await fetchJson(`/api/agent-dispatcher/${encodeURIComponent(threadId)}/${action}`, {
              method: "POST"
            });
            agentDispatcherFeedback.textContent = formatDispatcherControlResult(action, threadId, response);
            await refreshRoles();
          } catch (error) {
            agentDispatcherFeedback.textContent = getErrorMessage(error);
          }
        });
      });

      agentDispatcherList.dataset.renderSignature = dispatcherSignature;
    }
  }

  async function loadAgentDispatcherReplyOptions() {
    const response = await fetchJson("/api/channels");
    const prevBot = normalizeText(manualBotSelect.value);
    const prevUser = normalizeText(manualTelegramUserSelect.value);

    const botIds = Array.isArray(response.telegram_bot_numeric_ids) ? response.telegram_bot_numeric_ids : [];
    manualBotSelect.replaceChildren();
    const defaultBotOption = document.createElement("option");
    defaultBotOption.value = "";
    defaultBotOption.textContent = "Hub default (omit bot_id)";
    manualBotSelect.appendChild(defaultBotOption);
    botIds.forEach((id) => {
      const opt = document.createElement("option");
      opt.value = id;
      opt.textContent = `Bot ${id}`;
      manualBotSelect.appendChild(opt);
    });
    if (prevBot && botIds.includes(prevBot)) {
      manualBotSelect.value = prevBot;
    } else if (botIds.length === 1) {
      manualBotSelect.value = botIds[0];
    }

    const allowedIds = Array.isArray(response.telegram_allowed_user_ids) ? response.telegram_allowed_user_ids : [];
    manualTelegramUserSelect.replaceChildren();
    const customUserOption = document.createElement("option");
    customUserOption.value = "";
    customUserOption.textContent = "Custom --- type chat id below";
    manualTelegramUserSelect.appendChild(customUserOption);
    allowedIds.forEach((id) => {
      const opt = document.createElement("option");
      opt.value = id;
      opt.textContent = `Operator ${id} (ALLOWED_USER_IDS)`;
      manualTelegramUserSelect.appendChild(opt);
    });
    if (prevUser && allowedIds.includes(prevUser)) {
      manualTelegramUserSelect.value = prevUser;
    } else if (allowedIds.length === 1) {
      manualTelegramUserSelect.value = allowedIds[0];
    }

    refreshManualReplyUi(
      manualChannelSelect,
      manualBotField,
      manualTelegramUserField,
      manualTelegramUserSelect,
      manualChatIdField,
      manualChatIdInput
    );
  }

  async function refreshAgentDispatcherPromptPreview(options = {}) {
    const replyChannels = collectAgentDispatcherReplyChannels(
      manualChannelSelect,
      manualChatIdInput,
      manualBotSelect,
      manualTelegramUserSelect
    );
    const payload = {
      dispatch_plan_path: normalizeText(dispatchPlanPathInput.value) || undefined,
      command_file_path: normalizeText(commandFilePathInput.value) || undefined,
      dispatch_repo_root: normalizeText(dispatchRepoRootInput.value) || undefined,
      docs_root: normalizeText(docsRootInput.value) || undefined,
      agent_type: normalizeText(agentTypeSelect.value) || "claude",
      model_id: normalizeText(agentModelInput.value) || undefined,
      mode: normalizeText(modeSelect.value) || "bridge",
      kill_policy: normalizeText(killPolicySelect.value) || "always",
      auto_approve: autoApproveInput.checked,
      credential_id: normalizeText(document.getElementById("agent-dispatcher-credential-id")?.value) || undefined
    };

    if (replyChannels.length > 0) {
      payload.user_reply_channels = replyChannels;
    }

    const validatorConfig = collectValidatorConfig();
    if (validatorConfig) {
      payload.validator = validatorConfig;
    }
    payload.pm_resolver = collectPmResolverConfig("agent-dispatcher-pm");
    try {
      payload.parallel_dispatch = collectParallelDispatchConfig("agent-dispatcher-parallel");
    } catch {
      payload.parallel_dispatch = { enabled: false, max_concurrency: 1 };
    }

    const response = await fetchJson("/api/agent-dispatcher/prompt-preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const nextPrompt = typeof response.system_prompt === "string" ? response.system_prompt : "";
    const shouldReplacePrompt = options.force === true
      || !agentDispatcherPromptDirty
      || agentDispatcherPromptInput.value === lastAgentDispatcherPromptPreview;

    lastAgentDispatcherPromptPreview = nextPrompt;
    if (shouldReplacePrompt) {
      agentDispatcherPromptInput.value = nextPrompt;
      agentDispatcherPromptDirty = false;
    }
  }

  agentDispatcherForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    agentDispatcherFeedback.textContent = "Starting agent dispatcher...";

    const replyChannels = collectAgentDispatcherReplyChannels(
      manualChannelSelect,
      manualChatIdInput,
      manualBotSelect,
      manualTelegramUserSelect
    );
    if (replyChannels.length === 0) {
      agentDispatcherFeedback.textContent =
        "For web, enter manual_reply_chat_id. For Telegram, pick an operator or Custom chat id.";
      return;
    }

    const formData = new FormData(agentDispatcherForm);
    const payload = {
      dispatch_plan_path: normalizeText(formData.get("dispatch_plan_path")),
      command_file_path: normalizeText(formData.get("command_file_path")),
      dispatch_repo_root: normalizeText(formData.get("dispatch_repo_root")) || undefined,
      docs_root: normalizeText(formData.get("docs_root")) || undefined,
      user_reply_channels: replyChannels,
      agent_type: normalizeText(formData.get("agent_type")) || "claude",
      model_id: normalizeText(formData.get("model_id")),
      mode: normalizeText(formData.get("mode")) || "bridge",
      kill_policy: normalizeText(formData.get("kill_policy")) || "always",
      auto_approve: Boolean(formData.get("auto_approve")),
      credential_id: normalizeText(formData.get("credential_id")) || undefined,
      system_prompt: normalizeText(agentDispatcherPromptInput.value)
    };

    const validatorConfig = collectValidatorConfig();
    if (validatorConfig) {
      payload.validator = validatorConfig;
    }
    try {
      payload.pm_resolver = collectPmResolverConfig("agent-dispatcher-pm");
    } catch (error) {
      agentDispatcherFeedback.textContent = getErrorMessage(error);
      return;
    }
    try {
      payload.parallel_dispatch = collectParallelDispatchConfig("agent-dispatcher-parallel");
    } catch (error) {
      agentDispatcherFeedback.textContent = getErrorMessage(error);
      return;
    }

    Object.keys(payload).forEach((key) => {
      if (payload[key] === "") {
        delete payload[key];
      }
    });

    try {
      const created = await fetchJson("/api/agent-dispatcher/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });

      agentDispatcherFeedback.textContent = `Dispatcher ${created.dispatcher_id} started.`;
      agentDispatcherForm.reset();
      dispatchRepoRootInput.value = "";
      docsRootInput.value = "";
      const validatorToggle = document.getElementById("agent-dispatcher-validator-enabled");
      const validatorFields = document.getElementById("agent-dispatcher-validator-fields");
      if (validatorToggle) validatorToggle.checked = false;
      if (validatorFields) validatorFields.hidden = true;
      const pmToggle = document.getElementById("agent-dispatcher-pm-enabled");
      const pmFields = document.getElementById("agent-dispatcher-pm-fields");
      if (pmToggle) pmToggle.checked = true;
      if (pmFields) pmFields.hidden = false;
      const parallelToggle = document.getElementById("agent-dispatcher-parallel-enabled");
      const parallelFields = document.getElementById("agent-dispatcher-parallel-fields");
      if (parallelToggle) parallelToggle.checked = false;
      if (parallelFields) parallelFields.hidden = true;
      await loadAgentDispatcherReplyOptions();
      agentDispatcherPromptDirty = false;
      await refreshAgentDispatcherPromptPreview({ force: true });
      await refreshRoles();
      window.location.href = `/role/${encodeURIComponent(created.dispatcher_id)}`;
    } catch (error) {
      agentDispatcherFeedback.textContent = getErrorMessage(error);
    }
  });

  refreshButton?.addEventListener("click", () => {
    void Promise.all([loadAgentDispatcherReplyOptions(), refreshAgentDispatcherPromptPreview({ force: true }), refreshRoles()]).catch((error) => {
      agentDispatcherFeedback.textContent = getErrorMessage(error);
    });
  });

  [dispatchPlanPathInput, commandFilePathInput, dispatchRepoRootInput, docsRootInput, agentTypeSelect, agentModelInput, modeSelect, killPolicySelect, autoApproveInput]
    .forEach((element) => {
      ["input", "change"].forEach((eventName) => {
        element.addEventListener(eventName, () => {
          void refreshAgentDispatcherPromptPreview().catch((error) => {
            agentDispatcherFeedback.textContent = getErrorMessage(error);
          });
        });
      });
    });

  [manualChannelSelect, manualChatIdInput, manualBotSelect, manualTelegramUserSelect].forEach((element) => {
    ["input", "change"].forEach((eventName) => {
      element.addEventListener(eventName, () => {
        void refreshAgentDispatcherPromptPreview().catch((error) => {
          agentDispatcherFeedback.textContent = getErrorMessage(error);
        });
      });
    });
  });

  collectPmResolverElements("agent-dispatcher-pm").forEach((element) => {
    ["input", "change"].forEach((eventName) => {
      element.addEventListener(eventName, () => {
        void refreshAgentDispatcherPromptPreview().catch((error) => {
          agentDispatcherFeedback.textContent = getErrorMessage(error);
        });
      });
    });
  });

  [
    "agent-dispatcher-parallel-enabled",
    "agent-dispatcher-parallel-max-concurrency"
  ].map((id) => document.getElementById(id)).filter(Boolean).forEach((element) => {
    ["input", "change"].forEach((eventName) => {
      element.addEventListener(eventName, () => {
        void refreshAgentDispatcherPromptPreview().catch((error) => {
          agentDispatcherFeedback.textContent = getErrorMessage(error);
        });
      });
    });
  });

  [manualChannelSelect, manualTelegramUserSelect].forEach((element) => {
    element.addEventListener("change", () => {
      refreshManualReplyUi(
        manualChannelSelect,
        manualBotField,
        manualTelegramUserField,
        manualTelegramUserSelect,
        manualChatIdField,
        manualChatIdInput
      );
    });
  });

  agentDispatcherPromptInput.addEventListener("input", () => {
    agentDispatcherPromptDirty = agentDispatcherPromptInput.value !== lastAgentDispatcherPromptPreview;
  });
  agentDispatcherPromptReset.addEventListener("click", () => {
    void refreshAgentDispatcherPromptPreview({ force: true }).catch((error) => {
      agentDispatcherFeedback.textContent = getErrorMessage(error);
    });
  });

  window.setInterval(() => {
    void refreshRoles().catch((error) => {
      agentDispatcherFeedback.textContent = getErrorMessage(error);
    });
  }, POLL_INTERVAL_MS);

  void refreshRoles().catch((error) => {
    agentDispatcherFeedback.textContent = getErrorMessage(error);
  });

  void Promise.all([
    loadAgentDispatcherReplyOptions(),
    refreshAgentDispatcherPromptPreview({ force: true })
  ]).catch((error) => {
    agentDispatcherFeedback.textContent = getErrorMessage(error);
  });
}

/* ═══════════════════════════════════════════════════════════════
   Role Detail
   ═══════════════════════════════════════════════════════════════ */

async function setupRoleDetail() {
  const threadId = decodeThreadId(["role", ""]);
  if (!threadId) {
    return;
  }

  const title = document.getElementById("role-title");
  const subtitle = document.getElementById("role-subtitle");
  const summary = document.getElementById("role-summary");
  const tasks = document.getElementById("role-tasks");
  const empty = document.getElementById("role-tasks-empty");
  const dashboardLink = document.getElementById("dashboard-link");
  const promptsLink = document.getElementById("prompts-link");
  const configLink = document.getElementById("config-link");
  const panelLinks = document.getElementById("role-panel-links");
  const roleTasksPanel = document.getElementById("role-tasks-panel");
  const dispatcherSessionPanel = document.getElementById("dispatcher-session-panel");
  const dispatcherSessionLog = document.getElementById("dispatcher-session-log");
  const dispatchPlanPanel = document.getElementById("dispatch-plan-panel");
  const dispatchPlanEmpty = document.getElementById("dispatch-plan-empty");
  const dispatchPlanTableShell = document.getElementById("dispatch-plan-table-shell");
  const dispatchPlanBody = document.getElementById("dispatch-plan-body");
  const dispatchPlanFeedback = document.getElementById("dispatch-plan-feedback");
  const hubControls = document.getElementById("agent-dispatcher-hub-controls");
  const startHubBtn = document.getElementById("agent-dispatcher-start-hub-btn");
  const continueHubBtn = document.getElementById("agent-dispatcher-continue-btn");
  const lifecycleHubBtn = document.getElementById("agent-dispatcher-lifecycle-btn");
  const deactivateBtn = document.getElementById("agent-dispatcher-deactivate-btn");
  const startHubFeedback = document.getElementById("agent-dispatcher-start-hub-feedback");
  const dispatcherTalkbox = document.getElementById("agent-dispatcher-talkbox");
  const dispatcherTalkForm = document.getElementById("agent-dispatcher-talk-form");
  const dispatcherTalkInput = document.getElementById("agent-dispatcher-talk-input");
  const dispatcherTalkFeedback = document.getElementById("agent-dispatcher-talk-feedback");
  const dispatcherTalkTarget = document.getElementById("agent-dispatcher-talk-target");
  const dispatcherTalkReplies = document.getElementById("agent-dispatcher-talk-replies");

  if (!title || !subtitle || !summary || !tasks || !empty || !promptsLink || !configLink) {
    return;
  }

  let startHubBound = false;
  let continueHubBound = false;
  let lifecycleHubBound = false;
  let deactivateBound = false;
  let dispatcherTalkBound = false;
  let dispatchPlanActionsBound = false;
  const directTalkTranscripts = new Map();
  const dispatcherTalkKey = `dispatcher:${threadId}`;

  const defaultEmptyMessage = empty.textContent;
  bindLocationNavigation(dashboardLink);
  promptsLink.href = `/role/${encodeURIComponent(threadId)}/prompts`;
  configLink.href = `/role/${encodeURIComponent(threadId)}/config`;
  bindLocationNavigation(promptsLink);
  bindLocationNavigation(configLink);
  let hasRendered = false;
  let lastRenderSignature = "";

  const render = async () => {
    const detail = await fetchJson(`/api/role/${encodeURIComponent(threadId)}`);
    if (detail.role_type === "scheduler") {
      window.location.assign(`/scheduler/${encodeURIComponent(detail.thread_id)}`);
      return;
    }

    const nextRenderSignature = JSON.stringify(detail);
    if (hasRendered && lastRenderSignature === nextRenderSignature) {
      return;
    }

    const isAgentDispatcher = detail.role_type === "agent-dispatcher";
    document.body.classList.toggle("role-detail-agent-dispatcher", isAgentDispatcher);
    summary.classList.toggle("role-summary-dispatcher", isAgentDispatcher);

    title.textContent = detail.thread_id;
    subtitle.textContent = isAgentDispatcher
      ? "Dispatcher control session."
      : (detail.taskspec ? "Inferred dispatch enabled." : "Explicit task DAG.");
    empty.textContent = defaultEmptyMessage;

    summary.innerHTML = isAgentDispatcher
      ? `
        <div><dt>role_type</dt><dd>${escapeHtml(detail.role_type)}</dd></div>
        <div><dt>status</dt><dd><span class="status-pill status-${escapeHtml(detail.status)}">${escapeHtml(detail.status)}</span></dd></div>
        <div><dt>dispatcher_thread_id</dt><dd><code>${escapeHtml(detail.dispatcher_thread_id || "pending")}</code></dd></div>
        <div><dt>current_worker</dt><dd>${escapeHtml(detail.current_worker || "idle")}</dd></div>
        ${renderPmResolverSummaryItem(detail)}
        <div><dt>agent_type</dt><dd>${escapeHtml(detail.agent_type || "---")}</dd></div>
        <div><dt>model_id</dt><dd>${escapeHtml(detail.model_id || "provider default")}</dd></div>
        <div><dt>mode</dt><dd>${escapeHtml(detail.mode || "---")}</dd></div>
        <div><dt>auto_approve</dt><dd>${detail.auto_approve === true ? "true" : "false"}</dd></div>
      `
      : `
        <div><dt>role_type</dt><dd>${escapeHtml(detail.role_type)}</dd></div>
        <div><dt>status</dt><dd><span class="status-pill status-${escapeHtml(detail.status)}">${escapeHtml(detail.status)}</span></dd></div>
        <div><dt>tasks</dt><dd>${escapeHtml(String(detail.tasks.length))}</dd></div>
        <div><dt>mode</dt><dd>${detail.taskspec ? "taskspec" : "task list"}</dd></div>
      `;

    if (panelLinks) {
      panelLinks.hidden = false;
    }
    if (roleTasksPanel) {
      roleTasksPanel.hidden = isAgentDispatcher;
    }
    if (dispatcherSessionPanel) {
      dispatcherSessionPanel.hidden = !isAgentDispatcher;
    }
    if (dispatchPlanPanel) {
      dispatchPlanPanel.hidden = !isAgentDispatcher;
    }

    if (isAgentDispatcher) {
      tasks.replaceChildren();
      empty.hidden = true;
      const dispatcherControls = resolveDispatcherDetailControls(detail);

      if (hubControls) {
        hubControls.hidden = false;
      }
      if (continueHubBtn) {
        continueHubBtn.hidden = !dispatcherControls.showContinue;
        continueHubBtn.textContent = dispatcherControls.continueLabel;
        continueHubBtn.disabled = dispatcherControls.continueDisabled;
      }
      if (startHubBtn) {
        startHubBtn.hidden = !dispatcherControls.showStartHub;
      }
      if (lifecycleHubBtn) {
        lifecycleHubBtn.hidden = !dispatcherControls.showLifecycle;
        lifecycleHubBtn.textContent = dispatcherControls.lifecycleLabel;
        lifecycleHubBtn.setAttribute("data-dispatcher-action", dispatcherControls.lifecycleAction || "");
      }

      if (!startHubBound && startHubBtn && startHubFeedback) {
        startHubBound = true;
        startHubBtn.addEventListener("click", async () => {
          try {
            startHubFeedback.textContent = "Starting Hub session...";
            const started = await fetchJson(
              `/api/agent-dispatcher/${encodeURIComponent(threadId)}/start-hub`,
              { method: "POST" }
            );
            startHubFeedback.textContent = started.status === "still_blocked"
              ? formatContinueResult(started)
              : `Hub session started (${started.dispatcher_thread_id}).`;
            await render();
          } catch (error) {
            startHubFeedback.textContent = getErrorMessage(error);
          }
        });
      }

      if (!continueHubBound && continueHubBtn && startHubFeedback) {
        continueHubBound = true;
        continueHubBtn.addEventListener("click", async () => {
          if (continueHubBtn.disabled) {
            return;
          }

          try {
            continueHubBtn.disabled = true;
            startHubFeedback.textContent = "Continuing dispatcher...";
            const continued = await fetchJson(
              `/api/agent-dispatcher/${encodeURIComponent(threadId)}/continue`,
              { method: "POST" }
            );
            startHubFeedback.textContent = formatContinueResult(continued);
            await render();
          } catch (error) {
            startHubFeedback.textContent = getErrorMessage(error);
          } finally {
            continueHubBtn.disabled = false;
          }
        });
      }

      if (!lifecycleHubBound && lifecycleHubBtn && startHubFeedback) {
        lifecycleHubBound = true;
        lifecycleHubBtn.addEventListener("click", async () => {
          const action = lifecycleHubBtn.getAttribute("data-dispatcher-action");
          if (!action || (action !== "pause" && action !== "resume")) {
            return;
          }

          try {
            lifecycleHubBtn.disabled = true;
            startHubFeedback.textContent = formatDispatcherControlProgress(action, threadId);
            const response = await fetchJson(
              `/api/agent-dispatcher/${encodeURIComponent(threadId)}/${action}`,
              { method: "POST" }
            );
            startHubFeedback.textContent = formatDispatcherControlResult(action, threadId, response);
            await render();
          } catch (error) {
            startHubFeedback.textContent = getErrorMessage(error);
          } finally {
            lifecycleHubBtn.disabled = false;
          }
        });
      }

      if (!deactivateBound && deactivateBtn && startHubFeedback) {
        deactivateBound = true;
        deactivateBtn.addEventListener("click", async () => {
          if (!window.confirm(`Deactivate role ${threadId}? This removes the role entry; the dispatcher Hub thread is not killed automatically.`)) {
            return;
          }
          try {
            deactivateBtn.disabled = true;
            startHubFeedback.textContent = "Deactivating role...";
            await fetchJson(`/api/role/${encodeURIComponent(threadId)}`, { method: "DELETE" });
            startHubFeedback.textContent = `Role ${threadId} deactivated. Returning to dashboard...`;
            window.setTimeout(() => {
              window.location.assign("/");
            }, 600);
          } catch (error) {
            startHubFeedback.textContent = getErrorMessage(error);
            deactivateBtn.disabled = false;
          }
        });
      }

      // Reply-to-dispatcher talk-box: show whenever the dispatcher has a
      // recorded thread id (including paused). The Hub will queue the
      // message via /api/hub-relay and the GUI keeps a local transcript of
      // the synchronous Hub reply when one arrives.
      const dispatcherThreadId = (detail.dispatcher_thread_id || "").trim();
      if (dispatcherTalkbox) {
        dispatcherTalkbox.hidden = dispatcherThreadId.length === 0;
      }
      if (dispatcherTalkTarget) {
        dispatcherTalkTarget.textContent = dispatcherThreadId || "pending";
      }
      if (dispatcherTalkForm) {
        dispatcherTalkForm.setAttribute("data-talk-key", dispatcherTalkKey);
      }
      renderDirectTalkTranscriptContainer(
        dispatcherTalkReplies,
        directTalkTranscripts.get(dispatcherTalkKey) ?? []
      );
      if (!dispatcherTalkBound && dispatcherTalkForm && dispatcherTalkInput) {
        dispatcherTalkBound = true;
        dispatcherTalkForm.addEventListener("submit", async (event) => {
          event.preventDefault();
          const targetThread = (detail.dispatcher_thread_id || "").trim();
          const content = dispatcherTalkInput.value.trim();
          if (!targetThread) {
            if (dispatcherTalkFeedback) {
              dispatcherTalkFeedback.textContent = "No dispatcher thread to reply to yet.";
            }
            return;
          }
          if (!content) {
            if (dispatcherTalkFeedback) {
              dispatcherTalkFeedback.textContent = "Type a message before sending.";
            }
            return;
          }
          const submitBtn = dispatcherTalkForm.querySelector("button[type='submit']");
          if (submitBtn instanceof HTMLButtonElement) {
            submitBtn.disabled = true;
          }
          if (dispatcherTalkFeedback) {
            dispatcherTalkFeedback.textContent = `Waiting for reply from ${targetThread}...`;
          }
          const sentAt = new Date().toISOString();
          try {
            const result = await sendDirectHubMessage({
              hubRelayUrl: () => "/api/hub-relay",
              threadId: targetThread,
              content
            });
            dispatcherTalkInput.value = "";
            const entries = appendDirectTalkTranscript(directTalkTranscripts, dispatcherTalkKey, {
              sentAt,
              targetLabel: "dispatcher",
              targetThread,
              request: content,
              reply: result
            });
            renderDirectTalkTranscriptContainer(dispatcherTalkReplies, entries);
            if (dispatcherTalkFeedback) {
              dispatcherTalkFeedback.textContent = `Reply received from ${targetThread}.`;
            }
          } catch (error) {
            const message = getErrorMessage(error);
            const entries = appendDirectTalkTranscript(directTalkTranscripts, dispatcherTalkKey, {
              sentAt,
              targetLabel: "dispatcher",
              targetThread,
              request: content,
              error: message
            });
            renderDirectTalkTranscriptContainer(dispatcherTalkReplies, entries);
            if (dispatcherTalkFeedback) {
              dispatcherTalkFeedback.textContent = message;
            }
          } finally {
            if (submitBtn instanceof HTMLButtonElement) {
              submitBtn.disabled = false;
            }
          }
        });
      }

      if (dispatcherSessionLog) {
        const sessionLines = Array.isArray(detail.session_log) && detail.session_log.length > 0
          ? detail.session_log
          : ["No dispatcher session detail available yet."];
        dispatcherSessionLog.textContent = sessionLines.join("\n");
      }

      if (!dispatchPlanActionsBound && dispatchPlanBody) {
        dispatchPlanActionsBound = true;
        bindDispatchDetailActions(dispatchPlanBody, dispatchPlanFeedback, {
          humanResolveUrl: (workerId) =>
            `/api/roles/${encodeURIComponent(threadId)}/worker/${encodeURIComponent(workerId)}/human-resolve`,
          hubRelayUrl: () => `/api/hub-relay`,
          directTalkTranscripts,
          afterAction: async () => { await render(); }
        });
        dispatchPlanBody.addEventListener("click", async (event) => {
          const actionTarget = event.target instanceof Element
            ? event.target.closest("[data-continue-worker], [data-resume-action], [data-status-apply]")
            : null;
          if (!(actionTarget instanceof HTMLButtonElement)) {
            return;
          }

          const workerId = actionTarget.getAttribute("data-worker-id");
          if (!workerId) {
            return;
          }

          const resumeAction = actionTarget.getAttribute("data-resume-action");
          const isContinueWorker = actionTarget.hasAttribute("data-continue-worker");
          const isStatusApply = actionTarget.hasAttribute("data-status-apply");
          if (!isContinueWorker && !resumeAction && !isStatusApply) {
            return;
          }

          if (
            resumeAction === "force-complete"
            && !window.confirm(
              `Force Complete will mark ${workerId} as complete and may unblock downstream workers on incomplete output. Continue?`
            )
          ) {
            return;
          }

          setDispatchPlanControlsDisabled(dispatchPlanBody, true);

          try {
            if (isContinueWorker) {
              if (dispatchPlanFeedback) {
                dispatchPlanFeedback.textContent = `Continuing ${workerId}...`;
              }

              const continued = await fetchJson(
                `/api/roles/${encodeURIComponent(threadId)}/worker/${encodeURIComponent(workerId)}/continue`,
                {
                  method: "POST",
                  headers: { "Content-Type": "application/json" }
                }
              );

              if (dispatchPlanFeedback) {
                dispatchPlanFeedback.textContent = formatContinueResult(continued);
              }
            } else if (resumeAction) {
              if (dispatchPlanFeedback) {
                dispatchPlanFeedback.textContent = `${formatResumeActionLabel(resumeAction)} ${workerId}...`;
              }

              const payload = resumeAction === "force-complete"
                ? { action: resumeAction, force: true }
                : { action: resumeAction };

              await fetchJson(
                `/api/roles/${encodeURIComponent(threadId)}/worker/${encodeURIComponent(workerId)}/resume`,
                {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify(payload)
                }
              );

              if (dispatchPlanFeedback) {
                dispatchPlanFeedback.textContent = `${workerId} ${formatResumeActionSuccess(resumeAction)}.`;
              }
            } else if (isStatusApply) {
              const rowElement = actionTarget.closest("tr");
              const statusSelect = rowElement?.querySelector("[data-worker-status]");
              const modelSelect = rowElement?.querySelector("[data-worker-model]");
              const effortSelect = rowElement?.querySelector("[data-worker-effort]");
              if (!(statusSelect instanceof HTMLSelectElement)) {
                throw new Error(`No status selector found for ${workerId}`);
              }
              const statusValue = statusSelect.value;
              const modelOverride = modelSelect instanceof HTMLSelectElement && modelSelect.value.trim()
                ? modelSelect.value.trim()
                : null;
              const effortOverride = effortSelect instanceof HTMLSelectElement && effortSelect.value.trim()
                ? effortSelect.value.trim()
                : null;

              if (dispatchPlanFeedback) {
                dispatchPlanFeedback.textContent = `Updating ${workerId} to ${formatDispatchStatusLabel(statusValue)}...`;
              }

              // Reset-to-pending must clear hub_result, otherwise the lifecycle
              // store re-derives ⛔ BLOCKED from the stale signal and overwrites
              // the plan markdown back. resume-worker (action=retry) clears it;
              // update-status does not.
              if (statusValue === "pending") {
                await fetchJson(
                  `/api/roles/${encodeURIComponent(threadId)}/worker/${encodeURIComponent(workerId)}/resume`,
                  {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ action: "retry" })
                  }
                );
              }

              if (statusValue !== "pending" || modelOverride || effortOverride) {
                const payload = { status: statusValue };
                if (modelOverride) {
                  payload.model = modelOverride;
                }
                if (effortOverride) {
                  payload.reasoning_effort = effortOverride;
                }
                await fetchJson(
                  `/api/roles/${encodeURIComponent(threadId)}/worker/${encodeURIComponent(workerId)}/status`,
                  {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(payload)
                  }
                );
              }

              if (dispatchPlanFeedback) {
                dispatchPlanFeedback.textContent = `${workerId} ${formatDispatchStatusSuccess(statusValue)}.`;
              }
            }

            await render();
          } catch (error) {
            if (dispatchPlanFeedback) {
              dispatchPlanFeedback.textContent = getErrorMessage(error);
            }
          } finally {
            setDispatchPlanControlsDisabled(dispatchPlanBody, false);
          }
        });
      }

      if (dispatchPlanBody && dispatchPlanEmpty && dispatchPlanTableShell) {
        const rows = Array.isArray(detail.dispatch_plan?.rows) ? detail.dispatch_plan.rows : [];
        const dispatchDetails = Array.isArray(detail.dispatch_details) ? detail.dispatch_details : [];
        const renderedPlanRows = renderDispatchPlanRows(rows, dispatchDetails);
        dispatchPlanBody.innerHTML = renderedPlanRows;
        hydrateDirectTalkTranscripts(dispatchPlanBody, directTalkTranscripts);
        dispatchPlanEmpty.hidden = renderedPlanRows.length > 0;
        dispatchPlanTableShell.hidden = renderedPlanRows.length === 0;
      }

      lastRenderSignature = nextRenderSignature;
      hasRendered = true;
      return;
    }

    if (hubControls) {
      hubControls.hidden = true;
    }

    tasks.replaceChildren();
    if (!Array.isArray(detail.tasks) || detail.tasks.length === 0) {
      empty.hidden = false;
      lastRenderSignature = nextRenderSignature;
      hasRendered = true;
      return;
    }

    empty.hidden = true;

    detail.tasks.forEach((task) => {
      const item = document.createElement("article");
      item.className = "task-card";
      item.innerHTML = `
        <div class="task-card-header">
          <div>
            <h3>${escapeHtml(task.task_id)}</h3>
            <p class="task-deps">depends_on: ${escapeHtml((task.depends_on || []).join(", ") || "---")}</p>
          </div>
          <span class="status-pill status-${escapeHtml(task.status)}">${escapeHtml(task.status)}</span>
        </div>
        <p class="instruction">${escapeHtml(task.instruction)}</p>
        <dl class="meta-grid">
          <div><dt>trace_id</dt><dd><code>${escapeHtml(task.trace_id || "---")}</code></dd></div>
          <div><dt>result</dt><dd>${escapeHtml(task.result_summary || "---")}</dd></div>
        </dl>
      `;
      tasks.appendChild(item);
    });

    lastRenderSignature = nextRenderSignature;
    hasRendered = true;
  };

  try {
    await render();
  } catch (error) {
    renderRoleDetailError({
      title,
      subtitle,
      summary,
      tasks,
      empty,
      dispatcherSessionPanel,
      dispatcherSessionLog,
      dispatchPlanPanel,
      dispatchPlanBody,
      dispatchPlanEmpty,
      dispatchPlanTableShell,
      roleTasksPanel,
      hubControls,
      continueHubBtn,
      lifecycleHubBtn
    }, getErrorMessage(error));
  }

  window.setInterval(() => {
    void render().catch((error) => {
      if (hasRendered) {
        console.warn("Role detail refresh failed", error);
        return;
      }

      renderRoleDetailError({
        title,
        subtitle,
        summary,
        tasks,
        empty,
        dispatcherSessionPanel,
        dispatcherSessionLog,
        dispatchPlanPanel,
        dispatchPlanBody,
        dispatchPlanEmpty,
        dispatchPlanTableShell,
        roleTasksPanel,
        hubControls,
        continueHubBtn,
        lifecycleHubBtn
      }, getErrorMessage(error));
    });
  }, POLL_INTERVAL_MS);
}

/* ═══════════════════════════════════════════════════════════════
   Prompt Editor
   ═══════════════════════════════════════════════════════════════ */

async function setupPromptEditor() {
  const threadId = decodeThreadId(["role", "", "prompts"]);
  if (!threadId) {
    return;
  }

  const title = document.getElementById("prompt-title");
  const detailLink = document.getElementById("detail-link");
  const promptLede = document.getElementById("prompt-lede");
  const systemPromptHelp = document.getElementById("system-prompt-help");
  const taskCaption = document.getElementById("prompt-task-caption");
  const feedback = document.getElementById("prompt-feedback");
  const systemForm = document.getElementById("system-prompt-form");
  const systemInput = document.getElementById("system-prompt-input");
  const empty = document.getElementById("prompt-task-empty");
  const list = document.getElementById("prompt-task-list");
  const validatorSection = document.getElementById("validator-prompt-section");
  const validatorForm = document.getElementById("validator-prompt-form");
  const validatorInput = document.getElementById("validator-prompt-input");
  const validatorFeedback = document.getElementById("validator-prompt-feedback");

  if (!title || !detailLink || !feedback || !systemForm || !systemInput || !empty || !list) {
    return;
  }

  detailLink.href = `/role/${encodeURIComponent(threadId)}`;

  const render = async () => {
    const [detail, prompts] = await Promise.all([
      fetchJson(`/api/role/${encodeURIComponent(threadId)}`),
      fetchJson(`/api/role/${encodeURIComponent(threadId)}/prompts`)
    ]);

    const isAgentDispatcher = detail.role_type === "agent-dispatcher";
    title.textContent = detail.thread_id;
    systemInput.value = prompts.system_prompt || "";
    list.replaceChildren();
    empty.textContent = isAgentDispatcher
      ? "Agent dispatchers do not expose per-task templates."
      : "This dispatcher has no tasks yet.";

    if (promptLede) {
      promptLede.textContent = isAgentDispatcher
        ? "Edit the dispatcher control prompt. Saved changes apply the next time the dispatcher session starts."
        : "Hot-reload prompt overrides for the next task dispatch.";
    }
    if (systemPromptHelp) {
      systemPromptHelp.textContent = isAgentDispatcher
        ? "Save an empty prompt to restore the system default before the next dispatcher start."
        : "Saved changes apply to future task dispatches.";
    }
    if (taskCaption) {
      taskCaption.textContent = isAgentDispatcher
        ? "Agent dispatchers only expose the system prompt."
        : "Delete a template to fall back to the base instruction.";
    }

    // Validator prompt: show for agent-dispatchers, load from __validator__ template
    if (validatorSection) {
      if (isAgentDispatcher) {
        validatorSection.hidden = false;
        const validatorTask = Array.isArray(prompts.tasks)
          ? prompts.tasks.find((t) => t.task_id === "__validator__")
          : null;
        if (validatorInput) validatorInput.value = validatorTask?.instruction_template || "";
      } else {
        validatorSection.hidden = true;
      }
    }

    if (!Array.isArray(prompts.tasks) || prompts.tasks.length === 0) {
      empty.hidden = false;
      return;
    }

    empty.hidden = true;

    prompts.tasks.forEach((task) => {
      const item = document.createElement("article");
      item.className = "task-card";
      item.innerHTML = `
        <div class="task-card-header">
          <div>
            <h3>${escapeHtml(task.task_id)}</h3>
            <p class="instruction">${escapeHtml(task.instruction)}</p>
          </div>
        </div>
        <label class="field">
          <span>instruction_template</span>
          <textarea rows="5">${escapeHtml(task.instruction_template || "")}</textarea>
        </label>
        <div class="card-actions">
          <button type="button" class="primary-button" data-action="save-template">Save Template</button>
          <button type="button" class="ghost-button" data-action="delete-template">Delete Template</button>
        </div>
      `;

      const textarea = item.querySelector("textarea");
      const saveButton = item.querySelector('[data-action="save-template"]');
      const deleteButton = item.querySelector('[data-action="delete-template"]');

      saveButton?.addEventListener("click", async () => {
        try {
          feedback.textContent = `Saving template for ${task.task_id}...`;
          await fetchJson(`/api/role/${encodeURIComponent(threadId)}/task/${encodeURIComponent(task.task_id)}/template`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ instruction_template: textarea.value })
          });
          feedback.textContent = `Template saved for ${task.task_id}.`;
          await render();
        } catch (error) {
          feedback.textContent = getErrorMessage(error);
        }
      });

      deleteButton?.addEventListener("click", async () => {
        try {
          feedback.textContent = `Deleting template for ${task.task_id}...`;
          await fetchJson(`/api/role/${encodeURIComponent(threadId)}/task/${encodeURIComponent(task.task_id)}/template`, {
            method: "DELETE"
          });
          feedback.textContent = `Template deleted for ${task.task_id}.`;
          await render();
        } catch (error) {
          feedback.textContent = getErrorMessage(error);
        }
      });

      list.appendChild(item);
    });
  };

  systemForm.addEventListener("submit", async (event) => {
    event.preventDefault();

    try {
      feedback.textContent = "Saving system prompt...";
      await fetchJson(`/api/role/${encodeURIComponent(threadId)}/prompt`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ system_prompt: systemInput.value })
      });
      feedback.textContent = "System prompt saved.";
      await render();
    } catch (error) {
      feedback.textContent = getErrorMessage(error);
    }
  });

  if (validatorForm && validatorInput && validatorFeedback) {
    validatorForm.addEventListener("submit", async (event) => {
      event.preventDefault();

      const value = validatorInput.value.trim();
      try {
        if (value) {
          validatorFeedback.textContent = "Saving validator prompt...";
          await fetchJson(`/api/role/${encodeURIComponent(threadId)}/task/${encodeURIComponent("__validator__")}/template`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ instruction_template: value })
          });
          validatorFeedback.textContent = "Validator prompt saved.";
        } else {
          validatorFeedback.textContent = "Clearing validator prompt...";
          await fetchJson(`/api/role/${encodeURIComponent(threadId)}/task/${encodeURIComponent("__validator__")}/template`, {
            method: "DELETE"
          });
          validatorFeedback.textContent = "Validator prompt cleared (using default).";
        }
        await render();
      } catch (error) {
        validatorFeedback.textContent = getErrorMessage(error);
      }
    });
  }

  try {
    await render();
  } catch (error) {
    feedback.textContent = getErrorMessage(error);
  }
}

/* ═══════════════════════════════════════════════════════════════
   Config Editor
   ═══════════════════════════════════════════════════════════════ */

async function setupConfigEditor() {
  const threadId = decodeThreadId(["role", "", "config"]);
  if (!threadId) {
    return;
  }

  // Populate credential selectors before rendering existing config so that
  // the populated <select>s can show the saved credential_id values.
  void loadCredentialSelectors();

  const title = document.getElementById("config-title");
  const detailLink = document.getElementById("config-detail-link");
  const lede = document.getElementById("config-lede");
  const sectionTitle = document.getElementById("config-section-title");
  const status = document.getElementById("config-status");
  const feedback = document.getElementById("config-feedback");
  const form = document.getElementById("config-form");
  const input = document.getElementById("config-input");
  const rawField = document.getElementById("config-raw-field");
  const fieldsContainer = document.getElementById("config-fields");
  const saveButton = document.getElementById("config-save-button");

  // Structured field elements
  const cfgDispatchPlanPath = document.getElementById("cfg-dispatch-plan-path");
  const cfgCommandFilePath = document.getElementById("cfg-command-file-path");
  const cfgDispatchRepoRoot = document.getElementById("cfg-dispatch-repo-root");
  const cfgDocsRoot = document.getElementById("cfg-docs-root");
  const cfgAgentType = document.getElementById("cfg-agent-type");
  const cfgModelId = document.getElementById("cfg-model-id");
  const cfgMode = document.getElementById("cfg-mode");
  const cfgKillPolicy = document.getElementById("cfg-kill-policy");
  const cfgAutoApprove = document.getElementById("cfg-auto-approve");
  const cfgParallelEnabled = document.getElementById("cfg-parallel-enabled");
  const cfgParallelMaxConcurrency = document.getElementById("cfg-parallel-max-concurrency");
  const cfgReplyChannels = document.getElementById("cfg-reply-channels");

  // Validator config fields
  const cfgValidatorEnabled = document.getElementById("cfg-validator-enabled");
  const cfgValidatorAgentType = document.getElementById("cfg-validator-agent-type");
  const cfgValidatorMode = document.getElementById("cfg-validator-mode");
  const cfgValidatorModelId = document.getElementById("cfg-validator-model-id");
  const cfgValidatorThresholdType = document.getElementById("cfg-validator-threshold-type");
  const cfgValidatorPassThreshold = document.getElementById("cfg-validator-pass-threshold");
  const cfgValidatorMaxFixCycles = document.getElementById("cfg-validator-max-fix-cycles");
  const cfgValidatorBaseBranch = document.getElementById("cfg-validator-base-branch");
  const cfgCredentialId = document.getElementById("cfg-credential-id");
  const cfgValidatorCredentialId = document.getElementById("cfg-validator-credential-id");
  const cfgPmEnabled = document.getElementById("cfg-pm-enabled");
  const cfgPmAgentType = document.getElementById("cfg-pm-agent-type");
  const cfgPmMode = document.getElementById("cfg-pm-mode");
  const cfgPmModelId = document.getElementById("cfg-pm-model-id");
  const cfgPmCredentialId = document.getElementById("cfg-pm-credential-id");
  const cfgPmAutoApprove = document.getElementById("cfg-pm-auto-approve");
  const cfgPmReplyChannels = document.getElementById("cfg-pm-reply-channels");

  if (!title || !detailLink || !status || !feedback || !form || !input || !saveButton) {
    return;
  }

  detailLink.href = `/role/${encodeURIComponent(threadId)}`;

  let useStructuredFields = false;

  const populateStructuredFields = (config) => {
    if (cfgDispatchPlanPath) cfgDispatchPlanPath.value = config.dispatch_plan_path || "";
    if (cfgCommandFilePath) cfgCommandFilePath.value = config.command_file_path || "";
    if (cfgDispatchRepoRoot) cfgDispatchRepoRoot.value = config.dispatch_repo_root || "";
    if (cfgDocsRoot) cfgDocsRoot.value = config.docs_root || "";
    if (cfgAgentType) cfgAgentType.value = config.agent_type || "claude";
    if (cfgModelId) cfgModelId.value = config.model_id || "";
    if (cfgMode) cfgMode.value = config.mode || "bridge";
    if (cfgKillPolicy) cfgKillPolicy.value = config.kill_policy || "always";
    if (cfgAutoApprove) cfgAutoApprove.value = String(config.auto_approve === true);
    if (cfgCredentialId) cfgCredentialId.value = config.credential_id || "";
    const parallel = config.parallel_dispatch || {};
    if (cfgParallelEnabled) cfgParallelEnabled.value = String(parallel.enabled === true);
    if (cfgParallelMaxConcurrency) cfgParallelMaxConcurrency.value = parallel.max_concurrency ?? 1;
    if (cfgReplyChannels) cfgReplyChannels.value = JSON.stringify(config.user_reply_channels || [], null, 2);

    // Validator fields
    const v = config.validator || {};
    if (cfgValidatorEnabled) cfgValidatorEnabled.value = String(v.enabled === true);
    if (cfgValidatorAgentType) cfgValidatorAgentType.value = v.agent_type || "codex";
    if (cfgValidatorMode) cfgValidatorMode.value = v.mode || normalizeValidatorMode(v.agent_type || "codex");
    if (cfgValidatorModelId) cfgValidatorModelId.value = v.model_id || "";
    if (cfgValidatorCredentialId) cfgValidatorCredentialId.value = v.credential_id || "";
    if (cfgValidatorThresholdType) cfgValidatorThresholdType.value = v.threshold_type || "score";
    if (cfgValidatorPassThreshold) cfgValidatorPassThreshold.value = v.pass_threshold ?? 0.7;
    if (cfgValidatorMaxFixCycles) cfgValidatorMaxFixCycles.value = v.max_fix_cycles ?? 3;
    if (cfgValidatorBaseBranch) cfgValidatorBaseBranch.value = v.base_branch || "main";

    const pm = config.pm_resolver || {};
    if (cfgPmEnabled) cfgPmEnabled.value = String(pm.enabled !== false);
    if (cfgPmAgentType) cfgPmAgentType.value = pm.agent_type || "codex";
    if (cfgPmMode) cfgPmMode.value = pm.mode || "bridge";
    if (cfgPmModelId) cfgPmModelId.value = pm.model_id || "";
    if (cfgPmCredentialId) cfgPmCredentialId.value = pm.credential_id || "";
    if (cfgPmAutoApprove) cfgPmAutoApprove.value = String(pm.auto_approve === true);
    if (cfgPmReplyChannels) cfgPmReplyChannels.value = pm.user_reply_channels ? JSON.stringify(pm.user_reply_channels, null, 2) : "";
  };

  const setStructuredFieldsDisabled = (disabled) => {
    if (cfgDispatchPlanPath) cfgDispatchPlanPath.readOnly = disabled;
    if (cfgCommandFilePath) cfgCommandFilePath.readOnly = disabled;
    if (cfgAgentType) cfgAgentType.disabled = disabled;
    if (cfgModelId) cfgModelId.disabled = disabled;
    if (cfgMode) cfgMode.disabled = disabled;
    if (cfgKillPolicy) cfgKillPolicy.disabled = disabled;
    if (cfgAutoApprove) cfgAutoApprove.disabled = disabled;
    if (cfgCredentialId) cfgCredentialId.disabled = disabled;
    if (cfgParallelEnabled) cfgParallelEnabled.disabled = disabled;
    if (cfgParallelMaxConcurrency) cfgParallelMaxConcurrency.readOnly = disabled;
    if (cfgValidatorEnabled) cfgValidatorEnabled.disabled = disabled;
    if (cfgValidatorAgentType) cfgValidatorAgentType.disabled = disabled;
    if (cfgValidatorMode) cfgValidatorMode.disabled = disabled;
    if (cfgValidatorModelId) cfgValidatorModelId.disabled = disabled;
    if (cfgValidatorCredentialId) cfgValidatorCredentialId.disabled = disabled;
    if (cfgValidatorThresholdType) cfgValidatorThresholdType.disabled = disabled;
    if (cfgValidatorPassThreshold) cfgValidatorPassThreshold.readOnly = disabled;
    if (cfgValidatorMaxFixCycles) cfgValidatorMaxFixCycles.readOnly = disabled;
    if (cfgValidatorBaseBranch) cfgValidatorBaseBranch.readOnly = disabled;
    if (cfgPmEnabled) cfgPmEnabled.disabled = disabled;
    if (cfgPmAgentType) cfgPmAgentType.disabled = disabled;
    if (cfgPmMode) cfgPmMode.disabled = disabled;
    if (cfgPmModelId) cfgPmModelId.disabled = disabled;
    if (cfgPmCredentialId) cfgPmCredentialId.disabled = disabled;
    if (cfgPmAutoApprove) cfgPmAutoApprove.disabled = disabled;
    if (cfgPmReplyChannels) cfgPmReplyChannels.readOnly = disabled;
  };

  const collectStructuredPatch = () => {
    const patch = {};
    // dispatch_plan_path / command_file_path are editable when the role is
    // not actively running (server gates via can_edit). When set we forward
    // them in the patch; when blanked we explicitly send null so the server
    // knows the operator wants the field cleared rather than untouched.
    if (cfgDispatchPlanPath) {
      const v = cfgDispatchPlanPath.value.trim();
      if (v.length > 0) patch.dispatch_plan_path = v;
    }
    if (cfgCommandFilePath) {
      const v = cfgCommandFilePath.value.trim();
      if (v.length > 0) patch.command_file_path = v;
    }
    if (cfgAgentType) patch.agent_type = cfgAgentType.value;
    if (cfgModelId) patch.model_id = cfgModelId.value.trim() || null;
    if (cfgMode) patch.mode = cfgMode.value;
    if (cfgKillPolicy) patch.kill_policy = cfgKillPolicy.value;
    if (cfgAutoApprove) patch.auto_approve = cfgAutoApprove.value === "true";
    // Send `null` when blank so the server clears any previously-stored value;
    // any non-empty value forwards through to /api/spawn as credential_id.
    if (cfgCredentialId) patch.credential_id = cfgCredentialId.value.trim() || null;
    patch.parallel_dispatch = collectParallelDispatchConfig("cfg-parallel", { minEnabledConcurrency: 1 });

    if (cfgValidatorEnabled) {
      const validatorAgentType = cfgValidatorAgentType?.value || "codex";
      const validatorMode = normalizeValidatorMode(validatorAgentType, cfgValidatorMode?.value);
      patch.validator = {
        enabled: cfgValidatorEnabled.value === "true",
        agent_type: validatorAgentType,
        mode: validatorMode,
        model_id: cfgValidatorModelId?.value?.trim() || undefined,
        credential_id: cfgValidatorCredentialId?.value?.trim() || undefined,
        threshold_type: cfgValidatorThresholdType?.value || "score",
        pass_threshold: parseFloat(cfgValidatorPassThreshold?.value) || 0.7,
        max_fix_cycles: parseInt(cfgValidatorMaxFixCycles?.value, 10) || 3,
        base_branch: cfgValidatorBaseBranch?.value?.trim() || "main"
      };
    }
    patch.pm_resolver = collectPmResolverConfig("cfg-pm");

    return patch;
  };

  const applyEditState = (response) => {
    const isAgentDispatcherConfig = isAgentDispatcherLaunchConfig(response.config);
    useStructuredFields = isAgentDispatcherConfig && fieldsContainer;

    if (useStructuredFields) {
      fieldsContainer.hidden = false;
      if (rawField) rawField.hidden = true;
      populateStructuredFields(response.config);
      setStructuredFieldsDisabled(response.can_edit !== true);
    } else {
      if (fieldsContainer) fieldsContainer.hidden = true;
      if (rawField) rawField.hidden = false;
      input.readOnly = response.can_edit !== true;
    }

    saveButton.disabled = response.can_edit !== true;
    if (sectionTitle) {
      sectionTitle.textContent = isAgentDispatcherConfig ? "Launch Config" : "Dispatch Plan JSON";
    }
    if (lede) {
      lede.textContent = isAgentDispatcherConfig
        ? "Edit launch settings for this agent dispatcher. Path fields are editable while the dispatcher is paused or pending; reply channels are read-only."
        : "Edit dispatcher JSON for `tasks` and `taskspec`. Prompt content stays on the prompt editor.";
    }
    status.textContent = response.can_edit
      ? (isAgentDispatcherConfig
        ? "Editable fields: dispatch_plan_path, command_file_path, agent_type, model_id, mode, kill_policy, auto_approve, parallel_dispatch, validator, pm_resolver. Changes apply to subsequent launches."
        : "Only tasks and taskspec are editable here. Runtime task fields are reset on save.")
      : response.blocked_reason || "Editing is temporarily unavailable.";
  };

  const render = async (successMessage = "") => {
    const response = await fetchJson(`/api/role/${encodeURIComponent(threadId)}/config`);
    title.textContent = response.thread_id;
    input.value = JSON.stringify(response.config, null, 2);
    applyEditState(response);
    feedback.textContent = successMessage || (response.can_edit ? "Dispatcher config loaded." : status.textContent);
  };

  form.addEventListener("submit", async (event) => {
    event.preventDefault();

    let payload;
    if (useStructuredFields) {
      try {
        payload = collectStructuredPatch();
      } catch (error) {
        feedback.textContent = getErrorMessage(error);
        return;
      }
    } else {
      try {
        payload = JSON.parse(input.value);
      } catch {
        feedback.textContent = "Config JSON must be valid JSON.";
        return;
      }
    }

    try {
      feedback.textContent = "Saving dispatcher config...";
      const response = await fetchJson(`/api/role/${encodeURIComponent(threadId)}/config`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });

      title.textContent = response.thread_id;
      input.value = JSON.stringify(response.config, null, 2);
      applyEditState(response);
      feedback.textContent = "Dispatcher config saved.";
    } catch (error) {
      feedback.textContent = getErrorMessage(error);
    }
  });

  try {
    await render();
  } catch (error) {
    title.textContent = "Config unavailable";
    status.textContent = "Unable to load dispatcher config.";
    feedback.textContent = getErrorMessage(error);
    input.value = "";
    input.readOnly = true;
    if (fieldsContainer) fieldsContainer.hidden = true;
    if (rawField) rawField.hidden = false;
    saveButton.disabled = true;
  }
}

/* ═══════════════════════════════════════════════════════════════
   Rendering Helpers
   ═══════════════════════════════════════════════════════════════ */

function renderRoleDetailError(elements, message) {
  elements.title.textContent = "Role unavailable";
  elements.subtitle.textContent = message;
  elements.summary.innerHTML = "";
  elements.tasks.replaceChildren();
  elements.empty.textContent = "Role data unavailable.";
  elements.empty.hidden = false;
  if (elements.roleTasksPanel) {
    elements.roleTasksPanel.hidden = false;
  }
  if (elements.dispatcherSessionPanel) {
    elements.dispatcherSessionPanel.hidden = true;
  }
  if (elements.dispatchPlanPanel) {
    elements.dispatchPlanPanel.hidden = true;
  }
  if (elements.dispatcherSessionLog) {
    elements.dispatcherSessionLog.textContent = "Role data unavailable.";
  }
  if (elements.dispatchPlanBody) {
    elements.dispatchPlanBody.innerHTML = "";
  }
  if (elements.dispatchPlanEmpty) {
    elements.dispatchPlanEmpty.textContent = "Role data unavailable.";
    elements.dispatchPlanEmpty.hidden = false;
  }
  if (elements.dispatchPlanTableShell) {
    elements.dispatchPlanTableShell.hidden = true;
  }
  if (elements.hubControls) {
    elements.hubControls.hidden = true;
  }
  if (elements.continueHubBtn) {
    elements.continueHubBtn.hidden = true;
  }
  if (elements.lifecycleHubBtn) {
    elements.lifecycleHubBtn.hidden = true;
  }
}

function renderDispatchDetailCard(detail, options = {}) {
  const isPmResolver = detail.detail_kind === "pm_resolver";
  const isValidator = detail.detail_kind === "validator";

  // Per-validation-cycle bars (one per Phase A marker cycle) live alongside
  // the worker bar. When they're rendered as siblings the worker bar should
  // not duplicate the per-cycle history inline.
  const hasSiblingValidatorBars = options.hasSiblingValidatorBars === true;

  let taskLabel = detail.task ? `${detail.worker_id}: ${detail.task}` : detail.worker_id;
  let commandLabel = "Dispatch Command";
  let replyLabel = "Agent Reply";
  let emptyReply = "No agent reply captured yet.";

  if (isPmResolver) {
    commandLabel = "PM Resolver Context";
    replyLabel = "PM Resolve Reply";
    emptyReply = "No PM resolver reply captured yet.";
  } else if (isValidator) {
    commandLabel = "Validator Context";
    replyLabel = "Validator Reply";
    emptyReply = "No validator reply captured yet.";
    if (typeof detail.validator_cycle === "number") {
      taskLabel = `${detail.task ?? `Validate cycle ${detail.validator_cycle}`}`;
    }
  }

  const subtitleParts = [
    detail.model,
    detail.applied_model,
    detail.applied_reasoning_effort,
    detail.worker_thread_id
  ].filter(Boolean);
  const retryBadge = !isPmResolver && !isValidator && Number(detail.retry_count) > 0
    ? `<span class="dispatch-detail-pill dispatch-detail-retry-pill" title="Worker has been re-launched ${escapeHtml(String(detail.retry_count))} time(s); prior attempts' prompt+reply are not persisted yet.">retry ×${escapeHtml(String(detail.retry_count))}</span>`
    : "";
  const cycleBadge = isValidator && typeof detail.validator_cycle === "number"
    ? `<span class="dispatch-detail-pill dispatch-detail-cycle-pill">cycle ${escapeHtml(String(detail.validator_cycle))}</span>`
    : "";
  const scoreBadge = isValidator && typeof detail.validator_score === "number"
    ? `<span class="dispatch-detail-pill dispatch-detail-score-pill">score ${escapeHtml(formatValidatorScore(detail.validator_score))}</span>`
    : "";
  const aliveDot = detail.is_alive
    ? `<span class="dispatch-detail-alive" title="Session is alive (${escapeHtml(detail.detail_kind || "worker")})" aria-label="alive"></span>`
    : "";
  const humanResolvedBadge = !isPmResolver && !isValidator && detail.human_resolution
    ? `<span class="dispatch-detail-pill dispatch-detail-human-pill" title="Marked HUMAN-resolved at ${escapeHtml(detail.human_resolution.resolved_at || "")}">HUMAN resolved</span>`
    : "";

  const showInlineValidation = !isPmResolver && !isValidator && !hasSiblingValidatorBars;
  const taskId = isPmResolver
    ? (detail.task_id || (detail.worker_id || "").replace(/^PM:/i, ""))
    : detail.worker_id || "";
  const threadId = detail.worker_thread_id || "";
  const detailKind = detail.detail_kind || "worker";
  const showHumanResolve = !isPmResolver && !isValidator
    && (String(detail.status || "").toLowerCase() === "blocked" || detail.is_alive === true);
  const canTalk = Boolean(threadId);

  return `
    <details class="dispatch-detail-card dispatch-detail-card-${escapeHtml(detailKind)}">
      <summary class="dispatch-detail-summary">
        <div class="dispatch-detail-header">
          <div class="dispatch-detail-title">
            ${aliveDot}
            <h3>${escapeHtml(taskLabel)}</h3>
            <p class="dispatch-detail-subtitle">${escapeHtml(subtitleParts.join(" / ") || "Worker detail")}</p>
          </div>
          <div class="dispatch-detail-pills">
            ${cycleBadge}
            ${scoreBadge}
            ${retryBadge}
            ${humanResolvedBadge}
            <span class="status-pill status-${escapeHtml(detail.status)}">${escapeHtml(detail.status)}</span>
          </div>
        </div>
      </summary>
      <div class="dispatch-detail-body">
        <dl class="summary-grid">
          <div><dt>${isValidator ? "validator" : (isPmResolver ? "pm_resolver" : "worker")}</dt><dd><code>${escapeHtml(detail.worker_id || "---")}</code></dd></div>
          <div><dt>${isValidator ? "validator_thread" : "thread"}</dt><dd><code>${escapeHtml(detail.worker_thread_id || "---")}</code></dd></div>
          <div><dt>trace_id</dt><dd><code>${escapeHtml(detail.trace_id || "---")}</code></dd></div>
        </dl>
        <div class="dispatch-detail-messages">
          ${renderDispatchMessage(commandLabel, detail.command, "No dispatch command captured yet.")}
          ${renderDispatchMessage(replyLabel, detail.reply, emptyReply)}
          ${showInlineValidation ? renderDispatchValidationMessage(detail.validation) : ""}
        </div>
        ${renderDispatchDetailActions({ taskId, threadId, detailKind, showHumanResolve, canTalk })}
      </div>
    </details>
  `;
}

function renderDispatchDetailActions({ taskId, threadId, detailKind, showHumanResolve, canTalk }) {
  const taskAttr = escapeHtml(taskId || "");
  const threadAttr = escapeHtml(threadId || "");
  const kindAttr = escapeHtml(detailKind || "worker");
  const talkKey = [detailKind || "worker", threadId || "", taskId || ""].join(":");
  const talkKeyAttr = escapeHtml(talkKey);
  const humanResolveBtn = showHumanResolve && taskId
    ? `<button type="button" class="ghost-button dispatch-detail-action-button"
        data-detail-action="human-resolve"
        data-detail-worker-id="${taskAttr}"
        title="Mark this worker HUMAN-resolved (clears blocked + reconciles failed PM)">
        ✋ HUMAN resolved
      </button>`
    : "";
  const talkForm = canTalk
    ? `<form class="dispatch-detail-talk" data-detail-action="talk"
        data-detail-thread-id="${threadAttr}"
        data-detail-kind="${kindAttr}"
        data-detail-worker-id="${taskAttr}"
        data-talk-key="${talkKeyAttr}">
        <label class="dispatch-detail-talk-label" for="dispatch-detail-talk-${taskAttr}">
          Talk directly to ${kindAttr}
        </label>
        <textarea id="dispatch-detail-talk-${taskAttr}" class="dispatch-detail-talk-input"
          name="content" rows="2"
          placeholder="Type to send a message to this thread (intent: run)..."></textarea>
        <div class="dispatch-detail-talk-actions">
          <button type="submit" class="ghost-button dispatch-detail-action-button">Send</button>
          <span class="dispatch-detail-talk-status" data-talk-feedback></span>
        </div>
        <div class="dispatch-direct-replies" data-talk-transcript data-talk-key="${talkKeyAttr}" hidden></div>
      </form>`
    : "";
  if (!humanResolveBtn && !talkForm) {
    return "";
  }
  return `
    <div class="dispatch-detail-footer">
      ${humanResolveBtn ? `<div class="dispatch-detail-footer-actions">${humanResolveBtn}</div>` : ""}
      ${talkForm}
    </div>
  `;
}

function renderPmResolverSummaryItem(detail) {
  const pmDetail = resolveLatestPmResolverDetail(detail);
  if (!pmDetail) {
    return `<div><dt>pm_resolver</dt><dd>idle</dd></div>`;
  }

  const pmDetails = resolvePmResolverDetails(detail);
  const status = normalizeText(pmDetail.status) || "running";
  const worker = normalizeText(pmDetail.worker_id).replace(/^PM:/i, "") || "issue";
  const thread = normalizeText(pmDetail.worker_thread_id) || "pending";
  const countLabel = pmDetails.length > 1 ? ` / ${pmDetails.length} total` : "";
  return `
    <div>
      <dt>pm_resolver</dt>
      <dd>
        <span class="status-pill status-${escapeHtml(status)}">${escapeHtml(status)}</span>
        <code>${escapeHtml(thread)}</code> / ${escapeHtml(worker)}${escapeHtml(countLabel)}
      </dd>
    </div>
  `;
}

function resolveLatestPmResolverDetail(detail) {
  const pmDetails = resolvePmResolverDetails(detail);
  const runningDetail = [...pmDetails].reverse()
    .find((entry) => normalizeText(entry?.status) === "running");
  return runningDetail ?? pmDetails[pmDetails.length - 1] ?? null;
}

function resolvePmResolverDetails(detail) {
  const dispatchDetails = Array.isArray(detail?.dispatch_details) ? detail.dispatch_details : [];
  return dispatchDetails.filter((entry) => entry?.detail_kind === "pm_resolver");
}

function renderDispatchPlanRows(rows, dispatchDetails) {
  const detailByWorker = groupDispatchDetailsByWorker(dispatchDetails);
  const renderedRows = [];

  rows.forEach((row) => {
    const workerKey = normalizeDispatchWorkerKey(row?.worker);
    const inlineDetails = workerKey ? detailByWorker.get(workerKey) ?? [] : [];
    if (workerKey) {
      detailByWorker.delete(workerKey);
    }
    const primaryDetail = getPrimaryDispatchDetail(inlineDetails);
    const rowModel = resolveDispatchRowAppliedModel(row, primaryDetail);
    const rowEffort = resolveDispatchRowAppliedReasoningEffort(row, primaryDetail);
    renderedRows.push(renderDispatchPlanRow({
      ...row,
      applied_model: rowModel,
      applied_reasoning_effort: rowEffort
    }, inlineDetails));
  });

  detailByWorker.forEach((details) => {
    renderedRows.push(renderDispatchPlanOrphanDetailRow(details));
  });

  return renderedRows.join("");
}

function renderDispatchPlanRow(row, details = []) {
  const inlineDetails = normalizeDispatchDetailList(details);
  const rowClassName = inlineDetails.length > 0 ? "dispatch-plan-row dispatch-plan-row-with-detail" : "dispatch-plan-row";
  const rowModel = resolveDispatchRowModelForDisplay(row, inlineDetails);

  return `
    <tr class="${rowClassName}">
      <td>${renderDispatchPlanStatus(row)}</td>
      <td>${escapeHtml(row.batch)}</td>
      <td><code>${escapeHtml(row.worker)}</code></td>
      <td>${escapeHtml(row.task)}</td>
      <td>${formatToolProgress(row.progress)}</td>
      <td>${escapeHtml(rowModel || "---")}</td>
      <td>${escapeHtml(row.depends_on || "---")}</td>
      <td>${renderActiveOwner(row)}</td>
      <td>${renderDispatchPlanActions(row)}</td>
    </tr>
    ${inlineDetails.length > 0 ? renderDispatchPlanDetailRow(inlineDetails) : ""}
  `;
}

function renderDispatchPlanOrphanDetailRow(details) {
  const inlineDetails = normalizeDispatchDetailList(details);
  const primaryDetail = getPrimaryDispatchDetail(inlineDetails);
  const syntheticRow = buildDispatchPlanSyntheticRow(primaryDetail);
  const syntheticModel = resolveDispatchWorkerAppliedModel(primaryDetail, syntheticRow.model);
  const syntheticEffort = resolveDispatchWorkerAppliedReasoningEffort(primaryDetail);

  return `
    <tr class="dispatch-plan-row dispatch-plan-row-with-detail dispatch-plan-row-orphan">
      <td>${renderDispatchPlanStatus(syntheticRow)}</td>
      <td>---</td>
      <td><code>${escapeHtml(syntheticRow.worker || "---")}</code></td>
      <td>${escapeHtml(syntheticRow.task || "---")}</td>
      <td>${formatToolProgress(syntheticRow.progress)}</td>
      <td>${escapeHtml(syntheticModel || syntheticRow.model || "---")}</td>
      <td>---</td>
      <td>${renderActiveOwner(syntheticRow)}</td>
      <td>${renderDispatchPlanActions({
        ...syntheticRow,
        applied_model: syntheticModel,
        applied_reasoning_effort: syntheticEffort
      })}</td>
    </tr>
    ${renderDispatchPlanDetailRow(inlineDetails, 9)}
  `;
}

function renderDispatchPlanDetailRow(details, colspan = 9) {
  const inlineDetails = sortDispatchDetailsForDisplay(normalizeDispatchDetailList(details));
  const hasSiblingValidatorBars = inlineDetails.some((detail) => detail?.detail_kind === "validator");
  return `
    <tr class="dispatch-plan-detail-row">
      <td colspan="${colspan}">
        <div class="dispatch-plan-inline-detail">
          ${inlineDetails.map((detail) => renderDispatchDetailCard(detail, { hasSiblingValidatorBars })).join("")}
        </div>
      </td>
    </tr>
  `;
}

// Display order within a single task's bar stack: the worker (latest
// attempt) first, then validator cycles in cycle order, then PM
// resolvers in start order. This mirrors the on-disk lifecycle: the
// worker emits its marker, then validators run cycles 1..N, then PM
// resolvers (if any) handle escalations.
function sortDispatchDetailsForDisplay(details) {
  const kindOrder = { worker: 0, validator: 1, pm_resolver: 2 };

  return [...details].sort((left, right) => {
    const leftKind = kindOrder[left?.detail_kind] ?? 3;
    const rightKind = kindOrder[right?.detail_kind] ?? 3;
    if (leftKind !== rightKind) {
      return leftKind - rightKind;
    }

    if (left?.detail_kind === "validator" && right?.detail_kind === "validator") {
      const leftCycle = typeof left.validator_cycle === "number" ? left.validator_cycle : 0;
      const rightCycle = typeof right.validator_cycle === "number" ? right.validator_cycle : 0;
      return leftCycle - rightCycle;
    }

    const leftTs = left?.reply?.timestamp ?? left?.command?.timestamp ?? "";
    const rightTs = right?.reply?.timestamp ?? right?.command?.timestamp ?? "";
    return String(leftTs).localeCompare(String(rightTs));
  });
}

function groupDispatchDetailsByWorker(dispatchDetails) {
  const detailByWorker = new Map();

  dispatchDetails.forEach((detail) => {
    const workerKey = normalizeDispatchDetailWorkerKey(detail);
    if (!workerKey) {
      return;
    }

    const details = detailByWorker.get(workerKey) ?? [];
    details.push(detail);
    detailByWorker.set(workerKey, details);
  });

  return detailByWorker;
}

function indexDispatchDetailsByWorker(dispatchDetails) {
  const detailByWorker = new Map();

  dispatchDetails.forEach((detail) => {
    const workerKey = normalizeDispatchWorkerKey(detail?.worker_id);
    if (!workerKey || detailByWorker.has(workerKey)) {
      return;
    }

    detailByWorker.set(workerKey, detail);
  });

  return detailByWorker;
}

function normalizeDispatchDetailWorkerKey(detail) {
  // task_id is the canonical grouping key (the dispatch-plan worker that
  // owns this bar). Older payloads without task_id fall back to deriving
  // it from worker_id, stripping role-specific prefixes.
  if (typeof detail?.task_id === "string" && detail.task_id.length > 0) {
    return normalizeDispatchWorkerKey(detail.task_id);
  }

  const workerId = normalizeText(detail?.worker_id);
  let baseWorkerId = workerId;
  if (detail?.detail_kind === "pm_resolver") {
    baseWorkerId = workerId.replace(/^PM:/i, "");
  } else if (detail?.detail_kind === "validator") {
    baseWorkerId = workerId.replace(/^VALIDATOR:/i, "").replace(/:CYCLE-\d+$/i, "");
  }
  return normalizeDispatchWorkerKey(baseWorkerId);
}

function normalizeDispatchDetailList(details) {
  if (Array.isArray(details)) {
    return details.filter(Boolean);
  }

  return details ? [details] : [];
}

function getPrimaryDispatchDetail(details) {
  const detailList = normalizeDispatchDetailList(details);
  return detailList.find((detail) => detail?.detail_kind !== "pm_resolver")
    ?? detailList[0]
    ?? null;
}

function normalizeDispatchWorkerKey(workerId) {
  return normalizeText(workerId).toUpperCase();
}

function buildDispatchPlanSyntheticRow(detail) {
  const detailKind = detail?.detail_kind || "";
  const ownerKind = detailKind === "validator" || detailKind === "pm_resolver" || detailKind === "worker"
    ? detailKind
    : null;
  return {
    status: toDispatchPlanStatus(detail?.status),
    worker: detail?.worker_id || "",
    task: detail?.task || "",
    model: detail?.model || detail?.applied_model || "",
    applied_model: detail?.applied_model || detail?.model || "",
    applied_reasoning_effort: detail?.applied_reasoning_effort || null,
    depends_on: "---",
    thread_id: detail?.worker_thread_id || "",
    detail_kind: detailKind,
    active_owner_kind: ownerKind,
    active_owner_thread_id: detail?.worker_thread_id || "",
    read_only: detailKind === "pm_resolver"
  };
}

function renderActiveOwner(row) {
  const kind = row?.active_owner_kind || null;
  const threadId = row?.active_owner_thread_id || "";
  const fallbackThreadId = row?.thread_id || "";

  if (!kind && !fallbackThreadId) {
    return `<span class="muted">idle</span>`;
  }

  const effectiveKind = kind || (fallbackThreadId ? "worker" : null);
  const effectiveThreadId = threadId || fallbackThreadId;
  const label = effectiveKind ? formatOwnerKindLabel(effectiveKind) : "—";
  const icon = effectiveKind ? formatOwnerKindIcon(effectiveKind) : "";
  const threadDisplay = effectiveThreadId
    ? `<code title="${escapeHtml(effectiveThreadId)}">${escapeHtml(effectiveThreadId)}</code>`
    : `<span class="muted">pending</span>`;

  return `
    <div class="dispatch-plan-owner">
      <span class="owner-kind">${icon ? `${icon} ` : ""}${escapeHtml(label)}</span>
      ${threadDisplay}
    </div>
  `;
}

function formatOwnerKindLabel(kind) {
  switch (kind) {
    case "worker": return "worker";
    case "validator": return "validator";
    case "pm_resolver": return "pm_resolver";
    default: return String(kind || "—");
  }
}

function formatOwnerKindIcon(kind) {
  switch (kind) {
    case "worker": return "🛠";
    case "validator": return "🔍";
    case "pm_resolver": return "🤝";
    default: return "";
  }
}

function renderDispatchPlanStatus(row) {
  const staleLabel = formatDispatchPlanStaleLabel(row);

  return `
    <div class="dispatch-plan-status">
      <span>${escapeHtml(row.status || "---")}</span>
      ${staleLabel ? `<span class="stale-pill">${escapeHtml(staleLabel)}</span>` : ""}
    </div>
  `;
}

function renderDispatchPlanActions(row) {
  // read_only is set by buildDispatchPlanSyntheticRow for pm_resolver detail-kind rows
  // (auto-resolved by the PM resolver subsystem, no operator action surface).
  // Plan rows with model=HUMAN or model=PM must keep their action buttons —
  // those are the only paths the operator has to drive a human-gated row to a
  // terminal status (Force Complete / Skip). Hiding them broke recovery from
  // the V-01-B HUMAN-gate loop scenario (2026-05-19).
  if (row?.read_only) {
    return `<span class="muted">---</span>`;
  }

  const workerId = escapeHtml(row.worker || "");
  const currentStatus = normalizeDispatchPlanStatus(row?.status);
  const currentModel = normalizeText(row?.applied_model) || normalizeText(row?.model);
  const currentReasoningEffort = normalizeText(row?.applied_reasoning_effort);
  const canContinue = canContinueDispatchRow(row);
  const statusEditor = currentStatus === "running" && !row?.show_status_editor
    ? ""
    : renderDispatchPlanStatusEditor(workerId, currentStatus, currentModel, currentReasoningEffort);

  if (currentStatus === "abandoned" || canContinue) {
    return `
      <div class="table-action-stack">
        <div class="table-action-group">
          <button type="button" class="primary-button table-action-button" data-worker-id="${workerId}" data-continue-worker>Continue</button>
          ${currentStatus === "running" ? `
          <button type="button" class="ghost-button table-action-button" data-worker-id="${workerId}" data-resume-action="retry">Redo</button>
          <button type="button" class="ghost-button table-action-button" data-worker-id="${workerId}" data-resume-action="skip">Skip</button>
          ` : ""}
          <button type="button" class="ghost-button table-action-button" data-worker-id="${workerId}" data-resume-action="validate">Validate</button>
          <button type="button" class="danger-button table-action-button" data-worker-id="${workerId}" data-resume-action="force-complete">Force Complete</button>
        </div>
        ${statusEditor}
      </div>
    `;
  }

  if (currentStatus === "running") {
    return `
      <div class="table-action-stack">
        <div class="table-action-group">
          <button type="button" class="ghost-button table-action-button" data-worker-id="${workerId}" data-resume-action="retry">Redo</button>
          <button type="button" class="ghost-button table-action-button" data-worker-id="${workerId}" data-resume-action="skip">Skip</button>
          <button type="button" class="ghost-button table-action-button" data-worker-id="${workerId}" data-resume-action="validate">Validate</button>
          <button type="button" class="danger-button table-action-button" data-worker-id="${workerId}" data-resume-action="force-complete">Force Complete</button>
        </div>
        ${statusEditor}
      </div>
    `;
  }

  return `
    <div class="table-action-stack">
      <div class="table-action-group">
        <button type="button" class="ghost-button table-action-button" data-worker-id="${workerId}" data-resume-action="retry">Redo</button>
        <button type="button" class="ghost-button table-action-button" data-worker-id="${workerId}" data-resume-action="validate">Validate</button>
        <button type="button" class="danger-button table-action-button" data-worker-id="${workerId}" data-resume-action="force-complete">Force Complete</button>
      </div>
      ${statusEditor}
    </div>
  `;
}

function resolveDispatchRowAppliedModel(row, primaryDetail) {
  return normalizeText(primaryDetail?.applied_model)
    || normalizeText(row?.applied_model)
    || normalizeText(row?.model)
    || "";
}

function resolveDispatchRowAppliedReasoningEffort(row, primaryDetail) {
  return normalizeText(primaryDetail?.applied_reasoning_effort)
    || normalizeText(row?.applied_reasoning_effort)
    || "";
}

function resolveDispatchWorkerAppliedModel(detail, fallbackModel) {
  return normalizeText(detail?.applied_model)
    || normalizeText(detail?.model)
    || normalizeText(fallbackModel)
    || "";
}

function resolveDispatchWorkerAppliedReasoningEffort(detail) {
  return normalizeText(detail?.applied_reasoning_effort) || "";
}

function resolveDispatchRowModelForDisplay(row, details = []) {
  const primaryDetail = getPrimaryDispatchDetail(details);
  return resolveDispatchRowAppliedModel(row, primaryDetail);
}

function renderDispatchPlanStatusEditor(workerId, currentStatus, currentModel, currentEffort) {
  const options = [
    "pending",
    "completed",
    "blocked",
    "failed",
    "abandoned",
    "skipped"
  ].map((status) => {
    const selected = status === currentStatus ? " selected" : "";
    return `<option value="${status}"${selected}>${escapeHtml(formatDispatchStatusLabel(status))}</option>`;
  }).join("");
  const modelOptions = resolveModelOptions(currentModel);
  const effortOptions = resolveEffortOptions(currentEffort);

  return `
    <div class="table-status-controls">
      <select class="table-status-select" data-worker-status aria-label="Update worker status for ${workerId}">
        ${options}
      </select>
      <select class="table-status-select" data-worker-model aria-label="Model override for ${workerId}">
        ${modelOptions}
      </select>
      <select class="table-status-select" data-worker-effort aria-label="Effort override for ${workerId}">
        ${effortOptions}
      </select>
      <button type="button" class="ghost-button table-action-button" data-worker-id="${workerId}" data-status-apply>Apply</button>
    </div>
  `;
}

function normalizeUnique(items) {
  const seen = new Set();
  return items.filter((item, index) => {
    const normalized = normalizeText(item);
    const key = normalized.toLowerCase();
    if (index === 0 && item === "") {
      seen.add(key);
      return true;
    }

    if (!normalized || seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function resolveModelOptions(currentModel) {
  const options = normalizeUnique([
    "",
    currentModel,
    "CODEX",
    "CODEX-HIGH",
    "CODEX-XHIGH",
    "OPUS",
    "SONNET",
    "GEMINI",
    ...WORKER_MODEL_OPTIONS
  ]);

  return options.map((model, index) => {
    const isCurrent = model === currentModel && index > 0 ? true : false;
    const selected = isCurrent ? " selected" : "";
    const label = isCurrent ? `${model} (current)` : model || "keep current";
    return `<option value="${escapeHtml(model)}"${selected}>${escapeHtml(label)}</option>`;
  }).join("");
}

function resolveEffortOptions(currentEffort) {
  const options = normalizeUnique(["", ...WORKER_REASONING_EFFORT_OPTIONS, currentEffort]);

  return options.map((effort, index) => {
    const isCurrent = effort === currentEffort && index > 0 ? true : false;
    const selected = isCurrent ? " selected" : "";
    const label = effort || "keep current";
    return `<option value="${escapeHtml(effort)}"${selected}>${escapeHtml(label)}</option>`;
  }).join("");
}

function formatDispatchPlanStaleLabel(row) {
  if (!row?.stale) {
    return "";
  }

  const minutes = typeof row.stale_duration_minutes === "number" && Number.isFinite(row.stale_duration_minutes)
    ? `${row.stale_duration_minutes}min`
    : normalizeText(row.stale_duration_human);

  return minutes ? `STALE ${minutes}` : "STALE";
}

function renderDispatchMessage(label, detail, emptyMessage) {
  const sender = formatDispatchSender(detail);
  const senderModel = typeof detail?.sender_model === "string" && detail.sender_model.trim().length > 0
    ? detail.sender_model.trim()
    : "---";
  const timestamp = formatTimestamp(detail?.timestamp);

  return `
    <section class="dispatch-message">
      <div class="dispatch-message-header">
        <div>
          <p class="dispatch-message-label">${escapeHtml(label)}</p>
          <h4>${escapeHtml(sender)}</h4>
        </div>
        <p class="dispatch-message-caption">${escapeHtml(timestamp)}</p>
      </div>
      <dl class="dispatch-meta">
        <div><dt>trace_id</dt><dd><code>${escapeHtml(detail?.trace_id || "---")}</code></dd></div>
        <div><dt>sender</dt><dd>${escapeHtml(sender)}</dd></div>
        <div><dt>model</dt><dd>${escapeHtml(senderModel)}</dd></div>
        <div><dt>time</dt><dd>${escapeHtml(timestamp)}</dd></div>
      </dl>
      ${detail?.content
        ? `<pre class="dispatch-message-content">${escapeHtml(detail.content)}</pre>`
        : `<p class="dispatch-message-empty">${escapeHtml(emptyMessage)}</p>`}
    </section>
  `;
}

function renderDispatchValidationMessage(validation) {
  const history = Array.isArray(validation?.history) ? validation.history : [];
  const latest = history.length > 0 ? history[history.length - 1] : null;
  const latestScore = typeof validation?.last_score === "number"
    ? validation.last_score
    : (typeof latest?.score === "number" ? latest.score : null);
  const latestCycle = typeof latest?.cycle === "number"
    ? latest.cycle
    : (typeof validation?.current_cycle === "number" ? validation.current_cycle : null);
  const maxCycles = typeof validation?.max_fix_cycles === "number" ? validation.max_fix_cycles : null;
  const validatorThreadId = normalizeText(latest?.validator_thread_id)
    || normalizeText(validation?.validator_thread_id)
    || "validator";

  if (!validation) {
    return renderDispatchMessage("Validator Reply", null, "No validator reply captured yet.");
  }

  const contentParts = history.length > 0
    ? history.flatMap((entry, index) => {
      const entryParts = [];
      const entryScore = typeof entry?.score === "number" ? entry.score : null;
      const entryCycle = typeof entry?.cycle === "number" ? entry.cycle : null;
      const entryThreadId = normalizeText(entry?.validator_thread_id) || "validator";
      entryParts.push(`Cycle: ${entryCycle ?? "---"}/${maxCycles ?? "---"}`);
      entryParts.push(`Score: ${formatValidatorScore(entryScore)}`);
      entryParts.push(`Validator: ${entryThreadId}`);
      const entryFeedback = normalizeText(entry?.feedback);
      if (entryFeedback) {
        entryParts.push("");
        entryParts.push(entryFeedback);
      }
      if (index < history.length - 1) {
        entryParts.push("");
        entryParts.push("---");
        entryParts.push("");
      }
      return entryParts;
    })
    : [];
  if (contentParts.length === 0) {
    const feedback = normalizeText(validation?.last_feedback) || normalizeText(latest?.feedback);
    if (latestScore !== null) {
      contentParts.push(`Score: ${formatValidatorScore(latestScore)}`);
    }
    if (latestCycle !== null || maxCycles !== null) {
      contentParts.push(`Cycle: ${latestCycle ?? "---"}/${maxCycles ?? "---"}`);
    }
    if (validatorThreadId) {
      contentParts.push(`Validator: ${validatorThreadId}`);
    }
    if (feedback) {
      if (contentParts.length > 0) {
        contentParts.push("");
      }
      contentParts.push(feedback);
    }
  }

  return renderDispatchMessage(
    "Validator Reply",
    {
      trace_id: null,
      sender_name: validatorThreadId,
      sender_agent_type: "validator",
      sender_model: latestScore === null ? null : `score ${formatValidatorScore(latestScore)}`,
      sender_thread_id: validatorThreadId,
      timestamp: latest?.timestamp || null,
      content: contentParts.join("\n")
    },
    "No validator reply captured yet."
  );
}

function formatValidatorScore(score) {
  if (typeof score !== "number" || !Number.isFinite(score)) {
    return "---";
  }

  return score.toFixed(2);
}

function formatDispatchSender(detail) {
  if (!detail) {
    return "---";
  }

  const senderName = typeof detail.sender_name === "string" && detail.sender_name.trim().length > 0
    ? detail.sender_name.trim()
    : "unknown";
  const senderType = typeof detail.sender_agent_type === "string" && detail.sender_agent_type.trim().length > 0
    ? detail.sender_agent_type.trim()
    : "";
  const senderModel = typeof detail.sender_model === "string" && detail.sender_model.trim().length > 0
    ? detail.sender_model.trim()
    : "";

  return [senderName, senderType, senderModel].filter(Boolean).join(" / ");
}

function formatTimestamp(value) {
  if (typeof value !== "string" || value.trim().length === 0) {
    return "---";
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "medium"
  }).format(parsed);
}

/* ═══════════════════════════════════════════════════════════════
   Manual Reply Channel UI
   ═══════════════════════════════════════════════════════════════ */

function syncManualReplyChatPlaceholder(manualChannelSelect, manualChatIdInput) {
  if (!manualChatIdInput) {
    return;
  }

  if (manualChannelSelect.value === "telegram") {
    manualChatIdInput.placeholder = "6137086342 or telegram:6137086342";
  } else {
    manualChatIdInput.placeholder = "web:gui-demo";
  }
}

function refreshManualReplyUi(
  manualChannelSelect,
  manualBotField,
  manualTelegramUserField,
  manualTelegramUserSelect,
  manualChatIdField,
  manualChatIdInput
) {
  const manualTelegram = manualChannelSelect.value === "telegram";

  if (manualBotField) {
    manualBotField.hidden = !manualTelegram;
  }
  if (manualTelegramUserField) {
    manualTelegramUserField.hidden = !manualTelegram;
  }

  if (manualChatIdField && manualChatIdInput) {
    const presetUid = manualTelegramUserSelect ? normalizeText(manualTelegramUserSelect.value) : "";
    if (manualTelegram && presetUid) {
      manualChatIdField.hidden = true;
      manualChatIdInput.value = "";
    } else {
      manualChatIdField.hidden = false;
    }
  }

  syncManualReplyChatPlaceholder(manualChannelSelect, manualChatIdInput);
}

function collectAgentDispatcherReplyChannels(
  manualChannelSelect,
  manualChatIdInput,
  manualBotSelect,
  manualTelegramUserSelect
) {
  const manualChannel = normalizeText(manualChannelSelect.value) || "web";

  if (manualChannel === "telegram") {
    const presetUid = manualTelegramUserSelect ? normalizeText(manualTelegramUserSelect.value) : "";
    let manualChatId = "";
    if (presetUid) {
      manualChatId = `telegram:${presetUid}`;
    } else {
      manualChatId = normalizeText(manualChatIdInput.value);
      if (!manualChatId) {
        return [];
      }
      if (/^\d+$/.test(manualChatId)) {
        manualChatId = `telegram:${manualChatId}`;
      }
    }

    const row = {
      channel: "telegram",
      chat_id: manualChatId
    };

    const botPick = manualBotSelect ? normalizeText(manualBotSelect.value) : "";
    if (botPick) {
      row.bot_id = botPick;
    }

    return [row];
  }

  const manualChatId = normalizeText(manualChatIdInput.value);
  if (!manualChatId) {
    return [];
  }

  return [{
    channel: manualChannel,
    chat_id: manualChatId
  }];
}

/* ═══════════════════════════════════════════════════════════════
   Dispatcher State Helpers
   ═══════════════════════════════════════════════════════════════ */

function pruneAgentDispatcherDetailCache(cache, threadIds) {
  const activeThreadIds = new Set(threadIds);
  Array.from(cache.keys()).forEach((threadId) => {
    if (!activeThreadIds.has(threadId)) {
      cache.delete(threadId);
    }
  });
}

function isAgentDispatcherLaunchConfig(config) {
  return Boolean(
    config
    && typeof config === "object"
    && Object.prototype.hasOwnProperty.call(config, "dispatch_plan_path")
    && Object.prototype.hasOwnProperty.call(config, "command_file_path")
  );
}

function resolveDispatcherCardControl(detail) {
  const status = normalizeText(detail?.status);
  const hasLiveThread = hasLiveDispatcherThread(detail);
  const recoverableWorker = normalizeText(detail?.continue_worker);
  const liveWorker = resolveLiveRunningWorker(detail);
  const validationWorker = resolveValidationContinueWorker(detail);
  // Start hub session is available whenever the dispatcher is non-terminal —
  // including when its hub thread is missing, so the operator can spawn a
  // recovery thread without leaving the dashboard.
  const showStartHub = !isTerminalDispatcherStatus(status);

  if (isTerminalDispatcherStatus(status)) {
    return { action: "continue", label: formatTerminalDispatcherStatus(status), disabled: true, showStartHub: false };
  }

  if (liveWorker) {
    return { action: "continue", label: "Working", disabled: true, showStartHub };
  }

  if (validationWorker) {
    return { action: "continue", label: "Continue", disabled: false, showStartHub };
  }

  if (recoverableWorker) {
    return { action: "continue", label: "Continue", disabled: false, showStartHub };
  }

  if (status === "paused") {
    return { action: "resume", label: "Resume", disabled: false, showStartHub };
  }

  if (status === "needs_reactivation") {
    return { action: "continue", label: "Continue", disabled: false, showStartHub };
  }

  if (!hasLiveThread) {
    return { action: "continue", label: "Idle", disabled: true, showStartHub };
  }

  return { action: "pause", label: "Pause", disabled: false, showStartHub };
}

function resolveDispatcherDetailControls(detail) {
  const status = normalizeText(detail?.status);
  const hasLiveThread = hasLiveDispatcherThread(detail);
  const recoverableWorker = normalizeText(detail?.continue_worker);
  const liveWorker = resolveLiveRunningWorker(detail);
  const validationWorker = resolveValidationContinueWorker(detail);
  // Start hub session must remain reachable whenever the dispatcher is
  // non-terminal — including the `active` + no-live-thread state that occurs
  // after a process restart, so the operator can spawn a recovery thread from
  // the role detail page instead of being silently locked out.
  const showStartHub = !isTerminalDispatcherStatus(status);

  // Pause/Resume targets the dispatcher session itself — independent of worker
  // state. Whenever the dispatcher has a live hub thread and is not terminal,
  // expose the lifecycle control so users can stop autonomous progress at any
  // time (including while a worker is mid-validation or waiting on a validator
  // respawn). The Continue/Working button can render alongside it.
  const lifecycle = resolveDispatcherLifecycleControls(status, hasLiveThread);

  if (isTerminalDispatcherStatus(status)) {
    return {
      showContinue: true,
      continueLabel: formatTerminalDispatcherStatus(status),
      continueDisabled: true,
      showStartHub: false,
      ...lifecycle
    };
  }

  if (liveWorker) {
    return {
      showContinue: true,
      continueLabel: "Working",
      continueDisabled: true,
      showStartHub,
      ...lifecycle
    };
  }

  if (validationWorker) {
    return {
      showContinue: true,
      continueLabel: "Continue",
      continueDisabled: false,
      showStartHub,
      ...lifecycle
    };
  }

  if (recoverableWorker) {
    return {
      showContinue: true,
      continueLabel: "Continue",
      continueDisabled: false,
      showStartHub,
      ...lifecycle
    };
  }

  if (status === "needs_reactivation") {
    return {
      showContinue: true,
      continueLabel: "Continue",
      continueDisabled: false,
      showStartHub,
      ...lifecycle
    };
  }

  if (status === "paused") {
    return {
      showContinue: false,
      continueLabel: "Continue",
      continueDisabled: false,
      showStartHub,
      ...lifecycle
    };
  }

  // Non-terminal dispatcher with no live hub thread (typical after a process
  // restart). Show a disabled "Idle" indicator so the action bar isn't blank,
  // and leave Start hub session enabled (showStartHub above) as the recovery
  // path. Mirrors the dashboard card's behaviour for the same state.
  if (!hasLiveThread) {
    return {
      showContinue: true,
      continueLabel: "Idle",
      continueDisabled: true,
      showStartHub,
      ...lifecycle
    };
  }

  return {
    showContinue: false,
    continueLabel: "Continue",
    continueDisabled: false,
    showStartHub,
    ...lifecycle
  };
}

function resolveDispatcherLifecycleControls(status, hasLiveThread) {
  if (isTerminalDispatcherStatus(status)) {
    return { showLifecycle: false, lifecycleAction: null, lifecycleLabel: "" };
  }
  // Paused dispatchers must expose Resume even without a live hub thread.
  // /resume hits setAgentDispatcherStatus, which calls
  // reactivatePersistedAgentDispatcher before flipping status — so the
  // no-live-thread case is recoverable from the GUI and shouldn't be silently
  // locked out (operator otherwise sees only Continue/Start hub session, both
  // of which return "still blocked: dispatcher is paused — hit Resume").
  if (status === "paused") {
    return { showLifecycle: true, lifecycleAction: "resume", lifecycleLabel: "Resume" };
  }
  if (!hasLiveThread || status === "needs_reactivation") {
    return { showLifecycle: false, lifecycleAction: null, lifecycleLabel: "" };
  }
  return { showLifecycle: true, lifecycleAction: "pause", lifecycleLabel: "Pause" };
}

function hasLiveDispatcherThread(detail) {
  return normalizeText(detail?.dispatcher_thread_id).length > 0;
}

function isTerminalDispatcherStatus(status) {
  return status === "completed";
}

function formatTerminalDispatcherStatus(status) {
  return status === "completed" ? "Completed" : status;
}

function resolveDispatcherTaskContext(detail) {
  const dispatchPlanRows = Array.isArray(detail?.dispatch_plan?.rows) ? detail.dispatch_plan.rows : [];
  const dispatchDetails = Array.isArray(detail?.dispatch_details) ? detail.dispatch_details : [];
  const detailByWorker = indexDispatchDetailsByWorker(dispatchDetails);

  const resolveContextForWorker = (label, workerId) => {
    const workerKey = normalizeDispatchWorkerKey(workerId);
    const dispatchPlanRow = dispatchPlanRows.find((row) => normalizeDispatchWorkerKey(row?.worker) === workerKey) ?? null;
    const dispatchDetail = detailByWorker.get(workerKey) ?? null;
    const taskLabel = normalizeText(dispatchPlanRow?.task || dispatchDetail?.task);
    const workerLabel = normalizeText(workerId) || normalizeText(dispatchDetail?.worker_id) || "idle";
    const summary = [workerLabel, taskLabel].filter(Boolean).join(" / ") || "No running or pending task.";

    return {
      label,
      summary
    };
  };

  const liveWorker = resolveLiveRunningWorker(detail);
  if (liveWorker) {
    return resolveContextForWorker("running task", liveWorker);
  }

  const continueWorker = normalizeText(detail?.continue_worker);
  if (continueWorker) {
    return resolveContextForWorker("ready task", continueWorker);
  }

  const currentWorker = normalizeText(detail?.current_worker);
  if (currentWorker) {
    return resolveContextForWorker("current task", currentWorker);
  }

  const preferredRow = dispatchPlanRows.find((row) => {
    const normalizedStatus = normalizeDispatchPlanStatus(row?.status);
    return (normalizedStatus === "pending" || normalizedStatus === "abandoned" || normalizedStatus === "failed")
      && !isHumanDispatchModel(row?.model);
  });
  if (preferredRow?.worker) {
    return resolveContextForWorker("next task", preferredRow.worker);
  }

  const latestDetail = [...dispatchDetails].reverse().find((worker) => normalizeText(worker?.worker_id).length > 0);
  if (latestDetail?.worker_id) {
    return resolveContextForWorker("recent task", latestDetail.worker_id);
  }

  return {
    label: "task context",
    summary: "No running or pending task."
  };
}

function resolveLiveRunningWorker(detail) {
  const liveDispatchDetail = Array.isArray(detail?.dispatch_details)
    ? detail.dispatch_details.find((worker) => {
      return normalizeText(worker?.status) === "running"
        && normalizeText(worker?.worker_thread_id).length > 0
        && !isHumanDispatchModel(worker?.model);
    })
    : null;
  if (liveDispatchDetail) {
    return normalizeText(liveDispatchDetail.worker_id);
  }

  const liveDispatchPlanRow = Array.isArray(detail?.dispatch_plan?.rows)
    ? detail.dispatch_plan.rows.find((row) => {
      return normalizeDispatchPlanStatus(row?.status) === "running"
        && normalizeText(row?.thread_id).length > 0
        && !isHumanDispatchModel(row?.model);
    })
    : null;

  return normalizeText(liveDispatchPlanRow?.worker);
}

function resolveValidationContinueWorker(detail) {
  const validationDetail = Array.isArray(detail?.dispatch_details)
    ? detail.dispatch_details.find((worker) => {
      const status = normalizeDispatchPlanStatus(worker?.status);
      return (status === "awaiting_validation" || status === "fix_requested")
        && normalizeText(worker?.worker_id).length > 0
        && !isHumanDispatchModel(worker?.model);
    })
    : null;
  if (validationDetail) {
    return normalizeText(validationDetail.worker_id);
  }

  const validationRow = Array.isArray(detail?.dispatch_plan?.rows)
    ? detail.dispatch_plan.rows.find((row) => {
      const status = normalizeDispatchPlanStatus(row?.status);
      return (status === "awaiting_validation" || status === "fix_requested")
        && normalizeText(row?.worker).length > 0
        && !isHumanDispatchModel(row?.model);
    })
    : null;

  return normalizeText(validationRow?.worker);
}

function canContinueDispatchRow(row) {
  const status = normalizeDispatchPlanStatus(row?.status);
  if (status === "awaiting_validation" || status === "fix_requested") {
    return !isHumanDispatchModel(row?.model);
  }

  return status === "running"
    && normalizeText(row?.thread_id).length === 0
    && !isHumanDispatchModel(row?.model);
}

function isHumanDispatchModel(model) {
  const normalized = normalizeText(model).toUpperCase();
  return normalized === "HUMAN" || normalized === "PM";
}

/* ═══════════════════════════════════════════════════════════════
   Status / Label Formatting
   ═══════════════════════════════════════════════════════════════ */

function formatDispatcherControlProgress(action, threadId) {
  switch (action) {
    case "continue":
      return `Continuing ${threadId}...`;
    case "pause":
      return `Pausing ${threadId}...`;
    default:
      return `Resuming ${threadId}...`;
  }
}

function formatDispatcherControlResult(action, threadId, response) {
  if (action === "continue") {
    return formatContinueResult(response);
  }

  return `Dispatcher ${threadId} is now ${response.status}.`;
}

function formatResumeActionLabel(action) {
  switch (action) {
    case "skip":
      return "Skipping";
    case "force-complete":
      return "Force completing";
    case "validate":
      return "Sending to validator for";
    default:
      return "Redoing";
  }
}

function formatResumeActionSuccess(action) {
  switch (action) {
    case "skip":
      return "marked skipped";
    case "force-complete":
      return "marked complete";
    case "validate":
      return "queued for validator";
    default:
      return "reset to pending for another pass";
  }
}

function formatContinueResult(result) {
  const message = typeof result?.message === "string" && result.message.trim().length > 0
    ? result.message.trim()
    : "";

  switch (result?.status) {
    case "continued":
      return message || "continued";
    case "continued_parallel":
      return message || "continued parallel";
    case "still_blocked":
      return message || "still blocked";
    case "manual_intervention_required":
      return message || "manual intervention required";
    // Parked behind an unreleased PM `escalate_human`. Distinct from
    // `still_blocked` on purpose: nothing automatic will ever clear it, only
    // the HUMAN-resolve action on the worker detail panel.
    case "awaiting_human_resolution":
      return message || "awaiting human resolution";
    // Parked behind a Context Capsule that still carries `⏳ 待物化`. Distinct
    // from `still_blocked` for the same reason as above: this one clears either
    // when the named dependency completes (automatic) or when PM writes the
    // sections the dispatcher cannot derive — never by retrying.
    case "awaiting_materialization":
      return message || "awaiting materialization";
    case "local_tool_bootstrap_failed":
      return message || "local tool bootstrap failed";
    case "validation_in_progress":
      return message || "validation in progress";
    case "validation_feedback_delivered":
      return message || "validator feedback delivered";
    default:
      return message || "continue result unavailable";
  }
}

function normalizeDispatchPlanStatus(status) {
  switch (status) {
    case "⬜":
      return "pending";
    case "🔄":
      return "running";
    case "✅":
      return "completed";
    case "❌":
      return "failed";
    case "⛔ BLOCKED":
      return "blocked";
    case "⚠️ ABANDONED":
      return "abandoned";
    case "⛔ SKIPPED":
      return "skipped";
    case "🔍":
      return "awaiting_validation";
    case "running":
      return "running";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "blocked":
      return "blocked";
    case "abandoned":
      return "abandoned";
    case "skipped":
      return "skipped";
    case "awaiting_validation":
      return "awaiting_validation";
    case "pending":
    default:
      if (typeof status === "string" && status.startsWith("🔁")) {
        return "fix_requested";
      }
      if (typeof status === "string" && status.startsWith("fix")) {
        return "fix_requested";
      }
      return "pending";
  }
}

function toDispatchPlanStatus(status) {
  switch (normalizeDispatchPlanStatus(status)) {
    case "running":
      return "running";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "blocked":
      return "blocked";
    case "abandoned":
      return "abandoned";
    case "skipped":
      return "skipped";
    case "awaiting_validation":
      return "awaiting_validation";
    case "fix_requested":
      return "fix_requested";
    default:
      return "pending";
  }
}

function formatDispatchStatusLabel(status) {
  switch (status) {
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
    case "blocked":
      return "Blocked";
    case "abandoned":
      return "Abandoned";
    case "skipped":
      return "Skipped";
    case "awaiting_validation":
      return "Validating";
    case "fix_requested":
      return "Fix Requested";
    default:
      return "Pending";
  }
}

function formatDispatchStatusSuccess(status) {
  switch (status) {
    case "completed":
      return "marked complete";
    case "failed":
      return "marked failed";
    case "blocked":
      return "marked blocked";
    case "abandoned":
      return "marked abandoned";
    case "skipped":
      return "marked skipped";
    default:
      return "reset to pending";
  }
}

function formatTimeShort(value) {
  if (!value) {
    return "---";
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit"
  }).format(parsed);
}

function setElementText(id, value) {
  const element = document.getElementById(id);
  if (!element) {
    return;
  }
  element.textContent = String(value);
}

function setElementValue(id, value) {
  const element = document.getElementById(id);
  if (!element || value === undefined || value === null) {
    return;
  }
  element.value = String(value);
}

function formatDepends(dependsOn) {
  return Array.isArray(dependsOn) && dependsOn.length > 0 ? dependsOn.join(", ") : (dependsOn || "---");
}

function formatToolProgress(progress) {
  if (!progress) {
    return "---";
  }

  const command = progress.command || "tool";
  const processed = formatCount(progress.processed);
  const total = formatCount(progress.total);
  const remaining = formatCount(progress.remaining);
  const success = formatCount(progress.success);
  const failed = formatCount(progress.failed);
  const skipped = formatCount(progress.skipped);
  const updated = formatTimestamp(progress.updated_at);
  const lastSkill = progress.last_skill
    ? `${progress.last_skill.owner}/${progress.last_skill.slug}`
    : null;
  const extraLines = formatToolProgressExtra(progress.extra);

  return [
    '<div class="tool-progress">',
    `<div><span class="status-badge ${statusClass(progress.status)}">${escapeHtml(progress.status || "unknown")}</span> <strong>${escapeHtml(command)}</strong></div>`,
    `<div class="tool-progress-main">${processed} / ${total} processed</div>`,
    `<div class="tool-progress-muted">${remaining} remaining; ${success} success, ${failed} failed, ${skipped} skipped</div>`,
    `<div class="tool-progress-muted">Updated ${escapeHtml(updated)}</div>`,
    lastSkill ? `<div class="tool-progress-muted">${escapeHtml(lastSkill)}</div>` : "",
    extraLines,
    "</div>"
  ].join("");
}

function formatToolProgressExtra(extra) {
  if (!extra || typeof extra !== "object") {
    return "";
  }
  const entries = Object.entries(extra);
  if (entries.length === 0) {
    return "";
  }
  return entries.map(([key, value]) => {
    const display = value === null || value === undefined
      ? "—"
      : typeof value === "object"
        ? JSON.stringify(value)
        : String(value);
    return `<div class="tool-progress-muted">${escapeHtml(key)}: ${escapeHtml(display)}</div>`;
  }).join("");
}

function formatCount(value) {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue.toLocaleString() : "---";
}

function statusClass(status) {
  const normalized = String(status || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

  if (status === "⬜") return "pending";
  if (status === "🔄") return "running";
  if (status === "✅") return "completed";
  if (status === "⛔ BLOCKED") return "blocked";
  if (status === "⛔ SKIPPED") return "skipped";
  return normalized || "idle";
}

function setDispatchPlanControlsDisabled(dispatchPlanBody, disabled) {
  Array.from(dispatchPlanBody.querySelectorAll("button, select")).forEach((control) => {
    if (control instanceof HTMLButtonElement || control instanceof HTMLSelectElement) {
      control.disabled = disabled;
    }
  });
}

/* ═══════════════════════════════════════════════════════════════
   Utilities
   ═══════════════════════════════════════════════════════════════ */

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;

  if (!response.ok) {
    throw new Error(body && typeof body.error === "string" ? body.error : `Request failed: ${response.status}`);
  }

  return body;
}

function bindLocationNavigation(link) {
  if (!link || typeof link.addEventListener !== "function") {
    return;
  }

  link.addEventListener("click", (event) => {
    const href = typeof link.href === "string" ? link.href : "";
    if (!href) {
      return;
    }
    if (event && typeof event.preventDefault === "function") {
      event.preventDefault();
    }
    if (typeof link.setAttribute === "function") {
      link.setAttribute("aria-busy", "true");
    }
    if (document.documentElement && document.documentElement.style) {
      document.documentElement.style.cursor = "wait";
    }
    navigateToHref(href);
  });
}

function navigateToHref(href) {
  if (typeof href !== "string" || href.trim().length === 0 || !window.location) {
    return;
  }
  if (typeof window.location.assign === "function") {
    window.location.assign(href);
    return;
  }
  window.location.href = href;
}

function decodeThreadId(pattern) {
  const pathname = window.location.pathname;
  let parts = pathname.split("/").filter(Boolean);

  // Strip the gateway-card prefix (e.g. /roles-gui/role/<id>) so the
  // pattern match still works when the GUI is mounted at /roles-gui/.
  if (parts[0] === "roles-gui") {
    parts = parts.slice(1);
  }

  if (parts.length !== pattern.length) {
    return null;
  }

  return decodeURIComponent(parts[1] || "");
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function getErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
