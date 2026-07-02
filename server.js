const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const tls = require("tls");
const { randomUUID } = require("crypto");
const pacResolver = require("pac-resolver");

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, "public");
const LOG_FILE = path.join(__dirname, "server.log");

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon"
};

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body)
  });
  res.end(body);
}

function sendProxyError(res, statusCode, statusText, message, elapsedMs = 0, errorDetails = [], diagnostics = {}) {
  sendJson(res, statusCode, {
    ok: false,
    status: statusCode,
    statusText,
    headers: {},
    body: "",
    error: message,
    errorDetails,
    diagnostics,
    elapsedMs
  });
}

function logEvent(level, event, data = {}) {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    event,
    ...data
  };

  fs.appendFile(LOG_FILE, `${JSON.stringify(entry)}\n`, (error) => {
    if (error) {
      console.error("Failed to write server.log:", error.message);
    }
  });
}

function hasHeader(headers, headerName) {
  return Object.keys(headers).some((key) => key.toLowerCase() === headerName.toLowerCase());
}

function applyDefaultHeaders(headers) {
  const defaults = {
    Accept: "*/*",
    "User-Agent": "ReqForge/1.0",
    "Cache-Control": "no-cache"
  };

  for (const [key, value] of Object.entries(defaults)) {
    if (!hasHeader(headers, key)) {
      headers[key] = value;
    }
  }
}

function getErrorDetails(error) {
  const details = [];

  if (error.name) {
    details.push(`Error type: ${error.name}`);
  }

  if (error.code) {
    details.push(`Error code: ${error.code}`);
  }

  if (error.cause) {
    if (error.cause.code) {
      details.push(`Cause code: ${error.cause.code}`);
    }
    if (error.cause.message) {
      details.push(`Cause message: ${error.cause.message}`);
    }
  }

  details.push("ReqForge did not receive an HTTP response from the target API.");

  return details;
}

function getHeaderValue(headers, headerName) {
  const match = Object.keys(headers).find((key) => key.toLowerCase() === headerName.toLowerCase());
  return match ? headers[match] : undefined;
}

function setHeaderValue(headers, headerName, value) {
  const match = Object.keys(headers).find((key) => key.toLowerCase() === headerName.toLowerCase());
  headers[match || headerName] = value;
}

function applyBodyHeaders(headers, body) {
  if (body === undefined || body === null || String(body).length === 0) {
    return;
  }

  if (!hasHeader(headers, "Content-Length") && !hasHeader(headers, "Transfer-Encoding")) {
    setHeaderValue(headers, "Content-Length", Buffer.byteLength(String(body)));
  }
}

function getEnvValue(names) {
  for (const name of names) {
    if (process.env[name]) {
      return process.env[name];
    }
  }

  return "";
}

function getNoProxyRules() {
  return getEnvValue(["NO_PROXY", "no_proxy"])
    .split(",")
    .map((rule) => rule.trim())
    .filter(Boolean);
}

function getTransportBypassRules(transportSettings = {}) {
  return Array.isArray(transportSettings.bypass)
    ? transportSettings.bypass.map((rule) => String(rule).trim()).filter(Boolean)
    : [];
}

function getTransportMode(transportSettings = {}) {
  const mode = String(transportSettings.mode || "auto").toLowerCase();
  const supported = new Set(["auto", "env", "manual", "direct"]);
  return supported.has(mode) ? mode : "auto";
}

function hostnameMatchesNoProxyRule(hostname, rule) {
  const normalizedHost = hostname.toLowerCase();
  const normalizedRule = rule.toLowerCase();
  const hostRule = normalizedRule.split(":")[0];

  if (normalizedRule === "*") {
    return true;
  }

  if (hostRule.startsWith(".")) {
    return normalizedHost === hostRule.slice(1) || normalizedHost.endsWith(hostRule);
  }

  return normalizedHost === hostRule || normalizedHost.endsWith(`.${hostRule}`);
}

