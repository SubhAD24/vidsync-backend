const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

const YTDLP =
 spawn("yt-dlp", [
  "--js-runtime", "node",
  "--no-playlist",
  "--merge-output-format", "mp4",
  "-f", format,
  "-o", "-",
  url
]);


exports.downloadVideo = (req, res) => {
  const { url } = req.body;

  if (!url) {
    return res.status(400).json({ error: "URL missing" });
  }

  const output = path.join(__dirname, `video_${Date.now()}.mp4`);

  console.log("STARTING DOWNLOAD:", url);

  const yt = spawn(YTDLP, [
    "--js-runtime",
    "node",
    "-f",
    "bestvideo+bestaudio/best",
    "--merge-output-format",
    "mp4",
    "-o",
    output,
    url,
  ]);

  yt.stderr.on("data", (d) => console.log(d.toString()));

  yt.on("close", (code) => {
    if (code !== 0 || !fs.existsSync(output)) {
      console.log("DOWNLOAD FAILED");
      return res.status(500).json({ error: "Download failed" });
    }

    console.log("DOWNLOAD COMPLETE");

    res.download(output, "video.mp4", () => {
      fs.unlink(output, () => {});
    });
  });
};
