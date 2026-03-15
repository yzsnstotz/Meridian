/**
 * Meridian Web GUI — shared logic (auth, API base, fetch with token).
 * Token: sessionStorage; init from ?token= query param.
 */

(function () {
  "use strict";

  const STORAGE_KEY = "meridian_web_token";
  const FOCUS_MODE_KEY = "meridian_focus_mode";

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

  function getToken() {
    var q = getQueryParams();
    if (q.token) {
      return q.token.trim();
    }
    try {
      var t = sessionStorage.getItem(STORAGE_KEY);
      return t ? t.trim() : "";
    } catch (e) {
      return "";
    }
  }

  function setToken(token) {
    try {
      if (token) {
        sessionStorage.setItem(STORAGE_KEY, token);
      } else {
        sessionStorage.removeItem(STORAGE_KEY);
      }
    } catch (e) {}
  }

  // Initialize token from ?token= on first load. Strip token from URL only on hub (index) to avoid leaking in history; keep token in URL on terminal so auth works when sessionStorage is unavailable (e.g. mobile, new tab).
  (function initTokenFromQuery() {
    var q = getQueryParams();
    if (q.token) {
      setToken(q.token.trim());
      var pathname = window.location.pathname || "/";
      var isHub = pathname === "/" || pathname === "" || pathname.endsWith("/index.html");
      if (isHub && window.location.search) {
        var rest = window.location.search.replace(/[?&]token=[^&]+&?/g, "?").replace(/\?&/, "?").replace(/\?$/, "");
        var url = pathname;
        if (rest && rest !== "?") url += rest;
        if (window.history && window.history.replaceState) {
          window.history.replaceState({}, "", url);
        }
      }
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
    setCustomFilters: setCustomFilters
  };
})();
