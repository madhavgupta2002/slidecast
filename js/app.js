// SlideCast: record a presentation one slide at a time, with a camera bubble you place yourself.
// Everything runs in the browser. Slides, scripts and recordings are stored in this browser (IndexedDB) only.
import { db } from "./db.js";
import { importPdf, importImages, parsePptxNotes, makeSampleDeck } from "./importers.js";
import { joinParts } from "./exporter.js";

const $ = id => document.getElementById(id);
const W = 1920, H = 1080;
const stage = $("stage"), ctx = stage.getContext("2d"), clip = $("clip"), camEl = $("cam");
const fmt = s => { s = Math.max(0, s || 0); return Math.floor(s / 60) + ":" + String(Math.floor(s % 60)).padStart(2, "0"); };
const uid = () => crypto.randomUUID();
const DEFAULT_CAM = { x: 1706, y: 866, r: 170 };
// avc3 keeps the stream valid if the encoder changes its parameters mid-recording (avc1 logs errors in Chrome)
const MIMES = ["video/mp4;codecs=avc3.640028,mp4a.40.2", "video/mp4;codecs=avc3,mp4a.40.2", "video/mp4;codecs=avc1.640028,mp4a.40.2", "video/mp4;codecs=avc1,mp4a.40.2", "video/mp4", "video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"];
const extOf = m => (m || "").startsWith("video/mp4") ? "mp4" : "webm";
const estimate = t => Math.max(10, Math.round((t.trim().split(/\s+/).filter(Boolean).length / 2.3) / 5) * 5);
const slug = s => (s || "presentation").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "presentation";

let project = { name: "My presentation", segs: [] };
const imgCache = new Map();   // seg id -> HTMLImageElement
const clipURL = new Map();    // seg id -> blob URL
const parts = new Map();      // seg id -> { secs, mime }
let cur = 0, mode = "idle", single = false, camStream = null, mixed = null, analyser = null, rec = null, segT0 = 0, drag = null;
const pending = new Set();

// ---------------------------------------------------------------- persistence
let saveT; const saveProject = () => { clearTimeout(saveT); saveT = setTimeout(() => db.set("project", project), 250); };
const seg = () => project.segs[cur];

async function prepare(s, blob) {
  if (s.kind === "slide") {
    const url = URL.createObjectURL(blob); const im = new Image(); im.src = url; await im.decode().catch(() => {}); imgCache.set(s.id, im);
  } else clipURL.set(s.id, URL.createObjectURL(blob));
}
async function dropSeg(s) {
  await db.del("media:" + s.id); await db.del("part:" + s.id);
  const u = clipURL.get(s.id); if (u) URL.revokeObjectURL(u);
  imgCache.delete(s.id); clipURL.delete(s.id); parts.delete(s.id);
}
async function addItems(items, kind = "slide") {
  for (const it of items) {
    const text = it.text || "";
    const s = { id: uid(), kind, label: it.label, text, target: it.target || estimate(text), manualTarget: !!it.target, cam: { ...DEFAULT_CAM } };
    await db.set("media:" + s.id, it.blob); await prepare(s, it.blob); project.segs.push(s);
  }
  saveProject();
}
async function resetProject(name = "My presentation") {
  for (const s of project.segs) await dropSeg(s);
  project = { name, segs: [] }; cur = 0; saveProject();
}

async function boot() {
  if (location.protocol === "file:") banner("Open SlideCast from a web address (run `npm run dev`, or use the deployed site). Browsers block camera and modules on file:// pages.");
  const p = await db.get("project").catch(() => null);
  if (p && Array.isArray(p.segs)) {
    project = p;
    for (const s of project.segs) {
      const blob = await db.get("media:" + s.id); if (blob) await prepare(s, blob);
      const part = await db.get("part:" + s.id); if (part) parts.set(s.id, { secs: part.secs, mime: part.mime });
    }
  }
  $("projName").value = project.name; go(0); draw();
}

// ---------------------------------------------------------------- UI helpers
function banner(msg) { const b = $("banner"); b.textContent = msg; b.hidden = !msg; }
// Builds the status line from text nodes only (never HTML), so file names and project data can't inject markup.
function status(...bits) {
  const el = $("status"); el.textContent = "";
  for (const x of bits) { if (typeof x === "string") el.append(document.createTextNode(x)); else { const b = document.createElement("b"); b.textContent = x.b; el.append(b); } }
}
function setRecUi(on) {
  for (const id of ["slidesBtn", "notesBtn", "clipBtn", "openBtn", "saveProjBtn", "newBtn", "projName", "prevBtn"]) $(id).disabled = on;
  $("script").readOnly = on; $("tgt").disabled = on;
}

