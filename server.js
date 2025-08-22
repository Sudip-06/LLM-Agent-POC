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
  DEFAULT_GROQ_MODEL = "openai/gpt-oss-120b",

  // Gemini
  GEMINI_API_KEY = "",
  DEFAULT_GEMINI_MODEL = "gemini-2.5-flash",

  // Google Programmable Search (for /api/search)
  GOOGLE_API_KEY = "",
  GOOGLE_CSE_ID = "",

  // AI Pipe (optional). If empty, server returns a helpful mock.
  AIPIPE_URL = ""
} = process.env;

if (!GROQ_API_KEY) console.warn("WARNING: GROQ_API_KEY not set.");
if (!GEMINI_API_KEY) console.warn("WARNING: GEMINI_API_KEY not set.");

/* ===== Health ===== */
app.get("/api/healthz", (_req, res) => res.json({ ok: true, service: "llm-agent-dual" }));
app.get("/api/version", (_req, res) => res.json({ version: "1.0.0" }));

/* =======================================================================================
   GROQ: OpenAI-style chat proxy
   Endpoint: https://api.groq.com/openai/v1/chat/completions
   Body: { model, messages, tools?, tool_choice? }
======================================================================================= */
app.post("/api/groq/chat", async (req, res) => {
  try {
    const body = req.body || {};
    const model = body.model || DEFAULT_GROQ_MODEL;
    if (!Array.isArray(body.messages)) body.messages = [];

    const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${GROQ_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        ...body,
        model,
        tool_choice: "auto",
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

/* =======================================================================================
   GEMINI: Adapter that accepts OpenAI-like { system, messages, tools }
   and calls Google Generative Language API (v1beta) generateContent.
   Returns an OpenAI-like { choices: [{ message: { content, tool_calls } }] }.
======================================================================================= */
app.post("/api/gemini/chat", async (req, res) => {
  try {
    const { model, system, messages, tools } = req.body || {};
    const mdl = model || DEFAULT_GEMINI_MODEL;
    if (!Array.isArray(messages)) {
      return res.status(400).json({ error: "messages[] required" });
    }
    if (!GEMINI_API_KEY) {
      return res.status(500).json({ error: "GEMINI_API_KEY not set" });
    }

    // Convert OpenAI tools -> Gemini functionDeclarations
    let functionDeclarations;
    if (Array.isArray(tools) && tools.length) {
      functionDeclarations = tools
        .filter(t => t?.type === "function" && t.function?.name)
        .map(t => ({
          name: t.function.name,
          description: t.function.description || "",
          parameters: t.function.parameters || { type: "object" }
        }));
    }

    // Convert OpenAI-style messages -> Gemini contents
    const contents = [];
    let systemInstruction = system
      ? { role: "system", parts: [{ text: String(system) }] }
      : undefined;

    for (const m of messages) {
      const role = m.role;
      if (role === "system") {
        systemInstruction = { role: "system", parts: [{ text: String(m.content || "") }] };
        continue;
      }
      if (role === "tool") {
        // Tool result: Gemini expects functionResponse
        let responseObj = {};
        try { responseObj = m.content ? JSON.parse(m.content) : {}; } catch { responseObj = { raw: String(m.content || "") }; }
        contents.push({
          role: "tool",
          parts: [{ functionResponse: { name: m.name || m.tool_name || "tool", response: responseObj } }]
        });
        continue;
      }
      // user / assistant => user / model
      const gemRole = role === "assistant" ? "model" : (role === "user" ? "user" : role);
      contents.push({ role: gemRole, parts: [{ text: String(m.content || "") }] });
    }

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(mdl)}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;

    const body = {
      contents,
      tools: functionDeclarations && functionDeclarations.length ? [{ functionDeclarations }] : undefined,
      systemInstruction
    };

    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json(data);

    // Normalize Gemini -> OpenAI-like
    const cand = (data.candidates || [])[0] || {};
    const parts = cand.content?.parts || [];
    const contentText = parts.filter(p => p.text).map(p => p.text).join("\n");

    const tool_calls = [];
    let callIdx = 0;
    for (const p of parts) {
      if (p.functionCall?.name) {
        const name = p.functionCall.name;
        const args = p.functionCall.args || p.functionCall.arguments || {};
        tool_calls.push({
          id: `call_${Date.now()}_${callIdx++}`,
          type: "function",
          function: { name, arguments: JSON.stringify(args) }
        });
      }
    }

    res.json({
      choices: [{ message: { content: contentText || "", tool_calls } }]
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: { message: err.message || "Gemini adapter failed" } });
  }
});

/* ===== Google Search Snippets (Custom Search JSON API) ===== */
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

    // Mock mode
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
  console.log(`LLM Agent (Groq + Gemini) on http://localhost:${PORT}`);
});
