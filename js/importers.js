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

/** Speaker notes from a .pptx, in slide order. Returns an array of strings (empty string when a slide has none). */
export async function parsePptxNotes(file) {
  if (!window.JSZip) await new Promise((res, rej) => { const s = document.createElement("script"); s.src = new URL("../vendor/jszip.min.js", import.meta.url).href; s.onload = res; s.onerror = rej; document.head.append(s); });
  const zip = await window.JSZip.loadAsync(await file.arrayBuffer());
  const read = async p => { const f = zip.file(p); return f ? new DOMParser().parseFromString(await f.async("string"), "application/xml") : null; };
  const rels = async p => {
    const d = await read(p); const m = {};
    if (d) for (const r of d.getElementsByTagName("Relationship")) m[r.getAttribute("Id")] = { type: r.getAttribute("Type"), target: r.getAttribute("Target") };
    return m;
  };
  const resolve = (base, target) => { const parts = (target.startsWith("/") ? target.slice(1) : base + target).split("/"); const o = []; for (const p of parts) { if (p === "..") o.pop(); else if (p !== ".") o.push(p); } return o.join("/"); };
  const pres = await read("ppt/presentation.xml"); const prel = await rels("ppt/_rels/presentation.xml.rels");
  if (!pres) throw new Error("Not a PowerPoint file");
  const ids = [...pres.getElementsByTagName("p:sldId")].map(e => e.getAttribute("r:id"));
  const notes = [];
  for (const id of ids) {
    const slidePath = resolve("ppt/", prel[id].target);
    const dir = slidePath.slice(0, slidePath.lastIndexOf("/") + 1), name = slidePath.slice(dir.length);
    const srel = await rels(`${dir}_rels/${name}.rels`);
    const n = Object.values(srel).find(r => r.type.endsWith("/notesSlide"));
    if (!n) { notes.push(""); continue; }
    const nd = await read(resolve(dir, n.target)); let text = "";
    if (nd) {
      const sps = [...nd.getElementsByTagName("p:sp")];
      const body = sps.filter(sp => { const ph = sp.getElementsByTagName("p:ph")[0]; return ph && ph.getAttribute("type") === "body"; });
      const use = body.length ? body : sps.filter(sp => { const ph = sp.getElementsByTagName("p:ph")[0]; return !ph || !["sldNum", "hdr", "ftr", "dt", "sldImg"].includes(ph.getAttribute("type")); });
      text = use.map(sp => [...sp.getElementsByTagName("a:p")].map(p => [...p.getElementsByTagName("a:t")].map(t => t.textContent).join("")).join("\n")).join("\n").trim();
    }
    notes.push(text.replace(/^SAY\s*\([^)]*\):\s*/i, "").trim());
  }
  return notes;
}

/** A small generic deck so people can try the app without any files. */
export async function makeSampleDeck() {
  const slides = [
    ["Welcome to SlideCast", "Record your talk one slide at a time", "Hi everyone. In this talk I will show how SlideCast works: you record a slide, press Next, and move on."],
    ["How it works", "1  Import slides   2  Add your script   3  Record   4  Export", "First I import my slides. Then I paste or type what I want to say. I record each slide and press Next when I am done."],
    ["Fix any slide", "Re-record only the slide you stumbled on", "If I make a mistake I press Re-record current slide. Only that part is replaced and everything else stays."],
    ["Thank you", "Export one video when every slide has a tick", "That is it. When all slides are recorded I export one video file. Thank you for watching."],
  ];
  const out = [];
  for (const [i, [title, sub, text]] of slides.entries()) {
    const c = document.createElement("canvas"); c.width = 1920; c.height = 1080; const x = c.getContext("2d");
    const g = x.createLinearGradient(0, 0, 1920, 1080); g.addColorStop(0, "#ffe4f4"); g.addColorStop(1, "#ffdcc4"); x.fillStyle = g; x.fillRect(0, 0, 1920, 1080);
    x.fillStyle = "#16161a"; x.font = "700 120px -apple-system, Helvetica, Arial, sans-serif"; x.fillText(title, 120, 470);
    x.font = "400 54px -apple-system, Helvetica, Arial, sans-serif"; x.fillStyle = "#4a4a55"; x.fillText(sub, 124, 580);
    x.font = "600 40px -apple-system, Helvetica, Arial, sans-serif"; x.fillStyle = "#d65c28"; x.fillText(`${i + 1} / ${slides.length}`, 124, 980);
    out.push({ blob: await canvasBlob(c), label: `Slide ${i + 1}`, text });
  }
  return out;
}
