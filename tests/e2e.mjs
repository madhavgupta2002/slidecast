// End-to-end check in real Chrome with a fake camera and microphone:
// import -> notes -> place camera -> record each slide -> re-record one -> reload -> export (checked with ffprobe).
import { chromium } from "playwright-core";
import { start } from "../scripts/dev.mjs";
import { execFileSync } from "node:child_process";
import { mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "test-output"); mkdirSync(out, { recursive: true });
const CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 5199, URL_ = `http://127.0.0.1:${PORT}/`;
const SAMPLE_PDF = process.env.SAMPLE_PDF, SAMPLE_PPTX = process.env.SAMPLE_PPTX;
let failed = 0;
const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) failed++; };

const server = await start(PORT);
const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"] });
const ctx = await browser.newContext({ permissions: ["camera", "microphone"], acceptDownloads: true, viewport: { width: 1500, height: 1000 } });
const page = await ctx.newPage();
const problems = [];
page.on("console", m => { if (["error", "warning"].includes(m.type())) problems.push(m.type() + ": " + m.text().slice(0, 160) + " @ " + (m.location().url || "")); });
page.on("pageerror", e => problems.push("pageerror: " + e.message));
page.on("response", r => { if (r.status() >= 400) problems.push("HTTP " + r.status() + " " + r.url()); });
page.on("dialog", d => d.accept());
const rows = () => page.locator("#list .seg");
const recorded = () => page.locator("#list .seg .st.done").count();
const wait = ms => page.waitForTimeout(ms);
const rowCount = n => page.waitForFunction(c => document.querySelectorAll("#list .seg").length === c, n, { timeout: 120000 });
const stored = async () => { await wait(500); return stored0(); };
const stored0 = () => page.evaluate(() => new Promise(r => { const q = indexedDB.open("slidecast"); q.onsuccess = () => { const g = q.result.transaction("kv").objectStore("kv").get("project"); g.onsuccess = () => r(g.result); }; }));

await page.goto(URL_);
ok(await page.locator("#empty").isVisible(), "empty state offers Import slides");
const buttons = (await page.locator("button:visible").allInnerTexts()).join(" | ");
ok(!/Open project|Save project|New|Add video clip|Import notes/i.test(buttons), "no project/clip/notes buttons");

// four generated slide images
const pngs = [];
for (let i = 1; i <= 4; i++) {
  const b64 = await page.evaluate(i => { const c = document.createElement("canvas"); c.width = 1920; c.height = 1080; const x = c.getContext("2d"); x.fillStyle = `hsl(${i * 70},60%,85%)`; x.fillRect(0, 0, 1920, 1080); x.fillStyle = "#222"; x.font = "200px sans-serif"; x.fillText("Slide " + i, 200, 600); return c.toDataURL("image/png").split(",")[1]; }, i);
  pngs.push({ name: `slide${i}.png`, mimeType: "image/png", buffer: Buffer.from(b64, "base64") });
}
await page.setInputFiles("#slidesIn", pngs); await rowCount(4);
ok(await rows().count() === 4, "four images import as four slides");

await page.click("#camBtn"); await page.waitForFunction(() => document.getElementById("camBtn").textContent.includes("Camera & mic on"));
ok(await page.locator("#camSel option").count() > 0, "camera list is filled");
await page.click('[data-corner="tl"]');
const cam = (await stored()).segs[0].cam; ok(cam.x < 400 && cam.y < 400, "corner button places the camera top-left");
await page.click("#allPos"); ok((await stored()).segs.every(s => s.cam.x === cam.x && s.cam.y === cam.y), "'Same for all slides' copies the camera position");

await page.click("#startBtn");
for (let i = 0; i < 4; i++) { await wait(i === 0 ? 4700 : 1500); await page.click("#nextBtn"); }
await page.waitForFunction(() => document.querySelectorAll("#list .seg .st.done").length === 4, null, { timeout: 15000 });
ok(await recorded() === 4, "all 4 slides recorded with Next");
ok(await page.locator("#exportBtn").isEnabled(), "export enabled once every slide has a recording");

