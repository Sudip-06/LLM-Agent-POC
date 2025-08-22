import express from "express";
import cors from "cors";
import morgan from "morgan";
import fetch from "node-fetch";
import path from "node:path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json({ limit: "4mb" }));
app.use(morgan("tiny"));

/* ===== Env ===== */
const {
  PORT = 7860,
  // Groq (OpenAI-compatible)
  GROQ_API_KEY = "",
  DEFAULT_MODEL = "llama-3.1-70b-versatile",

  // Google Programmable Search (for /api/search)
  GOOGLE_API_KEY = "",
  GOOGLE_CSE_ID = "",

  // AI Pipe (optional). If empty, server returns a helpful mock.
  AIPIPE_URL = ""
} = process.env;

if (!GROQ_API_KEY) {
  console.warn("WARNING: GROQ_API_KEY is not set. /api/chat will fail until you add it.");
}

/* ===== Health ===== */
app.get("/api/healthz", (_req, res) => res.json({ ok: true, service: "llm-agent-groq" }));
app.get("/api/version", (_req, res) => res.json({ version: "1.0.0" }));

/* ===== Groq chat proxy (OpenAI-style) =====
   Endpoint: https://api.groq.com/openai/v1/chat/completions
   Body: { model, messages, tools?, tool_choice? }
*/
app.post("/api/chat", async (req, res) => {
  try {
    const body = req.body || {};
    if (!Array.isArray(body.messages)) body.messages = [];
    if (!body.model) body.model = DEFAULT_MODEL;

    const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${GROQ_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        ...body,
        tool_choice: "auto", // let the model decide when to use tools
        temperature: body.temperature ?? 0.3
      })
    });

    const data = await r.json();
    if (!r.ok) return res.status(r.status).json(data);
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: { message: err.message || "Groq chat proxy failed" } });
  }
});

/* ===== Google Search Snippets (Custom Search JSON API) =====
   Docs: https://developers.google.com/custom-search/v1/overview
*/
app.get("/api/search", async (req, res) => {
  try {
    const q = (req.query.q || "").toString().trim();
    if (!q) return res.status(400).json({ error: "Missing q" });
    if (!GOOGLE_API_KEY || !GOOGLE_CSE_ID) {
      return res.status(500).json({ error: "GOOGLE_API_KEY/GOOGLE_CSE_ID not set" });
    }

    const url = new URL("https://www.googleapis.com/customsearch/v1");
    url.searchParams.set("key", GOOGLE_API_KEY);
    url.searchParams.set("cx", GOOGLE_CSE_ID);
    url.searchParams.set("q", q);

    const r = await fetch(url);
    const d = await r.json();
    if (!r.ok) return res.status(r.status).json(d);

    const items = (d.items || []).map(it => ({
      title: it.title,
      link: it.link,
      snippet: it.snippet
    }));
    res.json({ query: q, items });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: { message: err.message || "Search failed" } });
  }
});

/* ===== AI Pipe: proxy or mock (auto-fallback) ===== */
app.post("/api/aipipe", async (req, res) => {
  try {
    if (AIPIPE_URL) {
      // Proxy mode
      const r = await fetch(AIPIPE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(req.body || {})
      });
      const d = await r.json();
      if (!r.ok) return res.status(r.status).json(d);
      return res.json(d);
    }

    // Mock mode (works without external service)
    const { input = "" } = req.body || {};
    const now = new Date().toISOString();
    return res.json({
      ok: true,
      engine: "mock",
      received_input: input,
      steps: [
        { name: "parse", status: "ok" },
        { name: "analyze", status: "ok" },
        { name: "summarize", status: "ok" }
      ],
      summary: input ? `AI Pipe mock processed: "${input}"` : "AI Pipe mock: no input provided.",
      timestamp: now
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: { message: err.message || "AI Pipe failed" } });
  }
});

/* ===== Static frontend ===== */
app.use(express.static(path.join(__dirname, "public")));
app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`LLM Agent (Groq) on http://localhost:${PORT}`);
});