function renderList() {
  const list = $("list"); list.textContent = "";
  const has = project.segs.length > 0, locked = mode === "rec";
  $("empty").hidden = has;
  $("rerecordBtn").disabled = locked || !camStream || !has;
  $("rerecordBtn").textContent = has && seg().kind === "clip" ? "⟲ Re-record current clip" : "⟲ Re-record current slide";
  $("startBtn").disabled = locked || !camStream || !has;
  $("stopBtn").disabled = !locked;
  $("exportBtn").disabled = locked || !has || !project.segs.every(s => parts.has(s.id));
  project.segs.forEach((s, i) => {
    const row = document.createElement("div"); row.className = "seg" + (i === cur ? " on" : ""); row.setAttribute("role", "listitem"); row.tabIndex = 0;
    const n = document.createElement("span"); n.className = "n"; n.textContent = i + 1;
    const mid = document.createElement("span"); const b = document.createElement("b"); b.textContent = s.label; mid.append(b, document.createElement("br"));
    const st = document.createElement("span"); const part = parts.get(s.id); st.className = "st" + (part ? " done" : "");
    st.textContent = (part ? "✓ recorded " + fmt(part.secs) : "not recorded") + " · suggested " + fmt(s.target); mid.append(st);
    const acts = document.createElement("span"); acts.className = "acts";
    const mk = (txt, title, fn, cls = "") => { const x = document.createElement("button"); x.textContent = txt; x.title = title; x.className = cls; x.disabled = locked && txt !== ""; x.onclick = e => { e.stopPropagation(); fn(); }; acts.append(x); return x; };
    mk(part ? "⟲" : "●", part ? "Re-record this part" : "Record this part", () => recordFrom(i, true)).disabled = locked || !camStream;
    mk("↑", "Move up", () => move(i, -1), "mini").disabled = locked || i === 0;
    mk("↓", "Move down", () => move(i, 1), "mini").disabled = locked || i === project.segs.length - 1;
    mk("✕", "Remove", () => remove(i), "mini").disabled = locked;
    row.append(n, mid, acts);
    row.onclick = () => { if (mode !== "rec") go(i); };
    row.onkeydown = e => { if ((e.key === "Enter" || e.key === " ") && e.target === row && mode !== "rec") { e.preventDefault(); go(i); } };
    list.append(row);
  });
}
function go(i) {
  cur = Math.max(0, Math.min(project.segs.length - 1, i));
  const s = seg(), has = !!s;
  $("nowLab").textContent = has ? `${s.label}  ·  ${cur + 1} of ${project.segs.length}` : "No slides yet";
  $("script").value = has ? s.text : ""; $("script").disabled = !has; $("tgt").value = has ? s.target : ""; $("tgt").disabled = !has || mode === "rec";
  const n = project.segs[cur + 1]; $("next").textContent = n ? `Next – ${n.label}: ${n.text}` : has ? "Last part." : "";
  if (has) $("size").value = s.cam.r;
  if (has && s.kind === "clip") { if (clip.dataset.id !== s.id) { clip.src = clipURL.get(s.id) || ""; clip.dataset.id = s.id; } if (mode !== "rec") { clip.pause(); clip.currentTime = 0; } } else if (mode !== "rec") clip.pause();
  $("nextBtn").disabled = !has || (mode === "rec" && s.kind === "clip");
  $("prevBtn").disabled = !has || mode === "rec";
  renderList();
}
async function move(i, d) { const j = i + d; if (j < 0 || j >= project.segs.length) return; [project.segs[i], project.segs[j]] = [project.segs[j], project.segs[i]]; cur = j; saveProject(); go(cur); }
async function remove(i) {
  const s = project.segs[i]; if (!confirm(`Remove "${s.label}" and its recording?`)) return;
  await dropSeg(s); project.segs.splice(i, 1); saveProject(); go(Math.min(cur, project.segs.length - 1));
}

// ---------------------------------------------------------------- script edits
$("script").addEventListener("input", () => { const s = seg(); if (!s || mode === "rec") return; s.text = $("script").value; if (!s.manualTarget) { s.target = estimate(s.text); $("tgt").value = s.target; } saveProject(); });
$("tgt").addEventListener("change", () => { const s = seg(); if (!s) return; const v = Math.max(1, Math.min(3600, Math.round(+$("tgt").value || s.target))); s.target = v; s.manualTarget = true; $("tgt").value = v; saveProject(); renderList(); });
$("fs").addEventListener("input", () => { $("script").style.fontSize = $("fs").value + "px"; localStorage.setItem("slidecast_fs", $("fs").value); });
{ const f = localStorage.getItem("slidecast_fs"); if (f) { $("fs").value = f; $("script").style.fontSize = f + "px"; } }
$("projName").addEventListener("input", () => { project.name = $("projName").value.slice(0, 80) || "My presentation"; saveProject(); });

