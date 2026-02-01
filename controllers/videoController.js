const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

/* 🔥 ABSOLUTE yt-dlp PATH (MANDATORY) */
const YTDLP_BIN =
  process.platform === "win32"
    ? "C:\\yt-dlp\\yt-dlp.exe"   // CHANGE if needed
    : "/usr/bin/yt-dlp";

const COOKIE_FILE = path.join(__dirname, "../cookies.txt");
const jobs = {};

/* ───────── CLEANER ───────── */
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

/* ───────── VIDEO INFO ───────── */
exports.getInfo = (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: "URL missing" });

  const args = [
    "--force-ipv4",
    "--no-playlist",
    "--cookies", COOKIE_FILE,
    "-J",
    url
  ];

  const yt = spawn(YTDLP_BIN, args);
  let raw = "";
  let errLog = "";

  yt.stdout.on("data", d => raw += d.toString());
  yt.stderr.on("data", d => errLog += d.toString());

  yt.on("close", code => {
    if (code !== 0 || !raw) {
      console.error("INFO ERROR:", errLog);
      return res.status(500).json({
        error: "Video not found or blocked",
        details: errLog.slice(0, 300)
      });
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

      const previewFormat = info.formats.find(f =>
        f.ext === "mp4" &&
        f.vcodec !== "none" &&
        f.protocol === "https" &&
        (!f.filesize || f.filesize < 50_000_000)
      );

      const thumbnail =
        info.thumbnail ||
        (info.thumbnails?.length
          ? info.thumbnails.at(-1).url
          : null);

      res.json({
        title: info.title,
        platform: info.extractor_key,
        qualities,
        thumbnail,
        preview: previewFormat?.url || null
      });

    } catch (e) {
      console.error("PARSE ERROR:", e);
      res.status(500).json({ error: "Metadata parse failed" });
    }
  });
};

/* ───────── START DOWNLOAD ───────── */
exports.startDownload = (req, res) => {
  const { url, quality, jobId, title, format } = req.body;
  if (!url || !jobId) return res.status(400).json({ error: "Missing fields" });

  const outputTemplate = path.join(__dirname, "..", `${jobId}.%(ext)s`);

  jobs[jobId] = {
    progress: 0,
    status: "starting",
    msg: "Initializing",
    filePath: null,
    title: title || "video",
    startTime: Date.now()
  };

  const args = [
    "--force-ipv4",
    "--no-playlist",
    "--newline",
    "-o", outputTemplate
  ];

  /* 🔥 Android client ONLY for download */
  if (url.includes("youtube")) {
    args.push("--extractor-args", "youtube:player_client=android");
  }

  if (format === "audio") {
    args.push("-x", "--audio-format", "mp3");
  } else {
    if (quality) {
      args.push("-f", `bestvideo[height<=${quality}]+bestaudio/best`);
    } else {
      args.push("-f", "bestvideo+bestaudio/best");
    }
    args.push("--recode-video", "mp4");
  }

  args.push(url);

  const yt = spawn(YTDLP_BIN, args);

  yt.stdout.on("data", d => {
    const text = d.toString();
    const match = text.match(/(\d+\.\d+)%/);

    if (match) {
      jobs[jobId].progress = Number(match[1]);
      jobs[jobId].status = "downloading";
    }

    if (text.includes("Destination:")) {
      const m = text.match(/Destination: (.+)$/m);
      if (m) jobs[jobId].filePath = m[1];
    }
  });

  yt.on("close", () => {
    const dir = path.join(__dirname, "..");
    const found = fs.readdirSync(dir).find(f => f.startsWith(jobId));
    if (found) {
      jobs[jobId].filePath = path.join(dir, found);
      jobs[jobId].progress = 100;
      jobs[jobId].status = "done";
    } else {
      jobs[jobId].status = "error";
    }
  });

  res.json({ started: true });
};

/* ───────── PROGRESS ───────── */
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

/* ───────── FILE DOWNLOAD ───────── */
exports.downloadFile = (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job || !fs.existsSync(job.filePath)) {
    return res.status(404).send("File not found");
  }

  const safeName = job.title.replace(/[^a-z0-9 _-]/gi, "_");
  const ext = path.extname(job.filePath);

  res.download(job.filePath, `${safeName}${ext}`, () => {
    try { fs.unlinkSync(job.filePath); } catch {}
    delete jobs[req.params.jobId];
  });
};
