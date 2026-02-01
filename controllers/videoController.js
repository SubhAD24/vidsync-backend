const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

const jobs = {};

/* ------------------ HELPERS ------------------ */

function normalizeUrl(url) {
  if (!url) return url;
  if (url.includes("m.facebook.com"))
    return url.replace("m.facebook.com", "www.facebook.com");
  return url.trim();
}

/* ------------------ GET VIDEO INFO ------------------ */

exports.getInfo = (req, res) => {
  let { url } = req.body;
  if (!url) return res.status(400).json({ error: "URL missing" });

  url = normalizeUrl(url);

  const yt = spawn("yt-dlp", [
    "--dump-single-json",
    "--no-playlist",
    "--force-ipv4",
    url,
  ]);

  let raw = "";
  let err = "";

  yt.stdout.on("data", (d) => (raw += d.toString()));
  yt.stderr.on("data", (d) => (err += d.toString()));

  yt.on("close", () => {
    // 🔴 FACEBOOK / IG INFO FAILURE → SAFE FALLBACK
    if (!raw) {
      console.error("yt-dlp info failed:", err);
      return res.json({
        title: "Social Media Video",
        platform: "Unknown",
        qualities: [720, 480, 360],
        warning: "Metadata unavailable. Download may still work.",
      });
    }

    try {
      const info = JSON.parse(raw);

      if (!info || !Array.isArray(info.formats)) {
        return res.json({
          title: info?.title || "Video",
          platform: info?.extractor_key || "Unknown",
          qualities: [720, 480, 360],
          warning: "Limited metadata. Using fallback qualities.",
        });
      }

      const qualities = [
        ...new Set(
          info.formats
            .filter(
              (f) =>
                f.height &&
                f.vcodec !== "none" &&
                (f.acodec !== "none" || f.audio_channels)
            )
            .map((f) => f.height)
        ),
      ].sort((a, b) => b - a);

      res.json({
        title: info.title,
        platform: info.extractor_key,
        qualities: qualities.length ? qualities : [720, 480, 360],
        thumbnail: info.thumbnail || null,
      });
    } catch (e) {
      console.error("Info parse error:", e);
      res.status(500).json({ error: "Failed to parse video info" });
    }
  });
};

/* ------------------ START DOWNLOAD ------------------ */

exports.startDownload = (req, res) => {
  let { url, quality, jobId, title } = req.body;
  if (!url || !jobId)
    return res.status(400).json({ error: "Missing fields" });

  url = normalizeUrl(url);

  const outDir = path.join(__dirname, "..", "downloads");
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir);

  const outputTemplate = path.join(outDir, `${jobId}.%(ext)s`);

  jobs[jobId] = {
    progress: 0,
    status: "starting",
    msg: "Initializing download...",
    filePath: null,
    title: title || "video",
  };

  const yt = spawn("yt-dlp", [
    "--force-ipv4",
    "--newline",
    "--no-playlist",
    "-f",
    `bv*[height<=${quality || 720}]+ba/b`,
    "--merge-output-format",
    "mp4",
    "-o",
    outputTemplate,
    url,
  ]);

  yt.on("error", (err) => {
    console.error("Spawn error:", err);
    jobs[jobId].status = "error";
    jobs[jobId].msg = "Download engine error";
  });

  yt.stdout.on("data", (d) => {
    const text = d.toString();

    const match = text.match(/(\d+\.\d+)%/);
    if (match) {
      jobs[jobId].progress = Number(match[1]);
      jobs[jobId].status = "downloading";
      jobs[jobId].msg = "Downloading...";
    }

    if (text.includes("Destination:")) {
      const m = text.match(/Destination:\s(.+)/);
      if (m) jobs[jobId].filePath = m[1];
    }
  });

  yt.on("close", () => {
    const files = fs.readdirSync(outDir);
    const found = files.find((f) => f.startsWith(jobId));

    if (!found) {
      jobs[jobId].status = "error";
      jobs[jobId].msg = "Download failed";
      return;
    }

    jobs[jobId].filePath = path.join(outDir, found);
    jobs[jobId].progress = 100;
    jobs[jobId].status = "done";
    jobs[jobId].msg = "Ready for download";
  });

  res.json({ started: true });
};

/* ------------------ PROGRESS (SSE) ------------------ */

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
  }, 800);
};

/* ------------------ FILE DOWNLOAD ------------------ */

exports.downloadFile = (req, res) => {
  const { jobId } = req.params;
  const job = jobs[jobId];

  if (!job || !job.filePath || !fs.existsSync(job.filePath))
    return res.status(404).send("File not found");

  const safeName = job.title.replace(/[^a-z0-9_\- ]/gi, "_");
  const ext = path.extname(job.filePath);

  res.download(job.filePath, `${safeName}${ext}`, () => {
    try {
      fs.unlinkSync(job.filePath);
    } catch (e) {}
    delete jobs[jobId];
  });
};
