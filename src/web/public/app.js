/**
 * Meridian Web GUI — shared logic (auth, API base, fetch with token).
 * Token: sessionStorage; init from ?token= query param.
 */

(function () {
  "use strict";

  const STORAGE_KEY = "meridian_web_token";

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

  // Initialize token from ?token= on first load
  (function initTokenFromQuery() {
    var q = getQueryParams();
    if (q.token) {
      setToken(q.token.trim());
      var url = window.location.pathname || "/";
      if (window.location.search) {
        var rest = window.location.search.replace(/[?&]token=[^&]+&?/g, "?").replace(/\?&/, "?").replace(/\?$/, "");
        if (rest && rest !== "?") url += rest;
      }
      if (window.history && window.history.replaceState) {
        window.history.replaceState({}, "", url);
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

  window.MeridianWeb = {
    getToken: getToken,
    setToken: setToken,
    apiBase: apiBase,
    fetchWithAuth: fetchWithAuth,
    ensureToken: ensureToken,
    getQueryParams: getQueryParams
  };
})();