function isNoProxyMatch(targetUrl, rules = getNoProxyRules()) {
  const hostname = targetUrl.hostname;
  const port = targetUrl.port || (targetUrl.protocol === "https:" ? "443" : "80");

  return rules.some((rule) => {
    const [ruleHost, rulePort] = rule.split(":");
    if (rulePort && rulePort !== port) {
      return false;
    }

    return hostnameMatchesNoProxyRule(hostname, ruleHost || rule);
  });
}

function getProxyUrl(targetUrl, noProxyRules = getNoProxyRules()) {
  if (isNoProxyMatch(targetUrl, noProxyRules)) {
    return null;
  }

  const proxyValue =
    targetUrl.protocol === "https:"
      ? getEnvValue(["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"])
      : getEnvValue(["HTTP_PROXY", "http_proxy"]);

  if (!proxyValue) {
    return null;
  }

  try {
    return new URL(proxyValue);
  } catch {
    const error = new Error(`Invalid proxy URL in environment: ${proxyValue}`);
    error.code = "EINVAL_PROXY";
    throw error;
  }
}

function getManualProxyAuthorization(manualProxy = {}) {
  const authType = String(manualProxy.authType || "none").toLowerCase();

  if (authType === "basic") {
    const username = String(manualProxy.username || "");
    const password = String(manualProxy.password || "");

    if (!username && !password) {
      return "";
    }

    return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
  }

  if (authType === "digest" || authType === "ntlm" || authType === "negotiate") {
    const token = String(manualProxy.authToken || "").trim();
    if (!token) {
      return "";
    }

    const schemeMap = {
      digest: "Digest",
      ntlm: "NTLM",
      negotiate: "Negotiate"
    };
    return `${schemeMap[authType]} ${token}`;
  }

  return "";
}

function getManualProxyCandidate(manualProxy = {}) {
  const host = String(manualProxy.host || "").trim();
  const port = Number(manualProxy.port || 0);
  const protocol = String(manualProxy.protocol || "http").toLowerCase();

  if (!host || !port) {
    return null;
  }

  if (!["http", "https", "socks4", "socks5"].includes(protocol)) {
    const error = new Error(`Unsupported manual proxy protocol: ${protocol}`);
    error.code = "EUNSUPPORTED_PROXY";
    throw error;
  }

  return {
    proxyUrl: new URL(`${protocol}://${host}:${port}`),
    proxyAuthorization: getManualProxyAuthorization(manualProxy)
  };
}

const pacCache = new Map();
const PAC_CACHE_TTL_MS = 60 * 60 * 1000;

async function fetchPacScript(pacUrl) {
  const cached = pacCache.get(pacUrl);
  if (cached && Date.now() - cached.timestamp < PAC_CACHE_TTL_MS) {
    return { script: cached.script, cacheHit: true };
  }

  const parsed = new URL(pacUrl);
  const transport = parsed.protocol === "https:" ? https : http;

  const script = await new Promise((resolve, reject) => {
    const req = transport.get(parsed, { timeout: 5000 }, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`PAC fetch failed with HTTP ${res.statusCode}`));
        res.resume();
        return;
      }

      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    });

    req.on("timeout", () => req.destroy(new Error("PAC fetch timed out")));
    req.on("error", reject);
  });

  if (!script.includes("FindProxyForURL")) {
    throw new Error("PAC script does not define FindProxyForURL");
  }

  pacCache.set(pacUrl, { script, timestamp: Date.now() });
  return { script, cacheHit: false };
}

