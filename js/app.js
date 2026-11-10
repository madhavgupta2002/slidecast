// SlideCast: import slides, read your speaker notes, place your camera, record one slide at a time.
// Everything runs in the browser. Slides, notes and recordings are stored in this browser (IndexedDB) only.
import { db } from "./db.js";
import { importPdf, importImages, parsePptx, renderCard } from "./importers.js";
import { joinParts } from "./exporter.js";

const $ = id => document.getElementById(id);
const W = 1920, H = 1080;
const stage = $("stage"), ctx = stage.getContext("2d"), camEl = $("cam");
const fmt = s => { s = Math.max(0, s || 0); return Math.floor(s / 60) + ":" + String(Math.floor(s % 60)).padStart(2, "0"); };
const uid = () => crypto.randomUUID();
const DEFAULT_CAM = { x: 1706, y: 866, r: 170 };
// avc3 keeps the stream valid if the encoder changes its parameters mid-recording (avc1 logs errors in Chrome)
const MIMES = ["video/mp4;codecs=avc3.640028,mp4a.40.2", "video/mp4;codecs=avc3,mp4a.40.2", "video/mp4;codecs=avc1.640028,mp4a.40.2", "video/mp4;codecs=avc1,mp4a.40.2", "video/mp4", "video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"];
const extOf = m => (m || "").startsWith("video/mp4") ? "mp4" : "webm";
const slug = s => (s || "presentation").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "presentation";

let project = { name: "presentation", segs: [] };   // segs: { id, label, text, cam: {x,y,r} }
const imgCache = new Map();    // seg id -> HTMLImageElement
const parts = new Map();       // seg id -> { secs, mime }
const pending = new Set();
let cur = 0, mode = "idle", single = false, camStream = null, mixed = null, analyser = null, rec = null, segT0 = 0, drag = null;

// ---------------------------------------------------------------- storage
let saveT; const saveProject = () => { clearTimeout(saveT); saveT = setTimeout(() => db.set("project", project), 250); };
const seg = () => project.segs[cur];

async function prepare(s, blob) {
  const im = new Image(); im.src = URL.createObjectURL(blob); await im.decode().catch(() => {}); imgCache.set(s.id, im);
}
async function dropAll() {
  for (const s of project.segs) { await db.del("media:" + s.id); await db.del("part:" + s.id); URL.revokeObjectURL(imgCache.get(s.id)?.src); }
  imgCache.clear(); parts.clear(); project = { name: "presentation", segs: [] }; cur = 0;
}
async function addSlides(items) {
  for (const it of items) {
    const s = { id: uid(), label: it.label, text: it.text || "", cam: { ...DEFAULT_CAM } };
    await db.set("media:" + s.id, it.blob); await prepare(s, it.blob); project.segs.push(s);
  }
  saveProject();
}
async function boot() {
  if (location.protocol === "file:") banner("Open SlideCast from a web address (run `npm run dev`, or use the deployed site). Browsers block the camera and scripts on file:// pages.");
  if (typeof MediaRecorder === "undefined" || !navigator.mediaDevices) banner("This browser cannot record video. Use a current version of Chrome, Edge or Firefox.");
  const p = await db.get("project").catch(() => null);
  if (p && Array.isArray(p.segs)) {
    project = { name: p.name || "presentation", segs: p.segs.filter(s => s.kind !== "clip") };   // older saved projects may contain clips
    for (const s of project.segs) {
      const blob = await db.get("media:" + s.id); if (blob) await prepare(s, blob);
      const part = await db.get("part:" + s.id); if (part) parts.set(s.id, { secs: part.secs, mime: part.mime });
    }
  }
  $("fileName").textContent = project.segs.length ? project.name : "";
  go(0); draw();
}

// ---------------------------------------------------------------- UI
function banner(msg) { const b = $("banner"); b.textContent = msg; b.hidden = !msg; }
// Builds the status line from text nodes only (never HTML), so file names and notes can't inject markup.
function status(...bits) {
  const el = $("status"); el.textContent = "";
  for (const x of bits) { if (typeof x === "string") el.append(document.createTextNode(x)); else { const b = document.createElement("b"); b.textContent = x.b; el.append(b); } }
}
function lock(on) { $("importBtn").disabled = $("emptyImport").disabled = $("prevBtn").disabled = on; $("script").readOnly = on; }

