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
  const refreshButton = document.querySelector('[data-action="refresh-roles"]');

  if (!list || !empty || !feedback || !form) {
    return;
  }

  async function refreshRoles() {
    const roles = await fetchJson("/api/roles");
    list.replaceChildren();

    if (!Array.isArray(roles) || roles.length === 0) {
      empty.hidden = false;
      return;
    }

    empty.hidden = true;

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

  refreshButton?.addEventListener("click", () => {
    void refreshRoles().catch((error) => {
      feedback.textContent = getErrorMessage(error);
    });
  });

  try {
    await refreshRoles();
  } catch (error) {
    feedback.textContent = getErrorMessage(error);
  }
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
  const promptsLink = document.getElementById("prompts-link");
  const configLink = document.getElementById("config-link");

  if (!title || !subtitle || !summary || !tasks || !empty || !promptsLink || !configLink) {
    return;
  }

  const defaultEmptyMessage = empty.textContent;
  promptsLink.href = `/role/${encodeURIComponent(threadId)}/prompts`;
  configLink.href = `/role/${encodeURIComponent(threadId)}/config`;

  const render = async () => {
    const detail = await fetchJson(`/api/role/${encodeURIComponent(threadId)}`);

    title.textContent = detail.thread_id;
    subtitle.textContent = detail.taskspec ? "Inferred dispatch enabled." : "Explicit task DAG.";
    empty.textContent = defaultEmptyMessage;

    summary.innerHTML = `
      <div><dt>role_type</dt><dd>${escapeHtml(detail.role_type)}</dd></div>
      <div><dt>status</dt><dd><span class="status-pill status-${escapeHtml(detail.status)}">${escapeHtml(detail.status)}</span></dd></div>
      <div><dt>tasks</dt><dd>${escapeHtml(String(detail.tasks.length))}</dd></div>
      <div><dt>mode</dt><dd>${detail.taskspec ? "taskspec" : "task list"}</dd></div>
    `;

    tasks.replaceChildren();
    if (!Array.isArray(detail.tasks) || detail.tasks.length === 0) {
      empty.hidden = false;
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
  };

  try {
    await render();
  } catch (error) {
    renderRoleDetailError({ title, subtitle, summary, tasks, empty }, getErrorMessage(error));
  }

  window.setInterval(() => {
    void render().catch((error) => {
      renderRoleDetailError({ title, subtitle, summary, tasks, empty }, getErrorMessage(error));
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

    title.textContent = detail.thread_id;
    systemInput.value = prompts.system_prompt || "";
    list.replaceChildren();

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
    input.readOnly = response.can_edit !== true;
    saveButton.disabled = response.can_edit !== true;
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