// ---------------------------------------------------------------- importing
const pick = id => $(id).click();
$("slidesBtn").onclick = $("emptyImport").onclick = () => pick("slidesIn");
$("notesBtn").onclick = () => pick("notesIn");
$("clipBtn").onclick = () => pick("clipIn");
$("openBtn").onclick = () => pick("projIn");
$("emptySample").onclick = async () => { await addItems(await makeSampleDeck()); project.name = "Sample deck"; $("projName").value = project.name; go(0); };

async function confirmReplace() {
  if (!project.segs.length) return true;
  if (confirm("Replace your current slides? Their recordings will be removed.\n\nPress Cancel to add the new slides after the current ones instead.")) { await resetProject(project.name); return true; }
  return true;
}
$("slidesIn").addEventListener("change", async e => {
  const files = [...e.target.files]; e.target.value = ""; if (!files.length) return;
  try {
    status("Importing slides…");
    const pdf = files.find(f => f.type === "application/pdf" || /\.pdf$/i.test(f.name));
    const items = pdf ? await importPdf(pdf, (i, n) => status(`Importing slide ${i} of ${n}…`)) : importImages(files);
    if (!items.length) { status("No slides found in those files."); return; }
    await confirmReplace(); const first = project.segs.length; await addItems(items);
    if (first === 0 && /^My presentation$/.test(project.name)) { project.name = (pdf || files[0]).name.replace(/\.[^.]+$/, ""); $("projName").value = project.name; }
    go(first); status(`Imported ${items.length} slides. Add a script for each one, or import speaker notes from a .pptx.`);
  } catch (err) { status("Could not import: " + err.message); }
});
$("notesIn").addEventListener("change", async e => {
  const f = e.target.files[0]; e.target.value = ""; if (!f) return;
  try {
    const notes = await parsePptxNotes(f); const slides = project.segs.filter(s => s.kind === "slide");
    if (!slides.length) { status("Import your slides first (as a PDF), then import the notes."); return; }
    let n = 0; slides.forEach((s, i) => { if (notes[i]) { s.text = notes[i]; if (!s.manualTarget) s.target = estimate(s.text); n++; } });
    saveProject(); go(cur);
    status(`Filled the script for ${n} slides from the speaker notes.` + (notes.length !== slides.length ? ` The file has ${notes.length} slides but you have ${slides.length}, so check the order.` : ""));
  } catch (err) { status("Could not read notes: " + err.message); }
});
$("clipIn").addEventListener("change", async e => {
  const f = e.target.files[0]; e.target.value = ""; if (!f) return;
  const url = URL.createObjectURL(f), v = document.createElement("video"); v.preload = "metadata"; v.src = url;
  try { await new Promise((res, rej) => { v.onloadedmetadata = res; v.onerror = () => rej(new Error("This video cannot be played in your browser.")); }); }
  catch (err) { URL.revokeObjectURL(url); status(err.message); return; }
  URL.revokeObjectURL(url);
  await addItems([{ blob: f, label: "Clip: " + f.name.replace(/\.[^.]+$/, "").slice(0, 30), target: Math.max(1, Math.round(v.duration)) }], "clip");
  go(project.segs.length - 1); status("Video clip added. It plays by itself while you talk over it.");
});