function renderList() {
  const list = $("list"); list.textContent = "";
  const has = project.segs.length > 0, locked = mode === "rec";
  $("empty").hidden = has;
  $("rerecordBtn").disabled = locked || !camStream || !has;
  $("startBtn").disabled = locked || !camStream || !has;
  $("stopBtn").disabled = !locked;
  $("exportBtn").disabled = locked || !has || !project.segs.every(s => parts.has(s.id));
  project.segs.forEach((s, i) => {
    const row = document.createElement("div"); row.className = "seg" + (i === cur ? " on" : ""); row.setAttribute("role", "listitem"); row.tabIndex = 0;
    const n = document.createElement("span"); n.className = "n"; n.textContent = i + 1;
    const mid = document.createElement("span"); const b = document.createElement("b"); b.textContent = s.label; mid.append(b, document.createElement("br"));
    const part = parts.get(s.id), st = document.createElement("span"); st.className = "st" + (part ? " done" : "");
    st.textContent = part ? "✓ recorded " + fmt(part.secs) : "not recorded"; mid.append(st);
    const acts = document.createElement("span"); acts.className = "acts";
    const btn = document.createElement("button"); btn.textContent = part ? "⟲ Re-record" : "● Record"; btn.disabled = locked || !camStream;
    btn.onclick = e => { e.stopPropagation(); recordFrom(i, true); }; acts.append(btn);
    row.append(n, mid, acts);
    row.onclick = () => { if (mode !== "rec") go(i); };
    row.onkeydown = e => { if ((e.key === "Enter" || e.key === " ") && e.target === row && mode !== "rec") { e.preventDefault(); go(i); } };
    list.append(row);
  });
}
function go(i) {
  cur = Math.max(0, Math.min(project.segs.length - 1, i));
  const s = seg(), has = !!s;
  $("nowLab").textContent = has ? `Speaker notes · ${s.label} of ${project.segs.length}` : "Speaker notes";
  $("script").value = has ? s.text : ""; $("script").disabled = !has;
  const n = project.segs[cur + 1]; $("next").textContent = n ? `Next – ${n.label}: ${n.text}` : has ? "Last slide." : "";
  if (has) $("size").value = s.cam.r;
  $("nextBtn").disabled = !has; $("prevBtn").disabled = !has || mode === "rec";
  renderList();
}
$("script").addEventListener("input", () => { const s = seg(); if (!s || mode === "rec") return; s.text = $("script").value; saveProject(); });
$("fs").addEventListener("input", () => { $("script").style.fontSize = $("fs").value + "px"; localStorage.setItem("slidecast_fs", $("fs").value); });
{ const f = localStorage.getItem("slidecast_fs"); if (f) { $("fs").value = f; $("script").style.fontSize = f + "px"; } }

// ---------------------------------------------------------------- import (PDF, images, PowerPoint)
$("importBtn").onclick = $("emptyImport").onclick = () => $("slidesIn").click();
$("slidesIn").addEventListener("change", async e => {
  const files = [...e.target.files]; e.target.value = ""; if (!files.length) return;
  const pdf = files.find(f => f.type === "application/pdf" || /\.pdf$/i.test(f.name));
  const pptx = files.find(f => /\.pptx$/i.test(f.name));
  const images = importImages(files);
  if (!pdf && !pptx && !images.length) { status("Choose a PDF, images or a PowerPoint (.pptx) file."); return; }
  try {
    status("Importing…");
    let items = null, deck = null;
    if (pdf) items = await importPdf(pdf, (i, n) => status(`Importing slide ${i} of ${n}…`)); else if (images.length) items = images;
    if (pptx) deck = await parsePptx(pptx);
    const noteFor = i => deck?.notes[i] || "";
    if (items) {   // a new deck replaces the old one
      if (project.segs.length && parts.size && !confirm("Replace the current slides? Their recordings will be removed.")) { status("Import cancelled."); return; }
      await dropAll(); items.forEach((it, i) => { it.text = noteFor(i); });
      await addSlides(items); project.name = (pdf || pptx || files[0]).name.replace(/\.[^.]+$/, "");
      status(deck ? (deck.notes.length === items.length ? `Imported ${items.length} slides with speaker notes.` : `Imported ${items.length} slides, but the PowerPoint has ${deck.notes.length}. Check the notes match the slides.`) : `Imported ${items.length} slides. ${pdf || images.length ? "Add the PowerPoint too if you want your speaker notes." : ""}`);
    } else if (project.segs.length) {   // PowerPoint on top of slides already loaded: fill in the notes
      project.segs.forEach((s, i) => { if (noteFor(i)) s.text = noteFor(i); });
      status(deck.notes.length === project.segs.length ? "Speaker notes added from the PowerPoint." : `The PowerPoint has ${deck.notes.length} slides but you have ${project.segs.length}. Check the notes match the slides.`);
    } else {   // PowerPoint on its own: draw simple text slides from it
      if (!deck.cards.length) { status("That PowerPoint has no slides."); return; }
      const cards = []; for (const [i, c] of deck.cards.entries()) cards.push({ blob: await renderCard(c), label: `Slide ${i + 1}`, text: noteFor(i) });
      await addSlides(cards); project.name = pptx.name.replace(/\.[^.]+$/, "");
      status("Imported the speaker notes. Slides are drawn from text only; to show your real slides, also choose the PDF export of this deck.");
    }
    saveProject(); $("fileName").textContent = project.name; go(0);
  } catch (err) { status("Could not import: " + err.message); }
});

