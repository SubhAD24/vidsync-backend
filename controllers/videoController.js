const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

const YTDLP_BIN = "yt-dlp"; // ✅ Docker / Railway safe

const jobs = {};

// 🧹 Clean up old jobs
setInterval(() => {
  const now = Date.now();
  for (const id in jobs) {
    if (now - jobs[id].startTime > 3600000) {
      if (jobs[id].filePath && fs.existsSync(jobs[id].filePath)) {
        try { fs.unlinkSync(jobs[id].filePath); } catch {}
      }
      delete jobs[id];
    }
  }
}, 600000);

/* =======================
   GET VIDEO INFO
======================= */
exports.getInfo = (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: "URL missing" });

  const args = ["--force-ipv4", "--no-playlist", "-J", url];

  // ✅ YouTube bot fix
  if (url.includes("youtube") || url.includes("youtu.be")) {
    args.push("--extractor-args", "youtube:player_client=android");
  }

  const yt = spawn(YTDLP_BIN, args);
  let raw = "";

  yt.stdout.on("data", d => raw += d.toString());
  yt.stderr.on("data", d => console.error("[yt-dlp]", d.toString()));

  yt.on("close", code => {
    if (code !== 0 || !raw) {
      return res.status(500).json({ error: "Failed to fetch info" });
    }

    try {
      const info = JSON.parse(raw);
      const formats = Array.isArray(info.formats) ? info.formats : [];

      const qualities = [...new Set(
        formats
          .filter(f => f.height && f.vcodec !== "none")
          .map(f => f.height)
      )].sort((a, b) => b - a);

      const preview = formats.find(f =>
        f.ext === "mp4" &&
        f.vcodec !== "none" &&
        f.acodec !== "none" &&
        f.protocol === "https"
      )?.url || null;

      const thumbnail =
        info.thumbnail ||
        info.thumbnails?.[info.thumbnails.length - 1]?.url ||
        null;

      res.json({
        title: info.title,
        platform: info.extractor_key,
        qualities,
        thumbnail,
        preview
      });

    } catch (e) {
      console.error(e);
      res.status(500).json({ error: "Parse error" });
    }
  });
};

/* =======================
   START DOWNLOAD
======================= */
exports.startDownload = (req, res) => {
  const { url, quality, jobId, title, format } = req.body;
  if (!url || !jobId) return res.status(400).json({ error: "Missing fields" });

  const output = path.join(__dirname, "..", `${jobId}.%(ext)s`);

  jobs[jobId] = {
    progress: 0,
    status: "starting",
    msg: "Initializing...",
    filePath: null,
    title: title || "video",
    startTime: Date.now()
  };

  const args = ["--force-ipv4", "--newline", "--no-playlist", "-o", output];

  if (url.includes("youtube") || url.includes("youtu.be")) {
    args.push("--extractor-args", "youtube:player_client=android");
  }

  if (format === "audio") {
    args.push("-x", "--audio-format", "mp3");
  } else {
    args.push(
      "-f",
      quality
        ? `bestvideo[height<=${quality}]+bestaudio/best`
        : "best"
    );
    args.push("--recode-video", "mp4"); // ✅ fixes FB / IG / YT audio
  }

  args.push(url);

  const yt = spawn(YTDLP_BIN, args);

  yt.stdout.on("data", d => {
    const t = d.toString();
    const m = t.match(/(\d+\.\d+)%/);
    if (m) jobs[jobId].progress = Number(m[1]);

    if (t.includes("Destination:")) {
      const f = t.match(/Destination: (.+)/);
      if (f) jobs[jobId].filePath = f[1];
    }
  });

  yt.on("close", () => {
    const files = fs.readdirSync(path.join(__dirname, ".."));
    const found = files.find(f => f.startsWith(jobId));
    if (found) {
      jobs[jobId].filePath = path.join(__dirname, "..", found);
      jobs[jobId].status = "done";
      jobs[jobId].progress = 100;
    } else {
      jobs[jobId].status = "error";
    }
  });

  res.json({ started: true });
};

/* =======================
   PROGRESS (SSE)
======================= */
exports.getProgress = (req, res) => {
  const { jobId } = req.params;
  res.setHeader("Content-Type", "text/event-stream");

  const timer = setInterval(() => {
    const job = jobs[jobId];
    if (!job) {
      res.write(`data: {"status":"error"}\n\n`);
      clearInterval(timer);
      return;
    }
    res.write(`data: ${JSON.stringify(job)}\n\n`);
    if (job.status !== "starting" && job.status !== "downloading") {
      clearInterval(timer);
      res.end();
    }
  }, 500);
};

/* =======================
   DOWNLOAD FILE
======================= */
exports.downloadFile = (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job || !fs.existsSync(job.filePath)) {
    return res.status(404).send("File lost");
  }

  res.download(job.filePath, err => {
    if (!err) {
      try { fs.unlinkSync(job.filePath); } catch {}
      delete jobs[req.params.jobId];
    }
  });
};
