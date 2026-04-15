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

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 5000;

// CORS configuration for Vercel frontend
const allowedOrigins = [
  'http://localhost:3000',
  'http://localhost:5173',
  process.env.FRONTEND_URL,
  'https://*.vercel.app'
].filter(Boolean);

app.use(cors({
  origin: function(origin, callback) {
    if (!origin) return callback(null, true);
    if (allowedOrigins.some(allowed => origin === allowed || origin.endsWith('.vercel.app'))) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true
}));

app.use(express.json());

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // limit each IP to 10 requests per windowMs
  message: { error: 'Too many requests, please try again later.' }
});

app.use('/api/process', limiter);

// Use /tmp for Render (ephemeral storage)
const TEMP_DIR = process.env.NODE_ENV === 'production' 
  ? '/tmp/video-tts'
  : path.join(__dirname, 'temp');

// Ensure temp directory exists
if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

// Configure multer for temp storage
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
  limits: { 
    fileSize: 100 * 1024 * 1024 // 100MB limit
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['video/mp4', 'video/mov', 'video/avi', 'video/mkv', 'video/webm'];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid video format. Please upload MP4, MOV, AVI, MKV, or WEBM.'));
    }
  }
});

// Check FFmpeg
try {
  execSync("ffmpeg -version", { stdio: 'ignore' });
  console.log("✅ FFmpeg is available");
} catch (error) {
  console.error("❌ FFmpeg is not installed or not in PATH");
  if (process.env.NODE_ENV === 'production') {
    console.error("Please ensure FFmpeg is installed on Render");
  }
  // Don't exit in production, just log error
  if (process.env.NODE_ENV !== 'production') {
    process.exit(1);
  }
}

// Cleanup old files every hour
setInterval(() => {
  const now = Date.now();
  fs.readdir(TEMP_DIR, (err, files) => {
    if (err) return;
    files.forEach(file => {
      const filePath = path.join(TEMP_DIR, file);
      fs.stat(filePath, (err, stats) => {
        if (err) return;
        // Delete files older than 1 hour
        if (now - stats.mtimeMs > 3600000) {
          fs.unlink(filePath, () => {});
          console.log(`Cleaned up: ${file}`);
        }
      });
    });
  });
}, 3600000);

// Health check endpoint
app.get("/api/health", (req, res) => {
  res.json({ 
    status: "ok", 
    ffmpeg: true,
    timestamp: new Date().toISOString(),
    temp_dir: TEMP_DIR,
    node_env: process.env.NODE_ENV
  });
});

// Process video endpoint
app.post("/api/process", upload.single("video"), async (req, res) => {
  let videoPath, audioPath, outputPath;
  
  try {
    // Validate inputs
    if (!req.file) {
      return res.status(400).json({ error: "No video file uploaded" });
    }
    if (!req.body.transcript) {
      return res.status(400).json({ error: "No transcript provided" });
    }
    
    const apiKey = req.body.apiKey || process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return res.status(400).json({ error: "OpenAI API key required. Please provide your API key." });
    }

    videoPath = req.file.path;
    audioPath = path.join(TEMP_DIR, `audio_${Date.now()}.mp3`);
    outputPath = path.join(TEMP_DIR, `output_${Date.now()}.mp4`);

    // Clean transcript (remove timestamps like [00:00] or [00:00:00])
    const transcript = req.body.transcript
      .replace(/\[\d{1,2}:\d{2}(?::\d{2})?\]/g, "")
      .replace(/\s+/g, " ")
      .trim();
    
    if (transcript.length === 0) {
      throw new Error("Transcript is empty after cleaning. Please provide valid text.");
    }
    
    if (transcript.length > 4096) {
      console.warn("Transcript too long, truncating to 4096 characters");
    }

    console.log(`Processing video: ${req.file.originalname}`);
    console.log(`File size: ${(req.file.size / 1024 / 1024).toFixed(2)} MB`);
    console.log(`Transcript length: ${transcript.length} chars`);
    console.log(`Transcript preview: ${transcript.substring(0, 100)}...`);

    // Generate TTS with OpenAI
    const ttsRes = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "tts-1",
        voice: "alloy",
        input: transcript.slice(0, 4096),
        speed: 1.0,
      }),
    });

    if (!ttsRes.ok) {
      const errorText = await ttsRes.text();
      console.error("OpenAI API error:", errorText);
      throw new Error(`OpenAI API error: ${ttsRes.status} - ${errorText}`);
    }

    const audioBuffer = await ttsRes.arrayBuffer();
    fs.writeFileSync(audioPath, Buffer.from(audioBuffer));
    console.log("✅ TTS generated successfully");

    // Get audio duration
    const audioDuration = execSync(
      `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 ${audioPath}`
    ).toString().trim();
    console.log(`Audio duration: ${audioDuration}s`);

    // Merge audio and video
    execSync(
      `ffmpeg -i ${videoPath} -i ${audioPath} -c:v copy -c:a aac -map 0:v:0 -map 1:a:0 -shortest -y ${outputPath}`,
      { stdio: 'pipe' }
    );
    
    console.log("✅ Video processing complete");

    // Get output file size
    const outputStats = fs.statSync(outputPath);
    console.log(`Output file size: ${(outputStats.size / 1024 / 1024).toFixed(2)} MB`);

    // Send the processed video
    res.download(outputPath, "synced_video.mp4", (err) => {
      if (err) {
        console.error("Download error:", err);
      }
      // Clean up after download
      [videoPath, audioPath, outputPath].forEach(file => {
        if (file && fs.existsSync(file)) {
          try { 
            fs.unlinkSync(file); 
            console.log(`Cleaned up: ${path.basename(file)}`);
          } catch(e) {
            console.error(`Failed to delete ${file}:`, e);
          }
        }
      });
    });

  } catch (err) {
    console.error("Processing error:", err);
    
    // Clean up files on error
    [videoPath, audioPath, outputPath].forEach(file => {
      if (file && fs.existsSync(file)) {
        try { 
          fs.unlinkSync(file); 
        } catch(e) {}
      }
    });
    
    res.status(500).json({ 
      error: err.message || "Error processing video",
      details: process.env.NODE_ENV === 'development' ? err.stack : undefined
    });
  }
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: "Endpoint not found" });
});

// Error handler
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: "Something went wrong!" });
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  console.log(`📁 Temp directory: ${TEMP_DIR}`);
  console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
});