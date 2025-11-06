// server.js — Virtual Planner (static files, cities, env checks, chat)
import express from "express";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import OpenAI from "openai";

dotenv.config();

const app = express();
app.use(express.json());

// --- Serve static assets (logos, CSS, JS) ---
const ROOT = process.cwd();
app.use(express.static(ROOT + "/public"));

// --- OpenAI setup ---
const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// --- Server port ---
const PORT = process.env.PORT || 3000;
const HOST = "0.0.0.0";

// --- Load city configuration from /data/cities.json ---
const CITIES_PATH = path.join(ROOT, "data", "cities.json");
let cities = {};
try {
  cities = JSON.parse(fs.readFileSync(CITIES_PATH, "utf8"));
  console.log("✅ Loaded city configurations for:", Object.keys(cities).join(", "));
} catch (e) {
  console.error("❌ ERROR: Cannot read data/cities.json", e);
}

// --- Health check route ---
app.get("/api/health", (_req, res) => res.json({ ok: true }));

// --- Verify city environment variables (no values leaked) ---
app.get("/api/city-env-status", (_req, res) => {
  const has = (k) => Boolean(process.env[k]);
  res.json({
    Greenvale: has("CITY_GREENVALE_TOKEN"),
    Harbortown: has("CITY_HARBORTOWN_TOKEN"),
    Ironridge: has("CITY_IRONRIDGE_TOKEN"),
    Riverton: has("CITY_RIVERTON_TOKEN")
  });
});

// --- Safe view of cities (no secrets) ---
app.get("/api/cities", (_req, res) => {
  const safe = {};
  for (const [key, cfg] of Object.entries(cities)) {
    const { accessToken, envKey, ...rest } = cfg;
    safe[key] = rest;
  }
  res.json(safe);
});

// --- Chat endpoint (single route for all cities) ---
app.post("/api/chat", async (req, res) => {
  try {
    const { city, message } = req.body || {};
    if (!city || !message) {
      return res.status(400).json({ error: "Provide 'city' and 'message' in the JSON body." });
    }

    const cfg = cities[city];
    if (!cfg) {
      return res.status(404).json({ error: `Unknown city: ${city}` });
    }

    // Each city points to an env var name in cities.json (envKey)
    const envKey = cfg.envKey;                 // e.g., CITY_GREENVALE_TOKEN
    const cityToken = process.env[envKey];     // e.g., greenvale_XXXX
    if (!cityToken) {
      return res.status(500).json({ error: `Missing environment variable: ${envKey}` });
    }

    // City-specific planner voice
    const systemPrompt = `
You are ${cfg.plannerName}, the city planner for ${city}.
Be clear, brief, and resident-friendly. When appropriate, suggest what part of the zoning code to check.
Do not give legal advice. If information is uncertain, explain what the user can verify and where.
`;

    // User content is just the user's message (we keep tokens server-side)
    const userPrompt = message;

    // Call OpenAI (Chat Completions API; reliable and simple)
    const completion = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt.trim() },
        { role: "user", content: userPrompt }
      ],
      temperature: 0.4
    });

    const text = completion?.choices?.[0]?.message?.content?.trim();
    if (!text) return res.status(502).json({ error: "No text returned from OpenAI." });

    res.json({
      city,
      planner: cfg.plannerName,
      reply: text
    });
  } catch (err) {
    console.error("Chat error:", err);
    res.status(500).json({ error: "Chat route failed." });
  }
});

// --- Simple GET test route (so you can verify without tools) ---
app.get("/api/chat/test/:city", async (req, res) => {
  try {
    const city = req.params.city;
    const cfg = cities[city];
    if (!cfg) return res.status(404).json({ error: `Unknown city: ${city}` });

    const envKey = cfg.envKey;
    if (!process.env[envKey]) {
      return res.status(500).json({ error: `Missing environment variable: ${envKey}` });
    }

    const systemPrompt = `
You are ${cfg.plannerName}, the city planner for ${city}.
Give one concise sentence describing what "mixed-use zoning" generally means.
`;

    const completion = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt.trim() },
        { role: "user", content: "Describe mixed-use zoning in one sentence." }
      ],
      temperature: 0.3
    });

    const text = completion?.choices?.[0]?.message?.content?.trim() || "(no text)";
    res.json({ city, planner: cfg.plannerName, sample: text });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Test route failed." });
  }
});

// --- Start server ---
app.listen(PORT, HOST, () => {
  console.log(`🚀 Virtual Planner running on http://localhost:${PORT}`);
});
