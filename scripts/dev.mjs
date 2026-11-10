// Tiny static server for local use. Listens on 127.0.0.1 only (this computer, not the network)
// and sends the same security headers as vercel.json so you test what you deploy.
import { createServer } from "node:http";
import { readFileSync, statSync, createReadStream, existsSync } from "node:fs";
import { join, extname, normalize, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.PORT || 5173);
const host = "127.0.0.1";
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".wasm": "application/wasm", ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".map": "application/json", ".webmanifest": "application/manifest+json" };
const cfg = JSON.parse(readFileSync(join(root, "vercel.json"), "utf8"));
const headers = Object.fromEntries((cfg.headers.find(h => h.source === "/(.*)")?.headers || []).map(h => [h.key, h.value]));

export function start(p = port) {
  const server = createServer((req, res) => {
    let path = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (path.endsWith("/")) path += "index.html";
    const file = normalize(join(root, path));
    if (!file.startsWith(root) || file.includes("node_modules") || file.includes("/.git") || !existsSync(file) || !statSync(file).isFile()) { res.writeHead(404, headers); return res.end("Not found"); }
    res.writeHead(200, { ...headers, "Content-Type": types[extname(file)] || "application/octet-stream", "Content-Length": statSync(file).size });
    createReadStream(file).pipe(res);
  });
  return new Promise(r => server.listen(p, host, () => r(server)));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await start();
  console.log(`SlideCast running at http://${host}:${port}/  (this computer only; Ctrl+C to stop)`);
}
