const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

// ⚠️ UPDATE THIS PATH IF NEEDED
const YTDLP_PATH = "C:\\Users\\suvro\\AppData\\Local\\Programs\\Python\\Python311\\Scripts\\yt-dlp.exe";

const jobs = {};

// Clean up old files
setInterval(() => {
  const now = Date.now();
  Object.keys(jobs).forEach(id => {
    if (now - jobs[id].startTime > 3600000) {
      if (jobs[id].filePath && fs.existsSync(jobs[id].filePath)) {
        try { fs.unlinkSync(jobs[id].filePath); } catch (e) {}
      }
      delete jobs[id];
    }
  });
}, 600000);

exports.getInfo = (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: "URL missing" });

  const args = [
    "--force-ipv4",
    "--no-playlist",
    "-J",
    url
  ];

  // YouTube Fix for "Sign in to confirm you're not a bot"
  if (url.includes("youtube") || url.includes("youtu.be")) {
     args.push("--extractor-args", "youtube:player_client=android");
  }

  const yt = spawn(YTDLP_PATH, args);
  let raw = "";

  yt.stdout.on("data", (d) => (raw += d.toString()));
  yt.stderr.on("data", (d) => console.error(`[Info Error] ${d.toString()}`));

  yt.on("close", (code) => {
    if (code !== 0 || !raw) return res.status(500).json({ error: "Failed to fetch info" });

    try {
      const info = JSON.parse(raw);
      
      const qualities = [...new Set(
        info.formats
          .filter((f) => f.height && f.vcodec !== "none")
          .map((f) => f.height)
      )].sort((a, b) => b - a);

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
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Parse error" });
    }
  });
};

exports.startDownload = (req, res) => {
  const { url, quality, jobId, title, format } = req.body;
  
  if (!url || !jobId) return res.status(400).json({ error: "Missing fields" });

  const outputPath = path.join(__dirname, "..", `${jobId}.%(ext)s`);
  
  jobs[jobId] = { 
    progress: 0, 
    status: "starting", 
    msg: "Initializing...", 
    filePath: null, 
    title: title || "video_download",
    startTime: Date.now() 
  };

  const args = ["--js-runtime", "node", "--force-ipv4", "--newline", "--no-playlist", "-o", outputPath];

  // YouTube Fix for Download
  if (url.includes("youtube") || url.includes("youtu.be")) {
    args.push("--extractor-args", "youtube:player_client=android");
  }

  if (format === 'audio') {
    args.push('-x', '--audio-format', 'mp3'); 
    jobs[jobId].msg = "Extracting Audio (MP3)...";
  } else {
    // 🟢 SAFE UNIVERSAL DOWNLOAD MODE
    // 1. "best" ensures we get the pre-merged video+audio if available (Fixes FB/Insta Sound)
    // 2. If quality is selected, we try to merge best video + best audio
    if (quality) {
        args.push("-f", `bestvideo[height<=${quality}]+bestaudio/best[height<=${quality}]/best`);
    } else {
        args.push("-f", "bestvideo+bestaudio/best");
    }

    // 🟢 FORCE RE-ENCODE TO MP4 (Fixes "Black Screen" / "No Audio" on Mobile)
    // This ensures the final file is ALWAYS a standard MP4 with AAC audio
    args.push("--recode-video", "mp4");

    jobs[jobId].msg = "Downloading Video...";
  }

  args.push(url);

  const yt = spawn(YTDLP_PATH, args);

  yt.on("error", (err) => {
    console.error("Spawn Error:", err);
    jobs[jobId].status = "error";
    jobs[jobId].msg = "Engine Error";
  });

  yt.stdout.on("data", (d) => {
    const text = d.toString();
    if (text.includes("[download]")) {
      const match = text.match(/(\d+\.\d+)%/);
      if (match) jobs[jobId].progress = Number(match[1]);
      jobs[jobId].status = "downloading";
      
      // Update message for recoding phase
      if (jobs[jobId].progress === 100) jobs[jobId].msg = "Finalizing (Fixing Audio)...";
      else jobs[jobId].msg = format === 'audio' ? "Processing Audio..." : "Downloading Video...";
    }
    if (text.includes("Destination:")) {
        const fileMatch = text.match(/Destination: (.+)$/m);
        if (fileMatch) jobs[jobId].filePath = fileMatch[1];
    }
    if (text.includes("has already been downloaded")) {
        const fileMatch = text.match(/\[download\] (.+) has already been downloaded/);
        if (fileMatch) jobs[jobId].filePath = fileMatch[1];
        jobs[jobId].progress = 100;
    }
  });

  yt.on("close", (code) => {
    const dir = path.join(__dirname, "..");
    const files = fs.readdirSync(dir);
    // Find file starting with ID (mp3 or mp4)
    const found = files.find(f => f.startsWith(jobId));
    
    if (found) {
        jobs[jobId].filePath = path.join(dir, found);
        jobs[jobId].status = "done";
        jobs[jobId].msg = "Ready for Download";
        jobs[jobId].progress = 100;
    } else {
        jobs[jobId].status = "error";
    }
  });

  res.json({ started: true });
};

exports.getProgress = (req, res) => {
  const { jobId } = req.params;
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const timer = setInterval(() => {
    const job = jobs[jobId];
    if (!job) {
       res.write(`data: ${JSON.stringify({ status: "error" })}\n\n`);
       return clearInterval(timer);
    }
    res.write(`data: ${JSON.stringify(job)}\n\n`);
    if (job.status === "done" || job.status === "error") {
      clearInterval(timer);
      res.end();
    }
  }, 500); 
};

exports.downloadFile = (req, res) => {
  const { jobId } = req.params;
  const job = jobs[jobId];
  if (!job || !fs.existsSync(job.filePath)) return res.status(404).send("File lost");
  
  const safeTitle = job.title.replace(/[^a-z0-9 \-_]/gi, '_').trim();
  const extension = path.extname(job.filePath); 
  const downloadName = `${safeTitle}${extension}`;

  res.download(job.filePath, downloadName, (err) => {
    if (!err) {
      try { fs.unlinkSync(job.filePath); } catch(e){}
      delete jobs[jobId];
    }
  });
};