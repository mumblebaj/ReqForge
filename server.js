const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const tls = require("tls");

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, "public");

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

function sendProxyError(res, statusCode, statusText, message, elapsedMs = 0, errorDetails = []) {
  sendJson(res, statusCode, {
    ok: false,
    status: statusCode,
    statusText,
    headers: {},
    body: "",
    error: message,
    errorDetails,
    elapsedMs
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

function isNoProxyMatch(targetUrl) {
  const hostname = targetUrl.hostname;
  const port = targetUrl.port || (targetUrl.protocol === "https:" ? "443" : "80");

  return getNoProxyRules().some((rule) => {
    const [ruleHost, rulePort] = rule.split(":");
    if (rulePort && rulePort !== port) {
      return false;
    }

    return hostnameMatchesNoProxyRule(hostname, ruleHost || rule);
  });
}

function getProxyUrl(targetUrl) {
  if (isNoProxyMatch(targetUrl)) {
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

function requestHttpThroughProxy(targetUrl, proxyUrl, options, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const headers = { ...options.headers, Host: targetUrl.host };
    const proxyAuthorization = getProxyAuthorization(proxyUrl);

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

function requestHttpsThroughProxy(targetUrl, proxyUrl, options, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const connectHeaders = {
      Host: targetUrl.host
    };
    const proxyAuthorization = getProxyAuthorization(proxyUrl);

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

async function sendHttpRequest(targetUrl, options, body, timeoutMs, redirectCount = 0) {
  const proxyUrl = getProxyUrl(targetUrl);

  if (proxyUrl && proxyUrl.protocol !== "http:") {
    const error = new Error("Only HTTP proxy URLs are currently supported.");
    error.code = "EUNSUPPORTED_PROXY";
    throw error;
  }

  const response = proxyUrl
    ? targetUrl.protocol === "https:"
      ? await requestHttpsThroughProxy(targetUrl, proxyUrl, options, body, timeoutMs)
      : await requestHttpThroughProxy(targetUrl, proxyUrl, options, body, timeoutMs)
    : await requestDirect(targetUrl, options, body, timeoutMs);

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

    return sendHttpRequest(redirectUrl, redirectOptions, redirectBody, timeoutMs, redirectCount + 1);
  }

  response.transport = getProxyDescription(proxyUrl);
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

  try {
    payload = await readJsonBody(req);
  } catch (error) {
    sendProxyError(res, 400, "Bad Request", error.message);
    return;
  }

  const method = String(payload.method || "GET").toUpperCase();
  const allowedMethods = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

  if (!allowedMethods.has(method)) {
    sendProxyError(res, 400, "Bad Request", "Unsupported HTTP method.");
    return;
  }

  let targetUrl;
  try {
    targetUrl = new URL(payload.url);
  } catch {
    sendProxyError(res, 400, "Bad Request", "Enter a valid absolute URL.");
    return;
  }

  if (!["http:", "https:"].includes(targetUrl.protocol)) {
    sendProxyError(res, 400, "Bad Request", "Only HTTP and HTTPS URLs are supported.");
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

  try {
    const hasBody = payload.body !== undefined && payload.body !== null && String(payload.body).length > 0;
    const body = ["GET"].includes(method) || !hasBody ? undefined : String(payload.body);

    applyBodyHeaders(headers, body);

    const response = await sendHttpRequest(targetUrl, {
      method,
      headers
    }, body, timeoutMs);

    sendJson(res, 200, {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
      body: response.body,
      transport: response.transport,
      elapsedMs: Math.round(performance.now() - startedAt)
    });
  } catch (error) {
    sendProxyError(
      res,
      502,
      "Bad Gateway",
      error.name === "AbortError" ? "Request timed out." : error.message,
      Math.round(performance.now() - startedAt),
      getErrorDetails(error)
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
});
