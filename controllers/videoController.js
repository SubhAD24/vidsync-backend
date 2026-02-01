const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

const jobs = {};

// =========================
// GET VIDEO INFO + PREVIEW
// =========================
exports.getInfo = (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: "URL missing" });

  const yt = spawn("yt-dlp", [
    "--force-ipv4",
    "-J",
    "--no-playlist",
    url,
  ]);

  let raw = "";

  yt.stdout.on("data", d => raw += d.toString());
  yt.stderr.on("data", d => console.error("[yt-dlp]", d.toString()));

  yt.on("close", code => {
    if (code !== 0 || !raw) {
      return res.status(500).json({ error: "Could not fetch video info" });
    }

    try {
      const info = JSON.parse(raw);

      // ✔️ QUALITIES
      const qualities = [...new Set(
        info.formats
          .filter(f => f.height && f.vcodec !== "none")
          .map(f => f.height)
      )].sort((a, b) => b - a);

      // ✔️ PREVIEW WITH AUDIO (CRITICAL FIX)
      const previewFormat = info.formats.find(f =>
        f.ext === "mp4" &&
        f.vcodec !== "none" &&
        f.acodec !== "none" &&
        f.protocol === "https" &&
        (!f.filesize || f.filesize < 20_000_000)
      );

      res.json({
        title: info.title,
        platform: info.extractor_key,
        qualities,
        thumbnail: info.thumbnail,
        preview: previewFormat ? previewFormat.url : null
      });

    } catch (e) {
      console.error(e);
      res.status(500).json({ error: "Parse error" });
    }
  });
};

// =========================
// START DOWNLOAD (AUDIO FIX)
// =========================
exports.startDownload = (req, res) => {
  const { url, quality, jobId } = req.body;
  if (!url || !jobId) return res.status(400).json({ error: "Missing fields" });

  const outDir = path.join(__dirname, "..");
  const outputTemplate = path.join(outDir, `${jobId}.%(ext)s`);

  jobs[jobId] = { progress: 0, status: "starting", file: null };

  // 🔥 UNIVERSAL FORMAT FIX (NO MORE SILENT VIDEO)
  const args = [
    "--force-ipv4",
    "--newline",
    "--no-playlist",

    "-f",
    "bv*[vcodec!=?vp9][ext=mp4]+ba[ext=m4a]/b[ext=mp4]/b",

    "--merge-output-format",
    "mp4",

    "-o",
    outputTemplate,
    url
  ];

  const yt = spawn("yt-dlp", args);

  yt.stdout.on("data", d => {
    const txt = d.toString();
    const match = txt.match(/(\d+\.\d+)%/);
    if (match) {
      jobs[jobId].progress = Number(match[1]);
      jobs[jobId].status = "downloading";
    }
  });

  yt.stderr.on("data", d => console.error("[download]", d.toString()));

  yt.on("close", () => {
    const file = fs.readdirSync(outDir).find(f => f.startsWith(jobId));
    if (file) {
      jobs[jobId].file = path.join(outDir, file);
      jobs[jobId].progress = 100;
      jobs[jobId].status = "done";
    } else {
      jobs[jobId].status = "error";
    }
  });

  res.json({ started: true });
};

// =========================
// PROGRESS (SSE)
// =========================
exports.getProgress = (req, res) => {
  const { jobId } = req.params;

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const timer = setInterval(() => {
    const job = jobs[jobId];
    if (!job) return;

    res.write(`data: ${JSON.stringify(job)}\n\n`);

    if (job.status === "done" || job.status === "error") {
      clearInterval(timer);
      res.end();
    }
  }, 500);
};

// =========================
// DOWNLOAD FILE
// =========================
exports.downloadFile = (req, res) => {
  const { jobId } = req.params;
  const job = jobs[jobId];

  if (!job || !job.file || !fs.existsSync(job.file)) {
    return res.status(404).send("File missing");
  }

  res.download(job.file, err => {
    if (!err) fs.unlink(job.file, () => {});
    delete jobs[jobId];
  });
};