function parsePacResult(pacResult) {
  const normalized = String(pacResult || "").trim();
  if (!normalized) {
    throw new Error("PAC resolver returned an empty result");
  }

  const directives = normalized
    .split(";")
    .map((directive) => directive.trim())
    .filter(Boolean);

  const parsed = directives.map((directive) => {
    if (directive.toUpperCase() === "DIRECT") {
      return { type: "DIRECT", raw: directive };
    }

    const match = directive.match(/^(PROXY|HTTP|HTTPS|SOCKS|SOCKS4|SOCKS5)\s+([^\s]+)$/i);
    if (!match) {
      return { type: "UNSUPPORTED", raw: directive, reason: "Unknown PAC directive" };
    }

    const pacScheme = match[1].toUpperCase();
    const endpoint = match[2];
    const [host, port] = endpoint.split(":");
    if (!host || !port) {
      return { type: "UNSUPPORTED", raw: directive, reason: "Invalid PAC proxy endpoint" };
    }

    const schemeMap = {
      PROXY: "http",
      HTTP: "http",
      HTTPS: "https",
      SOCKS: "socks5",
      SOCKS4: "socks4",
      SOCKS5: "socks5"
    };

    return {
      type: "PROXY",
      raw: directive,
      protocol: schemeMap[pacScheme],
      proxyUrl: new URL(`${schemeMap[pacScheme]}://${host}:${port}`)
    };
  });

  if (!parsed.length) {
    throw new Error("PAC resolver returned no usable directives");
  }

  return parsed;
}

async function resolveProxyFromPac(targetUrl, manualPacUrl) {
  if (!manualPacUrl) {
    return null;
  }

  const { script, cacheHit } = await fetchPacScript(manualPacUrl);
  const FindProxyForURL = pacResolver(script);
  const pacResult = await FindProxyForURL(targetUrl.href, targetUrl.hostname);
  const directives = parsePacResult(pacResult);

  return {
    directives,
    diagnostics: {
      source: "manual-pac",
      pacUrl: manualPacUrl,
      cache: cacheHit ? "hit" : "miss",
      result: String(pacResult),
      mode: directives.some((entry) => entry.type === "PROXY") ? "proxy" : "direct"
    }
  };
}

function getProxyDescription(proxyUrl) {
  if (!proxyUrl) {
    return "direct connection";
  }

  return `${proxyUrl.protocol}//${proxyUrl.hostname}:${proxyUrl.port || (proxyUrl.protocol === "https:" ? "443" : "80")}`;
}

function getProxyAuthorization(proxyUrl) {
  if (!proxyUrl.username && !proxyUrl.password) {
    return "";
  }

  return `Basic ${Buffer.from(`${decodeURIComponent(proxyUrl.username)}:${decodeURIComponent(proxyUrl.password)}`).toString("base64")}`;
}

function collectResponse(res) {
  return new Promise((resolve, reject) => {
    const chunks = [];

    res.on("data", (chunk) => chunks.push(chunk));
    res.on("end", () => {
      resolve({
        ok: res.statusCode >= 200 && res.statusCode < 300,
        status: res.statusCode,
        statusText: res.statusMessage,
        headers: res.headers,
        body: Buffer.concat(chunks).toString("utf8")
      });
    });
    res.on("error", reject);
  });
}

function createTimeoutError() {
  const error = new Error("Request timed out.");
  error.name = "AbortError";
  return error;
}

function requestDirect(targetUrl, options, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const transport = targetUrl.protocol === "https:" ? https : http;
    const req = transport.request(
      {
        protocol: targetUrl.protocol,
        hostname: targetUrl.hostname,
        port: targetUrl.port || (targetUrl.protocol === "https:" ? 443 : 80),
        method: options.method,
        path: `${targetUrl.pathname}${targetUrl.search}`,
        headers: options.headers,
        timeout: timeoutMs
      },
      async (res) => {
        try {
          resolve(await collectResponse(res));
        } catch (error) {
          reject(error);
        }
      }
    );

    req.on("timeout", () => req.destroy(createTimeoutError()));
    req.on("error", reject);
    req.end(body);
  });
}

