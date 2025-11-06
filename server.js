// server.js — Virtual Planner (mobile-first, per-city URLs)
import express from "express";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import OpenAI from "openai";

dotenv.config();

const app = express();
app.use(express.json());

// Paths
const ROOT = process.cwd();
const PORT = Number(process.env.PORT || 3000);
const HOST = "0.0.0.0";

// Static files (logos, chat.html, etc.)
app.use(express.static(path.join(ROOT, "public")));

// --- OpenAI ---
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const client = new OpenAI({ apiKey: OPENAI_API_KEY });

// --- Load cities ---
const CITIES_PATH = path.join(ROOT, "data", "cities.json");
let cities = {};
try {
  cities = JSON.parse(fs.readFileSync(CITIES_PATH, "utf8"));
  console.log("✅ Cities:", Object.keys(cities).join(", "));
} catch (e) {
  console.error("❌ Cannot read data/cities.json", e.message);
  cities = {};
}

// Helpers
function getCityConfig(name) {
  const wanted = String(name || "").trim().toLowerCase();
  const key = Object.keys(cities).find(k => k.toLowerCase() === wanted);
  if (!key) return null;
  return { key, cfg: cities[key] };
}
function hasEnv(k){ return Boolean(process.env[k]); }
function safeErr(e){
  const msg = e?.error?.message || e?.response?.data?.error?.message || e?.message || "Unexpected error";
  const code = e?.status || e?.response?.status || 500;
  return { error: msg, code };
}

// --- API routes ---
app.get("/api/health", (_req, res) => res.json({ ok: true }));
app.get("/api/key-status", (_req, res) => res.json({ hasOpenAIKey: Boolean(OPENAI_API_KEY) }));
app.get("/api/city-env-status", (_req, res) => {
  res.json({
    Greenvale: hasEnv("CITY_GREENVALE_TOKEN"),
    Harbortown: hasEnv("CITY_HARBORTOWN_TOKEN"),
    Ironridge: hasEnv("CITY_IRONRIDGE_TOKEN"),
    Riverton: hasEnv("CITY_RIVERTON_TOKEN"),
  });
});
app.get("/api/cities", (_req, res) => {
  const safe = {};
  for (const [key, cfg] of Object.entries(cities)) {
    const { envKey, accessToken, ...rest } = cfg;
    safe[key] = rest;
  }
  res.json(safe);
});

// Chat (POST)
app.post("/api/chat", async (req, res) => {
  try {
    const { city, message } = req.body || {};
    if (!city || !message) return res.status(400).json({ error: "Provide 'city' and 'message'." });

    const found = getCityConfig(city);
    if (!found) return res.status(404).json({ error: `Unknown city: ${city}` });
    const { key: cityKey, cfg } = found;

    const envKey = cfg.envKey;
    const cityToken = process.env[envKey];
    if (!envKey || !cityToken) return res.status(500).json({ error: `Missing environment variable: ${envKey}` });
    if (!OPENAI_API_KEY) return res.status(500).json({ error: "Missing OPENAI_API_KEY" });

    // Tone + behavior: 8th-grade, short-first, varied “not found” wording
    const systemPrompt = `
You are ${cfg.plannerName}, city planner for ${cityKey}.
Write at an 8th-grade reading level. Start with short, clear answers. Add detail only when needed.
Use friendly, plain language. Line spacing should feel airy (short sentences, white space).
If the code does not have a clear rule, vary your phrasing, e.g.:
- "I don’t see that in the code. You may want to check Section __ or ask the planning desk."
- "That rule isn’t listed. Try reviewing the use table or recent amendments."
- "Nothing explicit on that. Look at the overlay district or special exceptions."
Always suggest the next step (what to look up and where). Do not give legal advice.
`.trim();

    const completion = await client.chat.completions.create({
      model: OPENAI_MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: message }
      ],
      temperature: 0.5
    });

    const text = completion?.choices?.[0]?.message?.content?.trim() || "(no response)";
    res.json({ city: cityKey, planner: cfg.plannerName, reply: text });
  } catch (e) {
    const out = safeErr(e);
    console.error("Chat error:", out);
    res.status(500).json(out);
  }
});

// Test route
app.get("/api/chat/test/:city", async (req, res) => {
  try {
    const found = getCityConfig(req.params.city);
    if (!found) return res.status(404).json({ error: `Unknown city: ${req.params.city}` });
    const { key: cityKey, cfg } = found;

    const envKey = cfg.envKey;
    if (!envKey || !process.env[envKey]) return res.status(500).json({ error: `Missing environment variable: ${envKey}` });
    if (!OPENAI_API_KEY) return res.status(500).json({ error: "Missing OPENAI_API_KEY" });

    const systemPrompt = `
You are ${cfg.plannerName}, city planner for ${cityKey}.
Define "mixed-use zoning" in one short sentence at an 8th-grade reading level.
`.trim();

    const completion = await client.chat.completions.create({
      model: OPENAI_MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: "What is mixed-use zoning?" }
      ],
      temperature: 0.3
    });

    const text = completion?.choices?.[0]?.message?.content?.trim() || "(no text)";
    res.json({ city: cityKey, planner: cfg.plannerName, sample: text });
  } catch (e) {
    const out = safeErr(e);
    console.error("Test error:", out);
    res.status(500).json(out);
  }
});

// --- Per-city pages (no dropdown). Each city has its own URL like /greenvale
const citySlugs = Object.keys(cities).map(k => k.toLowerCase());
app.get("/:city", (req, res) => {
  const slug = String(req.params.city || "").toLowerCase();
  if (citySlugs.includes(slug)) {
    return res.sendFile(path.join(ROOT, "public", "chat.html"));
  }
  res.status(404).send("City not found");
});

// Start
app.listen(PORT, HOST, () => {
  console.log(`🚀 Virtual Planner running on http://localhost:${PORT}`);
});
