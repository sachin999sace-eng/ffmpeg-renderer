import express from "express";
import axios from "axios";
import fs from "fs";
import path from "path";
import os from "os";
import { v4 as uuidv4 } from "uuid";
import { execSync } from "child_process";

const app = express();
app.use(express.json({ limit: "20mb" }));

const FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf";

function safeName(s) {
  return s.replace(/[^\w.-]+/g, "_").slice(0, 80);
}

// Write text to a file so drawtext avoids escaping issues
function writeTextFile(dir, idx, text) {
  const p = path.join(dir, `text_${String(idx).padStart(3, "0")}.txt`);
  fs.writeFileSync(p, text.replace(/\r/g, ""));
  return p;
}

app.get("/health", (_, res) => res.json({ ok: true }));

/**
 * POST /render
 * body: {
 *   width?: number (default 1920),
 *   height?: number (default 1080),
 *   fps?: number (default 30),
 *   slides: [{ imageUrl: string, text?: string, durationSec?: number }]
 * }
 */
app.post("/render", async (req, res) => {
  const { slides = [], width = 1920, height = 1080, fps = 30 } = req.body || {};
  if (!Array.isArray(slides) || slides.length === 0) {
    return res.status(400).json({ error: "slides[] required" });
  }

  const runId = uuidv4().slice(0, 8);
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), `ffmpeg-${runId}-`));
  const framesDir = path.join(workDir, "frames");
  const clipsDir = path.join(workDir, "clips");
  fs.mkdirSync(framesDir);
  fs.mkdirSync(clipsDir);

  try {
    // 1) Download images
    const localImages = [];
    for (let i = 0; i < slides.length; i++) {
      const s = slides[i];
      const idx = String(i + 1).padStart(3, "0");
      const imgPath = path.join(framesDir, `img_${idx}.jpg`);
      const r = await axios.get(s.imageUrl, { responseType: "arraybuffer", timeout: 30000 });
      fs.writeFileSync(imgPath, r.data);
      localImages.push({ ...s, imgPath, idx, durationSec: Math.max(4, Math.min(15, s.durationSec || 8)) });
    }

    // 2) Create per-slide clip with drawtext overlay
    const clipPaths = [];
    for (const s of localImages) {
      const clipPath = path.join(clipsDir, `clip_${s.idx}.mp4`);
      const textFile = writeTextFile(workDir, s.idx, (s.text || "").slice(0, 250)); // keep overlay readable

      const vf = [
        `scale=${width}:${height}:force_original_aspect_ratio=decrease`,
        `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`,
        `drawtext=fontfile=${FONT}:textfile='${textFile}':x=50:y=H-th-60:fontsize=36:fontcolor=white:line_spacing=8:box=1:boxcolor=black@0.45:boxborderw=15`
      ].join(",");

      const cmd = [
        `ffmpeg -y -loop 1 -t ${s.durationSec} -i "${s.imgPath}"`,
        `-vf "${vf}" -r ${fps} -pix_fmt yuv420p -c:v libx264 -preset veryfast`,
        `"${clipPath}"`
      ].join(" ");
      execSync(cmd, { stdio: "inherit" });
      clipPaths.push(clipPath);
    }

    // 3) Concat all clips losslessly
    const listFile = path.join(workDir, "concat.txt");
    fs.writeFileSync(listFile, clipPaths.map(p => `file '${p}'`).join("\n"));

    const outFile = path.join(workDir, `${safeName(runId)}.mp4`);
    execSync(`ffmpeg -y -f concat -safe 0 -i "${listFile}" -c copy "${outFile}"`, { stdio: "inherit" });

    // 4) Stream result
    res.setHeader("Content-Type", "video/mp4");
    const rs = fs.createReadStream(outFile);
    rs.pipe(res);
    rs.on("close", () => {
      // cleanup in background
      fs.rm(workDir, { recursive: true, force: true }, () => {});
    });
  } catch (err) {
    console.error(err);
    fs.rm(workDir, { recursive: true, force: true }, () => {});
    res.status(500).json({ error: "render_failed", detail: String(err) });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`FFmpeg render server on :${PORT}`));
