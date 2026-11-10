// Copies the browser libraries out of node_modules into vendor/ so the site is plain static files
// (no build step on Vercel, no third-party CDN at runtime).
import { cpSync, mkdirSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const nm = (...p) => join(root, "node_modules", ...p);
const out = (...p) => join(root, "vendor", ...p);

mkdirSync(out("ffmpeg"), { recursive: true });
mkdirSync(out("ffmpeg-core"), { recursive: true });
mkdirSync(out("pdfjs"), { recursive: true });

for (const f of readdirSync(nm("@ffmpeg/ffmpeg/dist/esm")).filter(f => f.endsWith(".js"))) cpSync(nm("@ffmpeg/ffmpeg/dist/esm", f), out("ffmpeg", f));
cpSync(nm("@ffmpeg/core/dist/esm/ffmpeg-core.js"), out("ffmpeg-core/ffmpeg-core.js"));
cpSync(nm("@ffmpeg/core/dist/esm/ffmpeg-core.wasm"), out("ffmpeg-core/ffmpeg-core.wasm"));
cpSync(nm("pdfjs-dist/build/pdf.min.mjs"), out("pdfjs/pdf.min.mjs"));
cpSync(nm("pdfjs-dist/build/pdf.worker.min.mjs"), out("pdfjs/pdf.worker.min.mjs"));
cpSync(nm("jszip/dist/jszip.min.js"), out("jszip.min.js"));
console.log("vendor/ updated");
