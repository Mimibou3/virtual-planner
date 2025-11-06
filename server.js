// server.js — Virtual Planner with Admin Override
// - Loads cities from config/cities.json via fs
// - Time + token gate for both UI and API
// - Runtime admin override (no restart required): /admin?key=ADMIN_KEY
// - Pretty citations: [file.txt] -> "Article X — Title"

import express from "express";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import OpenAI from "openai";

dotenv.config();

const app = express();
app.use(express.json());

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const PORT = process.env.PORT || 3000;
const ROOT = process.cwd();

// -----------------------------
// Config + runtime flags
// -----------------------------
const CITIES_PATH = path.join(ROOT, "config", "cities.json");
const cities = JSON.parse(fs.readFileSync(CITIES_PATH, "utf8"));

// Runtime access flag (can be toggled from /admin without restart)
let runtimeAccessEnabled =
  String(process.env.ACCESS_ENABLED ?? "true").toLowerCase() !== "false";

const ADMIN_KEY = String(process.env.ADMIN_KEY || "");

// -----------------------------
// Helpers
// -----------------------------
function read(filePath) {
  try { return fs.readFileSync(filePath, "utf8"); }
  catch { return ""; }
}

function loadAll(city) {
  const dir = path.join(ROOT, "content", city);
  let files = [];
  try {
    files = fs.readdirSync(dir).filter(f => f.toLowerCase().endsWith(".txt"));
  } catch {
    return {};
  }
  const map = {};
  for (const f of files) {
    map[f] = read(path.join(dir, f));
  }
  return map;
}

function loadIndex(city) {
  const p = path.join(ROOT, "content", city, "index.csv");
  const raw = read(p);
  const out = new Map();
  if (!raw.trim()) return out;

  const lines = raw.split(/\r?\n/).filter(Boolean);
  for (const line of lines) {
    const cols = line.split(",").map(s => s.trim());
    if (cols.length < 3) continue;
    const [file, article, title] = cols;
    if (!file.toLowerCase().endsWith(".txt")) continue;
    out.set(file, { article, title });
  }
  return out;
}

function prettyCitations(city, text) {
  const index = loadIndex(city);
  if (!index.size) {
    return text.replace(/\[([^\]]+\.txt)\]/g, (_, f) => f.replace(/\.txt$/i, ""));
  }
  return text.replace(/\[([^\]]+\.txt)\]/g, (_, f) => {
    const meta = index.get(f) || index.get(f.trim());
    if (!meta) return f.replace(/\.txt$/i, "");
    const a = meta.article || "";
    const t = meta.title || "";
    const aLabel = a ? `Article ${a}` : "Article";
    return `${aLabel} — ${t}`.trim();
  });
}

