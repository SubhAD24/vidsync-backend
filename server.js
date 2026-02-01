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

app.listen(5000, () => {
  console.log("✅ Server running on http://localhost:5000");
});
