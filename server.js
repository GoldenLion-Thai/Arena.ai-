#!/usr/bin/env node
/* Zero-dependency static server for the Sovereign reference implementation.
   Binds 0.0.0.0 so it works behind a proxy/preview host.

   node server.js            → http://localhost:8080
   PORT=3000 node server.js  → http://localhost:3000
*/
const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || "0.0.0.0";

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

function safeJoin(root, target) {
  const p = path.normalize(path.join(root, target));
  return p.startsWith(root) ? p : null;
}

const server = http.createServer((req, res) => {
  const url = decodeURIComponent((req.url || "/").split("?")[0]);
  let rel = url === "/" ? "/index.html" : url;

  let file = safeJoin(ROOT, rel);
  if (!file) {
    res.writeHead(403).end("Forbidden");
    return;
  }

  fs.stat(file, (err, st) => {
    if (!err && st.isDirectory()) file = path.join(file, "index.html");
    fs.readFile(file, (err2, data) => {
      if (err2) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("404 — " + rel);
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
});

server.listen(PORT, HOST, () => {
  console.log(`Sovereign → http://${HOST}:${PORT}  (root ${ROOT})`);
});
