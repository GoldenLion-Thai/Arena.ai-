#!/usr/bin/env node
/* ============================================================================
   server.js — static server + same-origin model gateway proxy.

   Static:  node server.js                       → http://localhost:8080
   Proxy:   OLLAMA_URL=http://10.0.0.12:11434 node server.js
            → /gateway/* is forwarded to that host, streaming intact.

   Why the proxy exists: a browser cannot reach a private subnet, and Ollama
   refuses cross-origin requests unless OLLAMA_ORIGINS allows them. Serving both
   the UI and the model from one origin removes CORS, works behind the preview
   host, and keeps the model port unpublished. This is NOT an open proxy — it
   forwards only to the single configured target.
   ========================================================================== */
const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

const ROOT = __dirname;
const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || "0.0.0.0";
const PREFIX = process.env.GATEWAY_PREFIX || "/gateway/";
const TARGET = process.env.OLLAMA_URL || process.env.GATEWAY_URL || "http://127.0.0.1:11434";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

/* ------------------------------------------------------------------ static */

function safeJoin(root, target) {
  const p = path.normalize(path.join(root, target));
  return p.startsWith(root) ? p : null;
}

function serveStatic(req, res) {
  const url = decodeURIComponent((req.url || "/").split("?")[0]);
  let file = safeJoin(ROOT, url === "/" ? "/index.html" : url);
  if (!file) {
    res.writeHead(403, { "Content-Type": "text/plain" }).end("Forbidden");
    return;
  }
  fs.stat(file, (err, st) => {
    if (!err && st.isDirectory()) file = path.join(file, "index.html");
    fs.readFile(file, (err2, data) => {
      if (err2) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("404 — " + url);
        return;
      }
      const ext = path.extname(file).toLowerCase();
      res.writeHead(200, {
        "Content-Type": MIME[ext] || "application/octet-stream",
        "Cache-Control": "no-cache",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
      });
      res.end(data);
    });
  });
}

/* ------------------------------------------------------------------- proxy */

function proxy(req, res) {
  let target;
  try {
    target = new URL(TARGET);
  } catch {
    res.writeHead(500, { "Content-Type": "text/plain" }).end("Bad OLLAMA_URL");
    return;
  }

  // /gateway/api/chat  →  {target}/api/chat
  const rest = req.url.slice(PREFIX.length - 1); // keep the leading slash
  const upstreamPath = (target.pathname.replace(/\/$/, "") + rest) || "/";

  const lib = target.protocol === "https:" ? https : http;
  const headers = Object.assign({}, req.headers);
  delete headers.host;
  delete headers.connection;
  delete headers["accept-encoding"]; // avoid gzipped streams we would have to decode
  headers["accept-encoding"] = "identity";
  headers.host = target.host;

  const upstream = lib.request(
    {
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || (target.protocol === "https:" ? 443 : 80),
      method: req.method,
      path: upstreamPath + (req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : ""),
      headers,
    },
    (up) => {
      const out = Object.assign({}, up.headers);
      // Streaming responses must not be buffered by intermediaries.
      out["cache-control"] = "no-cache, no-transform";
      out["x-accel-buffering"] = "no";
      delete out["content-length"];
      delete out["transfer-encoding"];
      res.writeHead(up.statusCode || 502, out);
      up.on("error", () => res.end());
      up.pipe(res); // token-by-token, no accumulation
    }
  );

  upstream.on("error", (e) => {
    const msg = `Gateway proxy could not reach ${TARGET}${upstreamPath}: ${e.code || e.message}\n\n` +
      `Fix one of:\n` +
      `  • start Ollama there, or set OLLAMA_URL to the right host\n` +
      `  • on the Ollama box: OLLAMA_HOST=127.0.0.1:11434 (keep it private)\n` +
      `  • in a VPC: check the security list / NSG allows this host on that port\n`;
    if (!res.headersSent) res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(msg);
  });

  req.pipe(upstream);
}

/* ------------------------------------------------------------------ server */

const server = http.createServer((req, res) => {
  if (req.url === PREFIX || req.url.startsWith(PREFIX)) return proxy(req, res);
  if (req.url === "/healthz") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: true, gateway: TARGET, prefix: PREFIX }));
  }
  serveStatic(req, res);
});

server.listen(PORT, HOST, () => {
  console.log(`Sovereign → http://${HOST}:${PORT}  (root ${ROOT})`);
  console.log(`Gateway   → ${PREFIX}* proxied to ${TARGET}`);
  console.log(`            set OLLAMA_URL to point at your Ollama/vLLM host`);
});
