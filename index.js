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

const getAudioDuration = (filePath) => {
  return new Promise((resolve, reject) => {
    exec(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${filePath}"`, (error, stdout) => {
      if (error) reject(error);
      else resolve(parseFloat(stdout.trim()));
    });
  });
};

app.post("/merge-audio", async (req, res) => {
  console.log("🟡 Incoming request");
  console.log("📦 Raw body:", req.body);

  const { files, outputName } = req.body;

  const silenceMs = 300;
  const fadeMs = 150;
  const compression = true;

  const compressor = compression
    ? "acompressor=threshold=-40dB:ratio=20:attack=1:release=50:makeup=15"
    : "";

  const tempDir = `temp_${uuidv4()}`;
  let finalInputs = [];

  try {
    fs.mkdirSync(tempDir);

    for (let i = 0; i < files.length; i++) {
      const filePath = path.join(tempDir, `part${i}.mp3`);
      const fadePath = path.join(tempDir, `fade${i}.wav`);
      const silencePath = path.join(tempDir, `silence${i}.wav`);

      const response = await axios.get(files[i], { responseType: "stream" });
      const writer = fs.createWriteStream(filePath);
      response.data.pipe(writer);

      await new Promise((resolve, reject) => {
        writer.on("finish", resolve);
        writer.on("error", reject);
      });

      const duration = await getAudioDuration(filePath);
      const fadeOutStart = Math.max(0, duration - fadeMs / 1000);

      const fadeCmd = `ffmpeg -i "${filePath}" -af "afade=t=in:st=0:d=${fadeMs / 1000},afade=t=out:st=${fadeOutStart.toFixed(2)}:d=${fadeMs / 1000}" -ar 44100 -ac 2 -y "${fadePath}"`;
      await new Promise((resolve, reject) => {
        exec(fadeCmd, (err) => (err ? reject(err) : resolve()));
      });
      finalInputs.push(fadePath);

      if (silenceMs > 0 && i < files.length - 1) {
        const silenceCmd = `ffmpeg -f lavfi -i anullsrc=channel_layout=stereo:sample_rate=44100 -t ${silenceMs / 1000} -y "${silencePath}"`;
        await new Promise((resolve, reject) => {
          exec(silenceCmd, (err) => (err ? reject(err) : resolve()));
        });
        finalInputs.push(silencePath);
      }
    }

    const inputArgs = finalInputs.map((file) => `-i "${file}"`).join(" ");
    const concatFilter = `concat=n=${finalInputs.length}:v=0:a=1${compressor ? "," + compressor : ""}`;
    const finalPath = path.join(tempDir, outputName);

    const ffmpegCmd = `ffmpeg ${inputArgs} -filter_complex "${concatFilter}" -acodec libmp3lame -y "${finalPath}"`;
    console.log("🎬 Running FFmpeg with:", ffmpegCmd);

    await new Promise((resolve, reject) => {
      exec(ffmpegCmd, (error) => (error ? reject(error) : resolve()));
    });

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
