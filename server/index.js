import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import fetch from "node-fetch";
import { GoogleAuth } from "google-auth-library";
import { Storage } from "@google-cloud/storage";
import { v4 as uuidv4 } from "uuid";
import fs from "fs";
import path from "path";

const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: "10mb" }));

// 🔹 CONFIG
const PROJECT_ID = "your-project-id";          // replace
const LOCATION = "us-central1";                // Imagen & Gemini usually here
const SERVICE_ACCOUNT_KEY = "./service-account.json";
const BUCKET_NAME = "your-bucket-name";        // replace with GCS bucket

// Auth setup
const auth = new GoogleAuth({
  keyFile: SERVICE_ACCOUNT_KEY,
  scopes: ["https://www.googleapis.com/auth/cloud-platform"],
});

// GCS
const storage = new Storage({ keyFilename: SERVICE_ACCOUNT_KEY });
const bucket = storage.bucket(BUCKET_NAME);

// Helper: get access token
async function getAccessToken() {
  const client = await auth.getClient();
  const tokenResponse = await client.getAccessToken();
  return tokenResponse.token;
}

// ===== TEXT GENERATION =====
app.post("/api/generate-text", async (req, res) => {
  try {
    const { prompt } = req.body;
    const token = await getAccessToken();

    const response = await fetch(
      `https://${LOCATION}-aiplatform.googleapis.com/v1/projects/${PROJECT_ID}/locations/${LOCATION}/publishers/google/models/gemini-1.5-flash:generateContent`,
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
        }),
      }
    );

    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ===== IMAGEN (with GCS upload + auto cleanup) =====
app.post("/api/generate-image", async (req, res) => {
  try {
    const { prompt } = req.body;
    const token = await getAccessToken();

    // Call Imagen
    const response = await fetch(
      `https://${LOCATION}-aiplatform.googleapis.com/v1/projects/${PROJECT_ID}/locations/${LOCATION}/publishers/google/models/imagegeneration:predict`,
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          instances: [{ prompt }],
          parameters: { sampleCount: 1, aspectRatio: "1:1" },
        }),
      }
    );

    const data = await response.json();
    if (!data.predictions || !data.predictions[0]?.bytesBase64Encoded) {
      throw new Error("No image returned from Vertex AI");
    }

    const base64Img = data.predictions[0].bytesBase64Encoded;
    const buffer = Buffer.from(base64Img, "base64");

    // Save to GCS
    const filename = `imagen-${uuidv4()}.png`;
    const file = bucket.file(filename);
    await file.save(buffer, {
      metadata: { contentType: "image/png" },
      public: true,
    });

    const publicUrl = `https://storage.googleapis.com/${BUCKET_NAME}/${filename}`;
    res.json({ url: publicUrl });
  } catch (err) {
    console.error("Image gen error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ===== AUTO CLEANUP (delete files older than 7 days) =====
async function cleanupOldFiles() {
  try {
    const [files] = await bucket.getFiles();
    const now = Date.now();
    for (const file of files) {
      const [metadata] = await file.getMetadata();
      const created = new Date(metadata.timeCreated).getTime();
      const ageDays = (now - created) / (1000 * 60 * 60 * 24);
      if (ageDays > 7) {
        console.log(`🗑 Deleting old file: ${file.name}`);
        await file.delete();
      }
    }
  } catch (err) {
    console.error("Cleanup error:", err);
  }
}
setInterval(cleanupOldFiles, 24 * 60 * 60 * 1000); // run daily

const PORT = 5000;
app.listen(PORT, () => {
  console.log(`✅ Server running on http://localhost:${PORT}`);
});
