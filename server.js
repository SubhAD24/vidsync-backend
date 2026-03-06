const express = require("express");
const cors = require("cors");
const video = require("./controllers/videoController");

const app = express();

// Allows your Vercel/Netlify frontend to talk to Render
app.use(cors());
app.use(express.json());

// ✅ Add a "Health Check" so you can see "Server is Live" in your browser
app.get("/", (req, res) => {
  res.send("🚀 VidSync Backend is Live and Awake!");
});

// Your existing routes
app.post("/api/info", video.getInfo);
app.post("/api/download", video.startDownload);
app.get("/api/progress/:jobId", video.getProgress);
app.get("/api/file/:jobId", video.downloadFile);

// ✅ Render provides the PORT automatically
const PORT = process.env.PORT || 5000;

// Remove "0.0.0.0" if it causes issues; Render handles the binding automatically.
app.listen(PORT, () => {
  console.log(`✅ VidSync running on port ${PORT}`);
});
