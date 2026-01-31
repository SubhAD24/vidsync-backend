const express = require("express");
const router = express.Router();

const {
  getInfo,
  startDownload,
  getProgress,
  downloadFile // <--- Make sure this is imported
} = require("../controllers/videoController");

router.post("/info", getInfo);
router.post("/download", startDownload);
router.get("/progress/:jobId", getProgress);
router.get("/file/:jobId", downloadFile); // <--- Make sure this route exists

module.exports = router;