// End-to-end check in real Chrome with a fake camera and microphone:
// import -> record each slide -> re-record one -> persistence -> export -> project save/open -> hostile project file.
import { chromium } from "playwright-core";
import { start } from "../scripts/dev.mjs";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
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
let expectBlocked = false;
page.on("console", m => { if (["error", "warning"].includes(m.type()) && !expectBlocked) problems.push(m.type() + ": " + m.text().slice(0, 160) + " @ " + (m.location().url || "")); });
page.on("response", r => { if (r.status() >= 400) problems.push("HTTP " + r.status() + " " + r.url()); });
page.on("pageerror", e => problems.push("pageerror: " + e.message));
page.on("dialog", d => d.accept());
const rows = () => page.locator("#list .seg");
const recorded = () => page.locator("#list .seg .st.done").count();
const wait = ms => page.waitForTimeout(ms);

await page.goto(URL_);
ok(await page.locator("#empty").isVisible(), "empty state shows import buttons");
await page.click("#emptySample");
await page.waitForFunction(() => document.querySelectorAll("#list .seg").length === 4);
ok(await rows().count() === 4, "sample deck has 4 slides");
ok((await page.inputValue("#script")).length > 20, "script text is shown for slide 1");

await page.click("#camBtn"); await page.waitForFunction(() => document.getElementById("camBtn").textContent.includes("Camera & mic on"));
ok(await page.locator("#camSel option").count() > 0, "camera list is filled");
await page.click("#startBtn");
for (let i = 0; i < 4; i++) { await wait(i === 0 ? 4700 : 1500); await page.click("#nextBtn"); }
await page.waitForFunction(() => document.querySelectorAll("#list .seg .st.done").length === 4, null, { timeout: 15000 });
ok(await recorded() === 4, "all 4 slides recorded with Next");
ok(await page.locator("#exportBtn").isEnabled(), "export enabled once every slide has a recording");

const before = await rows().nth(1).locator(".st").innerText();
await rows().nth(1).click(); await page.click("#rerecordBtn");
await wait(4700); ok(await page.locator("#recdot").isVisible(), "re-record starts on the selected slide only");
await wait(2200); await page.click("#nextBtn");
await page.waitForFunction(() => getComputedStyle(document.getElementById("recdot")).display === "none");
await page.waitForFunction(() => document.getElementById("saved").textContent.includes("Slide 2 saved"));
const after = await rows().nth(1).locator(".st").innerText();
ok(await recorded() === 4 && before !== after, `re-record replaced slide 2 only (${before.split("·")[0].trim()} -> ${after.split("·")[0].trim()})`);

await page.reload(); await page.waitForSelector("#list .seg");
ok(await rows().count() === 4 && await recorded() === 4, "slides and recordings survive a reload");

await page.click("#exportBtn");
await page.waitForSelector("#ovDownload:not([hidden])", { timeout: 180000 });
const [dl] = await Promise.all([page.waitForEvent("download"), page.click("#ovDownload")]);
const file = join(out, dl.suggestedFilename()); await dl.saveAs(file);
const partSecs = await page.evaluate(async () => { const db = await new Promise(r => { const q = indexedDB.open("slidecast"); q.onsuccess = () => r(q.result); }); const st = db.transaction("kv").objectStore("kv"); const proj = await new Promise(r => { const g = st.get("project"); g.onsuccess = () => r(g.result); }); const out = []; for (const s of proj.segs) out.push(await new Promise(r => { const g = db.transaction("kv").objectStore("kv").get("part:" + s.id); g.onsuccess = () => r(g.result.secs); })); return out; });
const sumSecs = partSecs.reduce((a, b) => a + b, 0);
const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=codec_type,codec_name,width,height,duration", "-of", "json", file]));
console.log("parts (s):", partSecs.map(x => x.toFixed(2)).join(" "), "| streams:", probe.streams.map(x => x.codec_type + " " + x.duration).join(", "), "| container", probe.format.duration);
const dur = Number(probe.format.duration), types = probe.streams.map(s => s.codec_type).sort().join(",");
ok(dl.suggestedFilename() === "sample-deck.mp4", `exported ${dl.suggestedFilename()}`);
ok(Math.abs(dur - sumSecs) < 1.5, `exported duration ${dur.toFixed(1)}s matches the parts (about ${sumSecs}s)`);
ok(types === "audio,video", `export has audio and video (${types})`);
const dv = probe.streams.find(x => x.codec_type === "video").duration, da = probe.streams.find(x => x.codec_type === "audio").duration;
ok(da === undefined || Math.abs(da - dv) < 0.4, `audio (${da}s) and video (${dv}s) stay in step`);
ok(probe.streams.find(s => s.codec_type === "video").width === 1920, "export is 1920 wide");
await page.click("#ovClose");

