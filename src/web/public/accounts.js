/**
 * /accounts page — list credentials, set default, revoke, edit label.
 * Add OAuth / Add API Key wired in G2 / G3.
 */

(function () {
  "use strict";

  var Web = window.MeridianWeb;
  if (!Web) {
    console.error("MeridianWeb helpers not loaded — accounts.js requires app.js");
    return;
  }

  var authErrorEl = document.getElementById("auth-error");
  var contentEl = document.getElementById("content");
  var bannerEl = document.getElementById("banner");
  var tbodyEl = document.getElementById("accounts-tbody");
  var btnRefresh = document.getElementById("btn-refresh");
  var btnAddOauth = document.getElementById("btn-add-oauth");
  var btnAddApiKey = document.getElementById("btn-add-apikey");

  var editDialog = document.getElementById("edit-dialog");
  var editLabelInput = document.getElementById("edit-label-input");
  var editFormError = document.getElementById("edit-form-error");
  var editCancelBtn = document.getElementById("edit-cancel-btn");
  var editSubmitBtn = document.getElementById("edit-submit-btn");
  var editingCredentialId = null;

  function escapeHtml(s) {
    if (s == null) return "";
    var d = document.createElement("div");
    d.textContent = String(s);
    return d.innerHTML;
  }

  function formatDate(iso) {
    if (!iso) return "—";
    try {
      var d = new Date(iso);
      if (isNaN(d.getTime())) return iso;
      return d.toLocaleString();
    } catch (e) {
      return iso;
    }
  }

  function showBanner(kind, text, autoHideMs) {
    if (!bannerEl) return;
    bannerEl.textContent = text;
    bannerEl.className = "show " + (kind === "success" ? "success" : "error");
    if (autoHideMs && Number(autoHideMs) > 0) {
      setTimeout(function () { hideBanner(); }, Number(autoHideMs));
    }
  }
  function hideBanner() {
    if (!bannerEl) return;
    bannerEl.className = "";
    bannerEl.textContent = "";
  }

  function showAuthError() {
    if (authErrorEl) authErrorEl.style.display = "";
    if (contentEl) contentEl.style.display = "none";
  }
  function showContent() {
    if (authErrorEl) authErrorEl.style.display = "none";
    if (contentEl) contentEl.style.display = "";
  }

  function api(url, options) {
    return Web.fetchWithAuth(url, options).then(function (res) {
      var contentType = res.headers.get("content-type") || "";
      var asJson = contentType.indexOf("application/json") >= 0;
      // 204 No Content
      if (res.status === 204) return { res: res, body: null };
      var bodyPromise = asJson ? res.json().catch(function () { return null; })
                               : res.text().catch(function () { return null; });
      return bodyPromise.then(function (body) {
        if (!res.ok) {
          var msg = (body && (body.error_message || body.error)) || ("HTTP " + res.status);
          var err = new Error(msg);
          err.status = res.status;
          err.body = body;
          throw err;
        }
        return { res: res, body: body };
      });
    });
  }

  function renderTable(credentials) {
    if (!tbodyEl) return;
    if (!credentials || credentials.length === 0) {
      tbodyEl.innerHTML = '<tr><td colspan="7" class="empty">No credentials yet. Click "Add OAuth Account" or "Add API Key Account" to create one.</td></tr>';
      return;
    }
    tbodyEl.innerHTML = credentials.map(function (c) {
      var revoked = !!c.revoked_at;
      var isDefault = !!c.is_default;
      var kindLabel = c.kind === "oauth" ? "OAuth" : "API Key";
      var kindCls = c.kind === "oauth" ? "kind-oauth" : "kind-api";
      var statusBadges = [];
      if (isDefault) statusBadges.push('<span class="badge default">Default</span>');
      if (revoked) statusBadges.push('<span class="badge revoked">Revoked</span>');
      if (statusBadges.length === 0) statusBadges.push('<span class="badge">Active</span>');

      var actions = [];
      actions.push('<button type="button" class="btn btn-small" data-action="edit" data-id="' + escapeHtml(c.credential_id) + '">Edit</button>');
      if (!revoked && !isDefault) {
        actions.push('<button type="button" class="btn btn-small" data-action="set-default" data-id="' + escapeHtml(c.credential_id) + '">Set default</button>');
      }
      if (!revoked) {
        actions.push('<button type="button" class="btn btn-small btn-danger" data-action="revoke" data-id="' + escapeHtml(c.credential_id) + '">Revoke</button>');
      }

      var labelCell = escapeHtml(c.credential_label || c.credential_id) +
        '<div style="font-size:0.7rem;color:var(--text-dim);margin-top:0.15rem"><code>' +
        escapeHtml(c.credential_id) + '</code></div>';

      return '<tr' + (revoked ? ' class="revoked"' : '') + '>' +
        '<td>' + labelCell + '</td>' +
        '<td>' + escapeHtml(c.provider || "codex") + '</td>' +
        '<td><span class="badge ' + kindCls + '">' + kindLabel + '</span></td>' +
        '<td>' + statusBadges.join(" ") + '</td>' +
        '<td>' + escapeHtml(formatDate(c.created_at)) + '</td>' +
        '<td>' + escapeHtml(formatDate(c.last_used_at)) + '</td>' +
        '<td><div class="actions">' + actions.join("") + '</div></td>' +
        '</tr>';
    }).join("");
  }

  function loadCredentials() {
    if (!tbodyEl) return Promise.resolve();
    tbodyEl.innerHTML = '<tr><td colspan="7" class="empty">Loading…</td></tr>';
    return api("/api/credentials")
      .then(function (r) {
        var creds = (r.body && Array.isArray(r.body.credentials)) ? r.body.credentials : [];
        // Sort: defaults first, then non-revoked by label, then revoked.
        creds.sort(function (a, b) {
          var aRev = a.revoked_at ? 1 : 0;
          var bRev = b.revoked_at ? 1 : 0;
          if (aRev !== bRev) return aRev - bRev;
          var aDef = a.is_default ? 0 : 1;
          var bDef = b.is_default ? 0 : 1;
          if (aDef !== bDef) return aDef - bDef;
          return String(a.credential_label || "").localeCompare(String(b.credential_label || ""));
        });
        renderTable(creds);
      })
      .catch(function (err) {
        if (err.status === 401) {
          showAuthError();
          return;
        }
        tbodyEl.innerHTML = '<tr><td colspan="7" class="empty" style="color:var(--danger-color)">' +
          escapeHtml(err.message || "Failed to load credentials") + '</td></tr>';
      });
  }

  function setDefault(credentialId) {
    return api("/api/credentials/" + encodeURIComponent(credentialId) + "/default", { method: "POST" })
      .then(function () {
        showBanner("success", "Default credential updated.", 4000);
        return loadCredentials();
      })
      .catch(function (err) { showBanner("error", "Set default failed: " + err.message); });
  }

  function revokeCredential(credentialId) {
    if (!window.confirm("Revoke this credential? Existing agents using it will keep running, but you can't reuse it for new spawns.")) {
      return Promise.resolve();
    }
    return api("/api/credentials/" + encodeURIComponent(credentialId), { method: "DELETE" })
      .then(function () {
        showBanner("success", "Credential revoked.", 4000);
        return loadCredentials();
      })
      .catch(function (err) { showBanner("error", "Revoke failed: " + err.message); });
  }

  function openEditDialog(credentialId, currentLabel) {
    editingCredentialId = credentialId;
    if (editLabelInput) editLabelInput.value = currentLabel || "";
    if (editFormError) editFormError.textContent = "";
    if (editDialog && typeof editDialog.showModal === "function") {
      editDialog.showModal();
    }
  }
  function closeEditDialog() {
    editingCredentialId = null;
    if (editDialog && editDialog.open) editDialog.close();
  }
  function submitEdit() {
    if (!editingCredentialId) return;
    var label = String((editLabelInput && editLabelInput.value) || "").trim();
    if (!label) {
      if (editFormError) editFormError.textContent = "Label is required.";
      return;
    }
    if (editSubmitBtn) editSubmitBtn.disabled = true;
    api("/api/credentials/" + encodeURIComponent(editingCredentialId), {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ credential_label: label })
    })
      .then(function () {
        closeEditDialog();
        showBanner("success", "Label updated.", 4000);
        return loadCredentials();
      })
      .catch(function (err) {
        if (editFormError) editFormError.textContent = err.message || "Update failed.";
      })
      .finally(function () { if (editSubmitBtn) editSubmitBtn.disabled = false; });
  }

  // Action delegation on the table body.
  if (tbodyEl) {
    tbodyEl.addEventListener("click", function (e) {
      var t = e.target;
      if (!t || t.tagName !== "BUTTON") return;
      var action = t.getAttribute("data-action");
      var id = t.getAttribute("data-id");
      if (!action || !id) return;
      if (action === "set-default") {
        t.disabled = true;
        setDefault(id).finally(function () { t.disabled = false; });
      } else if (action === "revoke") {
        revokeCredential(id);
      } else if (action === "edit") {
        // Look up current label from the row.
        var row = t.closest("tr");
        var labelTextEl = row ? row.querySelector("td:first-child") : null;
        var rawLabel = labelTextEl ? (labelTextEl.firstChild && labelTextEl.firstChild.nodeValue) : "";
        openEditDialog(id, (rawLabel || "").trim());
      }
    });
  }

  if (btnRefresh) btnRefresh.addEventListener("click", function () { hideBanner(); loadCredentials(); });
  if (editCancelBtn) editCancelBtn.addEventListener("click", closeEditDialog);
  if (editSubmitBtn) editSubmitBtn.addEventListener("click", submitEdit);
  document.querySelectorAll('[data-close]').forEach(function (btn) {
    btn.addEventListener("click", function () {
      var id = btn.getAttribute("data-close");
      var dlg = document.getElementById(id);
      if (dlg && dlg.open) dlg.close();
    });
  });

  // OAuth dialog wiring (G2).
  var oauthDialog = document.getElementById("oauth-dialog");
  var oauthLabelInput = document.getElementById("oauth-label-input");
  var oauthLabelError = document.getElementById("oauth-label-error");
  var oauthFormBlock = document.getElementById("oauth-form-block");
  var oauthStatusBlock = document.getElementById("oauth-status-block");
  var oauthStatusLabel = document.getElementById("oauth-status-label");
  var oauthStatusDetail = document.getElementById("oauth-status-detail");
  var oauthUrlBlock = document.getElementById("oauth-url-block");
  var oauthLoginUrlEl = document.getElementById("oauth-login-url");
  var oauthOpenUrlEl = document.getElementById("oauth-open-url");
  var oauthCopyUrlBtn = document.getElementById("oauth-copy-url");
  var oauthLogDetails = document.getElementById("oauth-log-details");
  var oauthLogExcerpt = document.getElementById("oauth-log-excerpt");
  var oauthCancelBtn = document.getElementById("oauth-cancel-btn");
  var oauthStartBtn = document.getElementById("oauth-start-btn");
  var oauthCloseBtn = document.getElementById("oauth-close-btn");

  var oauthState = {
    jobId: null,
    pollHandle: null,
    terminal: false,
    lastShownUrl: null
  };
  var OAUTH_POLL_MS = 1000;
  var OAUTH_TERMINAL_STATUSES = { completed: true, failed: true, cancelled: true, timeout: true };
  var OAUTH_STATUS_LABELS = {
    pending: "Starting…",
    awaiting_browser: "Waiting for browser login",
    completed: "Completed",
    failed: "Failed",
    cancelled: "Cancelled",
    timeout: "Timed out"
  };

  function resetOauthDialog() {
    stopOauthPolling();
    oauthState.jobId = null;
    oauthState.terminal = false;
    oauthState.lastShownUrl = null;
    if (oauthLabelInput) oauthLabelInput.value = "";
    if (oauthLabelError) oauthLabelError.textContent = "";
    if (oauthFormBlock) oauthFormBlock.style.display = "";
    if (oauthStatusBlock) oauthStatusBlock.style.display = "none";
    if (oauthUrlBlock) oauthUrlBlock.style.display = "none";
    if (oauthLoginUrlEl) oauthLoginUrlEl.textContent = "";
    if (oauthOpenUrlEl) oauthOpenUrlEl.removeAttribute("href");
    if (oauthLogDetails) oauthLogDetails.style.display = "none";
    if (oauthLogExcerpt) oauthLogExcerpt.textContent = "";
    if (oauthStatusLabel) {
      oauthStatusLabel.textContent = "pending";
      oauthStatusLabel.className = "status-label s-pending";
    }
    if (oauthStatusDetail) oauthStatusDetail.textContent = "Starting Codex login…";
    if (oauthStartBtn) {
      oauthStartBtn.disabled = false;
      oauthStartBtn.style.display = "";
    }
    if (oauthCancelBtn) oauthCancelBtn.style.display = "";
    if (oauthCloseBtn) oauthCloseBtn.style.display = "none";
  }

  function openOauthDialog() {
    resetOauthDialog();
    if (oauthDialog && typeof oauthDialog.showModal === "function") {
      oauthDialog.showModal();
      if (oauthLabelInput) {
        try { oauthLabelInput.focus(); } catch (e) {}
      }
    }
  }

  function closeOauthDialog() {
    stopOauthPolling();
    if (oauthDialog && oauthDialog.open) oauthDialog.close();
  }

  function stopOauthPolling() {
    if (oauthState.pollHandle) {
      clearInterval(oauthState.pollHandle);
      oauthState.pollHandle = null;
    }
  }

  function renderOauthStatus(jobBody) {
    var status = (jobBody && jobBody.status) || "pending";
    var humanLabel = OAUTH_STATUS_LABELS[status] || status;
    if (oauthStatusLabel) {
      oauthStatusLabel.textContent = status;
      oauthStatusLabel.className = "status-label s-" + status;
    }
    if (oauthStatusDetail) {
      if (status === "awaiting_browser") {
        oauthStatusDetail.textContent = "Open the login URL below in your browser and complete the sign-in.";
      } else if (status === "completed") {
        oauthStatusDetail.textContent = "Login complete. Credential saved.";
      } else if (status === "failed" || status === "timeout" || status === "cancelled") {
        oauthStatusDetail.textContent = (jobBody && jobBody.error_message) || humanLabel;
      } else {
        oauthStatusDetail.textContent = humanLabel;
      }
    }
    var url = jobBody && jobBody.login_url;
    if (url && oauthUrlBlock && oauthLoginUrlEl && oauthOpenUrlEl) {
      oauthUrlBlock.style.display = "";
      oauthLoginUrlEl.textContent = url;
      oauthOpenUrlEl.setAttribute("href", url);
      oauthState.lastShownUrl = url;
    } else if (!url && oauthUrlBlock && !oauthState.lastShownUrl) {
      oauthUrlBlock.style.display = "none";
    }
    var excerpt = jobBody && jobBody.log_excerpt;
    if (excerpt && oauthLogDetails && oauthLogExcerpt) {
      oauthLogDetails.style.display = "";
      oauthLogExcerpt.textContent = excerpt;
    }
  }

  function pollOauthOnce() {
    if (!oauthState.jobId) return;
    api("/api/credentials/oauth-login/" + encodeURIComponent(oauthState.jobId))
      .then(function (r) {
        var body = r.body || {};
        renderOauthStatus(body);
        var status = body.status;
        if (OAUTH_TERMINAL_STATUSES[status]) {
          oauthState.terminal = true;
          stopOauthPolling();
          if (oauthCancelBtn) oauthCancelBtn.style.display = "none";
          if (oauthStartBtn) oauthStartBtn.style.display = "none";
          if (oauthCloseBtn) oauthCloseBtn.style.display = "";
          if (status === "completed") {
            showBanner("success", "OAuth login completed — credential saved.", 4000);
            loadCredentials();
            // Auto-close shortly after success.
            setTimeout(function () { if (!oauthState.jobId) return; closeOauthDialog(); }, 1500);
          }
        }
      })
      .catch(function (err) {
        renderOauthStatus({ status: "failed", error_message: err.message || "Polling failed" });
        oauthState.terminal = true;
        stopOauthPolling();
        if (oauthCancelBtn) oauthCancelBtn.style.display = "none";
        if (oauthStartBtn) oauthStartBtn.style.display = "none";
        if (oauthCloseBtn) oauthCloseBtn.style.display = "";
      });
  }

  function startOauthLogin() {
    var label = String((oauthLabelInput && oauthLabelInput.value) || "").trim();
    if (!label) {
      if (oauthLabelError) oauthLabelError.textContent = "Label is required.";
      return;
    }
    if (oauthLabelError) oauthLabelError.textContent = "";
    if (oauthStartBtn) oauthStartBtn.disabled = true;

    api("/api/credentials/oauth-login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ credential_label: label })
    })
      .then(function (r) {
        var body = r.body || {};
        if (!body.job_id) throw new Error("server did not return a job_id");
        oauthState.jobId = body.job_id;
        if (oauthFormBlock) oauthFormBlock.style.display = "none";
        if (oauthStatusBlock) oauthStatusBlock.style.display = "";
        renderOauthStatus({ status: body.status || "pending" });
        // Immediate poll, then interval.
        pollOauthOnce();
        oauthState.pollHandle = setInterval(pollOauthOnce, OAUTH_POLL_MS);
      })
      .catch(function (err) {
        if (oauthLabelError) oauthLabelError.textContent = err.message || "Failed to start login.";
        if (oauthStartBtn) oauthStartBtn.disabled = false;
      });
  }

  function cancelOauthLogin() {
    if (!oauthState.jobId) {
      // No job yet — just close the dialog.
      closeOauthDialog();
      return;
    }
    if (oauthState.terminal) {
      closeOauthDialog();
      return;
    }
    var id = oauthState.jobId;
    api("/api/credentials/oauth-login/" + encodeURIComponent(id), { method: "DELETE" })
      .then(function () {
        stopOauthPolling();
        renderOauthStatus({ status: "cancelled" });
        oauthState.terminal = true;
        if (oauthCancelBtn) oauthCancelBtn.style.display = "none";
        if (oauthStartBtn) oauthStartBtn.style.display = "none";
        if (oauthCloseBtn) oauthCloseBtn.style.display = "";
      })
      .catch(function (err) {
        showBanner("error", "Cancel failed: " + err.message);
      });
  }

  if (btnAddOauth) btnAddOauth.addEventListener("click", openOauthDialog);
  if (oauthStartBtn) oauthStartBtn.addEventListener("click", startOauthLogin);
  if (oauthCancelBtn) oauthCancelBtn.addEventListener("click", cancelOauthLogin);
  if (oauthCloseBtn) oauthCloseBtn.addEventListener("click", closeOauthDialog);
  if (oauthCopyUrlBtn) {
    oauthCopyUrlBtn.addEventListener("click", function () {
      var url = oauthLoginUrlEl ? oauthLoginUrlEl.textContent : "";
      if (!url) return;
      var doneCopy = function () {
        var prev = oauthCopyUrlBtn.textContent;
        oauthCopyUrlBtn.textContent = "Copied";
        setTimeout(function () { oauthCopyUrlBtn.textContent = prev || "Copy"; }, 1500);
      };
      if (navigator && navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
        navigator.clipboard.writeText(url).then(doneCopy).catch(function () {
          // Fallback: select and copy.
          var ta = document.createElement("textarea");
          ta.value = url;
          document.body.appendChild(ta);
          ta.select();
          try { document.execCommand("copy"); doneCopy(); } catch (e) {}
          document.body.removeChild(ta);
        });
      } else {
        var ta = document.createElement("textarea");
        ta.value = url;
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand("copy"); doneCopy(); } catch (e) {}
        document.body.removeChild(ta);
      }
    });
  }
  // Stop polling if the dialog is dismissed (Escape, backdrop, X). Also tear
  // down the server-side job — otherwise the `codex login` subprocess keeps
  // running, holds port 1455, and the OAuth state token from its URL would
  // be the only one the codex callback server would accept. If the user
  // walked away mid-flight, that lingering subprocess plus a stale URL is
  // exactly the "callback unreachable" failure mode.
  if (oauthDialog) {
    oauthDialog.addEventListener("close", function () {
      stopOauthPolling();
      var id = oauthState.jobId;
      if (id && !oauthState.terminal) {
        api("/api/credentials/oauth-login/" + encodeURIComponent(id), { method: "DELETE" })
          .catch(function () { /* best effort */ });
      }
    });
  }

  // API-key dialog wiring (G3).
  var apikeyDialog = document.getElementById("apikey-dialog");
  var apikeyLabelInput = document.getElementById("apikey-label-input");
  var apikeyBaseUrlInput = document.getElementById("apikey-baseurl-input");
  var apikeyModelInput = document.getElementById("apikey-model-input");
  var apikeyEnvVarInput = document.getElementById("apikey-envvar-input");
  var apikeyKeyInput = document.getElementById("apikey-key-input");
  var apikeyFormError = document.getElementById("apikey-form-error");
  var apikeyCancelBtn = document.getElementById("apikey-cancel-btn");
  var apikeySubmitBtn = document.getElementById("apikey-submit-btn");

  function resetApiKeyDialog() {
    if (apikeyLabelInput) apikeyLabelInput.value = "";
    if (apikeyBaseUrlInput) apikeyBaseUrlInput.value = "";
    if (apikeyModelInput) apikeyModelInput.value = "";
    if (apikeyEnvVarInput) apikeyEnvVarInput.value = "";
    if (apikeyKeyInput) apikeyKeyInput.value = "";
    if (apikeyFormError) apikeyFormError.textContent = "";
    if (apikeySubmitBtn) apikeySubmitBtn.disabled = false;
  }
  function openApiKeyDialog() {
    resetApiKeyDialog();
    if (apikeyDialog && typeof apikeyDialog.showModal === "function") {
      apikeyDialog.showModal();
      if (apikeyLabelInput) {
        try { apikeyLabelInput.focus(); } catch (e) {}
      }
    }
  }
  function closeApiKeyDialog() {
    if (apikeyDialog && apikeyDialog.open) apikeyDialog.close();
  }
  function submitApiKey() {
    var label = String((apikeyLabelInput && apikeyLabelInput.value) || "").trim();
    var baseUrl = String((apikeyBaseUrlInput && apikeyBaseUrlInput.value) || "").trim();
    var modelId = String((apikeyModelInput && apikeyModelInput.value) || "").trim();
    var envVar = String((apikeyEnvVarInput && apikeyEnvVarInput.value) || "").trim();
    var keyValue = String((apikeyKeyInput && apikeyKeyInput.value) || "");
    var missing = [];
    if (!label) missing.push("Label");
    if (!baseUrl) missing.push("Service URL");
    if (!modelId) missing.push("Model code");
    if (!envVar) missing.push("Env var name");
    if (!keyValue) missing.push("Key value");
    if (missing.length) {
      if (apikeyFormError) apikeyFormError.textContent = "Missing: " + missing.join(", ");
      return;
    }
    if (apikeyFormError) apikeyFormError.textContent = "";
    if (apikeySubmitBtn) apikeySubmitBtn.disabled = true;
    api("/api/credentials/api-key", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        credential_label: label,
        base_url: baseUrl,
        model_id: modelId,
        env_var: envVar,
        key_value: keyValue
      })
    })
      .then(function () {
        closeApiKeyDialog();
        showBanner("success", "API-key credential created.", 4000);
        return loadCredentials();
      })
      .catch(function (err) {
        if (apikeyFormError) apikeyFormError.textContent = err.message || "Create failed.";
      })
      .finally(function () { if (apikeySubmitBtn) apikeySubmitBtn.disabled = false; });
  }

  if (btnAddApiKey) btnAddApiKey.addEventListener("click", openApiKeyDialog);
  if (apikeyCancelBtn) apikeyCancelBtn.addEventListener("click", closeApiKeyDialog);
  if (apikeySubmitBtn) apikeySubmitBtn.addEventListener("click", submitApiKey);

  // Expose for follow-up commits to override (G2/G3 will replace the click handlers
  // on btnAddOauth/btnAddApiKey by re-binding through MeridianAccounts).
  window.MeridianAccounts = {
    api: api,
    loadCredentials: loadCredentials,
    showBanner: showBanner,
    hideBanner: hideBanner,
    escapeHtml: escapeHtml,
    formatDate: formatDate
  };

  // Initial load.
  if (!Web.ensureToken()) {
    showAuthError();
  } else {
    showContent();
    loadCredentials();
  }
})();
