const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

// ⚠️ UPDATE THIS PATH TO YOUR YT-DLP LOCATION
const YTDLP_PATH = "C:\\Users\\suvro\\AppData\\Local\\Programs\\Python\\Python311\\Scripts\\yt-dlp.exe";

// 🟢 QUEUE SYSTEM STORAGE
const jobs = {};

// 🟢 QUEUE JANITOR (Cleans up old jobs every 10 mins)
setInterval(() => {
  const now = Date.now();
  Object.keys(jobs).forEach(id => {
    // If job is older than 1 hour, delete it to free memory
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

  const yt = spawn(YTDLP_PATH, ["--js-runtime", "node", "--force-ipv4", "-J", "--no-playlist", url]);
  let raw = "";

  yt.stdout.on("data", (d) => (raw += d.toString()));
  yt.stderr.on("data", (d) => console.error(`[Info Error] ${d.toString()}`));

  yt.on("close", (code) => {
    if (code !== 0 || !raw) return res.status(500).json({ error: "Failed to fetch info" });

    try {
      const info = JSON.parse(raw);
      // Extract Qualities
      const qualities = [...new Set(
        info.formats
          .filter((f) => f.height && f.vcodec !== "none")
          .map((f) => f.height)
      )].sort((a, b) => b - a);

      // Find Preview Video (Small MP4)
      const previewFormat = info.formats.find((f) => 
        f.ext === "mp4" && f.vcodec !== "none" && 
        f.protocol === "https" && 
        (f.filesize < 20000000 || !f.filesize)
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
  
  // 🟢 INITIALIZE JOB IN QUEUE
  jobs[jobId] = { 
    progress: 0, 
    status: "starting", 
    msg: "Initializing...", 
    filePath: null, 
    title: title || "video_download",
    startTime: Date.now() 
  };

  const args = ["--js-runtime", "node", "--force-ipv4", "--newline", "--no-playlist", "-o", outputPath];

  if (format === 'audio') {
    args.push('-x', '--audio-format', 'mp3'); 
    jobs[jobId].msg = "Extracting Audio (MP3)...";
  } else {
    args.push("-f", `bestvideo[height<=${quality}]+bestaudio/best`);
    args.push("--merge-output-format", "mp4");
    jobs[jobId].msg = "Downloading Video...";
  }

  args.push(url);

  // 🟢 SPAWN PROCESS
  const yt = spawn(YTDLP_PATH, args);

  // 🟢 CATCH STARTUP ERRORS (Fixes "Stuck" issues)
  yt.on("error", (err) => {
    console.error("Spawn Error:", err);
    jobs[jobId].status = "error";
    jobs[jobId].msg = "Engine Error";
  });

  yt.stdout.on("data", (d) => {
    const text = d.toString();
    // Parse Progress
    if (text.includes("[download]")) {
      const match = text.match(/(\d+\.\d+)%/);
      if (match) jobs[jobId].progress = Number(match[1]);
      jobs[jobId].status = "downloading";
      jobs[jobId].msg = format === 'audio' ? "Processing Audio..." : "Downloading Video...";
    }
    // Capture File Path
    if (text.includes("Destination:")) {
        const fileMatch = text.match(/Destination: (.+)$/m);
        if (fileMatch) jobs[jobId].filePath = fileMatch[1];
    }
    // Handle "Already Downloaded"
    if (text.includes("has already been downloaded")) {
        const fileMatch = text.match(/\[download\] (.+) has already been downloaded/);
        if (fileMatch) jobs[jobId].filePath = fileMatch[1];
        jobs[jobId].progress = 100;
    }
  });

  yt.on("close", (code) => {
    const dir = path.join(__dirname, "..");
    const files = fs.readdirSync(dir);
    // Robust File Finder
    const found = files.find(f => f.startsWith(jobId));
    
    if (found) {
        jobs[jobId].filePath = path.join(dir, found);
        jobs[jobId].status = "done";
        jobs[jobId].msg = "Ready for Download";
        jobs[jobId].progress = 100;
    } else {
        console.error(`Job ${jobId} failed with code ${code}`);
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
      delete jobs[jobId]; // 🟢 Remove from queue after download
    }
  });
};