const [pj] = await Promise.all([page.waitForEvent("download"), page.click("#saveProjBtn")]);
const pjFile = join(out, "project.json"); await pj.saveAs(pjFile);
await page.click("#newBtn"); await page.waitForSelector("#empty", { state: "visible" }); ok(await page.locator("#empty").isVisible(), "New clears the project");
await page.setInputFiles("#projIn", pjFile); await page.waitForFunction(() => document.querySelectorAll("#list .seg").length === 4);
ok(await rows().count() === 4, "project file re-opens with 4 slides");

const evil = { format: "slidecast", version: 1, name: "<img src=x onerror=window.__xss=1>", segs: [{ kind: "slide", label: "<img src=x onerror=window.__xss=1>", text: "<script>window.__xss=1</script>", target: 9e9, cam: { x: -5, y: 1e9, r: 1e9 }, data: "data:image/svg+xml;base64," + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" onload="window.__xss=1"/>').toString("base64") }, { kind: "slide", label: "bad", data: "data:text/html;base64,PHNjcmlwdD4=" }] };
const evilFile = join(out, "evil.json"); writeFileSync(evilFile, JSON.stringify(evil));
expectBlocked = true; await page.click("#newBtn"); await page.setInputFiles("#projIn", evilFile); await wait(1500); expectBlocked = false;
ok(await page.evaluate(() => window.__xss === undefined), "hostile project file runs no script");
ok(await rows().count() === 1, "non-image data is rejected, valid part kept");
const camVals = await page.evaluate(async () => (await new Promise(r => { const q = indexedDB.open("slidecast"); q.onsuccess = () => { const g = q.result.transaction("kv").objectStore("kv").get("project"); g.onsuccess = () => r(g.result); }; })).segs[0]);
ok(camVals.cam.r === 420 && camVals.cam.x >= 420 && camVals.cam.y <= 1080 - 420 && camVals.target === 3600, "camera and time values are clamped to safe ranges");

if (SAMPLE_PDF && existsSync(SAMPLE_PDF)) {
  await page.click("#newBtn"); await page.setInputFiles("#slidesIn", SAMPLE_PDF);
  await page.waitForFunction(() => document.querySelectorAll("#list .seg").length >= 2, null, { timeout: 120000 });
  const n = await rows().count(); ok(n >= 2, `PDF import produced ${n} slides`);
  await page.screenshot({ path: join(out, "pdf-import.png") });
  if (SAMPLE_PPTX && existsSync(SAMPLE_PPTX)) {
    await page.setInputFiles("#notesIn", SAMPLE_PPTX); await wait(2500);
    const filled = await page.evaluate(async () => (await new Promise(r => { const q = indexedDB.open("slidecast"); q.onsuccess = () => { const g = q.result.transaction("kv").objectStore("kv").get("project"); g.onsuccess = () => r(g.result); }; })).segs.filter(s => s.text.length > 10).length);
    ok(filled >= 2, `PPTX speaker notes filled ${filled} scripts`);
  }
}
ok(problems.length === 0, "no console errors or CSP violations" + (problems.length ? ": " + problems.slice(0, 3).join(" | ") : ""));
await browser.close(); server.close();
console.log(failed ? `\n${failed} check(s) failed` : "\nAll checks passed"); process.exit(failed ? 1 : 0);
