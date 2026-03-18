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

  if (!title || !subtitle || !summary || !tasks || !empty || !promptsLink) {
    return;
  }

  promptsLink.href = `/role/${encodeURIComponent(threadId)}/prompts`;

  const render = async () => {
    const detail = await fetchJson(`/api/role/${encodeURIComponent(threadId)}`);

    title.textContent = detail.thread_id;
    subtitle.textContent = detail.taskspec ? "Inferred dispatch enabled." : "Explicit task DAG.";

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
    subtitle.textContent = getErrorMessage(error);
  }

  window.setInterval(() => {
    void render().catch((error) => {
      subtitle.textContent = getErrorMessage(error);
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
