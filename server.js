const express = require("express");
const cors = require("cors");
const video = require("./controllers/videoController");

const app = express();

app.use(cors());
app.use(express.json());

app.post("/api/info", video.getInfo);
app.post("/api/download", video.startDownload);
app.get("/api/progress/:jobId", video.getProgress);
app.get("/api/file/:jobId", video.downloadFile);

// ✅ THIS FIXES RAILWAY
const PORT = process.env.PORT || 5000;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ Backend running on port ${PORT}`);
});
