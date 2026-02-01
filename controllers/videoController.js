const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

const YTDLP = "yt-dlp"; // ✅ DO NOT CHANGE

const jobs = {};

/* ───────────────── CLEANER ───────────────── */
setInterval(() => {
  const now = Date.now();
  for (const id in jobs) {
    if (now - jobs[id].startTime > 60 * 60 * 1000) {
      if (jobs[id].filePath && fs.existsSync(jobs[id].filePath)) {
        try { fs.unlinkSync(jobs[id].filePath); } catch {}
      }
      delete jobs[id];
    }
  }
}, 10 * 60 * 1000);

/* ───────────────── VIDEO INFO ───────────────── */
exports.getInfo = (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: "URL missing" });

  const yt = spawn(YTDLP, [
    "--force-ipv4",
    "--no-playlist",
    "-J",
    url
  ]);

  let raw = "";

  yt.stdout.on("data", d => raw += d.toString());
  yt.stderr.on("data", d => console.log("[yt-dlp]", d.toString()));

  yt.on("close", code => {
    if (code !== 0 || !raw) {
      return res.status(500).json({ error: "Could not fetch video info" });
    }

    try {
      const info = JSON.parse(raw);

      const qualities = [
        ...new Set(
          info.formats
            .filter(f => f.height && f.vcodec !== "none")
            .map(f => f.height)
        )
      ].sort((a, b) => b - a);

      res.json({
        title: info.title,
        platform: info.extractor_key,
        qualities,
        thumbnail: info.thumbnail || null
      });

    } catch {
      res.status(500).json({ error: "Parse error" });
    }
  });
};

/* ───────────────── START DOWNLOAD ───────────────── */
exports.startDownload = (req, res) => {
  const { url, quality, jobId, title } = req.body;
  if (!url || !jobId) return res.status(400).json({ error: "Missing fields" });

  const outputTemplate = path.join(
    __dirname,
    "..",
    `${jobId}.%(ext)s`
  );

  jobs[jobId] = {
    progress: 0,
    status: "starting",
    msg: "Initializing…",
    filePath: null,
    title: title || "video",
    startTime: Date.now()
  };

  const args = [
    "--force-ipv4",
    "--no-playlist",
    "--newline",
    "--audio-multistreams",

    // 🔥 FACEBOOK + INSTAGRAM + YOUTUBE SAFE FORMAT
    "-f",
    quality
      ? `bv*[height<=${quality}]/bv*+ba/best`
      : "bv*+ba/best",

    "--merge-output-format",
    "mp4",

    "-o",
    outputTemplate,

    url
  ];

  const yt = spawn(YTDLP, args);

  yt.on("error", err => {
    console.error("Spawn error:", err);
    jobs[jobId].status = "error";
    jobs[jobId].msg = "Engine error";
  });

  yt.stdout.on("data", d => {
    const text = d.toString();

    const match = text.match(/(\d+\.\d+)%/);
    if (match) {
      jobs[jobId].progress = Number(match[1]);
      jobs[jobId].status = "downloading";
      jobs[jobId].msg = "Downloading…";
    }

    if (text.includes("Destination:")) {
      const m = text.match(/Destination: (.+)$/m);
      if (m) jobs[jobId].filePath = m[1];
    }
  });

  yt.on("close", () => {
    const files = fs.readdirSync(path.join(__dirname, ".."));
    const found = files.find(f => f.startsWith(jobId));

    if (found) {
      jobs[jobId].filePath = path.join(__dirname, "..", found);
      jobs[jobId].progress = 100;
      jobs[jobId].status = "done";
      jobs[jobId].msg = "Ready";
    } else {
      jobs[jobId].status = "error";
    }
  });

  res.json({ started: true });
};

/* ───────────────── PROGRESS STREAM ───────────────── */
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
      return;
    }

    res.write(`data: ${JSON.stringify(job)}\n\n`);

    if (job.status === "done" || job.status === "error") {
      clearInterval(timer);
      res.end();
    }
  }, 500);
};

/* ───────────────── FILE DOWNLOAD ───────────────── */
exports.downloadFile = (req, res) => {
  const { jobId } = req.params;
  const job = jobs[jobId];

  if (!job || !job.filePath || !fs.existsSync(job.filePath)) {
    return res.status(404).send("File not found");
  }

  const safeName = job.title.replace(/[^a-z0-9 _-]/gi, "_");
  const ext = path.extname(job.filePath);

  res.download(job.filePath, `${safeName}${ext}`, () => {
    try { fs.unlinkSync(job.filePath); } catch {}
    delete jobs[jobId];
  });
};
