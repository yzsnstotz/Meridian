/**
 * Meridian Web GUI — shared logic (auth, API base, fetch with token).
 * Token: sessionStorage; init from ?token= query param.
 */

(function () {
  "use strict";

  const STORAGE_KEY = "meridian_web_token";
  const FOCUS_MODE_KEY = "meridian_focus_mode";
  var inMemoryToken = "";

  function getQueryParams() {
    const params = {};
    const search = typeof window.location.search === "string" ? window.location.search.slice(1) : "";
    search.split("&").forEach(function (pair) {
      const i = pair.indexOf("=");
      if (i > 0) {
        params[decodeURIComponent(pair.slice(0, i))] = decodeURIComponent(pair.slice(i + 1));
      }
    });
    return params;
  }

  function getStoredToken() {
    try {
      var t = sessionStorage.getItem(STORAGE_KEY);
      var trimmed = t ? t.trim() : "";
      if (trimmed) {
        inMemoryToken = trimmed;
      }
      return trimmed;
    } catch (e) {
      return "";
    }
  }

  function getToken() {
    var q = getQueryParams();
    if (q.token) {
      var queryToken = q.token.trim();
      if (queryToken) {
        inMemoryToken = queryToken;
      }
      return queryToken;
    }
    if (inMemoryToken) {
      return inMemoryToken;
    }
    return getStoredToken();
  }

  function setToken(token) {
    var trimmed = token ? token.trim() : "";
    inMemoryToken = trimmed;
    try {
      if (trimmed) {
        sessionStorage.setItem(STORAGE_KEY, trimmed);
      } else {
        sessionStorage.removeItem(STORAGE_KEY);
      }
    } catch (e) {}
    return trimmed === "" ? getStoredToken() === "" : getStoredToken() === trimmed;
  }

  // Initialize token from ?token= on first load. Keep the query token intact so the
  // page still authenticates in browser automation or storage-constrained contexts.
  (function initTokenFromQuery() {
    var q = getQueryParams();
    if (q.token) {
      setToken(q.token.trim());
    }
  })();

  function apiBase() {
    var origin = window.location.origin || "";
    var path = (window.location.pathname || "/").replace(/\/[^/]*$/, "") || "/";
    if (path === "/" && origin) {
      return origin;
    }
    return origin + (path.endsWith("/") ? path.slice(0, -1) : path);
  }

  function fetchWithAuth(url, options) {
    options = options || {};
    var headers = options.headers || {};
    if (typeof headers.append === "function" || Array.isArray(headers)) {
      headers = {};
    }
    var token = getToken();
    if (token) {
      headers["Authorization"] = "Bearer " + token;
    }
    var u = url.indexOf("/") === 0 ? apiBase() + url : url;
    return fetch(u, Object.assign({}, options, { headers: headers }));
  }

  function ensureToken() {
    if (getToken()) return true;
    return false;
  }

  function getFocusModeEnabled(defaultValue) {
    var fallback = defaultValue !== false;
    try {
      var raw = sessionStorage.getItem(FOCUS_MODE_KEY);
      if (raw === "on") return true;
      if (raw === "off") return false;
      return fallback;
    } catch (e) {
      return fallback;
    }
  }

  function setFocusModeEnabled(enabled) {
    try {
      sessionStorage.setItem(FOCUS_MODE_KEY, enabled ? "on" : "off");
    } catch (e) {}
  }

  // Custom filter persistence (localStorage — survives tab close)
  var CUSTOM_FILTERS_PREFIX = "meridian_custom_filters_";

  function getCustomFilters(scope) {
    try {
      var raw = localStorage.getItem(CUSTOM_FILTERS_PREFIX + scope);
      if (!raw) return [];
      var parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch (e) { return []; }
  }

  function setCustomFilters(scope, filters) {
    try {
      localStorage.setItem(CUSTOM_FILTERS_PREFIX + scope, JSON.stringify(filters));
    } catch (e) {}
  }

  // Caller registry API helpers — used by index.html admin panel.
  // Each returns a Promise that resolves to the parsed JSON body on success,
  // or rejects with an Error whose message is the server error string.

  function loadCallers() {
    return fetchWithAuth("/api/callers")
      .then(function (res) {
        return res.json().then(function (body) {
          if (!res.ok) throw new Error(body && body.error ? body.error : ("HTTP " + res.status));
          return body;
        });
      });
  }

  function mintCaller(callerId, callerLabel) {
    return fetchWithAuth("/api/callers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ caller_id: callerId, caller_label: callerLabel })
    }).then(function (res) {
      return res.json().then(function (body) {
        if (!res.ok) throw new Error(body && body.error ? body.error : ("HTTP " + res.status));
        return body;
      });
    });
  }

  function rotateCaller(callerId) {
    return fetchWithAuth("/api/callers/" + encodeURIComponent(callerId) + "/rotate", {
      method: "POST"
    }).then(function (res) {
      return res.json().then(function (body) {
        if (!res.ok) throw new Error(body && body.error ? body.error : ("HTTP " + res.status));
        return body;
      });
    });
  }

  function updateCallerAuthority(callerId, authority) {
    return fetchWithAuth("/api/callers/" + encodeURIComponent(callerId) + "/authority", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ caller_authority: authority })
    }).then(function (res) {
      return res.json().then(function (body) {
        if (!res.ok) throw new Error(body && body.error ? body.error : ("HTTP " + res.status));
        return body;
      });
    });
  }

  function revokeCaller(callerId) {
    return fetchWithAuth("/api/callers/" + encodeURIComponent(callerId), {
      method: "DELETE"
    }).then(function (res) {
      return res.json().then(function (body) {
        if (!res.ok) throw new Error(body && body.error ? body.error : ("HTTP " + res.status));
        return body;
      });
    });
  }

  window.MeridianWeb = {
    getToken: getToken,
    setToken: setToken,
    apiBase: apiBase,
    fetchWithAuth: fetchWithAuth,
    ensureToken: ensureToken,
    getQueryParams: getQueryParams,
    getFocusModeEnabled: getFocusModeEnabled,
    setFocusModeEnabled: setFocusModeEnabled,
    getCustomFilters: getCustomFilters,
    setCustomFilters: setCustomFilters,
    loadCallers: loadCallers,
    mintCaller: mintCaller,
    rotateCaller: rotateCaller,
    updateCallerAuthority: updateCallerAuthority,
    revokeCaller: revokeCaller
  };
})();
