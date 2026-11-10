// Getting slides and speaker notes into the app. Everything runs in the browser; nothing is uploaded.
export const naturalSort = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
const canvasBlob = (c, type = "image/jpeg", q = 0.92) => new Promise(r => c.toBlob(r, type, q));

/** PDF (e.g. PowerPoint > File > Export > PDF) -> one 1920px-wide JPEG per page. */
export async function importPdf(file, onProgress) {
  const pdfjs = await import("../vendor/pdfjs/pdf.min.mjs");
  pdfjs.GlobalWorkerOptions.workerSrc = new URL("../vendor/pdfjs/pdf.worker.min.mjs", import.meta.url).href;
  const doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()), isEvalSupported: false }).promise;
  const out = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const base = page.getViewport({ scale: 1 });
    const vp = page.getViewport({ scale: 1920 / base.width });
    const c = document.createElement("canvas"); c.width = Math.round(vp.width); c.height = Math.round(vp.height);
    await page.render({ canvasContext: c.getContext("2d"), viewport: vp, background: "#ffffff" }).promise;
    out.push({ blob: await canvasBlob(c), label: `Slide ${i}` });
    onProgress?.(i, doc.numPages);
  }
  return out;
}

/** PNG/JPG/WebP files, in natural filename order. */
export function importImages(files) {
  return [...files].filter(f => /^image\//.test(f.type)).sort(naturalSort).map((f, i) => ({ blob: f, label: `Slide ${i + 1}` }));
}

/** A .pptx: speaker notes per slide, plus each slide's text (used only if no PDF/images are given). */
export async function parsePptx(file) {
  if (!window.JSZip) await new Promise((res, rej) => { const s = document.createElement("script"); s.src = new URL("../vendor/jszip.min.js", import.meta.url).href; s.onload = res; s.onerror = rej; document.head.append(s); });
  const zip = await window.JSZip.loadAsync(await file.arrayBuffer());
  const read = async p => { const f = zip.file(p); return f ? new DOMParser().parseFromString(await f.async("string"), "application/xml") : null; };
  const rels = async p => {
    const d = await read(p); const m = {};
    if (d) for (const r of d.getElementsByTagName("Relationship")) m[r.getAttribute("Id")] = { type: r.getAttribute("Type"), target: r.getAttribute("Target") };
    return m;
  };
  const resolve = (base, target) => { const parts = (target.startsWith("/") ? target.slice(1) : base + target).split("/"); const o = []; for (const p of parts) { if (p === "..") o.pop(); else if (p !== ".") o.push(p); } return o.join("/"); };
  const phType = sp => { const ph = sp.getElementsByTagName("p:ph")[0]; return ph ? (ph.getAttribute("type") || "body") : null; };
  const paras = sp => [...sp.getElementsByTagName("a:p")].map(p => [...p.getElementsByTagName("a:t")].map(t => t.textContent).join("")).filter(Boolean);
  const pres = await read("ppt/presentation.xml"); const prel = await rels("ppt/_rels/presentation.xml.rels");
  if (!pres) throw new Error("This does not look like a PowerPoint (.pptx) file");
  const ids = [...pres.getElementsByTagName("p:sldId")].map(e => e.getAttribute("r:id"));
  const notes = [], cards = [];
  for (const id of ids) {
    const slidePath = resolve("ppt/", prel[id].target);
    const dir = slidePath.slice(0, slidePath.lastIndexOf("/") + 1), name = slidePath.slice(dir.length);
    const sd = await read(slidePath), skip = ["sldNum", "hdr", "ftr", "dt"];
    const sps = sd ? [...sd.getElementsByTagName("p:sp")].filter(sp => !skip.includes(phType(sp))) : [];
    const title = sps.filter(sp => ["title", "ctrTitle"].includes(phType(sp))).map(sp => paras(sp).join(" ")).join(" ");
    const body = sps.filter(sp => !["title", "ctrTitle"].includes(phType(sp))).flatMap(paras);
    cards.push({ title, body });
    const srel = await rels(`${dir}_rels/${name}.rels`);
    const n = Object.values(srel).find(r => r.type.endsWith("/notesSlide"));
    let text = "";
    if (n) {
      const nd = await read(resolve(dir, n.target));
      if (nd) {
        const nsp = [...nd.getElementsByTagName("p:sp")];
        const nb = nsp.filter(sp => phType(sp) === "body");
        const use = nb.length ? nb : nsp.filter(sp => !["sldNum", "hdr", "ftr", "dt", "sldImg"].includes(phType(sp)));
        text = use.map(sp => paras(sp).join("\n")).join("\n").trim();
      }
    }
    notes.push(text.replace(/^SAY\s*\([^)]*\):\s*/i, "").trim());
  }
  return { notes, cards };
}

/** Draws a plain slide from text, for a .pptx imported without a PDF. */
export async function renderCard({ title, body }) {
  const c = document.createElement("canvas"); c.width = 1920; c.height = 1080; const x = c.getContext("2d");
  x.fillStyle = "#ffffff"; x.fillRect(0, 0, 1920, 1080);
  const wrap = (text, font, maxW) => { x.font = font; const lines = []; let line = ""; for (const w of text.split(/\s+/)) { const t = line ? line + " " + w : w; if (x.measureText(t).width > maxW && line) { lines.push(line); line = w; } else line = t; } if (line) lines.push(line); return lines; };
  let y = 170; x.fillStyle = "#16161a";
  for (const l of wrap(title || "", "700 88px -apple-system, Helvetica, Arial, sans-serif", 1680).slice(0, 3)) { x.fillText(l, 120, y); y += 104; }
  y += 30; x.fillStyle = "#3a3a44";
  for (const para of body) for (const l of wrap(para, "400 52px -apple-system, Helvetica, Arial, sans-serif", 1640)) { if (y > 1000) break; x.fillText(l, 120, y); y += 70; }
  return canvasBlob(c);
}