const before = await rows().nth(1).locator(".st").innerText();
await rows().nth(1).click(); await page.click("#rerecordBtn");
await wait(4700); ok(await page.locator("#recdot").isVisible(), "re-record starts on the selected slide only");
await wait(2200); await page.click("#nextBtn");
await page.waitForFunction(() => document.getElementById("saved").textContent.includes("Slide 2 saved"));
const after = await rows().nth(1).locator(".st").innerText();
ok(await recorded() === 4 && before !== after, `re-record replaced slide 2 only (${before} -> ${after})`);

await page.reload(); await rowCount(4);
ok(await recorded() === 4, "slides and recordings survive a reload");

await page.click("#exportBtn");
await page.waitForSelector("#ovDownload:not([hidden])", { timeout: 180000 });
const partSecs = await page.evaluate(async () => { const db = await new Promise(r => { const q = indexedDB.open("slidecast"); q.onsuccess = () => r(q.result); }); const get = k => new Promise(r => { const g = db.transaction("kv").objectStore("kv").get(k); g.onsuccess = () => r(g.result); }); const proj = await get("project"); const o = []; for (const s of proj.segs) o.push((await get("part:" + s.id)).secs); return o; });
const sum = partSecs.reduce((a, b) => a + b, 0);
const [dl] = await Promise.all([page.waitForEvent("download"), page.click("#ovDownload")]);
const file = join(out, dl.suggestedFilename()); await dl.saveAs(file);
const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=codec_type,width,duration", "-of", "json", file]));
const v = probe.streams.find(s => s.codec_type === "video"), a = probe.streams.find(s => s.codec_type === "audio");
ok(dl.suggestedFilename() === "slide1.mp4" || dl.suggestedFilename().endsWith(".mp4"), `exported ${dl.suggestedFilename()}`);
ok(Math.abs(Number(probe.format.duration) - sum) < 1.5, `exported ${Number(probe.format.duration).toFixed(1)}s matches the parts (${sum.toFixed(1)}s)`);
ok(!!v && !!a, "export has audio and video");
ok(Math.abs(Number(a.duration) - Number(v.duration)) < 0.4, `audio (${a.duration}s) and video (${v.duration}s) stay in step`);
ok(v.width === 1920, "export is 1920 wide");
await page.click("#ovClose");

if (SAMPLE_PDF && SAMPLE_PPTX && existsSync(SAMPLE_PDF) && existsSync(SAMPLE_PPTX)) {
  // PDF + PowerPoint chosen together -> real slides with speaker notes
  await page.setInputFiles("#slidesIn", [SAMPLE_PDF, SAMPLE_PPTX]);
  await page.waitForFunction(() => document.querySelectorAll("#list .seg").length === 8 && document.getElementById("script").value.length > 5, null, { timeout: 120000 });
  const withNotes = (await stored()).segs.filter(s => s.text.length > 10).length;
  ok(withNotes >= 6, `PDF + PowerPoint together: 8 slides, ${withNotes} with speaker notes`);
  await rows().nth(1).click(); ok((await page.inputValue("#script")).length > 20, "notes are visible beside the selected slide");
  await page.screenshot({ path: join(out, "pdf-pptx.png") });
  // PowerPoint alone on top of loaded slides -> only notes change
  await page.setInputFiles("#slidesIn", [SAMPLE_PPTX]); await wait(2000);
  ok(await rows().count() === 8, "PowerPoint alone keeps the loaded slides and refreshes the notes");
  // PowerPoint alone from scratch -> text slides + notes
  await page.evaluate(() => indexedDB.deleteDatabase("slidecast")); await page.reload(); await page.waitForSelector("#empty:not([hidden])");
  await page.setInputFiles("#slidesIn", [SAMPLE_PPTX]); await rowCount(8);
  ok((await stored()).segs.filter(s => s.text.length > 10).length >= 6, "PowerPoint alone: 8 text slides with notes");
  ok(/PDF/.test(await page.locator("#status").innerText()), "tells the user to add the PDF for exact slides");
}
ok(problems.length === 0, "no console errors or CSP violations" + (problems.length ? ": " + problems.slice(0, 3).join(" | ") : ""));
await browser.close(); server.close();
console.log(failed ? `\n${failed} check(s) failed` : "\nAll checks passed"); process.exit(failed ? 1 : 0);
