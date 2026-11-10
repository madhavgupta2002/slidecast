# SlideCast

Record a presentation **one slide at a time**, with a camera bubble you place yourself. Press **Next** when you finish a slide, **re-record** any slide you stumble on, then export **one video**.

Everything runs in your browser. Slides, notes and recordings are stored on your computer only (IndexedDB) and are never uploaded.

## Using it

1. **Import slides.** Choose a **PDF** of your slides (PowerPoint: File › Export › PDF; Keynote and Google Slides can export PDF too), a set of **images**, or a **PowerPoint (.pptx)** file.
   - Choose the **PDF and the PowerPoint together** to get your real slides *and* your speaker notes.
   - A PowerPoint on its own gives you the speaker notes with plain text slides (a browser cannot draw PowerPoint design), so add the PDF too if you want your slides to look right. If you import the PDF first, you can add the PowerPoint afterwards; the notes are matched to the slides by order.
2. **Read your notes.** The speaker notes for the current slide are shown beside it, large enough to read while you talk. You can edit them.
3. **Place your camera.** Press **① Turn on camera & mic**. Drag the camera circle on the slide, scroll over it (or use **Camera size**) to resize it, or use the corner buttons. **Same for all slides** copies the position to every slide; otherwise each slide keeps its own.
4. **Record.** Press **② Record from slide 1**. After a 3-second countdown the slide records until you press **Next** (or the → key), then the next slide starts. Press **Stop** (or Esc) to pause the session.
5. **Fix mistakes.** Every slide is listed on the right with a ✓ once recorded. Select a slide and press **⟲ Re-record this slide**, or use the button in its row. Only that slide is replaced.
6. **③ Export video** joins all slides into one file (MP4 in Chrome and Edge, WebM in Firefox) and offers a download. The join does not re-encode, so it is fast and loses no quality.

Your slides, notes and recordings are kept in this browser, so a reload loses nothing. Importing a new deck replaces the old one.

## Run it on your computer

Needs Node 18 or newer. No install step is needed to run it:

```bash
npm run dev
```

Open **http://127.0.0.1:5173**. The server listens on `127.0.0.1` only (your computer, not your network) and sends the same security headers as the deployed site.

Do not open `index.html` by double-clicking it: browsers block ES modules and camera access on `file://` pages.

## Deploy to GitHub and Vercel

The site is plain static files (the libraries are already in `vendor/`), so there is no build step.

### 1. Put it on GitHub

1. Sign in at https://github.com and choose **New repository**. Name it `slidecast`. Leave "Add a README" and ".gitignore" **unticked** (this folder already has them). Choose **Public** or **Private**, then **Create repository**.
2. In Terminal, from this folder:

```bash
cd ~/Desktop/SlideCast
git init -b main
git add -A
git commit -m "SlideCast: first version"
git remote add origin https://github.com/YOUR-USERNAME/slidecast.git
git push -u origin main
```

(Use your GitHub username. If Git asks for a password, use a personal access token from GitHub › Settings › Developer settings, or sign in with the GitHub CLI: `brew install gh && gh auth login`.)

`node_modules/` and `test-output/` are in `.gitignore`, so they are not uploaded. The largest file is `vendor/ffmpeg-core/ffmpeg-core.wasm` (31 MB), well under GitHub's 100 MB limit.

### 2. Deploy on Vercel

1. Sign in at https://vercel.com with your GitHub account.
2. **Add New… › Project**, then **Import** your `slidecast` repository.
3. Settings (leave everything else as it is):
   - **Framework Preset:** Other
   - **Build Command:** leave empty
   - **Output Directory:** leave empty (the project root is served)
   - **Install Command:** leave empty
4. Press **Deploy**. In about a minute you get a URL like `https://slidecast-xxxx.vercel.app`.

Every later `git push` to `main` redeploys automatically.

Command-line alternative: `npm i -g vercel`, then `vercel` in this folder (answer the prompts, keep the defaults), and `vercel --prod` to publish.

### 3. Check the deployed site

- Open the URL, import a PDF, press **① Turn on camera & mic** and allow access. (Cameras only work on `https://` or `localhost`; Vercel provides https.)
- Record two slides and press **③ Export video**. The first export downloads the 31 MB video engine, then it is cached.
- Optional: add a custom domain under the project's **Settings › Domains**.

## Privacy and security

- No server code, no analytics, no accounts, no uploads. Camera and microphone data stay in your browser.
- `vercel.json` sets a strict Content Security Policy (only this site's own scripts, no third parties), allows the camera and microphone for this site only, and blocks embedding in other sites.
- Text from your files (file names, speaker notes) is always shown as plain text, never as HTML.
- Recordings live in this browser's storage. Clearing site data or using a private window removes them, so export your video before you clear anything.

## Browser support

Tested in Chrome 157. Edge and other Chromium browsers should behave the same. Firefox records WebM and should work but is untested. Safari is untested; recent versions can record, but camera and format support varies.

## Tests

```bash
npm install     # one time: installs the test tools
npm test        # needs Google Chrome; set CHROME=/path/to/chrome if it is elsewhere
```

The test drives real Chrome with a fake camera and microphone: it imports images, places the camera, records every slide, re-records one, reloads, exports and checks the file with `ffprobe` (duration, audio and video in step). To also test PDF and PowerPoint import, set `SAMPLE_PDF=/path/deck.pdf SAMPLE_PPTX=/path/deck.pptx`.

## Updating the bundled libraries

`npm install` then `npm run vendor` copies pdf.js, JSZip and ffmpeg.wasm from `node_modules` into `vendor/`. Commit the result.

## Licence

None added yet. Choose one (for example MIT) before making the repository public. The bundled libraries keep their own licences: pdf.js (Apache-2.0), JSZip (MIT or GPL-3.0), @ffmpeg/ffmpeg (MIT), and the FFmpeg core it loads, `@ffmpeg/core` (GPL-2.0-or-later). The core is a separate file in `vendor/ffmpeg-core/` that is served unmodified. If you redistribute this project, keep its licence terms in mind and read the GPL notes at https://github.com/ffmpegwasm/ffmpeg.wasm.