// project files
const toDataURL = b => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(b); });
$("saveProjBtn").onclick = async () => {
  status("Saving project file…");
  const segs = []; for (const s of project.segs) segs.push({ ...s, data: await toDataURL(await db.get("media:" + s.id)) });
  const blob = new Blob([JSON.stringify({ format: "slidecast", version: 1, name: project.name, segs })], { type: "application/json" });
  download(blob, slug(project.name) + ".slidecast.json"); status("Project saved. It contains your slides and scripts (not your recordings).");
};
$("projIn").addEventListener("change", async e => {
  const f = e.target.files[0]; e.target.value = ""; if (!f) return;
  try {
    if (f.size > 400 * 1024 * 1024) throw new Error("File is too large.");
    const j = JSON.parse(await f.text());
    if (j.format !== "slidecast" || !Array.isArray(j.segs) || j.segs.length > 200) throw new Error("This is not a SlideCast project file.");
    if (project.segs.length && !confirm("Open this project and replace the current one? Recordings of the current project will be removed.")) return;
    await resetProject(String(j.name || "My presentation").slice(0, 80));
    const num = (v, lo, hi, d) => Number.isFinite(+v) ? Math.max(lo, Math.min(hi, +v)) : d;
    for (const x of j.segs) {
      const kind = x.kind === "clip" ? "clip" : "slide";
      if (typeof x.data !== "string" || !x.data.startsWith(kind === "clip" ? "data:video/" : "data:image/")) continue;
      const blob = await (await fetch(x.data)).blob();
      const cam = x.cam || {}; const r = num(cam.r, 80, 420, 170);
      await addItems([{ blob, label: String(x.label || "Slide").slice(0, 60), text: String(x.text || "").slice(0, 5000), target: x.manualTarget ? num(x.target, 1, 3600, 20) : 0 }], kind);
      const s = project.segs[project.segs.length - 1]; s.target = num(x.target, 1, 3600, s.target); s.cam = { x: num(cam.x, r, W - r, DEFAULT_CAM.x), y: num(cam.y, r, H - r, DEFAULT_CAM.y), r };
    }
    $("projName").value = project.name; saveProject(); go(0); status(`Opened "${project.name}" with ${project.segs.length} parts.`);
  } catch (err) { status("Could not open project: " + err.message); }
});
$("newBtn").onclick = async () => { if (!project.segs.length || confirm("Start a new presentation? The current slides and recordings will be removed from this browser.")) { await resetProject(); $("projName").value = project.name; go(0); status("Import slides to begin."); } };

// ---------------------------------------------------------------- camera bubble
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
  const fill = (sel, kind, cur) => { sel.textContent = ""; devs.filter(d => d.kind === kind).forEach(d => { const o = document.createElement("option"); o.value = d.deviceId; o.textContent = d.label || kind; if (cur?.getSettings().deviceId === d.deviceId) o.selected = true; sel.append(o); }); sel.disabled = false; };
  fill($("camSel"), "videoinput", camStream.getVideoTracks()[0]); fill($("micSel"), "audioinput", camStream.getAudioTracks()[0]);
}
$("camBtn").onclick = async () => {
  try { await openMedia(); $("camBtn").classList.add("ok"); $("camBtn").textContent = "① Camera & mic on"; renderList(); status("Camera ready. Press ", { b: "② Record from slide 1" }, "."); }
  catch (err) { alert("Camera or microphone is blocked: " + err.message + "\nAllow access in the browser's address bar and try again."); }
};
$("camSel").onchange = $("micSel").onchange = () => openMedia().catch(err => status("Could not switch device: " + err.message));

// ---------------------------------------------------------------- recording (one part per slide; Next ends the part)
const mime = typeof MediaRecorder !== "undefined" ? (MIMES.find(m => MediaRecorder.isTypeSupported(m)) || "") : "";
const countdown = async () => { for (let n = 3; n > 0; n--) { $("count").textContent = n; $("count").style.display = "grid"; await new Promise(r => setTimeout(r, 1000)); } $("count").style.display = "none"; };

