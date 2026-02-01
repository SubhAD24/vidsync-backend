const express = require("express");
const router = express.Router();
const controller = require("../controllers/videoController");

router.post("/info", controller.getInfo);
router.post("/download", controller.startDownload);
router.get("/progress/:jobId", controller.getProgress);
router.get("/file/:jobId", controller.downloadFile);

module.exports = router;
