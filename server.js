// server.js — Virtual Planner (Render-ready)
// Features: static files, cities loader, env checks, chat (OpenAI), strong diagnostics

import express from "express";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import OpenAI from "openai";

// ---------- bootstrap ----------
dotenv.config();

const app = express();
app.use(express.json());

// Host + Port for Render/Local
const PORT = Number(process.env.PORT || 3000);
const HOST = "0.0.0.0";

// Root path and public assets
const ROOT = process.cwd();
app.use(express.static(path.join(ROOT, "public")));

// ---------- OpenAI client ----------
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

const client = new OpenAI({ apiKey: OPENAI_API_KEY });

// ---------- Load cities.json ----------
const CITIES_PATH = path.join(ROOT, "data", "cities.json");
let cities = {};
try {
  const raw = fs.readFileSync(CITIES_PATH, "utf8");
  cities = JSON.parse(raw);
  console.log("✅ Loaded city configurations for:", Object.keys(cities).join(", "));
} catch (e) {
  console.error("❌ ERROR: Cannot read data/cities.json:", e.message);
  cities = {};
}

// ---------- helpers ----------
function getCityConfig(name) {
  const wanted = String(name || "").trim().toLowerCase();
  const key = Object.keys(cities).find((k) => k.toLowerCase() === wanted);
  if (!key) return null;
  return { key, cfg: cities[key] };
}

function hasEnv(key) {
  return Boolean(process.env[key]);
}

function safeErrorResponse(err) {
  // Normalize OpenAI/HTTP errors without leaking secrets
  const msg =
    err?.error?.message ||
    err?.response?.data?.error?.message ||
    err?.message ||
    "Unexpected error";
  const code = err?.status || err?.response?.status || 500;
  return { error: msg, code };
}

// ---------- routes ----------

// Quick health ping
app.get("/api/health", (_req, res) => res.json({ ok: true }));

// Boolean check that OpenAI key exists (no value leaked)
app.get("/api/key-status", (_req, res) =>
  res.json({ hasOpenAIKey: Boolean(OPENAI_API_KEY) })
);

// Boolean check for each city token (no values leaked)
app.get("/api/city-env-status", (_req, res) => {
  res.json({
    Greenvale: hasEnv("CITY_GREENVALE_TOKEN"),
    Harbortown: hasEnv("CITY_HARBORTOWN_TOKEN"),
    Ironridge: hasEnv("CITY_IRONRIDGE_TOKEN"),
    Riverton: hasEnv("CITY_RIVERTON_TOKEN"),
  });
});

// Safe listing of cities (no secrets)
app.get("/api/cities", (_req, res) => {
  const safe = {};
  for (const [key, cfg] of Object.entries(cities)) {
    const { envKey, accessToken, ...rest } = cfg; // strip any secret-ish fields if present
    safe[key] = rest;
  }
  res.json(safe);
});

// Main chat endpoint (POST) — case-insensitive city
app.post("/api/chat", async (req, res) => {
  try {
    const { city, message } = req.body || {};
    if (!city || !message) {
      return res
        .status(400)
        .json({ error: "Provide 'city' and 'message' in the JSON body." });
    }

    const found = getCityConfig(city);
    if (!found) {
      return res.status(404).json({ error: `Unknown city: ${city}` });
    }
    const { key: cityKey, cfg } = found;

    // Get per-city token name from cities.json (envKey), then read value from env
    const envKey = cfg.envKey;
    const cityToken = process.env[envKey];
    if (!envKey || !cityToken) {
      return res
        .status(500)
        .json({ error: `Missing environment variable: ${envKey}` });
    }

    if (!OPENAI_API_KEY) {
      return res.status(500).json({ error: "Missing OPENAI_API_KEY" });
    }

    const systemPrompt = `
You are ${cfg.plannerName}, the city planner for ${cityKey}.
Be clear, concise, and resident-friendly. Suggest which zoning sections to check when relevant.
Do not give legal advice. If unsure, say what to verify and where.
`.trim();

    const completion = await client.chat.completions.create({
      model: OPENAI_MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: message },
      ],
      temperature: 0.4,
    });

    const text =
      completion?.choices?.[0]?.message?.content?.trim() || "(no response)";
    res.json({ city: cityKey, planner: cfg.plannerName, reply: text });
  } catch (err) {
    const out = safeErrorResponse(err);
    console.error("Chat error:", out);
    res.status(500).json(out);
  }
});

// Simple GET test that hits OpenAI (no tools needed)
// Example: /api/chat/test/greenvale
app.get("/api/chat/test/:city", async (req, res) => {
  try {
    const found = getCityConfig(req.params.city);
    if (!found) {
      return res
        .status(404)
        .json({ error: `Unknown city: ${req.params.city}` });
    }
    const { key: cityKey, cfg } = found;

    const envKey = cfg.envKey;
    if (!envKey || !process.env[envKey]) {
      return res
        .status(500)
        .json({ error: `Missing environment variable: ${envKey}` });
    }

    if (!OPENAI_API_KEY) {
      return res.status(500).json({ error: "Missing OPENAI_API_KEY" });
    }

    const systemPrompt = `
You are ${cfg.plannerName}, the city planner for ${cityKey}.
Answer in one concise sentence: What does "mixed-use zoning" generally mean?
`.trim();

    const completion = await client.chat.completions.create({
      model: OPENAI_MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: "Describe mixed-use zoning in one sentence." },
      ],
      temperature: 0.3,
    });

    const text =
      completion?.choices?.[0]?.message?.content?.trim() || "(no text)";
    res.json({ city: cityKey, planner: cfg.plannerName, sample: text });
  } catch (err) {
    const out = safeErrorResponse(err);
    console.error("Test error:", out);
    res.status(500).json(out);
  }
});

// ---------- start ----------
app.listen(PORT, HOST, () => {
  console.log(`🚀 Virtual Planner running on http://localhost:${PORT}`);
});
