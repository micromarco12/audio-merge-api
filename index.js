const express = require("express");
const axios = require("axios");
const fs = require("fs");
const { v4: uuidv4 } = require("uuid");
const cloudinary = require("cloudinary").v2;
const { exec } = require("child_process");
const path = require("path");

const app = express();
app.use(express.json());

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

app.post("/merge-audio", async (req, res) => {
  console.log("🟡 Incoming request");
  console.log("📦 Raw body:", req.body);

  const { files, outputName } = req.body;

  // Hardcoded settings
  const silenceMs = 300;         // Add 300ms of silence between clips
  const fadeMs = 150;            // Add 150ms fade in/out per clip
  const compression = true;      // Enable FFmpeg compression

  const compressor = compression
    ? "acompressor=threshold=-20dB:ratio=3:attack=10:release=200:makeup=4"
    : "";

  const tempDir = `temp_${uuidv4()}`;
  let finalInputs = [];

  try {
    fs.mkdirSync(tempDir);

    for (let i = 0; i < files.length; i++) {
      const filePath = path.join(tempDir, `part${i}.mp3`);
      const fadePath = path.join(tempDir, `fade${i}.wav`);
      const silencePath = path.join(tempDir, `silence${i}.wav`);

      // Download file
      const response = await axios.get(files[i], { responseType: "stream" });
      const writer = fs.createWriteStream(filePath);
      response.data.pipe(writer);

      await new Promise((resolve, reject) => {
        writer.on("finish", resolve);
        writer.on("error", reject);
      });

      // Apply fade in/out
      await new Promise((resolve, reject) => {
        const fadeCmd = `ffmpeg -i ${filePath} -af "afade=t=in:st=0:d=${fadeMs / 1000},afade=t=out:st=0:d=${fadeMs / 1000}" -ar 44100 -ac 2 -y ${fadePath}`;
        exec(fadeCmd, (err) => (err ? reject(err) : resolve()));
      });
      finalInputs.push(fadePath);

      // Add silence after, except last file
      if (silenceMs > 0 && i < files.length - 1) {
        await new Promise((resolve, reject) => {
          const silenceCmd = `ffmpeg -f lavfi -i anullsrc=channel_layout=stereo:sample_rate=44100 -t ${silenceMs / 1000} -y ${silencePath}`;
          exec(silenceCmd, (err) => (err ? reject(err) : resolve()));
        });
        finalInputs.push(silencePath);
      }
    }

    // Build input args and concat filter
    const inputArgs = finalInputs.map((file, i) => `-i ${file}`).join(" ");
    const concatFilter = `concat=n=${finalInputs.length}:v=0:a=1${compressor ? "," + compressor : ""}`;
    const finalPath = path.join(tempDir, outputName);

    const ffmpegCmd = `ffmpeg ${inputArgs} -filter_complex "${concatFilter}" -acodec libmp3lame -y ${finalPath}`;
    console.log("🎬 Running FFmpeg with:", ffmpegCmd);

    await new Promise((resolve, reject) => {
      exec(ffmpegCmd, (error) => (error ? reject(error) : resolve()));
    });

    // Upload to Cloudinary
    const result = await cloudinary.uploader.upload(finalPath, {
      resource_type: "video",
      folder: "audio-webflow",
      public_id: outputName.replace(".mp3", ""),
    });

    console.log("☁️ Uploaded to Cloudinary");

    try {
      const cleanup = await cloudinary.api.delete_resources_by_prefix("FFmpeg-converter/", {
        resource_type: "video",
        invalidate: true
      });
      console.log("🧹 Deleted chunked files:", cleanup);
    } catch (cleanupError) {
      console.error("❌ Cloudinary cleanup failed:", cleanupError.message);
    }

    res.json({ finalUrl: result.secure_url });

  } catch (err) {
    console.error("🔥 Server error:", err.message);
    res.status(500).json({ error: err.message });
  } finally {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
      console.log("🧹 Temp files cleaned up");
    } catch (cleanupErr) {
      console.warn("⚠️ Cleanup failed:", cleanupErr.message);
    }
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🟢 Server running on port ${PORT}`));
