// server.js — Virtual Planner (robust errors + logo-friendly + clear logs)
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

// ---------- config ----------
const CITIES_PATH = path.join(ROOT, "config", "cities.json");
let cities = {};
try {
  cities = JSON.parse(fs.readFileSync(CITIES_PATH, "utf8"));
} catch (e) {
  console.error("ERROR: Cannot read config/cities.json", e);
}

let runtimeAccessEnabled =
  String(process.env.ACCESS_ENABLED ?? "true").toLowerCase() !== "false";
const ADMIN_KEY = String(process.env.ADMIN_KEY || "");

// ---------- helpers ----------
const read = (p) => {
  try { return fs.readFileSync(p, "utf8"); } catch { return ""; }
};

const dirExists = (p) => {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
};
const fileExists = (p) => {
  try { return fs.statSync(p).isFile(); } catch { return false; }
};

const escapeReg = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function loadAll(city) {
  const dir = path.join(ROOT, "content", city);
  if (!dirExists(dir)) return {};
  const files = fs.readdirSync(dir).filter(f => f.toLowerCase().endsWith(".txt"));
  const map = {};
  for (const f of files) map[f] = read(path.join(dir, f));
  return map;
}

function loadIndex(city) {
  const p = path.join(ROOT, "content", city, "index.csv");
  const raw = read(p);
  const map = new Map();
  if (!raw.trim()) return map;
  for (const line of raw.split(/\r?\n/).filter(Boolean)) {
    const [file, article, title] = line.split(",").map(s => s?.trim() ?? "");
    if (!file?.toLowerCase().endsWith(".txt")) continue;
    map.set(file, { article, title });
  }
  return map;
}

function prettyCitations(city, text) {
  // Convert [file.txt] → "Article X — Title" using index.csv
  const index = loadIndex(city);
  return text.replace(/\[([^\]]+\.txt)\]/g, (_, f) => {
    const meta = index.get(f) || index.get(f.trim());
    if (!meta) return f.replace(/\.txt$/i, "");
    const a = meta.article ? `Article ${meta.article}` : "Article";
    const t = meta.title || "";
    return `${a} — ${t}`.trim();
  });
}

function sliceByKeywords(all, question, maxChars = 6000) {
  const q = (question || "").toLowerCase();
  const terms = Array.from(new Set(q.split(/[^a-z0-9]+/i).filter(Boolean)));
  const scored = [];

  for (const [file, text] of Object.entries(all)) {
    const lower = (text || "").toLowerCase();
    let score = 0;
    for (const t of terms) {
      if (t.length < 3) continue;
      score += (lower.match(new RegExp(`\\b${escapeReg(t)}\\b`, "g")) || []).length;
    }
    for (const hint of ["use","permitted","special","parking","definition","district","table"]) {
      score += lower.includes(hint) ? 0.25 : 0;
    }
    scored.push({ file, text, score });
  }

  scored.sort((a,b)=> b.score - a.score);
  let out = "", total = 0;
  for (const s of scored) {
    if (total >= maxChars) break;
    out += `--- ${s.file} ---\n${(s.text||"").trim()}\n\n`;
    total += (s.text||"").length;
  }
  return out;
}

function getCityConfig(city){ return cities[city] || null; }
function isWithinWindow(now, startIso, endIso) {
  if (!startIso || !endIso) return true;
  const st = new Date(startIso), en = new Date(endIso);
  return now >= st && now <= en;
}

function sendClosed(res) {
  return res.status(403).sendFile(path.join(ROOT,"public","closed.html"));
}

// ---------- admin ----------
function adminAuth(req,res,next){
  const key = (req.query.key || req.body?.key || "").toString();
  if (!ADMIN_KEY || key !== ADMIN_KEY) {
    return res.status(401).send("Unauthorized (bad admin key).");
  }
  next();
}

