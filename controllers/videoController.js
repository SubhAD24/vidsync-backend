const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

// 🟢 AS REQUESTED: Using system path
const YTDLP_BIN = "yt-dlp";

const jobs = {};

/* ───────── CLEANER ───────── */
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

/* ───────── INFO ───────── */
exports.getInfo = (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: "URL missing" });

  // 🟢 CLEANEST ARGUMENTS (Restored to what worked)
  const args = [
    "--force-ipv4",
    "--no-playlist",
    "-J",
    url
  ];

  // 🟢 ONLY add this for YouTube. 
  // If we add this for FB/Insta, it might break them.
  if (url.includes("youtube.com") || url.includes("youtu.be")) {
     args.push("--extractor-args", "youtube:player_client=android");
  }

  const yt = spawn(YTDLP_BIN, args);

  let raw = "";
  let errorLog = "";

  yt.stdout.on("data", d => raw += d.toString());
  yt.stderr.on("data", d => errorLog += d.toString());

  yt.on("close", (code) => {
    // Debugging: If it fails, we print WHY it failed in the terminal
    if (code !== 0 || !raw) {
        console.error("❌ YT-DLP Error:", errorLog); 
        return res.status(500).json({ error: "Video not found or access denied" });
    }

    try {
      const info = JSON.parse(raw);

      const qualities = [...new Set(
        info.formats
          .filter(f => f.height && f.vcodec !== "none")
          .map(f => f.height)
      )].sort((a, b) => b - a);

      let thumb = info.thumbnail;
      if (!thumb && info.thumbnails?.length) {
        thumb = info.thumbnails.at(-1).url;
      }

      // Check if it's YouTube
      const isYouTube = info.extractor.includes("youtube");

      // For FB/Insta, try to get a direct MP4 link for preview
      let previewUrl = null;
      if (!isYouTube) {
          // Try to find an MP4 file
          const mp4 = info.formats.find(f => f.ext === 'mp4' && f.acodec !== 'none');
          previewUrl = mp4 ? mp4.url : null;
      }

      res.json({
        title: info.title,
        platform: info.extractor_key,
        qualities,
        thumbnail: thumb,
        preview: previewUrl 
      });

    } catch (e) {
      console.error("Parse Error:", e);
      res.status(500).json({ error: "Server parse error" });
    }
  });
};

/* ───────── DOWNLOAD ───────── */
exports.startDownload = (req, res) => {
  const { url, quality, jobId, title, format } = req.body;
  if (!url || !jobId) return res.status(400).json({ error: "Missing fields" });

  const out = path.join(__dirname, "..", `${jobId}.%(ext)s`);

  jobs[jobId] = {
    progress: 0,
    status: "starting",
    filePath: null,
    title,
    startTime: Date.now()
  };

  const args = [
      "--force-ipv4", 
      "--no-playlist", 
      "--newline", 
      "-o", out
  ];

  // 🟢 YOUTUBE FIX
  if (url.includes("youtube.com") || url.includes("youtu.be")) {
    args.push("--extractor-args", "youtube:player_client=android");
  }

  if (format === "audio") {
    args.push("-x", "--audio-format", "mp3");
  } else {
    // 🟢 MOBILE AUDIO FIX (Recode to MP4)
    if (quality) {
       args.push("-f", `bestvideo[height<=${quality}]+bestaudio/best[height<=${quality}]/best`);
    } else {
       args.push("-f", "bestvideo+bestaudio/best");
    }
    args.push("--recode-video", "mp4");
  }

  args.push(url);

  const yt = spawn(YTDLP_BIN, args);

  yt.stdout.on("data", d => {
    const m = d.toString().match(/(\d+\.\d+)%/);
    if (m) jobs[jobId].progress = Number(m[1]);
  });

  yt.on("close", () => {
    const dir = path.join(__dirname, "..");
    const file = fs.readdirSync(dir).find(f => f.startsWith(jobId));
    if (file) {
      jobs[jobId].filePath = path.join(dir, file);
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

  const t = setInterval(() => {
    const job = jobs[jobId];
    if (!job) {
      res.write(`data: ${JSON.stringify({status:"error"})}\n\n`);
      clearInterval(t);
      return;
    }
    res.write(`data: ${JSON.stringify(job)}\n\n`);
    if (job.status === "done" || job.status === "error") {
      clearInterval(t);
      res.end();
    }
  }, 500);
};

/* ───────── FILE ───────── */
exports.downloadFile = (req, res) => {
  const { jobId } = req.params;
  const job = jobs[jobId];

  if (!job?.filePath || !fs.existsSync(job.filePath)) {
    return res.status(404).send("File not found");
  }

  const safe = job.title.replace(/[^a-z0-9 _-]/gi, "_");
  const ext = path.extname(job.filePath);

  res.download(job.filePath, `${safe}${ext}`, () => {
    try { fs.unlinkSync(job.filePath); } catch {}
    delete jobs[jobId];
  });
};