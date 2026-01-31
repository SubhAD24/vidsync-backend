const express = require("express");
const cors = require("cors");
const path = require("path");

// Import the correct routes
const videoRoutes = require("./routes/videoRoutes");

const app = express();

app.use(cors());
app.use(express.json());

// Mount the API routes
app.use("/api", videoRoutes);

// 🟢 MODIFIED: Use environment variable PORT or default to 5000
const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`🚀 Backend running on port ${PORT}`);
});