function requestHttpThroughProxy(targetUrl, proxyUrl, options, body, timeoutMs, explicitProxyAuthorization = "") {
  return new Promise((resolve, reject) => {
    const headers = { ...options.headers, Host: targetUrl.host };
    const proxyAuthorization = explicitProxyAuthorization || getProxyAuthorization(proxyUrl);

    if (proxyAuthorization) {
      headers["Proxy-Authorization"] = proxyAuthorization;
    }

    const req = http.request(
      {
        hostname: proxyUrl.hostname,
        port: proxyUrl.port || 80,
        method: options.method,
        path: targetUrl.href,
        headers,
        timeout: timeoutMs
      },
      async (res) => {
        try {
          resolve(await collectResponse(res));
        } catch (error) {
          reject(error);
        }
      }
    );

    req.on("timeout", () => req.destroy(createTimeoutError()));
    req.on("error", reject);
    req.end(body);
  });
}

function requestHttpsThroughProxy(targetUrl, proxyUrl, options, body, timeoutMs, explicitProxyAuthorization = "") {
  return new Promise((resolve, reject) => {
    const connectHeaders = {
      Host: targetUrl.host
    };
    const proxyAuthorization = explicitProxyAuthorization || getProxyAuthorization(proxyUrl);

    if (proxyAuthorization) {
      connectHeaders["Proxy-Authorization"] = proxyAuthorization;
    }

    const connectReq = http.request({
      hostname: proxyUrl.hostname,
      port: proxyUrl.port || 80,
      method: "CONNECT",
      path: targetUrl.host,
      headers: connectHeaders,
      timeout: timeoutMs
    });

    connectReq.on("connect", (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        const error = new Error(`Proxy CONNECT failed with ${res.statusCode} ${res.statusMessage}`);
        error.code = "EPROXYCONNECT";
        reject(error);
        return;
      }

      const secureSocket = tls.connect({
        socket,
        servername: targetUrl.hostname
      });

      const req = https.request(
        {
          hostname: targetUrl.hostname,
          port: targetUrl.port || 443,
          method: options.method,
          path: `${targetUrl.pathname}${targetUrl.search}`,
          headers: options.headers,
          createConnection: () => secureSocket,
          timeout: timeoutMs
        },
        async (targetRes) => {
          try {
            resolve(await collectResponse(targetRes));
          } catch (error) {
            reject(error);
          }
        }
      );

      req.on("timeout", () => req.destroy(createTimeoutError()));
      req.on("error", reject);
      req.end(body);
    });

    connectReq.on("timeout", () => connectReq.destroy(createTimeoutError()));
    connectReq.on("error", reject);
    connectReq.end();
  });
}