app.get("/admin", adminAuth, (req,res)=>{
  const rows = Object.entries(cities).map(([k,v])=>{
    const url = `/?city=${encodeURIComponent(k)}&token=${encodeURIComponent(v.token)}`;
    return `<tr>
      <td>${k}</td><td>${v.planner}</td><td>${v.start} → ${v.end}</td>
      <td><a href="${url}" target="_blank">Open</a></td>
    </tr>`;
  }).join("");
  res.send(`<!doctype html><html><head><meta charset="utf-8"><title>Admin</title>
<style>body{font-family:system-ui;max-width:900px;margin:24px auto;padding:0 16px}
table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #eee;padding:8px}
.btn{padding:8px 12px;border:1px solid #ddd;border-radius:8px;cursor:pointer}</style>
</head><body>
<h1>Virtual Planner — Admin</h1>
<p>Status: <b>${runtimeAccessEnabled ? "Enabled" : "Disabled"}</b>
<button class="btn" onclick="toggle(true)">Enable</button>
<button class="btn" onclick="toggle(false)">Disable</button></p>
<table><thead><tr><th>City</th><th>Planner</th><th>Window</th><th>Test</th></tr></thead>
<tbody>${rows}</tbody></table>
<script>
async function toggle(enabled){
  const key = new URLSearchParams(location.search).get("key");
  const r = await fetch("/admin/toggle?key="+encodeURIComponent(key), {
    method:"POST",headers:{"Content-Type":"application/json"},
    body: JSON.stringify({enabled})
  });
  location.reload();
}
</script></body></html>`);
});

app.post("/admin/toggle", adminAuth, (req, res) => {
  let body = "";
  req.on("data", c => body += c);
  req.on("end", () => {
    try {
      const val = !!JSON.parse(body||"{}").enabled;
      runtimeAccessEnabled = val;
      res.json({ enabled: runtimeAccessEnabled });
    } catch {
      res.status(400).json({ error: "Bad JSON" });
    }
  });
});

// ---------- gates ----------
function gate(req,res,next){
  const city = (req.query.city || "").toString().toLowerCase().trim();
  const token = (req.query.token || "").toString().trim();

  const cfg = getCityConfig(city);
  if (!cfg) return res.status(404).send("Unknown city.");

  if (!runtimeAccessEnabled) return sendClosed(res);

  if (!token || token !== cfg.token) {
    return res.status(401).send("Unauthorized (invalid or missing token).");
  }

  const now = new Date();
  if (!isWithinWindow(now, cfg.start, cfg.end)) return sendClosed(res);

  req.city = city;
  req.planner = cfg.planner || "Senior Planner";
  next();
}

// ---------- routes ----------
app.get("/", gate, (req,res)=> {
  res.sendFile(path.join(ROOT,"public","index.html"));
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    access: runtimeAccessEnabled,
    hasOpenAIKey: !!process.env.OPENAI_API_KEY,
    cities: Object.keys(cities)
  });
});

app.post("/api/respond", gate, async (req,res)=>{
  try {
    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({ error: "Missing OPENAI_API_KEY on server." });
    }

    const city = req.city;
    const plannerName = req.planner;
    const q = (req.body?.user || "").toString().slice(0,2000).trim();
    if (!q) return res.json({ text: "Please enter a question." });

    const all = loadAll(city);
    const context = sliceByKeywords(all, q);
    if (!context.trim()) {
      return res.json({
        text: `I don't see that in our excerpts for this city. You may need to ask a staff member or check the full code at City Hall.`
      });
    }

    const SYSTEM = `
You are the city's Virtual Planner (simulation): ${plannerName}.
Audience: 7–8th grade reading level. Keep answers under ~120 words.
Rules:
- Use ONLY the supplied CONTEXT (zoning excerpts). If not present, say so plainly.
- Start with a clear answer in 1–2 short sentences.
- Add at most one brief next-step suggestion (vary the phrasing).
- Include one citation per answer when relevant, formatted [file.txt].
`;

    const USER = `
CITY: ${city}
QUESTION: ${q}

CONTEXT:
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
    if (!answer) {
      return res.status(502).json({ error: "No response from model." });
    }
    answer = prettyCitations(city, answer);
    return res.json({ text: answer });

  } catch (err) {
    console.error("RESPOND ERROR:", err);
    return res.status(500).json({ error: "Server error while generating an answer." });
  }
});

// static
app.use(express.static(path.join(ROOT,"public")));

app.listen(PORT, ()=> {
  console.log(`Virtual Planner running on http://localhost:${PORT}`);
});
