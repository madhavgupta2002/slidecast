// Joins the recorded parts into one video. Uses ffmpeg compiled to WebAssembly (runs in your browser).
// Parts are joined without re-encoding, so it is fast and loses no quality.
import { FFmpeg } from "../vendor/ffmpeg/index.js";

export async function joinParts(parts, { ext, onStatus, onProgress }) {
  const ff = new FFmpeg();
  ff.on("progress", ({ progress }) => onProgress?.(Math.max(0, Math.min(1, progress))));
  onStatus?.("Loading the video engine (about 31 MB, cached after the first time)…");
  await ff.load({
    coreURL: new URL("../vendor/ffmpeg-core/ffmpeg-core.js", import.meta.url).href,
    wasmURL: new URL("../vendor/ffmpeg-core/ffmpeg-core.wasm", import.meta.url).href,
  });
  try {
    // MP4 parts from MediaRecorder carry timestamps that make a direct join drift (audio ends up much shorter
    // than video). Re-wrapping each part as Matroska first, then joining, keeps audio and video in step.
    const names = [];
    for (const [i, p] of parts.entries()) {
      onStatus?.(`Preparing part ${i + 1} of ${parts.length}…`); onProgress?.(i / (parts.length + 1));
      const src = `p${i}.${ext}`, mid = `m${String(i).padStart(2, "0")}.mkv`;
      await ff.writeFile(src, new Uint8Array(await p.blob.arrayBuffer()));
      const c = await ff.exec(["-i", src, "-c", "copy", mid]);
      if (c !== 0) throw new Error(`Could not read part ${i + 1} (ffmpeg code ${c})`);
      await ff.deleteFile(src); names.push(mid);
    }
    await ff.writeFile("list.txt", names.map(n => `file '${n}'`).join("\n"));
    onStatus?.("Joining parts into one video…");
    const out = `out.${ext}`;
    const code = await ff.exec(["-f", "concat", "-safe", "0", "-i", "list.txt", "-c", "copy", ...(ext === "mp4" ? ["-movflags", "+faststart"] : []), out]);
    if (code !== 0) throw new Error("ffmpeg exited with code " + code);
    const data = await ff.readFile(out);
    return new Blob([data.buffer], { type: ext === "mp4" ? "video/mp4" : "video/webm" });
  } finally { ff.terminate(); }
}