async function sendHttpRequest(targetUrl, options, body, timeoutMs, transportSettings = {}, requestContext = {}, redirectCount = 0) {
  const requestId = requestContext.requestId || "unknown";
  const mode = getTransportMode(transportSettings);
  const manualPacUrl = String(transportSettings.manualPacUrl || "").trim();
  const transportBypassRules = getTransportBypassRules(transportSettings);
  const envBypassRules = getNoProxyRules();

  const activeBypassRules =
    mode === "manual"
      ? transportBypassRules
      : mode === "direct"
        ? []
        : [...envBypassRules, ...transportBypassRules];

  const pacDiagnostics = {
    configured: Boolean(manualPacUrl),
    attempted: false,
    cache: "not-applicable",
    result: "not-evaluated",
    mode: "not-evaluated",
    fallbackReason: "",
    error: "",
    directives: []
  };

  const diagnosticsAttempts = [];
  const candidates = [];

  const addCandidate = (candidate) => {
    const key = candidate.proxyUrl ? `${candidate.source}:${candidate.proxyUrl.toString()}` : `${candidate.source}:DIRECT`;
    if (!candidates.some((item) => item.key === key)) {
      candidates.push({ ...candidate, key });
    }
  };

  const bypassHit = activeBypassRules.length ? isNoProxyMatch(targetUrl, activeBypassRules) : false;
  if (bypassHit) {
    addCandidate({ source: "bypass", proxyUrl: null, proxyAuthorization: "" });
  } else if (mode === "direct") {
    addCandidate({ source: "direct-mode", proxyUrl: null, proxyAuthorization: "" });
  } else {
    if (manualPacUrl) {
      pacDiagnostics.attempted = true;
      try {
        const pacResolution = await resolveProxyFromPac(targetUrl, manualPacUrl);
        pacDiagnostics.cache = pacResolution.diagnostics.cache;
        pacDiagnostics.result = pacResolution.diagnostics.result;
        pacDiagnostics.mode = pacResolution.diagnostics.mode;
        pacDiagnostics.directives = pacResolution.directives.map((entry) => entry.raw || entry.type);

        pacResolution.directives.forEach((entry, index) => {
          if (entry.type === "DIRECT") {
            addCandidate({ source: `manual-pac-${index + 1}`, proxyUrl: null, proxyAuthorization: "" });
            return;
          }

          if (entry.type === "PROXY") {
            addCandidate({ source: `manual-pac-${index + 1}`, proxyUrl: entry.proxyUrl, proxyAuthorization: "" });
            return;
          }

          diagnosticsAttempts.push({
            source: `manual-pac-${index + 1}`,
            transport: "unsupported",
            error: entry.reason || "Unsupported PAC directive",
            code: "EUNSUPPORTED_PAC_DIRECTIVE"
          });
        });

        if (!candidates.length) {
          pacDiagnostics.fallbackReason = "PAC returned no usable directives; trying other sources.";
        }
      } catch (error) {
        pacDiagnostics.error = error.message;
        pacDiagnostics.fallbackReason = "PAC evaluation failed; trying other proxy sources.";
      }
    }

    if (mode === "manual") {
      try {
        const manualCandidate = getManualProxyCandidate(transportSettings.manualProxy || {});
        if (manualCandidate) {
          addCandidate({
            source: "manual-proxy",
            proxyUrl: manualCandidate.proxyUrl,
            proxyAuthorization: manualCandidate.proxyAuthorization
          });
        } else if (!candidates.length) {
          const error = new Error("Manual proxy mode is selected but no manual proxy host/port is configured.");
          error.code = "EMANUAL_PROXY_REQUIRED";
          throw error;
        }
      } catch (error) {
        if (!error.code) {
          error.code = "EMANUAL_PROXY_CONFIG";
        }
        error.diagnostics = {
          requestId,
          proxy: {
            mode,
            source: "manual-proxy",
            resolved: "UNRESOLVED",
            bypassApplied: bypassHit,
            bypassRules: activeBypassRules
          },
          pac: pacDiagnostics,
          attempts: diagnosticsAttempts
        };
        throw error;
      }
    }

    if ((mode === "auto" || mode === "env") && !candidates.length) {
      const envProxyUrl = getProxyUrl(targetUrl, activeBypassRules);
      if (envProxyUrl) {
        addCandidate({ source: "environment", proxyUrl: envProxyUrl, proxyAuthorization: "" });
      } else {
        addCandidate({ source: "environment-fallback-direct", proxyUrl: null, proxyAuthorization: "" });
      }
    }
  }

  let response;
  let selectedCandidate = null;
  let lastError = null;

  for (const candidate of candidates) {
    const transportLabel = candidate.proxyUrl ? candidate.proxyUrl.toString() : "DIRECT";
    const startedAt = performance.now();

    try {
      if (candidate.proxyUrl && candidate.proxyUrl.protocol !== "http:") {
        const unsupportedError = new Error(
          `Unsupported proxy protocol for runtime transport: ${candidate.proxyUrl.protocol}. Only http:// proxies are currently executable.`
        );
        unsupportedError.code = "EUNSUPPORTED_PROXY";
        throw unsupportedError;
      }

      response = candidate.proxyUrl
        ? targetUrl.protocol === "https:"
          ? await requestHttpsThroughProxy(targetUrl, candidate.proxyUrl, options, body, timeoutMs, candidate.proxyAuthorization)
          : await requestHttpThroughProxy(targetUrl, candidate.proxyUrl, options, body, timeoutMs, candidate.proxyAuthorization)
        : await requestDirect(targetUrl, options, body, timeoutMs);

      diagnosticsAttempts.push({
        source: candidate.source,
        transport: transportLabel,
        result: "success",
        elapsedMs: Math.round(performance.now() - startedAt)
      });

      selectedCandidate = candidate;
      logEvent("info", "proxy-attempt-success", {
        requestId,
        targetUrl: targetUrl.href,
        source: candidate.source,
        transport: transportLabel,
        elapsedMs: Math.round(performance.now() - startedAt)
      });
      break;
    } catch (error) {
      lastError = error;
      diagnosticsAttempts.push({
        source: candidate.source,
        transport: transportLabel,
        result: "failed",
        elapsedMs: Math.round(performance.now() - startedAt),
        error: error.message,
        code: error.code || "UNKNOWN"
      });

      logEvent("warn", "proxy-attempt-failed", {
        requestId,
        targetUrl: targetUrl.href,
        source: candidate.source,
        transport: transportLabel,
        elapsedMs: Math.round(performance.now() - startedAt),
        error: error.message,
        code: error.code || "UNKNOWN"
      });
    }
  }

  if (!response) {
    const attemptedSummary = diagnosticsAttempts
      .filter((attempt) => attempt.result === "failed")
      .map((attempt) => `${attempt.source} (${attempt.transport}) -> ${attempt.code}: ${attempt.error}`)
      .join(" | ");

    const error = new Error(
      attemptedSummary
        ? `All transport attempts failed. ${attemptedSummary}`
        : "No transport candidate succeeded."
    );
    error.code = (lastError && lastError.code) || "EPROXYALLFAILED";
    error.cause = lastError || undefined;
    error.diagnostics = {
      requestId,
      proxy: {
        mode,
        source: "failed",
        resolved: "UNRESOLVED",
        bypassApplied: bypassHit,
        bypassRules: activeBypassRules
      },
      pac: pacDiagnostics,
      attempts: diagnosticsAttempts
    };
    throw error;
  }

  const redirectLocation = response.headers.location;
  if ([301, 302, 303, 307, 308].includes(response.status) && redirectLocation && redirectCount < 5) {
    const redirectUrl = new URL(redirectLocation, targetUrl);
    const redirectOptions = { ...options, headers: { ...options.headers } };
    let redirectBody = body;

    if (response.status === 303 || ((response.status === 301 || response.status === 302) && options.method === "POST")) {
      redirectOptions.method = "GET";
      redirectBody = undefined;
      delete redirectOptions.headers["Content-Length"];
      delete redirectOptions.headers["content-length"];
    }

    return sendHttpRequest(redirectUrl, redirectOptions, redirectBody, timeoutMs, transportSettings, requestContext, redirectCount + 1);
  }

  response.transport = getProxyDescription(selectedCandidate.proxyUrl);
  response.diagnostics = {
    requestId,
    proxy: {
      mode,
      source: selectedCandidate.source,
      resolved: selectedCandidate.proxyUrl ? selectedCandidate.proxyUrl.toString() : "DIRECT",
      bypassApplied: bypassHit,
      bypassRules: activeBypassRules
    },
    pac: pacDiagnostics,
    attempts: diagnosticsAttempts
  };
  return response;
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";

    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 1024 * 1024 * 5) {
        reject(new Error("Request payload is larger than 5MB."));
        req.destroy();
      }
    });

    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error("The request body must be valid JSON."));
      }
    });

    req.on("error", reject);
  });
}

