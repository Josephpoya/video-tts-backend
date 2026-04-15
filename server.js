// 1. IMPORTS first
import express from "express";
import multer from "multer";
import fs from "fs";
import { execSync } from "child_process";
import fetch from "node-fetch";
import cors from "cors";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from 'url';
import rateLimit from 'express-rate-limit';

// 2. CONFIGURATION
dotenv.config();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 3. CREATE APP (THIS WAS MISSING BEFORE YOUR NEW ENDPOINT)
const app = express();
const PORT = process.env.PORT || 5000;

// 4. MIDDLEWARE
app.use(cors({
  origin: [
    'http://localhost:3000',
    'http://localhost:5173',
    'https://frontend-poya.vercel.app',
    'https://*.vercel.app'
  ],
  credentials: true
}));
app.use(express.json());

// 5. RATE LIMITING
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Too many requests, please try again later.' }
});

// 6. TEMP DIRECTORY
const TEMP_DIR = '/tmp/video-tts';
if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

// 7. MULTER CONFIGURATION
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, TEMP_DIR);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({ 
  storage: storage,
  limits: { fileSize: 100 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['video/mp4', 'video/mov', 'video/avi', 'video/mkv', 'video/webm'];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid video format'));
    }
  }
});

// 8. FFMPEG CHECK
try {
  execSync("ffmpeg -version", { stdio: 'ignore' });
  console.log("✅ FFmpeg is available");
} catch (error) {
  console.error("❌ FFmpeg is not installed");
}

// 9. HEALTH CHECK ENDPOINT (PUT THIS FIRST)
app.get("/api/health", (req, res) => {
  res.json({ 
    status: "ok", 
    ffmpeg: true,
    timestamp: new Date().toISOString(),
    temp_dir: TEMP_DIR,
    node_env: process.env.NODE_ENV
  });
});

// 10. NEW ENDPOINT FOR PUTER (WITH AUDIO FILE)
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

    console.log(`Processing video: ${req.files['video'][0].originalname}`);
    console.log(`Audio size: ${(req.files['audio'][0].size / 1024).toFixed(2)} KB`);

    // Merge audio and video
    execSync(
      `ffmpeg -i ${videoPath} -i ${audioPath} -c:v copy -c:a aac -map 0:v:0 -map 1:a:0 -shortest -y ${outputPath}`,
      { stdio: 'pipe' }
    );
    
    console.log("✅ Video merged successfully");
    
    res.download(outputPath, "synced_video.mp4", (err) => {
      if (err) console.error("Download error:", err);
      // Cleanup
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

// 11. ORIGINAL ENDPOINT (FOR OPENAI - KEEP FOR BACKWARD COMPATIBILITY)
app.post("/api/process", upload.single("video"), async (req, res) => {
  // ... your existing code ...
});

// 12. 404 HANDLER
app.use((req, res) => {
  res.status(404).json({ error: "Endpoint not found" });
});

// 13. ERROR HANDLER
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: "Something went wrong!" });
});

// 14. START SERVER
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📁 Temp directory: ${TEMP_DIR}`);
});