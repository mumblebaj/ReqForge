const http = require("http");
const fs = require("fs");
const path = require("path");

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
    sendJson(res, 400, { error: error.message });
    return;
  }

  const method = String(payload.method || "GET").toUpperCase();
  const allowedMethods = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

  if (!allowedMethods.has(method)) {
    sendJson(res, 400, { error: "Unsupported HTTP method." });
    return;
  }

  let targetUrl;
  try {
    targetUrl = new URL(payload.url);
  } catch {
    sendJson(res, 400, { error: "Enter a valid absolute URL." });
    return;
  }

  if (!["http:", "https:"].includes(targetUrl.protocol)) {
    sendJson(res, 400, { error: "Only HTTP and HTTPS URLs are supported." });
    return;
  }

  const headers = {};
  for (const [key, value] of Object.entries(payload.headers || {})) {
    if (key && value !== undefined && value !== null) {
      headers[key] = String(value);
    }
  }

  const timeoutMs = Math.min(Number(payload.timeoutMs || 30000), 120000);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = performance.now();

  try {
    const hasBody = payload.body !== undefined && payload.body !== null && String(payload.body).length > 0;
    const response = await fetch(targetUrl, {
      method,
      headers,
      body: ["GET"].includes(method) || !hasBody ? undefined : String(payload.body),
      signal: controller.signal,
      redirect: "follow"
    });

    const responseBody = await response.text();
    const responseHeaders = {};
    response.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });

    sendJson(res, 200, {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
      body: responseBody,
      elapsedMs: Math.round(performance.now() - startedAt)
    });
  } catch (error) {
    sendJson(res, 502, {
      error: error.name === "AbortError" ? "Request timed out." : error.message,
      elapsedMs: Math.round(performance.now() - startedAt)
    });
  } finally {
    clearTimeout(timeout);
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
