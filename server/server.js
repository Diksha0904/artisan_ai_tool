// server.js
import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import fetch from "node-fetch";
import { GoogleAuth } from "google-auth-library";
import { Storage } from "@google-cloud/storage";
import { v4 as uuidv4 } from "uuid";
import dotenv from "dotenv";
import cron from "node-cron";
import path from "path";
import fs from "fs";

dotenv.config();

const PORT = process.env.PORT || 5000;
const PROJECT_ID = process.env.PROJECT_ID;
const LOCATION = process.env.LOCATION || "us-central1";
const SERVICE_ACCOUNT_JSON_PATH = process.env.SERVICE_ACCOUNT_JSON_PATH || "./service-account.json";
const BUCKET_NAME = process.env.BUCKET_NAME;
const KEEP_DAYS = Number(process.env.KEEP_DAYS || 7);

if (!PROJECT_ID || !BUCKET_NAME) {
  console.error("Please set PROJECT_ID and BUCKET_NAME in .env");
  process.exit(1);
}

// Google Auth setup
const auth = new GoogleAuth({
  keyFile: SERVICE_ACCOUNT_JSON_PATH,
  scopes: ["https://www.googleapis.com/auth/cloud-platform"],
});

// Storage client
const storage = new Storage({ keyFilename: SERVICE_ACCOUNT_JSON_PATH });
const bucket = storage.bucket(BUCKET_NAME);

// Helper to get access token for Vertex AI calls
async function getAccessToken() {
  const client = await auth.getClient();
  const tokenResponse = await client.getAccessToken();
  return tokenResponse.token;
}

const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: "15mb" })); // images may be large

// ----------------- Text Generation endpoint -----------------
app.post("/api/generate-text", async (req, res) => {
  try {
    const { prompt, options } = req.body; // options can carry temperature, length etc.
    if (!prompt) return res.status(400).json({ error: "Missing prompt" });

    const token = await getAccessToken();

    // NOTE: Endpoint path and JSON body may be updated by Google. Adapt as needed.
    const endpoint = `https://${LOCATION}-aiplatform.googleapis.com/v1/projects/${PROJECT_ID}/locations/${LOCATION}/publishers/google/models/gemini-1.5-flash:generateContent`;

    const body = {
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      // any additional options may be passed according to Vertex docs
    };

    const r = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    const data = await r.json();

    // Try to extract plain text. Vertex response shapes may differ; adjust parsing if needed.
    // For many Vertex LLMs, 'output' or 'candidates' contain the text; check your response.
    let text = "";
    try {
      // Try standard shape
      if (data?.outputs?.length) {
        text = data.outputs.map(o => o.content || "").join("\n");
      } else if (data?.candidates?.length) {
        text = data.candidates.map(c => c.content || "").join("\n");
      } else if (data?.response?.text) {
        text = data.response.text;
      } else if (data?.content) {
        text = data.content;
      } else {
        text = JSON.stringify(data);
      }
    } catch (e) {
      text = JSON.stringify(data);
    }

    // You may want to parse the returned text into title/description/story/tags/price in your prompt.
    // Here we return the raw text and the full response.
    res.json({ success: true, text, raw: data });
  } catch (err) {
    console.error("generate-text error", err);
    res.status(500).json({ error: err.message });
  }
});

