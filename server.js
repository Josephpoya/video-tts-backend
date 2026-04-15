// Add to backend/server.js - new endpoint that accepts audio file directly
app.post("/api/process-with-audio", upload.fields([
  { name: 'video', maxCount: 1 },
  { name: 'audio', maxCount: 1 }
]), async (req, res) => {
  let videoPath, audioPath, outputPath;
  
  try {
    if (!req.files['video'] || !req.files['audio']) {
      return res.status(400).json({ error: "Both video and audio files required" });
    }

    videoPath = req.files['video'][0].path;
    audioPath = req.files['audio'][0].path;
    outputPath = path.join(TEMP_DIR, `output_${Date.now()}.mp4`);

    // Merge audio and video
    execSync(
      `ffmpeg -i ${videoPath} -i ${audioPath} -c:v copy -c:a aac -map 0:v:0 -map 1:a:0 -shortest -y ${outputPath}`,
      { stdio: 'pipe' }
    );
    
    res.download(outputPath, "synced_video.mp4", (err) => {
      if (err) console.error("Download error:", err);
      [videoPath, audioPath, outputPath].forEach(file => {
        if (file && fs.existsSync(file)) {
          try { fs.unlinkSync(file); } catch(e) {}
        }
      });
    });

  } catch (err) {
    console.error("Error:", err);
    res.status(500).json({ error: err.message });
    [videoPath, audioPath, outputPath].forEach(file => {
      if (file && fs.existsSync(file)) {
        try { fs.unlinkSync(file); } catch(e) {}
      }
    });
  }
});