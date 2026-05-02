const POLL_INTERVAL_MS = 3000;

document.addEventListener("DOMContentLoaded", () => {
  const page = document.body.dataset.page;

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

function setupTabNavigation() {
  const tabs = document.querySelectorAll(".nav-tab[data-tab]");
  const panels = document.querySelectorAll(".tab-panel");

  const activateTab = (target) => {
    tabs.forEach((t) => t.classList.remove("active"));
    panels.forEach((p) => p.classList.remove("active"));

    const tab = Array.from(tabs).find((candidate) => candidate.dataset.tab === target);
    const panel = document.getElementById(`tab-${target}`);
    if (!tab || !panel) return;

    tab.classList.add("active");
    panel.classList.add("active");
  };

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

/* ═══════════════════════════════════════════════════════════════
   Validator Toggle (dispatcher creation form)
   ═══════════════════════════════════════════════════════════════ */

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
        if (!(statusSelect instanceof HTMLSelectElement)) {
          throw new Error(`No status selector found for ${workerId}`);
        }

        if (dispatchPlanFeedback) {
          dispatchPlanFeedback.textContent = `Updating ${workerId} to ${formatDispatchStatusLabel(statusSelect.value)}...`;
        }

        await fetchJson(
          `/api/scheduler/${encodeURIComponent(schedulerId)}/worker/${encodeURIComponent(workerId)}/status`,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              status: statusSelect.value
            })
          }
        );

        if (dispatchPlanFeedback) {
          dispatchPlanFeedback.textContent = `${workerId} ${formatDispatchStatusSuccess(statusSelect.value)}.`;
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
  const detailByWorker = indexDispatchDetailsByWorker(dispatchDetails);
  const workerStatusByWorker = indexSchedulerWorkerStatusByWorker(workers);
  const renderedRows = [];

  rows.forEach((row) => {
    const normalizedRow = normalizeSchedulerDispatchRow(row, workerStatusByWorker);
    const workerKey = normalizeDispatchWorkerKey(normalizedRow.worker);
    const inlineDetail = workerKey ? detailByWorker.get(workerKey) ?? null : null;
    if (workerKey) {
      detailByWorker.delete(workerKey);
    }
    renderedRows.push(renderSchedulerDispatchProgressRow(normalizedRow, inlineDetail));
  });

  detailByWorker.forEach((detail) => {
    const syntheticRow = normalizeSchedulerDispatchRow(buildDispatchPlanSyntheticRow(detail), workerStatusByWorker);
    renderedRows.push(renderSchedulerDispatchProgressRow(syntheticRow, detail, true));
  });

  return renderedRows.join("");
}

