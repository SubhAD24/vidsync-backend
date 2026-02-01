const express = require("express");
const cors = require("cors");
const videoRoutes = require("./routes/videoRoutes");

const app = express();
app.use(cors());
app.use(express.json());

app.use("/api", videoRoutes);

const PORT = process.env.PORT || 8080;
app.listen(PORT, () =>
  console.log("🚀 Backend running on port", PORT)
);
