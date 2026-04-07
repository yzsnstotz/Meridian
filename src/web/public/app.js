const POLL_INTERVAL_MS = 3000;

document.addEventListener("DOMContentLoaded", () => {
  const page = document.body.dataset.page;

  if (page === "dashboard") {
    void setupDashboard();
    return;
  }

  if (page === "role-detail") {
    void setupRoleDetail();
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

async function setupDashboard() {
  const list = document.getElementById("roles-list");
  const empty = document.getElementById("roles-empty");
  const feedback = document.getElementById("dashboard-feedback");
  const form = document.getElementById("create-role-form");
  const agentDispatcherList = document.getElementById("agent-dispatchers-list");
  const agentDispatcherEmpty = document.getElementById("agent-dispatchers-empty");
  const agentDispatcherForm = document.getElementById("start-agent-dispatcher-form");
  const agentDispatcherFeedback = document.getElementById("agent-dispatcher-feedback");
  const channelSelect = document.getElementById("agent-dispatcher-channel-select");
  const manualChannelSelect = document.getElementById("agent-dispatcher-manual-channel");
  const manualChatIdInput = document.getElementById("agent-dispatcher-manual-chat-id");
  const dispatchPlanPathInput = document.getElementById("agent-dispatcher-dispatch-plan-path");
  const commandFilePathInput = document.getElementById("agent-dispatcher-command-file-path");
  const agentTypeSelect = document.getElementById("agent-dispatcher-agent-type");
  const modeSelect = document.getElementById("agent-dispatcher-mode");
  const killPolicySelect = document.getElementById("agent-dispatcher-kill-policy");
  const agentDispatcherPromptInput = document.getElementById("agent-dispatcher-system-prompt");
  const agentDispatcherPromptReset = document.getElementById("agent-dispatcher-prompt-reset");
  const refreshButton = document.querySelector('[data-action="refresh-roles"]');

  if (
    !list
    || !empty
    || !feedback
    || !form
    || !agentDispatcherList
    || !agentDispatcherEmpty
    || !agentDispatcherForm
    || !agentDispatcherFeedback
    || !channelSelect
    || !manualChannelSelect
    || !manualChatIdInput
    || !dispatchPlanPathInput
    || !commandFilePathInput
    || !agentTypeSelect
    || !modeSelect
    || !killPolicySelect
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
      return;
    }

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
            <a class="ghost-link" href="/role/${encodeURIComponent(role.thread_id)}">Open detail</a>
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
            feedback.textContent = "Deactivating role…";
            await fetchJson(`/api/role/${encodeURIComponent(threadId)}`, { method: "DELETE" });
            feedback.textContent = `Role ${threadId} deactivated.`;
            await refreshRoles();
          } catch (error) {
            feedback.textContent = getErrorMessage(error);
          }
        });
      });

      list.dataset.renderSignature = roleSignature;
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
      current_worker: detail.current_worker,
      agent_type: detail.agent_type,
      last_log_line: detail.last_log_line
    })));

    if (agentDispatcherList.dataset.renderSignature !== dispatcherSignature) {
      agentDispatcherList.replaceChildren();

      details.forEach((detail) => {
        const control = resolveDispatcherCardControl(detail);
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
            <div><dt>agent</dt><dd>${escapeHtml(detail.agent_type || "—")}</dd></div>
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
              agentDispatcherFeedback.textContent = `Starting Hub session for ${threadId}…`;
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

  async function loadReplyChannels() {
    const response = await fetchJson("/api/channels");
    channelSelect.replaceChildren();

    const callout = document.getElementById("agent-dispatcher-reply-channel-callout");
    const manualWrap = document.getElementById("agent-dispatcher-manual-fallback-wrap");

    if (!Array.isArray(response.channels) || response.channels.length === 0) {
      const option = document.createElement("option");
      option.value = "";
      option.textContent = "No reply channels available; use manual fallback";
      option.disabled = true;
      channelSelect.appendChild(option);
      if (callout) {
        callout.hidden = false;
      }
      if (manualWrap) {
        manualWrap.classList.add("manual-fallback-highlight");
      }
      if (manualChatIdInput && callout) {
        manualChatIdInput.setAttribute("aria-describedby", "agent-dispatcher-reply-channel-callout");
      }
      return;
    }

    if (callout) {
      callout.hidden = true;
    }
    if (manualWrap) {
      manualWrap.classList.remove("manual-fallback-highlight");
    }
    if (manualChatIdInput) {
      manualChatIdInput.removeAttribute("aria-describedby");
    }

    response.channels.forEach((replyChannel, index) => {
      const option = document.createElement("option");
      option.value = JSON.stringify(replyChannel);
      option.textContent = formatReplyChannelLabel(replyChannel);
      option.selected = index === 0;
      channelSelect.appendChild(option);
    });
  }

  async function refreshAgentDispatcherPromptPreview(options = {}) {
    const replyChannels = collectAgentDispatcherReplyChannels(channelSelect, manualChannelSelect, manualChatIdInput);
    const payload = {
      dispatch_plan_path: normalizeText(dispatchPlanPathInput.value) || undefined,
      command_file_path: normalizeText(commandFilePathInput.value) || undefined,
      agent_type: normalizeText(agentTypeSelect.value) || "claude",
      mode: normalizeText(modeSelect.value) || "bridge",
      kill_policy: normalizeText(killPolicySelect.value) || "always"
    };

    if (replyChannels.length > 0) {
      payload.user_reply_channels = replyChannels;
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

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    feedback.textContent = "Activating role…";

    const formData = new FormData(form);
    const payload = {
      thread_id: normalizeText(formData.get("thread_id")),
      system_prompt: normalizeText(formData.get("system_prompt")),
      taskspec: normalizeText(formData.get("taskspec"))
    };

    const tasksJson = normalizeText(formData.get("tasks_json"));
    if (tasksJson) {
      try {
        payload.tasks = JSON.parse(tasksJson);
      } catch {
        feedback.textContent = "tasks JSON must be valid JSON.";
        return;
      }
    }

    Object.keys(payload).forEach((key) => {
      if (payload[key] === "") {
        delete payload[key];
      }
    });

    try {
      const created = await fetchJson("/api/role", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });

      feedback.textContent = `Role ${created.thread_id} activated.`;
      form.reset();
      await refreshRoles();
      window.location.href = `/role/${encodeURIComponent(created.thread_id)}`;
    } catch (error) {
      feedback.textContent = getErrorMessage(error);
    }
  });

  agentDispatcherForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    agentDispatcherFeedback.textContent = "Starting agent dispatcher…";

    const replyChannels = collectAgentDispatcherReplyChannels(channelSelect, manualChannelSelect, manualChatIdInput);
    if (replyChannels.length === 0) {
      agentDispatcherFeedback.textContent = "Select a reply channel or provide a manual fallback chat_id.";
      return;
    }

    const formData = new FormData(agentDispatcherForm);
    const payload = {
      dispatch_plan_path: normalizeText(formData.get("dispatch_plan_path")),
      command_file_path: normalizeText(formData.get("command_file_path")),
      user_reply_channels: replyChannels,
      agent_type: normalizeText(formData.get("agent_type")) || "claude",
      mode: normalizeText(formData.get("mode")) || "bridge",
      kill_policy: normalizeText(formData.get("kill_policy")) || "always",
      system_prompt: normalizeText(agentDispatcherPromptInput.value)
    };

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
      Array.from(channelSelect.options).forEach((option, index) => {
        option.selected = index === 0 && !option.disabled;
      });
      agentDispatcherPromptDirty = false;
      await refreshAgentDispatcherPromptPreview({ force: true });
      await refreshRoles();
      window.location.href = `/role/${encodeURIComponent(created.dispatcher_id)}`;
    } catch (error) {
      agentDispatcherFeedback.textContent = getErrorMessage(error);
    }
  });

  refreshButton?.addEventListener("click", () => {
    void Promise.all([loadReplyChannels(), refreshAgentDispatcherPromptPreview({ force: true }), refreshRoles()]).catch((error) => {
      const message = getErrorMessage(error);
      feedback.textContent = message;
      agentDispatcherFeedback.textContent = message;
    });
  });

  [dispatchPlanPathInput, commandFilePathInput, agentTypeSelect, modeSelect, killPolicySelect]
    .forEach((element) => {
      ["input", "change"].forEach((eventName) => {
        element.addEventListener(eventName, () => {
          void refreshAgentDispatcherPromptPreview().catch((error) => {
            agentDispatcherFeedback.textContent = getErrorMessage(error);
          });
        });
      });
    });

  [channelSelect, manualChannelSelect, manualChatIdInput].forEach((element) => {
    ["input", "change"].forEach((eventName) => {
      element.addEventListener(eventName, () => {
        void refreshAgentDispatcherPromptPreview().catch((error) => {
          agentDispatcherFeedback.textContent = getErrorMessage(error);
        });
      });
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

  try {
    await loadReplyChannels();
    await refreshAgentDispatcherPromptPreview({ force: true });
    await refreshRoles();
  } catch (error) {
    const message = getErrorMessage(error);
    feedback.textContent = message;
    agentDispatcherFeedback.textContent = message;
  }

  window.setInterval(() => {
    void refreshRoles().catch((error) => {
      const message = getErrorMessage(error);
      feedback.textContent = message;
      agentDispatcherFeedback.textContent = message;
    });
  }, POLL_INTERVAL_MS);
}

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
  const dispatchDetailsPanel = document.getElementById("dispatch-details-panel");
  const dispatchDetailsEmpty = document.getElementById("dispatch-details-empty");
  const dispatchDetailsList = document.getElementById("dispatch-details-list");
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
        <div><dt>agent_type</dt><dd>${escapeHtml(detail.agent_type || "—")}</dd></div>
        <div><dt>mode</dt><dd>${escapeHtml(detail.mode || "—")}</dd></div>
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
    if (dispatchDetailsPanel) {
      dispatchDetailsPanel.hidden = !isAgentDispatcher;
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
            startHubFeedback.textContent = "Starting Hub session…";
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
          try {
            continueHubBtn.disabled = true;
            startHubFeedback.textContent = "Continuing dispatcher…";
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

      if (dispatchDetailsList && dispatchDetailsEmpty) {
        const dispatchDetails = Array.isArray(detail.dispatch_details) ? detail.dispatch_details : [];
        dispatchDetailsList.innerHTML = dispatchDetails.map(renderDispatchDetailCard).join("");
        dispatchDetailsEmpty.hidden = dispatchDetails.length > 0;
        dispatchDetailsList.hidden = dispatchDetails.length === 0;
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
                dispatchPlanFeedback.textContent = `Continuing ${workerId}…`;
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
                dispatchPlanFeedback.textContent = `${formatResumeActionLabel(resumeAction)} ${workerId}…`;
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
                dispatchPlanFeedback.textContent = `Updating ${workerId} to ${formatDispatchStatusLabel(statusSelect.value)}…`;
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
        dispatchPlanBody.innerHTML = rows.map((row) => renderDispatchPlanRow(row)).join("");
        dispatchPlanEmpty.hidden = rows.length > 0;
        dispatchPlanTableShell.hidden = rows.length === 0;
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
            <p class="task-deps">depends_on: ${escapeHtml((task.depends_on || []).join(", ") || "—")}</p>
          </div>
          <span class="status-pill status-${escapeHtml(task.status)}">${escapeHtml(task.status)}</span>
        </div>
        <p class="instruction">${escapeHtml(task.instruction)}</p>
        <dl class="meta-grid">
          <div><dt>trace_id</dt><dd><code>${escapeHtml(task.trace_id || "—")}</code></dd></div>
          <div><dt>result</dt><dd>${escapeHtml(task.result_summary || "—")}</dd></div>
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
      dispatchDetailsPanel,
      dispatchDetailsList,
      dispatchDetailsEmpty,
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
        dispatchDetailsPanel,
        dispatchDetailsList,
        dispatchDetailsEmpty,
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
          feedback.textContent = `Saving template for ${task.task_id}…`;
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
          feedback.textContent = `Deleting template for ${task.task_id}…`;
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
      feedback.textContent = "Saving system prompt…";
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

  try {
    await render();
  } catch (error) {
    feedback.textContent = getErrorMessage(error);
  }
}

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
  const saveButton = document.getElementById("config-save-button");

  if (!title || !detailLink || !status || !feedback || !form || !input || !saveButton) {
    return;
  }

  detailLink.href = `/role/${encodeURIComponent(threadId)}`;

  const applyEditState = (response) => {
    const isAgentDispatcherConfig = isAgentDispatcherLaunchConfig(response.config);
    input.readOnly = response.can_edit !== true;
    saveButton.disabled = response.can_edit !== true;
    if (sectionTitle) {
      sectionTitle.textContent = isAgentDispatcherConfig ? "Launch Config JSON" : "Dispatch Plan JSON";
    }
    if (lede) {
      lede.textContent = isAgentDispatcherConfig
        ? "Review the saved launch JSON for this agent dispatcher. Prompt content stays on the prompt editor."
        : "Edit dispatcher JSON for `tasks` and `taskspec`. Prompt content stays on the prompt editor.";
    }
    status.textContent = response.can_edit
      ? "Only tasks and taskspec are editable here. Runtime task fields are reset on save."
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
    try {
      payload = JSON.parse(input.value);
    } catch {
      feedback.textContent = "Config JSON must be valid JSON.";
      return;
    }

    try {
      feedback.textContent = "Saving dispatcher config…";
      const response = await fetchJson(`/api/role/${encodeURIComponent(threadId)}/config`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });

      title.textContent = response.thread_id;
      input.value = JSON.stringify(response.config, null, 2);
      applyEditState(response);
      feedback.textContent = response.can_edit
        ? "Dispatcher config saved."
        : response.blocked_reason || "Dispatcher config saved, but editing is now unavailable.";
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
    saveButton.disabled = true;
  }
}

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
  if (elements.dispatchDetailsPanel) {
    elements.dispatchDetailsPanel.hidden = true;
  }
  if (elements.dispatchPlanPanel) {
    elements.dispatchPlanPanel.hidden = true;
  }
  if (elements.dispatcherSessionLog) {
    elements.dispatcherSessionLog.textContent = "Role data unavailable.";
  }
  if (elements.dispatchDetailsList) {
    elements.dispatchDetailsList.innerHTML = "";
    elements.dispatchDetailsList.hidden = true;
  }
  if (elements.dispatchDetailsEmpty) {
    elements.dispatchDetailsEmpty.textContent = "Role data unavailable.";
    elements.dispatchDetailsEmpty.hidden = false;
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
    <article class="dispatch-detail-card">
      <div class="dispatch-detail-header">
        <div class="dispatch-detail-title">
          <h3>${escapeHtml(taskLabel)}</h3>
          <p class="dispatch-detail-subtitle">${escapeHtml(subtitleParts.join(" · ") || "Worker detail")}</p>
        </div>
        <span class="status-pill status-${escapeHtml(detail.status)}">${escapeHtml(detail.status)}</span>
      </div>
      <dl class="summary-grid">
        <div><dt>worker</dt><dd><code>${escapeHtml(detail.worker_id || "—")}</code></dd></div>
        <div><dt>worker_thread</dt><dd><code>${escapeHtml(detail.worker_thread_id || "—")}</code></dd></div>
        <div><dt>trace_id</dt><dd><code>${escapeHtml(detail.trace_id || "—")}</code></dd></div>
      </dl>
      <div class="dispatch-detail-messages">
        ${renderDispatchMessage("Dispatch Command", detail.command, "No dispatch command captured yet.")}
        ${renderDispatchMessage("Agent Reply", detail.reply, "No agent reply captured yet.")}
      </div>
    </article>
  `;
}

function renderDispatchPlanRow(row) {
  return `
    <tr>
      <td>${renderDispatchPlanStatus(row)}</td>
      <td>${escapeHtml(row.batch)}</td>
      <td><code>${escapeHtml(row.worker)}</code></td>
      <td>${escapeHtml(row.task)}</td>
      <td>${escapeHtml(row.model)}</td>
      <td>${escapeHtml(row.depends_on || "—")}</td>
      <td>${renderDispatchPlanActions(row)}</td>
    </tr>
  `;
}

function renderDispatchPlanStatus(row) {
  const staleLabel = formatDispatchPlanStaleLabel(row);

  return `
    <div class="dispatch-plan-status">
      <span>${escapeHtml(row.status || "—")}</span>
      ${staleLabel ? `<span class="stale-pill">${escapeHtml(staleLabel)}</span>` : ""}
    </div>
  `;
}

function renderDispatchPlanActions(row) {
  const workerId = escapeHtml(row.worker || "");
  const currentStatus = normalizeDispatchPlanStatus(row?.status);
  const statusEditor = currentStatus === "running"
    ? ""
    : renderDispatchPlanStatusEditor(workerId, currentStatus);

  if (currentStatus === "abandoned") {
    return `
      <div class="table-action-stack">
        <div class="table-action-group">
          <button type="button" class="primary-button table-action-button" data-worker-id="${workerId}" data-continue-worker>Continue</button>
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

  return minutes ? `⚠️ STALE ${minutes}` : "⚠️ STALE";
}

function renderDispatchMessage(label, detail, emptyMessage) {
  const sender = formatDispatchSender(detail);
  const senderModel = typeof detail?.sender_model === "string" && detail.sender_model.trim().length > 0
    ? detail.sender_model.trim()
    : "—";
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
        <div><dt>trace_id</dt><dd><code>${escapeHtml(detail?.trace_id || "—")}</code></dd></div>
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

function formatDispatchSender(detail) {
  if (!detail) {
    return "—";
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

  return [senderName, senderType, senderModel].filter(Boolean).join(" · ");
}

function formatTimestamp(value) {
  if (typeof value !== "string" || value.trim().length === 0) {
    return "—";
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

function collectAgentDispatcherReplyChannels(channelSelect, manualChannelSelect, manualChatIdInput) {
  const selectedChannels = Array.from(channelSelect.selectedOptions)
    .map((option) => {
      try {
        return JSON.parse(option.value);
      } catch {
        return null;
      }
    })
    .filter(Boolean);

  if (selectedChannels.length > 0) {
    return selectedChannels;
  }

  const manualChatId = normalizeText(manualChatIdInput.value);
  if (!manualChatId) {
    return [];
  }

  return [{
    channel: normalizeText(manualChannelSelect.value) || "web",
    chat_id: manualChatId
  }];
}

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

function formatReplyChannelLabel(replyChannel) {
  const name = replyChannel.chat_name || replyChannel.bot_name || replyChannel.chat_id;
  return `${replyChannel.channel} · ${name}`;
}

function resolveDispatcherCardControl(detail) {
  const status = normalizeText(detail?.status);
  const hasLiveThread = hasLiveDispatcherThread(detail);

  if (status === "paused" && hasLiveThread) {
    return { action: "resume", label: "Resume" };
  }

  if (!hasLiveThread || status === "needs_reactivation") {
    return { action: "continue", label: "Continue" };
  }

  return { action: "pause", label: "Pause" };
}

function resolveDispatcherDetailControls(detail) {
  const status = normalizeText(detail?.status);
  const hasLiveThread = hasLiveDispatcherThread(detail);

  if (!hasLiveThread || status === "needs_reactivation") {
    return {
      showContinue: true,
      showLifecycle: false,
      lifecycleAction: null,
      lifecycleLabel: ""
    };
  }

  if (status === "paused") {
    return {
      showContinue: false,
      showLifecycle: true,
      lifecycleAction: "resume",
      lifecycleLabel: "Resume"
    };
  }

  return {
    showContinue: false,
    showLifecycle: true,
    lifecycleAction: "pause",
    lifecycleLabel: "Pause"
  };
}

function hasLiveDispatcherThread(detail) {
  return normalizeText(detail?.dispatcher_thread_id).length > 0;
}

function formatDispatcherControlProgress(action, threadId) {
  switch (action) {
    case "continue":
      return `Continuing ${threadId}…`;
    case "pause":
      return `Pausing ${threadId}…`;
    default:
      return `Resuming ${threadId}…`;
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
    case "local_tool_bootstrap_failed":
      return message || "local tool bootstrap failed";
    default:
      return message || "continue result unavailable";
  }
}

function normalizeDispatchPlanStatus(status) {
  switch (status) {
    case "🔄":
      return "running";
    case "✅":
      return "completed";
    case "❌":
      return "failed";
    case "⚠️ ABANDONED":
      return "abandoned";
    case "⛔ SKIPPED":
      return "skipped";
    case "⬜":
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
    case "abandoned":
      return "Abandoned";
    case "skipped":
      return "Skipped";
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
    case "abandoned":
      return "marked abandoned";
    case "skipped":
      return "marked skipped";
    default:
      return "reset to pending";
  }
}

function setDispatchPlanControlsDisabled(dispatchPlanBody, disabled) {
  Array.from(dispatchPlanBody.querySelectorAll("button, select")).forEach((control) => {
    if (control instanceof HTMLButtonElement || control instanceof HTMLSelectElement) {
      control.disabled = disabled;
    }
  });
}

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