// ---------------------------------------------------------------- camera placement
const toC = e => { const r = stage.getBoundingClientRect(); return { x: (e.clientX - r.left) / r.width * W, y: (e.clientY - r.top) / r.height * H }; };
const onBubble = p => { const s = seg(); if (!s) return false; const b = s.cam; return (p.x - b.x) ** 2 + (p.y - b.y) ** 2 <= b.r * b.r; };
const clampCam = b => { b.r = Math.max(80, Math.min(420, b.r)); b.x = Math.max(b.r, Math.min(W - b.r, b.x)); b.y = Math.max(b.r, Math.min(H - b.r, b.y)); };
stage.addEventListener("pointerdown", e => { const p = toC(e); if (!onBubble(p)) return; const b = seg().cam; drag = { dx: p.x - b.x, dy: p.y - b.y }; stage.setPointerCapture(e.pointerId); });
stage.addEventListener("pointermove", e => {
  const p = toC(e); stage.style.cursor = drag ? "grabbing" : onBubble(p) ? "grab" : "default"; if (!drag) return;
  const b = seg().cam; b.x = p.x - drag.dx; b.y = p.y - drag.dy; clampCam(b);
});
stage.addEventListener("pointerup", () => { if (drag) { drag = null; saveProject(); } });
stage.addEventListener("wheel", e => { if (!onBubble(toC(e))) return; e.preventDefault(); setSize(seg().cam.r - e.deltaY * 0.3); }, { passive: false });
function setSize(r) { const s = seg(); if (!s) return; s.cam.r = r; clampCam(s.cam); $("size").value = s.cam.r; saveProject(); }
$("size").oninput = e => setSize(+e.target.value);
document.querySelectorAll("[data-corner]").forEach(b => b.onclick = () => {
  const s = seg(); if (!s) return; const r = s.cam.r, m = 44, c = b.dataset.corner;
  s.cam.x = c.endsWith("l") ? m + r : W - m - r; s.cam.y = c.startsWith("t") ? m + r : H - m - r; saveProject();
});
$("allPos").onclick = () => { const s = seg(); if (!s) return; project.segs.forEach(x => { x.cam = { ...s.cam }; }); saveProject(); status("Camera position copied to every slide."); };