function escapeReg(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

function sliceByKeywords(allFilesMap, question, maxChars = 6000) {
  const q = (question || "").toLowerCase();
  const terms = Array.from(new Set(
    q.split(/[^a-z0-9]+/i).filter(Boolean).map(s => s.toLowerCase())
  ));
  const scored = [];

  for (const [file, text] of Object.entries(allFilesMap)) {
    const lower = text.toLowerCase();
    let score = 0;
    for (const t of terms) {
      if (t.length < 3) continue;
      const hits = (lower.match(new RegExp(`\\b${escapeReg(t)}\\b`, "g")) || []).length;
      score += hits;
    }
    for (const bonus of ["use", "permitted", "special", "parking", "definition", "district", "table"]) {
      score += (lower.includes(bonus) ? 0.25 : 0);
    }
    scored.push({ file, text, score });
  }

  scored.sort((a, b) => b.score - a.score);
  const out = [];
  let total = 0;
  for (const s of scored) {
    if (total >= maxChars) break;
    out.push(`--- ${s.file} ---\n${s.text.trim()}\n`);
    total += s.text.length;
  }
  return out.join("\n");
}

function getCityConfig(city) { return cities[city] || null; }
function isWithinWindow(now, startIso, endIso) {
  if (!startIso || !endIso) return true;
  const start = new Date(startIso);
  const end = new Date(endIso);
  return now >= start && now <= end;
}

function sendClosed(res) {
  const closedPath = path.join(ROOT, "public", "closed.html");
  res.status(403).sendFile(closedPath);
}

// -----------------------------
// Gate middleware
// -----------------------------
function gate(req, res, next) {
  const cityRaw = (req.query.city || "").toString().toLowerCase().trim();
  const tokenQ = (req.query.token || "").toString().trim();

  const cfg = getCityConfig(cityRaw);
  if (!cfg) return res.status(404).send("Unknown city.");

  // Admin runtime kill switch
  if (!runtimeAccessEnabled) {
    return sendClosed(res);
  }

  // Token required
  if (!tokenQ || tokenQ !== cfg.token) {
    return res.status(401).send("Unauthorized (invalid or missing token).");
  }

  // Time window
  const now = new Date();
  if (!isWithinWindow(now, cfg.start, cfg.end)) {
    return sendClosed(res);
  }

  req.city = cityRaw;
  req.planner = cfg.planner;
  next();
}

// -----------------------------
// Admin UI (simple, no build)
// -----------------------------
function adminAuth(req, res, next) {
  const key = (req.query.key || req.body?.key || "").toString();
  if (!ADMIN_KEY || key !== ADMIN_KEY) {
    return res.status(401).send("Unauthorized (bad admin key).");
  }
  next();
}

app.get("/admin", adminAuth, (req, res) => {
  const rows = Object.entries(cities).map(([k, v]) => {
    const url = `/?city=${encodeURIComponent(k)}&token=${encodeURIComponent(v.token)}`;
    return `
      <tr>
        <td style="padding:8px 12px;border-bottom:1px solid #eee">${k}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #eee">${v.planner}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #eee">${v.start} → ${v.end}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #eee">
          <a href="${url}" target="_blank">Open</a>
        </td>
      </tr>
    `;
  }).join("");

  res.send(`
<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Virtual Planner Admin</title>
<style>
  body{font-family:system-ui,Segoe UI,Arial;margin:0;background:#f7f7fb;color:#111}
  .wrap{max-width:900px;margin:24px auto;padding:0 16px}
  .card{background:#fff;border:1px solid #e5e7eb;border-radius:14px;box-shadow:0 10px 30px rgba(0,0,0,.06);padding:20px}
  h1{margin:0 0 12px;font-size:20px}
  .row{display:flex;align-items:center;gap:10px;margin:12px 0}
  .pill{display:inline-block;padding:6px 10px;border-radius:999px;border:1px solid #e5e7eb}
  .on{background:#ecfdf5;color:#065f46;border-color:#a7f3d0}
  .off{background:#fef2f2;color:#991b1b;border-color:#fecaca}
  button{padding:10px 14px;border-radius:10px;border:1px solid #e5e7eb;background:#2b72ff;color:#fff;cursor:pointer}
  table{width:100%;border-collapse:collapse;margin-top:14px;font-size:14px}
  th,td{padding:8px 12px;border-bottom:1px solid #eee;text-align:left}
</style>
</head>
<body>
  <div class="wrap">
    <div class="card">
      <h1>Virtual Planner — Admin</h1>
      <div class="row">
        <span>Status:</span>
        <span id="status" class="pill ${runtimeAccessEnabled ? "on" : "off"}">
          ${runtimeAccessEnabled ? "Enabled" : "Disabled"}
        </span>
        <button onclick="toggle(true)">Enable</button>
        <button onclick="toggle(false)" style="background:#fff;color:#111">Disable</button>
      </div>

      <table>
        <thead><tr><th>City</th><th>Planner</th><th>Window</th><th>Test</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  </div>
<script>
  async function toggle(enabled){
    const key = new URLSearchParams(location.search).get("key");
    const r = await fetch("/admin/toggle?key="+encodeURIComponent(key), {
      method:"POST",
      headers:{ "Content-Type":"application/json" },
      body: JSON.stringify({ enabled })
    });
    const data = await r.json();
    const s = document.getElementById("status");
    s.textContent = data.enabled ? "Enabled" : "Disabled";
    s.className = "pill " + (data.enabled ? "on" : "off");
  }
</script>
</body>
</html>
  `);
});

app.post("/admin/toggle", adminAuth, (req, res) => {
  // body may not be parsed for urlencoded; we use JSON above
  let body = "";
  req.on("data", c => body += c);
  req.on("end", () => {
    try {
      const parsed = body ? JSON.parse(body) : {};
      const val = !!parsed.enabled;
      runtimeAccessEnabled = val;
      res.json({ enabled: runtimeAccessEnabled });
    } catch {
      res.status(400).json({ error: "Bad JSON" });
    }
  });
});

// -----------------------------
// User routes
// -----------------------------
app.get("/", gate, (req, res) => {
  const indexPath = path.join(ROOT, "public", "index.html");
  res.sendFile(indexPath);
});

app.post("/api/respond", gate, async (req, res) => {
  try {
    const city = req.city;
    const plannerName = req.planner || "Senior Planner";
    const question = (req.body?.user || "").toString().slice(0, 2000);

    if (!question.trim()) {
      return res.json({ text: "Please enter a question." });
    }

    const all = loadAll(city);
    const context = sliceByKeywords(all, question);

    const SYSTEM = `
You are the city's Virtual Planner (a simulation) named ${plannerName}.
Speak as the planner—use “I” when appropriate (e.g., “I don’t see that in our code”).
Audience: adults reading at a 7–8th grade level. Keep it short (max ~120 words).
Tone: friendly, practical, and direct; avoid legalese. No emojis.

Rules:
- Only rely on the zoning excerpts provided in CONTEXT. Do not invent rules.
- If the code doesn’t cover it, say so clearly (vary phrasing) and suggest one useful next step (vary phrasing).
- Start with a clear answer in 1–2 short sentences.
- If helpful, add 0–1 gentle prompt (not every time).
- Include one citation per answer when relevant, formatted as [filename.txt].
`;

    const USER = `
CITY: ${city}
QUESTION: ${question}

CONTEXT (zoning excerpts):
${context}
`;

    const completion = await client.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.3,
      max_tokens: 220,
      messages: [
        { role: "system", content: SYSTEM.trim() },
        { role: "user", content: USER.trim() }
      ]
    });

    let answer = (completion.choices?.[0]?.message?.content || "").trim();
    answer = prettyCitations(city, answer);

    res.json({ text: answer });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error." });
  }
});

// Static
app.use(express.static(path.join(ROOT, "public")));

app.listen(PORT, () => {
  console.log(`Virtual Planner running on http://localhost:${PORT}`);
});