function serveStatic(req, res) {
  const requestPath = req.url === "/" ? "/index.html" : req.url;
  const decodedPath = decodeURIComponent(requestPath.split("?")[0]);
  const filePath = path.normalize(path.join(PUBLIC_DIR, decodedPath));

  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }

    const extension = path.extname(filePath);
    res.writeHead(200, {
      "Content-Type": MIME_TYPES[extension] || "application/octet-stream"
    });
    res.end(data);
  });
}

async function proxyRequest(req, res) {
  let payload;
  const requestId = randomUUID();

  try {
    payload = await readJsonBody(req);
  } catch (error) {
    logEvent("warn", "request-parse-failed", { requestId, error: error.message });
    sendProxyError(res, 400, "Bad Request", error.message, 0, [], {
      requestId,
      stage: "parse"
    });
    return;
  }

  const method = String(payload.method || "GET").toUpperCase();
  const allowedMethods = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

  if (!allowedMethods.has(method)) {
    sendProxyError(res, 400, "Bad Request", "Unsupported HTTP method.", 0, [], {
      requestId,
      stage: "validate-method"
    });
    return;
  }

  let targetUrl;
  try {
    targetUrl = new URL(payload.url);
  } catch {
    sendProxyError(res, 400, "Bad Request", "Enter a valid absolute URL.", 0, [], {
      requestId,
      stage: "validate-url"
    });
    return;
  }

  if (!["http:", "https:"].includes(targetUrl.protocol)) {
    sendProxyError(res, 400, "Bad Request", "Only HTTP and HTTPS URLs are supported.", 0, [], {
      requestId,
      stage: "validate-protocol"
    });
    return;
  }

  const headers = {};
  for (const [key, value] of Object.entries(payload.headers || {})) {
    if (key && value !== undefined && value !== null) {
      headers[key] = String(value);
    }
  }
  applyDefaultHeaders(headers);

  const timeoutMs = Math.min(Number(payload.timeoutMs || 30000), 120000);
  const startedAt = performance.now();
  const transportSettings = payload.transport || {};

  logEvent("info", "request-start", {
    requestId,
    method,
    targetUrl: targetUrl.href,
    transportMode: getTransportMode(transportSettings),
    manualPacConfigured: Boolean(String(transportSettings.manualPacUrl || "").trim())
  });

  try {
    const hasBody = payload.body !== undefined && payload.body !== null && String(payload.body).length > 0;
    const body = ["GET"].includes(method) || !hasBody ? undefined : String(payload.body);

    applyBodyHeaders(headers, body);

    const response = await sendHttpRequest(targetUrl, {
      method,
      headers
    }, body, timeoutMs, transportSettings, { requestId });

    logEvent("info", "request-finished", {
      requestId,
      method,
      targetUrl: targetUrl.href,
      status: response.status,
      elapsedMs: Math.round(performance.now() - startedAt),
      transport: response.transport,
      proxySource: response.diagnostics && response.diagnostics.proxy ? response.diagnostics.proxy.source : "unknown"
    });

    sendJson(res, 200, {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
      body: response.body,
      transport: response.transport,
      diagnostics: response.diagnostics,
      elapsedMs: Math.round(performance.now() - startedAt)
    });
  } catch (error) {
    const elapsedMs = Math.round(performance.now() - startedAt);
    const diagnostics = error.diagnostics || {
      requestId,
      proxy: {
        mode: getTransportMode(transportSettings),
        source: "exception",
        resolved: "UNRESOLVED"
      }
    };

    logEvent("error", "request-failed", {
      requestId,
      method,
      targetUrl: targetUrl.href,
      elapsedMs,
      error: error.message,
      code: error.code || "UNKNOWN",
      diagnostics
    });

    sendProxyError(
      res,
      502,
      "Bad Gateway",
      error.name === "AbortError" ? "Request timed out." : error.message,
      elapsedMs,
      getErrorDetails(error),
      diagnostics
    );
  }
}

const server = http.createServer((req, res) => {
  if (req.method === "POST" && req.url === "/api/request") {
    proxyRequest(req, res);
    return;
  }

  if (req.method === "GET") {
    serveStatic(req, res);
    return;
  }

  res.writeHead(405);
  res.end("Method not allowed");
});

server.listen(PORT, () => {
  console.log(`ReqForge running at http://localhost:${PORT}`);
  logEvent("info", "server-start", { port: PORT, nodeEnv: process.env.NODE_ENV || "development" });
});