// ---------------------------------------------------------------- camera + mic
async function openMedia() {
  camStream?.getTracks().forEach(t => t.stop());
  const v = $("camSel").value, a = $("micSel").value;
  camStream = await navigator.mediaDevices.getUserMedia({
    video: { width: { ideal: 1280 }, height: { ideal: 720 }, ...(v ? { deviceId: { exact: v } } : {}) },
    audio: { echoCancellation: true, noiseSuppression: true, ...(a ? { deviceId: { exact: a } } : {}) },
  });
  camEl.srcObject = camStream; await camEl.play();
  const ac = new AudioContext(); analyser = ac.createAnalyser(); analyser.fftSize = 512; ac.createMediaStreamSource(camStream).connect(analyser);
  mixed = new MediaStream([...stage.captureStream(30).getVideoTracks(), ...camStream.getAudioTracks()]);
  const devs = await navigator.mediaDevices.enumerateDevices();
  const fill = (sel, kind, track) => { sel.textContent = ""; devs.filter(d => d.kind === kind).forEach(d => { const o = document.createElement("option"); o.value = d.deviceId; o.textContent = d.label || kind; if (track?.getSettings().deviceId === d.deviceId) o.selected = true; sel.append(o); }); sel.disabled = false; };
  fill($("camSel"), "videoinput", camStream.getVideoTracks()[0]); fill($("micSel"), "audioinput", camStream.getAudioTracks()[0]);
}
$("camBtn").onclick = async () => {
  try { await openMedia(); $("camBtn").classList.add("ok"); $("camBtn").textContent = "① Camera & mic on"; renderList(); status("Camera ready. Place it on the slide if you like, then press ", { b: "② Record from slide 1" }, "."); }
  catch (err) { alert("Camera or microphone is blocked: " + err.message + "\nAllow access in the browser's address bar and try again."); }
};
$("camSel").onchange = $("micSel").onchange = () => openMedia().catch(err => status("Could not switch device: " + err.message));

// ---------------------------------------------------------------- recording: one part per slide, Next ends the part
const mime = typeof MediaRecorder !== "undefined" ? (MIMES.find(m => MediaRecorder.isTypeSupported(m)) || "") : "";
const countdown = async () => { for (let n = 3; n > 0; n--) { $("count").textContent = n; $("count").style.display = "grid"; await new Promise(r => setTimeout(r, 1000)); } $("count").style.display = "none"; };

async function recordFrom(i, only) {
  if (!camStream || mode === "rec" || !project.segs.length) return;
  single = only; mode = "rec"; lock(true); go(i); await countdown(); startPart();
}
function startPart() {
  const s = seg(), chunks = [];
  const r = new MediaRecorder(mixed, { mimeType: mime || undefined, videoBitsPerSecond: 8e6 });
  r.ondataavailable = e => e.data.size && chunks.push(e.data);
  r.onstop = () => savePart(s, new Blob(chunks, { type: r.mimeType || mime || "video/webm" }), (performance.now() - r._t0) / 1000, r.mimeType || mime);
  r._t0 = performance.now(); segT0 = r._t0; r.start(500); rec = r;
  $("recdot").style.display = "flex";
  status("Recording ", { b: s.label }, ". Press ", { b: "Next ▶" }, " (or →) when you finish this slide.");
  go(cur);
}
function next() {
  if (mode !== "rec") { go(cur + 1); return; }
  if (rec && rec.state !== "inactive") rec.stop(); rec = null;
  if (!single && cur < project.segs.length - 1) { cur++; go(cur); setTimeout(startPart, 250); return; }
  endSession();
}
function endSession() {
  mode = "idle"; lock(false); $("recdot").style.display = "none"; go(cur);
  status("Stopped. Re-record any slide from the list, or press ", { b: "③ Export video" }, " when every slide has a ✓.");
}
$("startBtn").onclick = () => recordFrom(0, false);
$("rerecordBtn").onclick = () => recordFrom(cur, true);
$("stopBtn").onclick = () => { if (mode !== "rec") return; if (rec && rec.state !== "inactive") rec.stop(); rec = null; endSession(); };
$("nextBtn").onclick = () => next();
$("prevBtn").onclick = () => { if (mode !== "rec") go(cur - 1); };
document.addEventListener("keydown", e => {
  if (["INPUT", "TEXTAREA", "SELECT"].includes(e.target.tagName) && !(e.target.id === "script" && e.target.readOnly)) return;
  if (e.key === "ArrowRight" || e.key === "PageDown") { e.preventDefault(); $("nextBtn").click(); }
  if (e.key === "ArrowLeft") $("prevBtn").click();
  if (e.key === "Escape") $("stopBtn").click();
});
async function savePart(s, blob, secs, mimeType) {
  pending.add(s.id); parts.set(s.id, { secs, mime: mimeType }); renderList(); $("saved").textContent = `Saving ${s.label}…`;
  try { await db.set("part:" + s.id, { blob, secs, mime: mimeType }); $("saved").textContent = `✓ ${s.label} saved in this browser.`; }
  catch (err) { parts.delete(s.id); $("saved").textContent = `Could not save ${s.label} (${err.message}). Try again.`; }
  pending.delete(s.id); renderList();
}

