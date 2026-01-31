const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const jobs = {};

/* ===================== INFO ===================== */
exports.getInfo = (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: "URL missing" });

  const yt = spawn("yt-dlp", [
    "--js-runtime", "node",
    "--no-playlist",
    "-J",
    url
  ]);

  let raw = "";

  yt.stdout.on("data", d => raw += d.toString());
  yt.stderr.on("data", d => console.error("[yt-dlp info]", d.toString()));

  yt.on("error", err => {
    console.error("Spawn error:", err.message);
    if (!res.headersSent) res.status(500).json({ error: "yt-dlp failed" });
  });

  yt.on("close", () => {
    try {
      const info = JSON.parse(raw);
      const qualities = [...new Set(
        info.formats
          .filter(f => f.height && f.vcodec !== "none")
          .map(f => f.height)
      )].sort((a, b) => b - a);

      res.json({
        title: info.title,
        platform: info.extractor_key,
        qualities
      });
    } catch {
      res.status(500).json({ error: "Failed to parse info" });
    }
  });
};

/* ===================== DOWNLOAD ===================== */
exports.startDownload = (req, res) => {
  const { url, quality, jobId } = req.body;
  if (!url || !jobId) return res.status(400).json({ error: "Missing fields" });

  const outDir = path.join(__dirname, "..");
  const outTemplate = path.join(outDir, `${jobId}.%(ext)s`);

  jobs[jobId] = {
    progress: 0,
    status: "starting",
    filePath: null
  };

  const yt = spawn("yt-dlp", [
    "--js-runtime", "node",
    "--newline",
    "--no-playlist",
    "-f", `bestvideo[height<=${quality || 1080}]+bestaudio/best`,
    "--merge-output-format", "mp4",
    "-o", outTemplate,
    url
  ]);

  yt.stdout.on("data", d => {
    const text = d.toString();
    const match = text.match(/(\d+\.\d+)%/);
    if (match) jobs[jobId].progress = Number(match[1]);
    jobs[jobId].status = "downloading";
  });

  yt.stderr.on("data", d => console.error("[yt-dlp]", d.toString()));

  yt.on("error", err => {
    console.error("Spawn error:", err.message);
    jobs[jobId].status = "error";
  });

  yt.on("close", () => {
    const file = fs.readdirSync(outDir).find(f => f.startsWith(jobId));
    if (!file) return jobs[jobId].status = "error";

    jobs[jobId].filePath = path.join(outDir, file);
    jobs[jobId].progress = 100;
    jobs[jobId].status = "done";
  });

  res.json({ started: true });
};

/* ===================== PROGRESS ===================== */
exports.getProgress = (req, res) => {
  const { jobId } = req.params;

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const timer = setInterval(() => {
    const job = jobs[jobId];
    if (!job) {
      res.write(`data: ${JSON.stringify({ status: "error" })}\n\n`);
      clearInterval(timer);
      return res.end();
    }

    res.write(`data: ${JSON.stringify(job)}\n\n`);

    if (job.status === "done" || job.status === "error") {
      clearInterval(timer);
      res.end();
    }
  }, 500);
};

/* ===================== FILE ===================== */
exports.downloadFile = (req, res) => {
  const { jobId } = req.params;
  const job = jobs[jobId];

  if (!job || !job.filePath || !fs.existsSync(job.filePath)) {
    return res.status(404).send("File not found");
  }

  res.download(job.filePath, () => {
    try { fs.unlinkSync(job.filePath); } catch {}
    delete jobs[jobId];
  });
};
