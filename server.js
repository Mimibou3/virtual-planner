// server.js — Virtual Planner (robust errors + logo support)
import express from "express";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import OpenAI from "openai";

dotenv.config();

const app = express();
app.use(express.json());

// --- Static files (logos, CSS, JS) ---
const ROOT = process.cwd();
app.use(express.static(ROOT + "/public"));

// --- OpenAI setup ---
const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// --- Server port ---
const PORT = process.env.PORT || 3000;
const HOST = "0.0.0.0";

// --- Config: Load cities.json from /data ---
const CITIES_PATH = path.join(ROOT, "data", "cities.json");
let cities = {};
try {
  cities = JSON.parse(fs.readFileSync(CITIES_PATH, "utf8"));
  console.log("✅ Loaded city configurations for:", Object.keys(cities).join(", "));
} catch (e) {
  console.error("❌ ERROR: Cannot read data/cities.json", e);
}

// --- Optional health route for quick testing ---
app.get("/api/health", (_req, res) => res.json({ ok: true }));

// --- Optional route: view cities (safe, hides secrets) ---
app.get("/api/cities", (_req, res) => {
  const safe = {};
  for (const [key, cfg] of Object.entries(cities)) {
    const { accessToken, envKey, ...rest } = cfg;
    safe[key] = rest;
  }
  res.json(safe);
});

// --- Start server ---
app.listen(PORT, HOST, () => {
  console.log(`🚀 Virtual Planner running on http://localhost:${PORT}`);
});
