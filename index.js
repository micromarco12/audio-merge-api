const express = require("express");
const app = express();
app.use(express.json());

app.post("/merge-audio", (req, res) => {
  console.log("✅ Basic POST received");
  console.log("📦 Request body:", req.body);

  res.json({ message: "Server is alive and received your test." });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🟢 Server running on port ${PORT}`));