// ----------------- Image Generation (Imagen) + upload to GCS -----------------
app.post("/api/generate-image", async (req, res) => {
  try {
    const { prompt, aspectRatio = "1:1", sampleCount = 1 } = req.body;
    if (!prompt) return res.status(400).json({ error: "Missing prompt" });

    const token = await getAccessToken();

    // NOTE: Imagen endpoint and JSON contract may change — adapt to latest Vertex AI image generation API.
    const endpoint = `https://${LOCATION}-aiplatform.googleapis.com/v1/projects/${PROJECT_ID}/locations/${LOCATION}/publishers/google/models/imagegeneration:predict`;

    const body = {
      instances: [{ prompt }],
      parameters: { sampleCount, aspectRatio },
    };

    const r = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    const data = await r.json();

    // Expected: data.predictions[0].bytesBase64Encoded (confirm for your model)
    if (!data?.predictions?.length) {
      console.error("Imagen response missing predictions:", data);
      return res.status(500).json({ error: "No image from Imagen", raw: data });
    }

    const first = data.predictions[0];
    // The actual field name may differ. Here we try common names:
    const base64Str =
      first.bytesBase64Encoded || first.imageBytes || first.data || (first.content ? first.content : null);

    if (!base64Str) {
      // If response contains a storage uri, return it directly
      if (first.gcsUri) {
        return res.json({ url: first.gcsUri, raw: data });
      }
      return res.status(500).json({ error: "No base64 image returned", raw: data });
    }

    // Convert base64 (strip data:... prefix if present)
    const base = base64Str.replace(/^data:image\/\w+;base64,/, "");
    const buffer = Buffer.from(base, "base64");

    // Upload to GCS
    const filename = `generated/imagen-${uuidv4()}.png`;
    const file = bucket.file(filename);

    await file.save(buffer, {
      metadata: { contentType: "image/png" },
      resumable: false,
    });

    // Make public (or set signed URL alternative)
    await file.makePublic();

    const publicUrl = `https://storage.googleapis.com/${BUCKET_NAME}/${filename}`;
    res.json({ success: true, url: publicUrl, raw: data });
  } catch (err) {
    console.error("generate-image error", err);
    res.status(500).json({ error: err.message });
  }
});

// ----------------- Optional: list generated images (for debugging) -----------------
app.get("/api/list-images", async (req, res) => {
  try {
    const [files] = await bucket.getFiles({ prefix: "generated/" });
    const items = files.map(f => ({ name: f.name, url: `https://storage.googleapis.com/${BUCKET_NAME}/${encodeURIComponent(f.name)}` }));
    res.json({ items });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ----------------- Automatic cleanup job (node-cron) -----------------
// Runs daily (at 03:00 AM) and deletes files in the 'generated/' folder older than KEEP_DAYS.
cron.schedule("0 3 * * *", async () => {
  try {
    console.log(`[cleanup] Running cleanup: deleting files older than ${KEEP_DAYS} days`);
    const [files] = await bucket.getFiles({ prefix: "generated/" });
    const now = Date.now();
    const cutoff = now - KEEP_DAYS * 24 * 60 * 60 * 1000;
    let deleted = 0;
    for (const file of files) {
      const [meta] = await file.getMetadata();
      const updated = new Date(meta.updated).getTime();
      if (updated < cutoff) {
        try {
          await file.delete();
          deleted++;
        } catch (e) {
          console.warn(`[cleanup] failed to delete ${file.name}`, e.message);
        }
      }
    }
    console.log(`[cleanup] Done - deleted ${deleted} files`);
  } catch (err) {
    console.error("[cleanup] error", err);
  }
});

// Expose endpoint to trigger cleanup ad-hoc (protected in real deployments)
app.post("/api/trigger-cleanup", async (req, res) => {
  try {
    // In production, add auth checking here.
    // Reuse the same logic:
    const [files] = await bucket.getFiles({ prefix: "generated/" });
    const now = Date.now();
    const cutoff = now - KEEP_DAYS * 24 * 60 * 60 * 1000;
    let deleted = 0;
    for (const file of files) {
      const [meta] = await file.getMetadata();
      const updated = new Date(meta.updated).getTime();
      if (updated < cutoff) {
        try {
          await file.delete();
          deleted++;
        } catch (e) {
          console.warn("failed to delete file", file.name, e.message);
        }
      }
    }
    res.json({ success: true, deleted });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`✅ Artisan backend running at http://localhost:${PORT}`);
});
