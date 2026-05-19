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

  // Add buttons — wired in G2 / G3. For now the buttons stay enabled so users
  // see them, but they alert until those commits land. (Replaced below.)
  if (btnAddOauth) {
    btnAddOauth.addEventListener("click", function () {
      alert("Add OAuth Account: implemented in next commit (G2).");
    });
  }
  if (btnAddApiKey) {
    btnAddApiKey.addEventListener("click", function () {
      alert("Add API Key Account: implemented in next commit (G3).");
    });
  }

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
