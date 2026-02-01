const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

// ⚠️ IF LOCAL: Use full path. IF HOSTED (Render/Heroku): Keep "yt-dlp"
const YTDLP = "yt-dlp"; 
// const YTDLP = "C:\\Users\\suvro\\AppData\\Local\\Programs\\Python\\Python311\\Scripts\\yt-dlp.exe";

const jobs = {};

/* ───────────────── CLEANER ───────────────── */
setInterval(() => {
  const now = Date.now();
  for (const id in jobs) {
    if (now - jobs[id].startTime > 60 * 60 * 1000) { // 1 Hour
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

      // 🟢 SMART PREVIEW FINDER (Fixes Facebook/Insta Previews)
      // Finds a direct MP4 file (<50MB) with both Audio & Video
      const previewFormat = info.formats.find((f) => 
        f.ext === "mp4" && 
        f.vcodec !== "none" && 
        f.acodec !== "none" && 
        f.protocol === "https" && 
        (f.filesize < 50000000 || !f.filesize)
      );
      const previewUrl = previewFormat ? previewFormat.url : null;

      // Thumbnail Fallback
      let thumb = info.thumbnail;
      if (!thumb && info.thumbnails && info.thumbnails.length > 0) {
        thumb = info.thumbnails[info.thumbnails.length - 1].url;
      }

      res.json({
        title: info.title,
        platform: info.extractor_key,
        qualities,
        thumbnail: thumb,
        preview: previewUrl // 🟢 Sending direct video link
      });

    } catch {
      res.status(500).json({ error: "Parse error" });
    }
  });
};

/* ───────────────── START DOWNLOAD ───────────────── */
exports.startDownload = (req, res) => {
  const { url, quality, jobId, title, format } = req.body; // 🟢 Added 'format'
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

  // 🟢 LOGIC TO FIX MOBILE AUDIO & FORMATS
  if (format === 'audio') {
    // 🎵 AUDIO MODE (MP3)
    args.push("-x", "--audio-format", "mp3");
    jobs[jobId].msg = "Extracting Audio...";
  } else {
    // 📺 VIDEO MODE (MP4 with AAC Audio)
    // 1. Force H.264 Video & AAC Audio (Compatible with ALL Phones)
    args.push("-S", "vcodec:h264,res,acodec:aac");

    // 2. Merge Strategy
    if (quality) {
       args.push("-f", `bestvideo[height<=${quality}]+bestaudio/best[height<=${quality}]/best`);
    } else {
       args.push("-f", "bestvideo+bestaudio/best");
    }

    // 3. Force MP4 Container
    args.push("--merge-output-format", "mp4");
    
    jobs[jobId].msg = "Downloading Video...";
  }

  // URL must be last
  args.push(url);

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
      // Update msg dynamically
      if (jobs[jobId].progress > 99) jobs[jobId].msg = "Finalizing...";
      else jobs[jobId].msg = format === 'audio' ? "Downloading Audio..." : "Downloading Video...";
    }

    if (text.includes("Destination:")) {
      const m = text.match(/Destination: (.+)$/m);
      if (m) jobs[jobId].filePath = m[1];
    }
    
    // Handle "Already downloaded" case
    if (text.includes("has already been downloaded")) {
        const m = text.match(/\[download\] (.+) has already been downloaded/);
        if (m) jobs[jobId].filePath = m[1];
        jobs[jobId].progress = 100;
    }
  });

  yt.on("close", () => {
    const dir = path.join(__dirname, "..");
    const files = fs.readdirSync(dir);
    // Robust find
    const found = files.find(f => f.startsWith(jobId));

    if (found) {
      jobs[jobId].filePath = path.join(dir, found);
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

  const safeName = job.title.replace(/[^a-z0-9 _-]/gi, "_").trim();
  const ext = path.extname(job.filePath);

  res.download(job.filePath, `${safeName}${ext}`, () => {
    try { fs.unlinkSync(job.filePath); } catch {}
    delete jobs[jobId];
  });
};