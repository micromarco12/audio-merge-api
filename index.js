const express = require("express");
const axios = require("axios");
const fs = require("fs");
const { v4: uuidv4 } = require("uuid");
const cloudinary = require("cloudinary").v2;
const { exec } = require("child_process");
const path = require("path");

const app = express();
app.use(express.json());

const config = require("./settings.json");

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const getAudioDuration = (filePath) => {
  return new Promise((resolve, reject) => {
    exec(
      `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${filePath}"`,
      (error, stdout) => {
        if (error) reject(error);
        else resolve(parseFloat(stdout.trim()));
      }
    );
  });
};

const getCompressorPreset = (presetName) => {
  switch ((presetName || "").toLowerCase()) {
    case "light":
      return "acompressor=threshold=-15dB:ratio=2:attack=20:release=300:makeup=2";
    case "radio":
      return "acompressor=threshold=-20dB:ratio=4:attack=10:release=250:makeup=4";
    case "crushed":
      return "acompressor=threshold=-40dB:ratio=20:attack=1:release=50:makeup=15";
    default:
      return "acompressor=threshold=-18dB:ratio=3:attack=15:release=200:makeup=3";
  }
};

app.post("/merge-audio", async (req, res) => {
  console.log("🟡 Incoming request");
  console.log("📦 Raw body:", req.body);

  const { files, outputName, outputFormat, bitrate } = req.body;

  const {
    silenceMs = 300,
    fadeMs = 150,
    preset = "normal",
    applyCompression = true,
    outputChannels = 2,
    processingEnabled = true
  } = config;

  const tempDir = `temp_${uuidv4()}`;
  fs.mkdirSync(tempDir);
  let finalPath = "";

  try {
    const detectedExt = path.extname(files[0]).toLowerCase().replace(".", "") || "mp3";
    const targetExt = ["mp3", "wav"].includes((outputFormat || "").toLowerCase()) ? outputFormat.toLowerCase() : detectedExt;
    const audioCodec = targetExt === "wav" ? "pcm_s16le" : "libmp3lame";
    const bitrateOption = targetExt === "mp3" ? `-b:a ${bitrate || "192k"} -compression_level 0 -write_xing 0 -abr 0` : "";

    finalPath = path.join(tempDir, `${outputName.replace(/\.(mp3|wav)?$/, "")}.${targetExt}`);

    if (!processingEnabled) {
      const fileList = [];

      for (let i = 0; i < files.length; i++) {
        const inputPath = path.join(tempDir, `raw${i}.${detectedExt}`);
        const cleanPath = path.join(tempDir, `part${i}.${detectedExt}`);

        const response = await axios.get(files[i], { responseType: "stream" });
        const writer = fs.createWriteStream(inputPath);
        response.data.pipe(writer);
        await new Promise((resolve, reject) => {
          writer.on("finish", resolve);
          writer.on("error", reject);
        });

        // Clean the file via re-encode
        const fixCmd = `ffmpeg -y -i "${inputPath}" -ar 44100 -ac 1 "${cleanPath}"`;
        await new Promise((resolve, reject) => {
          exec(fixCmd, (err) => (err ? reject(err) : resolve()));
        });

        fileList.push(`part${i}.${detectedExt}`);
      }

      const listFilePath = path.join(tempDir, "list.txt");
      fs.writeFileSync(listFilePath, fileList.map(f => `file '${f}'`).join("\n"));

      const rawMergeCmd = `cd ${tempDir} && ffmpeg -f concat -safe 0 -i list.txt -acodec ${audioCodec} ${bitrateOption} -y "${path.basename(finalPath)}"`;
      console.log("🧵 Raw merge:", rawMergeCmd);
      await new Promise((resolve, reject) => {
        exec(rawMergeCmd, (err, stdout, stderr) => {
          console.log(stderr);
          err ? reject(err) : resolve();
        });
      });

    } else {
      const compressor = applyCompression ? getCompressorPreset(preset) : "";
      let finalInputs = [];

      for (let i = 0; i < files.length; i++) {
        const inputPath = path.join(tempDir, `raw${i}.${detectedExt}`);
        const cleanPath = path.join(tempDir, `clean${i}.wav`);
        const fadePath = path.join(tempDir, `fade${i}.wav`);
        const silencePath = path.join(tempDir, `silence${i}.wav`);

        const response = await axios.get(files[i], { responseType: "stream" });
        const writer = fs.createWriteStream(inputPath);
        response.data.pipe(writer);
        await new Promise((resolve, reject) => {
          writer.on("finish", resolve);
          writer.on("error", reject);
        });

        // Clean the input
        const fixCmd = `ffmpeg -y -i "${inputPath}" -ar 44100 -ac ${outputChannels} "${cleanPath}"`;
        await new Promise((resolve, reject) => {
          exec(fixCmd, (err) => (err ? reject(err) : resolve()));
        });

        const duration = await getAudioDuration(cleanPath);
        const fadeOutStart = Math.max(0, duration - fadeMs / 1000);
        const fadeCmd = `ffmpeg -i "${cleanPath}" -af "afade=t=in:st=0:d=${fadeMs / 1000},afade=t=out:st=${fadeOutStart.toFixed(2)}:d=${fadeMs / 1000}" -ar 44100 -ac ${outputChannels} -y "${fadePath}"`;
        await new Promise((resolve, reject) => {
          exec(fadeCmd, (err) => (err ? reject(err) : resolve()));
        });

        finalInputs.push(fadePath);

        if (silenceMs > 0 && i < files.length - 1) {
          const channelLayout = outputChannels === 1 ? "mono" : "stereo";
          const silenceCmd = `ffmpeg -f lavfi -i anullsrc=channel_layout=${channelLayout}:sample_rate=44100 -t ${silenceMs / 1000} -y "${silencePath}"`;
          await new Promise((resolve, reject) => {
            exec(silenceCmd, (err) => (err ? reject(err) : resolve()));
          });
          finalInputs.push(silencePath);
        }
      }

      const inputArgs = finalInputs.map(f => `-i "${f}"`).join(" ");
      const concatFilter = `concat=n=${finalInputs.length}:v=0:a=1${compressor ? "," + compressor : ""}`;
      const fullCmd = `ffmpeg ${inputArgs} -filter_complex "${concatFilter}" -acodec ${audioCodec} ${bitrateOption} -y "${finalPath}"`;

      console.log("🎬 Full processing FFmpeg:", fullCmd);
      await new Promise((resolve, reject) => {
        exec(fullCmd, (err, stdout, stderr) => {
          console.log(stderr);
          err ? reject(err) : resolve();
        });
      });
    }

    const result = await cloudinary.uploader.upload(finalPath, {
      resource_type: "video",
      folder: "audio-webflow",
      public_id: outputName.replace(/\.(mp3|wav)$/, ""),
    });

    console.log("☁️ Uploaded to Cloudinary:", result.secure_url);

    try {
      const cleanup = await cloudinary.api.delete_resources_by_prefix("FFmpeg-converter/", {
        resource_type: "video",
        invalidate: true,
      });
      console.log("🧹 Deleted chunked files from Cloudinary:", cleanup);
    } catch (cleanupError) {
      console.error("❌ Cloudinary cleanup failed:", cleanupError.message);
    }

    res.json({ finalUrl: result.secure_url });

  } catch (err) {
    console.error("🔥 Server error:", err.message);
    res.status(500).json({ error: err.message });
  } finally {
    try {
      if (tempDir && fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
        console.log("🧹 Local temp files cleaned up");
      }
    } catch (cleanupErr) {
      console.warn("⚠️ Local cleanup failed:", cleanupErr.message);
    }
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🟢 Server running on port ${PORT}`));
