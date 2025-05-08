const express = require("express");
const axios = require("axios");
const fs = require("fs");
const { v4: uuidv4 } = require("uuid");
const cloudinary = require("cloudinary").v2;
const { exec, execSync } = require("child_process");
const path = require("path");

const app = express();
app.use(express.json());

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// 🔧 CHANGE THIS to adjust silence gap (in seconds)
const SILENCE_DURATION = 0.25;

app.post("/merge-audio", async (req, res) => {
  console.log("🟡 Incoming request");
  console.log("📦 Raw body:", req.body);

  const { files, outputName, bitrate } = req.body;
  const tempDir = `temp_${uuidv4()}`;
  let paths = [];

  try {
    fs.mkdirSync(tempDir);
    for (let i = 0; i < files.length; i++) {
      const filePath = path.join(tempDir, `part${i}.mp3`);
      console.log(`⬇️ Downloading: ${files[i]}`);
      const response = await axios.get(files[i], { responseType: "stream" });

      const writer = fs.createWriteStream(filePath);
      response.data.pipe(writer);

      await new Promise((resolve, reject) => {
        writer.on("finish", () => {
          console.log(`✅ Saved: ${filePath}`);
          resolve();
        });
        writer.on("error", (err) => {
          console.error(`❌ Error saving ${filePath}`, err.message);
          reject(err);
        });
      });

      paths.push(filePath);
    }

    const listFile = path.join(tempDir, "list.txt");

    // 🔇 Always generate silence
    const silencePath = path.join(tempDir, "silence.mp3");
    execSync(`ffmpeg -f lavfi -i anullsrc=r=44100:cl=mono -t ${SILENCE_DURATION} -q:a 9 -acodec libmp3lame ${silencePath}`);
    console.log(`🎧 Generated ${SILENCE_DURATION}s silence.mp3`);

    // 🔁 Interleave silence between tracks
    let pathsWithGaps = [];
    for (let i = 0; i < paths.length; i++) {
      pathsWithGaps.push(paths[i]);
      if (i < paths.length - 1) {
        pathsWithGaps.push(silencePath);
      }
    }

    fs.writeFileSync(
      listFile,
      pathsWithGaps.map(p => `file '${path.basename(p)}'`).join("\n")
    );

    const bitrateArg = bitrate ? `-b:a ${bitrate}` : "";
    const cmd = `cd ${tempDir} && ffmpeg -f concat -safe 0 -i list.txt -c copy ${bitrateArg} ${outputName}`;

    console.log("🎬 Running FFmpeg...");
    await new Promise((resolve, reject) => {
      exec(cmd, (error) => {
        if (error) {
          console.error("🔥 FFmpeg error:", error.message);
          reject(error);
        } else {
          console.log("✅ FFmpeg completed");
          resolve();
        }
      });
    });

    const result = await cloudinary.uploader.upload(path.join(tempDir, outputName), {
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