async function recordFrom(i, only) {
  if (!camStream || mode === "rec" || !project.segs.length) return;
  single = only; mode = "rec"; setRecUi(true); go(i); await countdown(); startPart();
}
function startPart() {
  const i = cur, s = seg(), chunks = [];
  if (s.kind === "clip") { clip.pause(); clip.currentTime = 0; }
  const r = new MediaRecorder(mixed, { mimeType: mime || undefined, videoBitsPerSecond: 8e6 });
  r.ondataavailable = e => e.data.size && chunks.push(e.data);
  r.onstop = () => savePart(s, new Blob(chunks, { type: r.mimeType || mime || "video/webm" }), (performance.now() - r._t0) / 1000, r.mimeType || mime);
  r._t0 = performance.now(); segT0 = r._t0; r.start(500); rec = r;
  $("recdot").style.display = "flex";
  status("Recording ", { b: s.label }, ". ", ...(s.kind === "clip" ? ["The clip plays by itself; talk over it."] : ["Press ", { b: "Next ▶" }, " (or →) when you finish this slide."]));
  if (s.kind === "clip") { clip.onended = () => { if (mode === "rec" && cur === i) next(); }; clip.play(); }
  go(i);
}
function stopPart() { if (rec && rec.state !== "inactive") rec.stop(); rec = null; clip.pause(); }
function next() {
  if (mode !== "rec") { go(cur + 1); return; }
  stopPart();
  if (!single && cur < project.segs.length - 1) { cur++; go(cur); setTimeout(startPart, 250); return; }
  endSession();
}
function endSession() {
  mode = "idle"; setRecUi(false); $("recdot").style.display = "none"; go(cur);
  status("Stopped. Re-record any part from the list, or press ", { b: "③ Export video" }, " when every part has a ✓.");
}
$("startBtn").onclick = () => recordFrom(0, false);
$("rerecordBtn").onclick = () => recordFrom(cur, true);
$("stopBtn").onclick = () => { if (mode === "rec") { stopPart(); endSession(); } };
$("nextBtn").onclick = () => { if (mode === "rec" && seg().kind === "clip") return; next(); };
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
  Object.assign(ov.title, { textContent: "Exporting your video" }); ov.st.textContent = "Starting…"; ov.bar.hidden = false; ov.bar.removeAttribute("value"); ov.vid.hidden = true; ov.dl.hidden = true; ov.parts.hidden = true; ov.parts.textContent = ""; ov.box.hidden = false;
  const list = []; for (const s of project.segs) { const p = await db.get("part:" + s.id); if (p) list.push({ ...p, label: s.label }); }
  try {
    const exts = new Set(list.map(p => extOf(p.mime)));
    if (exts.size !== 1) throw new Error("Parts were recorded in different formats. Re-record the parts so they match.");
    const ext = [...exts][0];
    const out = await joinParts(list, { ext, onStatus: t => { ov.st.textContent = t; }, onProgress: p => { ov.bar.max = 1; ov.bar.value = p; } });
    const name = slug(project.name) + "." + ext;
    ov.title.textContent = "Your video is ready"; ov.st.textContent = `${name} · ${(out.size / 1048576).toFixed(1)} MB`; ov.bar.hidden = true;
    ov.vid.src = URL.createObjectURL(out); ov.vid.hidden = false; ov.dl.href = ov.vid.src; ov.dl.download = name; ov.dl.hidden = false;
  } catch (err) {
    ov.title.textContent = "Could not join the parts"; ov.st.textContent = err.message + " You can still download each part and join them in any video editor."; ov.bar.hidden = true;
    ov.parts.hidden = false;
    list.forEach((p, i) => { const b = document.createElement("button"); b.className = "btn"; b.textContent = `Download part ${i + 1}: ${p.label}`; b.onclick = () => download(p.blob, `${slug(project.name)}-${String(i + 1).padStart(2, "0")}.${extOf(p.mime)}`); ov.parts.append(b); });
  }
};

// ---------------------------------------------------------------- drawing
function fit(src, sw, sh) { const k = Math.min(W / sw, H / sh), w = sw * k, h = sh * k; ctx.drawImage(src, (W - w) / 2, (H - h) / 2, w, h); }
function draw() {
  const s = seg(); ctx.fillStyle = "#111"; ctx.fillRect(0, 0, W, H);
  if (s) {
    if (s.kind === "slide") { const im = imgCache.get(s.id); if (im?.complete && im.naturalWidth) fit(im, im.naturalWidth, im.naturalHeight); }
    else if (clip.readyState >= 2) fit(clip, clip.videoWidth, clip.videoHeight);
    if ($("bubble").checked && camStream && camEl.readyState >= 2) {
      const b = s.cam, vw = camEl.videoWidth, vh = camEl.videoHeight, m = Math.min(vw, vh);
      ctx.save(); ctx.beginPath(); ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2); ctx.clip();
      if ($("mirror").checked) { ctx.translate(b.x * 2, 0); ctx.scale(-1, 1); }
      ctx.drawImage(camEl, (vw - m) / 2, (vh - m) / 2, m, m, b.x - b.r, b.y - b.r, b.r * 2, b.r * 2); ctx.restore();
      ctx.lineWidth = 8; ctx.strokeStyle = "#fff"; ctx.beginPath(); ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2); ctx.stroke();
    }
    const el = s.kind === "clip" ? clip.currentTime : mode === "rec" ? (performance.now() - segT0) / 1000 : 0;
    $("cur").textContent = fmt(el); $("cur").className = el > s.target + 3 ? "over" : "";
  } else $("cur").textContent = "0:00";
  if (analyser) { const a = new Uint8Array(analyser.fftSize); analyser.getByteTimeDomainData(a); let pk = 0; for (const v of a) pk = Math.max(pk, Math.abs(v - 128)); $("lvl").style.width = Math.min(100, pk / 1.2) + "%"; }
  requestAnimationFrame(draw);
}

if (typeof MediaRecorder === "undefined" || !navigator.mediaDevices) banner("This browser cannot record video. Use a current version of Chrome, Edge or Firefox.");
boot();
