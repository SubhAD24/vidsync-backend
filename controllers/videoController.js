const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

// 🟢 PRODUCTION PATH (Use "yt-dlp" if it's in your system PATH)
const YTDLP_BIN = "yt-dlp"; 
// If that doesn't work, uncomment and use your specific path:
// const YTDLP_BIN = "C:\\Users\\suvro\\AppData\\Local\\Programs\\Python\\Python311\\Scripts\\yt-dlp.exe";

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

/* ───────────────── VIDEO INFO (Fixes "Couldn't find video") ───────────────── */
exports.getInfo = (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: "URL missing" });

  const args = [
    "--force-ipv4",
    "--no-playlist",
    "-J",
    url
  ];

  // 🟢 YOUTUBE FIX: REQUIRED for "getInfo" to work.
  // Without this, YouTube blocks the request as a "Bot".
  if (url.includes("youtube.com") || url.includes("youtu.be")) {
     args.push("--extractor-args", "youtube:player_client=android");
  }

  const yt = spawn(YTDLP_BIN, args);
  let raw = "";

  yt.stdout.on("data", d => raw += d.toString());
  // Log specific errors to help debugging
  yt.stderr.on("data", d => console.log("[yt-dlp info error]", d.toString()));

  yt.on("close", code => {
    if (code !== 0 || !raw) {
      console.error("Info Fetch Failed. URL:", url);
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

      const previewFormat = info.formats.find((f) => 
        f.ext === "mp4" && 
        f.vcodec !== "none" && 
        f.protocol === "https" && 
        (f.filesize < 50000000 || !f.filesize)
      );
      const previewUrl = previewFormat ? previewFormat.url : null;

      let thumb = info.thumbnail;
      if (!thumb && info.thumbnails && info.thumbnails.length > 0) {
        thumb = info.thumbnails[info.thumbnails.length - 1].url;
      }

      res.json({
        title: info.title,
        platform: info.extractor_key,
        qualities,
        thumbnail: thumb,
        preview: previewUrl 
      });

    } catch (e) {
      console.error("JSON Parse Error:", e);
      res.status(500).json({ error: "Parse error" });
    }
  });
};

/* ───────────────── START DOWNLOAD ───────────────── */
exports.startDownload = (req, res) => {
  const { url, quality, jobId, title, format } = req.body; 
  if (!url || !jobId) return res.status(400).json({ error: "Missing fields" });

  const outputTemplate = path.join(
    __dirname,
    "..",
    `${jobId}.%(ext)s`
  );

  jobs[jobId] = {
    progress: 0,
    status: "starting",
    msg: "Initializing...",
    filePath: null,
    title: title || "video",
    startTime: Date.now()
  };

  const args = [
    "--force-ipv4",
    "--no-playlist",
    "--newline",
    "-o",
    outputTemplate,
  ];

  // 🟢 YOUTUBE FIX: Required for download
  if (url.includes("youtube.com") || url.includes("youtu.be")) {
    args.push("--extractor-args", "youtube:player_client=android");
  }

  if (format === 'audio') {
    args.push("-x", "--audio-format", "mp3");
    jobs[jobId].msg = "Extracting Audio...";
  } else {
    // 🟢 MOBILE AUDIO FIX
    if (quality) {
       args.push("-f", `bestvideo[height<=${quality}]+bestaudio/best[height<=${quality}]/best`);
    } else {
       args.push("-f", "bestvideo+bestaudio/best");
    }

    // Force MP4 Recode (Fixes audio on phones)
    args.push("--recode-video", "mp4");
    
    jobs[jobId].msg = "Downloading Video...";
  }

  args.push(url);

  const yt = spawn(YTDLP_BIN, args);

  yt.on("error", err => {
    console.error("Spawn error:", err);
    jobs[jobId].status = "error";
    jobs[jobId].msg = "Engine error (Check Path)";
  });

  yt.stdout.on("data", d => {
    const text = d.toString();

    const match = text.match(/(\d+\.\d+)%/);
    if (match) {
      jobs[jobId].progress = Number(match[1]);
      jobs[jobId].status = "downloading";
      if (jobs[jobId].progress === 100) jobs[jobId].msg = "Finalizing (Audio Fix)...";
      else jobs[jobId].msg = format === 'audio' ? "Downloading Audio..." : "Downloading Video...";
    }

    if (text.includes("Destination:")) {
      const m = text.match(/Destination: (.+)$/m);
      if (m) jobs[jobId].filePath = m[1];
    }
    
    if (text.includes("has already been downloaded")) {
        const m = text.match(/\[download\] (.+) has already been downloaded/);
        if (m) jobs[jobId].filePath = m[1];
        jobs[jobId].progress = 100;
    }
  });

  yt.on("close", (code) => {
    const dir = path.join(__dirname, "..");
    const files = fs.readdirSync(dir);
    const found = files.find(f => f.startsWith(jobId));

    if (found) {
      jobs[jobId].filePath = path.join(dir, found);
      jobs[jobId].progress = 100;
      jobs[jobId].status = "done";
      jobs[jobId].msg = "Ready";
    } else {
      console.error("Job failed with code:", code);
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

  const safeName = job.title.replace(/[^a-z0-9 _-]/gi, "_").trim();
  const ext = path.extname(job.filePath);

  res.download(job.filePath, `${safeName}${ext}`, () => {
    try { fs.unlinkSync(job.filePath); } catch {}
    delete jobs[jobId];
  });
};