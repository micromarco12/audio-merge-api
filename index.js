const express = require("express");
const axios = require("axios");
const fs = require("fs");
const { v4: uuidv4 } = require("uuid");
const cloudinary = require("cloudinary").v2;
const { exec } = require("child_process");

const app = express();
app.use(express.json());

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

app.post("/merge-audio", async (req, res) => {
  console.log("✅ Received POST /merge-audio request");

  const { files, outputName } = req.body;
  const tempDir = `temp_${uuidv4()}`;
  fs.mkdirSync(tempDir);


  try {
    const paths = [];
    for (let i = 0; i < files.length; i++) {
      const filePath = `${tempDir}/part${i}.mp3`;
      const response = await axios.get(files[i], { responseType: "stream" });
      const writer = fs.createWriteStream(filePath);
      response.data.pipe(writer);
      await new Promise((resolve, reject) => {
        writer.on("finish", resolve);
        writer.on("error", reject);
      });
      paths.push(filePath);
    }

    const listFile = `${tempDir}/list.txt`;
    fs.writeFileSync(listFile, paths.map(p => `file '${p}'`).join("\n"));


    const outputPath = `${tempDir}/${outputName}`;
    await new Promise((resolve, reject) => {
      exec(`ffmpeg -f concat -safe 0 -i ${listFile} -c copy ${outputPath}`, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });

    const result = await cloudinary.uploader.upload(outputPath, {
      resource_type: "video",
      public_id: outputName.replace(".mp3", ""),
    });

    res.json({ finalUrl: result.secure_url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));