// ---------------------------------------------------------------- export
function download(blob, name) { const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 60000); }
const ov = { box: $("overlay"), title: $("ovTitle"), st: $("ovStatus"), bar: $("ovBar"), vid: $("ovVideo"), dl: $("ovDownload"), parts: $("ovParts") };
$("ovClose").onclick = () => { ov.box.hidden = true; ov.vid.pause(); };
$("exportBtn").onclick = async () => {
  while (pending.size) await new Promise(r => setTimeout(r, 200));
  ov.title.textContent = "Exporting your video"; ov.st.textContent = "Starting…"; ov.bar.hidden = false; ov.bar.removeAttribute("value"); ov.vid.hidden = true; ov.dl.hidden = true; ov.parts.hidden = true; ov.parts.textContent = ""; ov.box.hidden = false;
  const list = []; for (const s of project.segs) { const p = await db.get("part:" + s.id); if (p) list.push({ ...p, label: s.label }); }
  try {
    const exts = new Set(list.map(p => extOf(p.mime)));
    if (exts.size !== 1) throw new Error("Slides were recorded in different formats. Re-record them so they match.");
    const ext = [...exts][0];
    const out = await joinParts(list, { ext, onStatus: t => { ov.st.textContent = t; }, onProgress: p => { ov.bar.max = 1; ov.bar.value = p; } });
    const name = slug(project.name) + "." + ext;
    ov.title.textContent = "Your video is ready"; ov.st.textContent = `${name} · ${(out.size / 1048576).toFixed(1)} MB`; ov.bar.hidden = true;
    ov.vid.src = URL.createObjectURL(out); ov.vid.hidden = false; ov.dl.href = ov.vid.src; ov.dl.download = name; ov.dl.hidden = false;
  } catch (err) {
    ov.title.textContent = "Could not join the slides"; ov.st.textContent = err.message + " You can still download each slide's recording and join them in any video editor."; ov.bar.hidden = true; ov.parts.hidden = false;
    list.forEach((p, i) => { const b = document.createElement("button"); b.className = "btn"; b.textContent = `Download slide ${i + 1}`; b.onclick = () => download(p.blob, `${slug(project.name)}-${String(i + 1).padStart(2, "0")}.${extOf(p.mime)}`); ov.parts.append(b); });
  }
};

// ---------------------------------------------------------------- drawing
function draw() {
  const s = seg(); ctx.fillStyle = "#111"; ctx.fillRect(0, 0, W, H);
  if (s) {
    const im = imgCache.get(s.id);
    if (im?.complete && im.naturalWidth) { const k = Math.min(W / im.naturalWidth, H / im.naturalHeight), w = im.naturalWidth * k, h = im.naturalHeight * k; ctx.drawImage(im, (W - w) / 2, (H - h) / 2, w, h); }
    if (camStream && camEl.readyState >= 2) {
      const b = s.cam, vw = camEl.videoWidth, vh = camEl.videoHeight, m = Math.min(vw, vh);
      ctx.save(); ctx.beginPath(); ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2); ctx.clip(); ctx.translate(b.x * 2, 0); ctx.scale(-1, 1);   // mirrored, like a selfie
      ctx.drawImage(camEl, (vw - m) / 2, (vh - m) / 2, m, m, b.x - b.r, b.y - b.r, b.r * 2, b.r * 2); ctx.restore();
      ctx.lineWidth = 8; ctx.strokeStyle = "#fff"; ctx.beginPath(); ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2); ctx.stroke();
    }
    $("cur").textContent = fmt(mode === "rec" ? (performance.now() - segT0) / 1000 : 0);
  } else $("cur").textContent = "0:00";
  if (analyser) { const a = new Uint8Array(analyser.fftSize); analyser.getByteTimeDomainData(a); let pk = 0; for (const v of a) pk = Math.max(pk, Math.abs(v - 128)); $("lvl").style.width = Math.min(100, pk / 1.2) + "%"; }
  requestAnimationFrame(draw);
}

boot();
