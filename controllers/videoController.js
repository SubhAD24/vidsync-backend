const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

// 🟢 CONFIGURATION
// Ensure 'yt-dlp' is installed and in your system PATH, or provide the full path to the executable here.
const YTDLP_BIN = "yt-dlp"; 

// Ensure output directory exists
const OUTPUT_DIR = path.join(__dirname, "..");
if (!fs.existsSync(OUTPUT_DIR)) {
  // Create it if it doesn't exist (optional safety check)
  // fs.mkdirSync(OUTPUT_DIR); 
}

const jobs = {};

/* ───────────────── CLEANER ───────────────── */
// Cleans up old files every 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const id in jobs) {
    if (now - jobs[id].startTime > 60 * 60 * 1000) { // 1 hour timeout
      if (jobs[id].filePath && fs.existsSync(jobs[id].filePath)) {
        try { fs.unlinkSync(jobs[id].filePath); } catch (e) { console.error("Cleanup error:", e); }
      }
      delete jobs[id];
    }
  }
}, 10 * 60 * 1000);

/* ───────────────── VIDEO INFO ───────────────── */
exports.getInfo = (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: "URL missing" });

  console.log(`[Info] Fetching metadata for: ${url}`);

  const args = [
    "--force-ipv4",
    "--no-playlist",
    "--no-warnings",
    "-J", // JSON output
    // 🟢 FIX 1: Use a real browser User-Agent to bypass "Bot" detection
    "--user-agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
    // 🟢 FIX 2: Use iOS client for metadata (It is currently less blocked than Android/Web)
    "--extractor-args", "youtube:player_client=ios", 
    url
  ];

  const yt = spawn(YTDLP_BIN, args);
  let raw = "";
  let errorLog = "";

  yt.stdout.on("data", d => raw += d.toString());
  
  // 🟢 FIX 3: Capture error log so we know WHY it failed
  yt.stderr.on("data", d => {
    errorLog += d.toString();
  });

  yt.on("close", code => {
    if (code !== 0 || !raw) {
      console.error("[Error] yt-dlp failed:", errorLog);
      return res.status(500).json({ error: "Could not fetch video info", details: errorLog });
    }

    try {
      const info = JSON.parse(raw);

      // Filter qualities (Video only, remove duplicates)
      const qualities = [
        ...new Set(
          info.formats
            .filter(f => f.height && f.vcodec !== "none")
            .map(f => f.height)
        )
      ].sort((a, b) => b - a);

      // Smart Preview Finder (Small MP4 file for preview)
      const previewFormat = info.formats.find((f) => 
        f.ext === "mp4" && 
        f.vcodec !== "none" && 
        f.protocol === "https" && 
        (f.filesize < 50000000 || !f.filesize) // < 50MB
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
      console.error("[Error] JSON Parse:", e.message);
      res.status(500).json({ error: "Parse error" });
    }
  });
};

/* ───────────────── START DOWNLOAD ───────────────── */
exports.startDownload = (req, res) => {
  const { url, quality, jobId, title, format } = req.body; 
  if (!url || !jobId) return res.status(400).json({ error: "Missing fields" });

  const outputTemplate = path.join(OUTPUT_DIR, `${jobId}.%(ext)s`);

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
    "--newline", // Critical for progress parsing
    "--no-warnings",
    "-o", outputTemplate,
    // 🟢 Keep User-Agent for consistency
    "--user-agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
  ];

  // 🟢 YOUTUBE SPECIFIC FLAGS
  if (url.includes("youtube.com") || url.includes("youtu.be")) {
    // For downloading, 'android' is often faster/unthrottled, but if it fails, remove this line.
    args.push("--extractor-args", "youtube:player_client=android");
  }

  if (format === 'audio') {
    args.push("-x", "--audio-format", "mp3");
    jobs[jobId].msg = "Extracting Audio...";
  } else {
    // 🟢 VIDEO SELECTION LOGIC
    if (quality) {
       // Try specific quality, fallback to best
       args.push("-f", `bestvideo[height<=${quality}]+bestaudio/best[height<=${quality}]/best`);
    } else {
       args.push("-f", "bestvideo+bestaudio/best");
    }

    // Force Recode to MP4 ensures compatibility on iPhones/Windows
    args.push("--recode-video", "mp4");
    
    jobs[jobId].msg = "Downloading Video...";
  }

  args.push(url);

  console.log(`[Download] Starting job ${jobId}`);
  const yt = spawn(YTDLP_BIN, args);

  yt.on("error", err => {
    console.error("Spawn error:", err);
    jobs[jobId].status = "error";
    jobs[jobId].msg = "Engine error (Check Path)";
  });

  yt.stderr.on("data", d => {
    // Optional: Log stderr if you want to debug downloads
    // console.log("STDERR:", d.toString());
  });

  yt.stdout.on("data", d => {
    const text = d.toString();

    // Parse Progress
    const match = text.match(/(\d+\.\d+)%/);
    if (match) {
      jobs[jobId].progress = Number(match[1]);
      jobs[jobId].status = "downloading";
      if (jobs[jobId].progress === 100) jobs[jobId].msg = "Finalizing (Audio Fix)...";
      else jobs[jobId].msg = format === 'audio' ? "Downloading Audio..." : "Downloading Video...";
    }

    // Capture Filename
    if (text.includes("Destination:")) {
      const m = text.match(/Destination: (.+)$/m);
      if (m) jobs[jobId].filePath = m[1];
    }
    
    // Capture "Already Downloaded" case
    if (text.includes("has already been downloaded")) {
        const m = text.match(/\[download\] (.+) has already been downloaded/);
        if (m) jobs[jobId].filePath = m[1];
        jobs[jobId].progress = 100;
    }
  });

  yt.on("close", (code) => {
    // Final check for file existence
    const files = fs.readdirSync(OUTPUT_DIR);
    // Find any file starting with jobId (ignoring extension)
    const found = files.find(f => f.startsWith(jobId));

    if (found) {
      jobs[jobId].filePath = path.join(OUTPUT_DIR, found);
      jobs[jobId].progress = 100;
      jobs[jobId].status = "done";
      jobs[jobId].msg = "Ready";
    } else {
      console.error(`Job ${jobId} failed with code:`, code);
      jobs[jobId].status = "error";
      jobs[jobId].msg = "Download Failed";
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
    return res.status(404).send("File not found or expired");
  }

  // Sanitize filename
  const safeName = job.title.replace(/[^a-z0-9 _-]/gi, "_").trim();
  const ext = path.extname(job.filePath);

  res.download(job.filePath, `${safeName}${ext}`, () => {
    // Delete file after successful download to save space
    try { fs.unlinkSync(job.filePath); } catch {}
    delete jobs[jobId];
  });
};