function renderSchedulerDispatchProgressRow(row, detail = null, orphan = false) {
  const issue = row.failure_reason || row.issue || row.stale_duration_human || "---";
  const issueLabel = row.stale && !row.failure_reason ? `stale ${issue}` : issue;
  const rowClassName = [
    "dispatch-plan-row",
    detail ? "dispatch-plan-row-with-detail" : "",
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
      <td>${row.thread_id ? `<code>${escapeHtml(row.thread_id)}</code>` : "---"}</td>
      <td>${escapeHtml(issueLabel)}</td>
      <td>${renderDispatchPlanActions(row)}</td>
    </tr>
    ${detail ? renderDispatchPlanDetailRow(detail, 11) : ""}
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
  setupValidatorToggle();
  setupSchedulerCreation();

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
              <a class="ghost-link" href="/scheduler/${encodeURIComponent(role.thread_id)}">Open detail</a>
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
            <a class="ghost-link" href="/role/${encodeURIComponent(detail.thread_id)}">Open detail</a>
            <button
              type="button"
              class="primary-button"
              data-dispatcher-id="${escapeHtml(detail.thread_id)}"
              data-dispatcher-action="start-hub"
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
      auto_approve: autoApproveInput.checked
    };

    if (replyChannels.length > 0) {
      payload.user_reply_channels = replyChannels;
    }

    const validatorConfig = collectValidatorConfig();
    if (validatorConfig) {
      payload.validator = validatorConfig;
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
      system_prompt: normalizeText(agentDispatcherPromptInput.value)
    };

    const validatorConfig = collectValidatorConfig();
    if (validatorConfig) {
      payload.validator = validatorConfig;
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
  const startHubFeedback = document.getElementById("agent-dispatcher-start-hub-feedback");

  if (!title || !subtitle || !summary || !tasks || !empty || !promptsLink || !configLink) {
    return;
  }

  let startHubBound = false;
  let continueHubBound = false;
  let lifecycleHubBound = false;
  let dispatchPlanActionsBound = false;

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
            startHubFeedback.textContent = `Hub session started (${started.dispatcher_thread_id}).`;
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

      if (dispatcherSessionLog) {
        const sessionLines = Array.isArray(detail.session_log) && detail.session_log.length > 0
          ? detail.session_log
          : ["No dispatcher session detail available yet."];
        dispatcherSessionLog.textContent = sessionLines.join("\n");
      }

      if (!dispatchPlanActionsBound && dispatchPlanBody) {
        dispatchPlanActionsBound = true;
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
              if (!(statusSelect instanceof HTMLSelectElement)) {
                throw new Error(`No status selector found for ${workerId}`);
              }

              if (dispatchPlanFeedback) {
                dispatchPlanFeedback.textContent = `Updating ${workerId} to ${formatDispatchStatusLabel(statusSelect.value)}...`;
              }

              await fetchJson(
                `/api/roles/${encodeURIComponent(threadId)}/worker/${encodeURIComponent(workerId)}/status`,
                {
                  method: "PATCH",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    status: statusSelect.value
                  })
                }
              );

              if (dispatchPlanFeedback) {
                dispatchPlanFeedback.textContent = `${workerId} ${formatDispatchStatusSuccess(statusSelect.value)}.`;
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
    if (cfgReplyChannels) cfgReplyChannels.value = JSON.stringify(config.user_reply_channels || [], null, 2);

    // Validator fields
    const v = config.validator || {};
    if (cfgValidatorEnabled) cfgValidatorEnabled.value = String(v.enabled === true);
    if (cfgValidatorAgentType) cfgValidatorAgentType.value = v.agent_type || "codex";
    if (cfgValidatorMode) cfgValidatorMode.value = v.mode || normalizeValidatorMode(v.agent_type || "codex");
    if (cfgValidatorModelId) cfgValidatorModelId.value = v.model_id || "";
    if (cfgValidatorThresholdType) cfgValidatorThresholdType.value = v.threshold_type || "score";
    if (cfgValidatorPassThreshold) cfgValidatorPassThreshold.value = v.pass_threshold ?? 0.7;
    if (cfgValidatorMaxFixCycles) cfgValidatorMaxFixCycles.value = v.max_fix_cycles ?? 3;
    if (cfgValidatorBaseBranch) cfgValidatorBaseBranch.value = v.base_branch || "main";
  };

  const setStructuredFieldsDisabled = (disabled) => {
    if (cfgAgentType) cfgAgentType.disabled = disabled;
    if (cfgModelId) cfgModelId.readOnly = disabled;
    if (cfgMode) cfgMode.disabled = disabled;
    if (cfgKillPolicy) cfgKillPolicy.disabled = disabled;
    if (cfgAutoApprove) cfgAutoApprove.disabled = disabled;
    if (cfgValidatorEnabled) cfgValidatorEnabled.disabled = disabled;
    if (cfgValidatorAgentType) cfgValidatorAgentType.disabled = disabled;
    if (cfgValidatorMode) cfgValidatorMode.disabled = disabled;
    if (cfgValidatorModelId) cfgValidatorModelId.readOnly = disabled;
    if (cfgValidatorThresholdType) cfgValidatorThresholdType.disabled = disabled;
    if (cfgValidatorPassThreshold) cfgValidatorPassThreshold.readOnly = disabled;
    if (cfgValidatorMaxFixCycles) cfgValidatorMaxFixCycles.readOnly = disabled;
    if (cfgValidatorBaseBranch) cfgValidatorBaseBranch.readOnly = disabled;
  };

  const collectStructuredPatch = () => {
    const patch = {};
    if (cfgAgentType) patch.agent_type = cfgAgentType.value;
    if (cfgModelId) patch.model_id = cfgModelId.value.trim() || null;
    if (cfgMode) patch.mode = cfgMode.value;
    if (cfgKillPolicy) patch.kill_policy = cfgKillPolicy.value;
    if (cfgAutoApprove) patch.auto_approve = cfgAutoApprove.value === "true";

    if (cfgValidatorEnabled) {
      const validatorAgentType = cfgValidatorAgentType?.value || "codex";
      const validatorMode = normalizeValidatorMode(validatorAgentType, cfgValidatorMode?.value);
      patch.validator = {
        enabled: cfgValidatorEnabled.value === "true",
        agent_type: validatorAgentType,
        mode: validatorMode,
        model_id: cfgValidatorModelId?.value?.trim() || undefined,
        threshold_type: cfgValidatorThresholdType?.value || "score",
        pass_threshold: parseFloat(cfgValidatorPassThreshold?.value) || 0.7,
        max_fix_cycles: parseInt(cfgValidatorMaxFixCycles?.value, 10) || 3,
        base_branch: cfgValidatorBaseBranch?.value?.trim() || "main"
      };
    }

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
        ? "Edit launch settings for this agent dispatcher. Path fields and reply channels are read-only."
        : "Edit dispatcher JSON for `tasks` and `taskspec`. Prompt content stays on the prompt editor.";
    }
    status.textContent = response.can_edit
      ? (isAgentDispatcherConfig
        ? "Editable fields: agent_type, model_id, mode, kill_policy, auto_approve. Changes apply to subsequent worker launches."
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
      payload = collectStructuredPatch();
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

function renderDispatchDetailCard(detail) {
  const taskLabel = detail.task ? `${detail.worker_id}: ${detail.task}` : detail.worker_id;
  const subtitleParts = [detail.model, detail.applied_model, detail.worker_thread_id].filter(Boolean);

  return `
    <details class="dispatch-detail-card">
      <summary class="dispatch-detail-summary">
        <div class="dispatch-detail-header">
          <div class="dispatch-detail-title">
            <h3>${escapeHtml(taskLabel)}</h3>
            <p class="dispatch-detail-subtitle">${escapeHtml(subtitleParts.join(" / ") || "Worker detail")}</p>
          </div>
          <span class="status-pill status-${escapeHtml(detail.status)}">${escapeHtml(detail.status)}</span>
        </div>
      </summary>
      <div class="dispatch-detail-body">
        <dl class="summary-grid">
          <div><dt>worker</dt><dd><code>${escapeHtml(detail.worker_id || "---")}</code></dd></div>
          <div><dt>worker_thread</dt><dd><code>${escapeHtml(detail.worker_thread_id || "---")}</code></dd></div>
          <div><dt>trace_id</dt><dd><code>${escapeHtml(detail.trace_id || "---")}</code></dd></div>
        </dl>
        <div class="dispatch-detail-messages">
          ${renderDispatchMessage("Dispatch Command", detail.command, "No dispatch command captured yet.")}
          ${renderDispatchMessage("Agent Reply", detail.reply, "No agent reply captured yet.")}
          ${renderDispatchValidationMessage(detail.validation)}
        </div>
      </div>
    </details>
  `;
}

function renderDispatchPlanRows(rows, dispatchDetails) {
  const detailByWorker = indexDispatchDetailsByWorker(dispatchDetails);
  const renderedRows = [];

  rows.forEach((row) => {
    const workerKey = normalizeDispatchWorkerKey(row?.worker);
    const inlineDetail = workerKey ? detailByWorker.get(workerKey) ?? null : null;
    if (workerKey) {
      detailByWorker.delete(workerKey);
    }
    renderedRows.push(renderDispatchPlanRow(row, inlineDetail));
  });

  detailByWorker.forEach((detail) => {
    renderedRows.push(renderDispatchPlanOrphanDetailRow(detail));
  });

  return renderedRows.join("");
}

function renderDispatchPlanRow(row, detail = null) {
  const rowClassName = detail ? "dispatch-plan-row dispatch-plan-row-with-detail" : "dispatch-plan-row";

  return `
    <tr class="${rowClassName}">
      <td>${renderDispatchPlanStatus(row)}</td>
      <td>${escapeHtml(row.batch)}</td>
      <td><code>${escapeHtml(row.worker)}</code></td>
      <td>${escapeHtml(row.task)}</td>
      <td>${formatToolProgress(row.progress)}</td>
      <td>${escapeHtml(row.model)}</td>
      <td>${escapeHtml(row.depends_on || "---")}</td>
      <td>${renderDispatchPlanActions(row)}</td>
    </tr>
    ${detail ? renderDispatchPlanDetailRow(detail) : ""}
  `;
}

function renderDispatchPlanOrphanDetailRow(detail) {
  const syntheticRow = buildDispatchPlanSyntheticRow(detail);

  return `
    <tr class="dispatch-plan-row dispatch-plan-row-with-detail dispatch-plan-row-orphan">
      <td>${renderDispatchPlanStatus(syntheticRow)}</td>
      <td>---</td>
      <td><code>${escapeHtml(syntheticRow.worker || "---")}</code></td>
      <td>${escapeHtml(syntheticRow.task || "---")}</td>
      <td>${formatToolProgress(syntheticRow.progress)}</td>
      <td>${escapeHtml(syntheticRow.model || "---")}</td>
      <td>---</td>
      <td>${renderDispatchPlanActions(syntheticRow)}</td>
    </tr>
    ${renderDispatchPlanDetailRow(detail)}
  `;
}

function renderDispatchPlanDetailRow(detail, colspan = 8) {
  return `
    <tr class="dispatch-plan-detail-row">
      <td colspan="${colspan}">
        <div class="dispatch-plan-inline-detail">
          ${renderDispatchDetailCard(detail)}
        </div>
      </td>
    </tr>
  `;
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

function normalizeDispatchWorkerKey(workerId) {
  return normalizeText(workerId).toUpperCase();
}

function buildDispatchPlanSyntheticRow(detail) {
  return {
    status: toDispatchPlanStatus(detail?.status),
    worker: detail?.worker_id || "",
    task: detail?.task || "",
    model: detail?.model || detail?.applied_model || "",
    depends_on: "---",
    thread_id: detail?.worker_thread_id || ""
  };
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
  const workerId = escapeHtml(row.worker || "");
  const currentStatus = normalizeDispatchPlanStatus(row?.status);
  const canContinue = canContinueDispatchRow(row);
  const statusEditor = currentStatus === "running" && !row?.show_status_editor
    ? ""
    : renderDispatchPlanStatusEditor(workerId, currentStatus);

  if (currentStatus === "abandoned" || canContinue) {
    return `
      <div class="table-action-stack">
        <div class="table-action-group">
          <button type="button" class="primary-button table-action-button" data-worker-id="${workerId}" data-continue-worker>Continue</button>
          ${currentStatus === "running" ? `
          <button type="button" class="ghost-button table-action-button" data-worker-id="${workerId}" data-resume-action="retry">Redo</button>
          <button type="button" class="ghost-button table-action-button" data-worker-id="${workerId}" data-resume-action="skip">Skip</button>
          <button type="button" class="danger-button table-action-button" data-worker-id="${workerId}" data-resume-action="force-complete">Force Complete</button>
          ` : ""}
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
      </div>
      ${statusEditor}
    </div>
  `;
}

function renderDispatchPlanStatusEditor(workerId, currentStatus) {
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

  return `
    <div class="table-status-controls">
      <select class="table-status-select" data-worker-status aria-label="Update worker status for ${workerId}">
        ${options}
      </select>
      <button type="button" class="ghost-button table-action-button" data-worker-id="${workerId}" data-status-apply>Apply</button>
    </div>
  `;
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

  if (isTerminalDispatcherStatus(status)) {
    return { action: "continue", label: formatTerminalDispatcherStatus(status), disabled: true };
  }

  if (liveWorker) {
    return { action: "continue", label: "Working", disabled: true };
  }

  if (validationWorker) {
    return { action: "continue", label: "Continue", disabled: false };
  }

  if (recoverableWorker) {
    return { action: "continue", label: "Continue", disabled: false };
  }

  if (status === "paused" && hasLiveThread) {
    return { action: "resume", label: "Resume", disabled: false };
  }

  if (!hasLiveThread || status === "needs_reactivation") {
    return { action: "continue", label: "Continue", disabled: false };
  }

  return { action: "pause", label: "Pause", disabled: false };
}

function resolveDispatcherDetailControls(detail) {
  const status = normalizeText(detail?.status);
  const hasLiveThread = hasLiveDispatcherThread(detail);
  const recoverableWorker = normalizeText(detail?.continue_worker);
  const liveWorker = resolveLiveRunningWorker(detail);
  const validationWorker = resolveValidationContinueWorker(detail);

  if (isTerminalDispatcherStatus(status)) {
    return {
      showContinue: true,
      continueLabel: formatTerminalDispatcherStatus(status),
      continueDisabled: true,
      showLifecycle: false,
      lifecycleAction: null,
      lifecycleLabel: ""
    };
  }

  if (liveWorker) {
    return {
      showContinue: true,
      continueLabel: "Working",
      continueDisabled: true,
      showLifecycle: hasLiveThread,
      lifecycleAction: hasLiveThread ? (status === "paused" ? "resume" : "pause") : null,
      lifecycleLabel: hasLiveThread ? (status === "paused" ? "Resume" : "Pause") : ""
    };
  }

  if (validationWorker) {
    return {
      showContinue: true,
      continueLabel: "Continue",
      continueDisabled: false,
      showLifecycle: false,
      lifecycleAction: null,
      lifecycleLabel: ""
    };
  }

  if (recoverableWorker) {
    return {
      showContinue: true,
      continueLabel: "Continue",
      continueDisabled: false,
      showLifecycle: false,
      lifecycleAction: null,
      lifecycleLabel: ""
    };
  }

  if (!hasLiveThread || status === "needs_reactivation") {
    return {
      showContinue: true,
      continueLabel: "Continue",
      continueDisabled: false,
      showLifecycle: false,
      lifecycleAction: null,
      lifecycleLabel: ""
    };
  }

  if (status === "paused") {
    return {
      showContinue: false,
      continueLabel: "Continue",
      continueDisabled: false,
      showLifecycle: true,
      lifecycleAction: "resume",
      lifecycleLabel: "Resume"
    };
  }

  return {
    showContinue: false,
    continueLabel: "Continue",
    continueDisabled: false,
    showLifecycle: true,
    lifecycleAction: "pause",
    lifecycleLabel: "Pause"
  };
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
    case "still_blocked":
      return message || "still blocked";
    case "manual_intervention_required":
      return message || "manual intervention required";
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
  const parts = pathname.split("/").filter(Boolean);

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

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
