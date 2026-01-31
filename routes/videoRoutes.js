const express = require("express");
const router = express.Router();

const {
  getInfo,
  startDownload,
  getProgress,
  downloadFile
} = require("../controllers/videoController");

router.post("/info", getInfo);
router.post("/download", startDownload);
router.get("/progress/:jobId", getProgress);
router.get("/file/:jobId", downloadFile);

module.exports = router;
