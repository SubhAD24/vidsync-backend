const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

const jobs = {};

/* ===============================
   URL NORMALIZER (CRITICAL)
================================ */
function normalizeUrl(url) {
  if (!url) return url;

  // YouTube Shorts → Watch
  if (url.includes("youtube.com/shorts/")) {
    const id = url.split("/shorts/")[1].split("?")[0];
    return `https://www.youtube.com/watch?v=${id}`;
  }

  // Instagram Reels → keep clean
  if (url.includes("instagram.com")) {
    return url.split("?")[0];
  }

  // Facebook short links
  if (url.includes("fb.watch")) {
    return url;
  }

  return url;
}

/* ===============================
   GET VIDEO INFO
================================ */
exports.getInfo = (req, res) => {
  let { url } = req.body;
  if (!url) return res.status(400).json({ error: "URL missing" });

  url = normalizeUrl(url);

  const yt = spawn("yt-dlp", [
    "--dump-single-json",
    "--no-playlist",
    "--force-ipv4",
    url
  ]);

  let raw = "";

  yt.stdout.on("data", d => raw += d.toString());
  yt.stderr.on("data", d => console.error("[yt-dlp]", d.toString()));

  yt.on("close", code => {
    if (!raw) {
      return res.status(500).json({ error: "Could not find video" });
    }

    try {
      const info = JSON.parse(raw);

      const qualities = [...new Set(
        info.formats
          .filter(f => f.height && f.acodec !== "none")
          .map(f => f.height)
      )].sort((a, b) => b - a);

      res.json({
        title: info.title,
        platform: info.extractor_key,
        qualities,
        thumbnail: info.thumbnail
      });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: "Parse failed" });
    }
  });
};

/* ===============================
   START DOWNLOAD (AUDIO FIXED)
================================ */
exports.startDownload = (req, res) => {
  let { url, quality, jobId } = req.body;
  if (!url || !jobId) return res.status(400).json({ error: "Missing fields" });

  url = normalizeUrl(url);

  const outDir = path.join(__dirname, "..");
  const output = path.join(outDir, `${jobId}.%(ext)s`);

  jobs[jobId] = {
    progress: 0,
    status: "starting",
    filePath: null
  };

  const yt = spawn("yt-dlp", [
    "--newline",
    "--force-ipv4",
    "--no-playlist",
    "-f",
    `bv*[height<=${quality}]+ba/b`,
    "--merge-output-format",
    "mp4",
    "-o",
    output,
    url
  ]);

  yt.stdout.on("data", d => {
    const t = d.toString();
    const m = t.match(/(\d+\.\d+)%/);
    if (m) jobs[jobId].progress = Number(m[1]);
  });

  yt.on("close", () => {
    const file = fs.readdirSync(outDir).find(f => f.startsWith(jobId));
    if (file) {
      jobs[jobId].filePath = path.join(outDir, file);
      jobs[jobId].status = "done";
      jobs[jobId].progress = 100;
    } else {
      jobs[jobId].status = "error";
    }
  });

  res.json({ started: true });
};

/* ===============================
   PROGRESS STREAM
================================ */
exports.getProgress = (req, res) => {
  const { jobId } = req.params;

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const timer = setInterval(() => {
    if (!jobs[jobId]) return;
    res.write(`data: ${JSON.stringify(jobs[jobId])}\n\n`);

    if (jobs[jobId].status === "done") {
      clearInterval(timer);
      res.end();
    }
  }, 1000);
};

/* ===============================
   FILE DOWNLOAD
================================ */
exports.downloadFile = (req, res) => {
  const { jobId } = req.params;
  const job = jobs[jobId];

  if (!job || !fs.existsSync(job.filePath)) {
    return res.status(404).send("File not found");
  }

  res.download(job.filePath, () => {
    fs.unlinkSync(job.filePath);
    delete jobs[jobId];
  });
};
