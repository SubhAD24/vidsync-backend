const express = require("express");
const router = express.Router();
const { downloadVideo } = require("../controllers/downloadController");

router.post("/download", downloadVideo);

module.exports = router;
