
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

/* =========================
   Environment
========================= */
const {
  PORT = 7860,

  // Groq (OpenAI-compatible)
  GROQ_API_KEY = "",
  DEFAULT_GROQ_MODEL = "openai/gpt-oss-120b",

  // Gemini (Google Generative Language API)
  GEMINI_API_KEY = "",
  DEFAULT_GEMINI_MODEL = "gemini-2.5-flash",

  // Google Programmable Search for /api/search
  GOOGLE_API_KEY = "",
  GOOGLE_CSE_ID = "",

  // AI Pipe proxy
  AIPIPE_URL = "",
  AIPIPE_AUTH = ""   // NEW: optional Authorization header (e.g., "Bearer <token>")
} = process.env;

if (!GROQ_API_KEY) console.warn("WARNING: GROQ_API_KEY not set.");
if (!GEMINI_API_KEY) console.warn("WARNING: GEMINI_API_KEY not set.");

app.get("/api/healthz", (_req, res) =>
  res.json({ ok: true, service: "llm-agent-dual" })
);
app.get("/api/version", (_req, res) => res.json({ version: "1.0.2" }));

/* =========================
   Groq chat (OpenAI-style)
   POST /api/groq/chat
========================= */
app.post("/api/groq/chat", async (req, res) => {
  try {
    if (!GROQ_API_KEY) return res.status(500).json({ error: "Missing GROQ_API_KEY" });

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
    console.error("Groq error:", err);
    res.status(500).json({ error: { message: err.message || "Groq chat proxy failed" } });
  }
});

/* =========================
   Gemini adapter (v1beta)
   POST /api/gemini/chat
========================= */
app.post("/api/gemini/chat", async (req, res) => {
  try {
    if (!GEMINI_API_KEY) return res.status(500).json({ error: "Missing GEMINI_API_KEY" });

    const { model, system, messages, tools } = req.body || {};
    const mdl = model || DEFAULT_GEMINI_MODEL;
    if (!Array.isArray(messages)) return res.status(400).json({ error: "messages[] required" });

    // OpenAI tools -> Gemini functionDeclarations
    let functionDeclarations;
    if (Array.isArray(tools) && tools.length) {
      functionDeclarations = tools
        .filter(t => t?.type === "function" && t.function?.name)
        .map(t => ({
          name: t.function.name,
          description: t.function.description || "",
          parameters: t.function.parameters || { type: "object" } // JSON schema
        }));
    }

    // OpenAI messages -> Gemini contents
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
        // Tool result => functionResponse
        let responseObj = {};
        try { responseObj = m.content ? JSON.parse(m.content) : {}; }
        catch { responseObj = { raw: String(m.content || "") }; }
        contents.push({
          role: "tool",
          parts: [{ functionResponse: { name: m.name || m.tool_name || "tool", response: responseObj } }]
        });
        continue;
      }
      // user / assistant
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

    res.json({ choices: [{ message: { content: contentText || "", tool_calls } }] });
  } catch (err) {
    console.error("Gemini error:", err);
    res.status(500).json({ error: { message: err.message || "Gemini adapter failed" } });
  }
});

/* =========================
   Google Search (Custom Search)
========================= */
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
    console.error("Search error:", err);
    res.status(500).json({ error: { message: err.message || "Search failed" } });
  }
});

/* =========================
   AI Pipe (proxy or mock)
========================= */
// at top with other imports
import crypto from "node:crypto";

// ...

app.post("/api/aipipe", async (req, res) => {
  try {
    if (!process.env.AIPIPE_URL) {
      // ---- Mock branch (no URL set) ----
      const { input = "" } = req.body || {};
      res.set("x-aipipe-mode", "mock");
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
        timestamp: new Date().toISOString()
      });
    }

    // ---- Proxy branch ----
    const headers = { "Content-Type": "application/json" };

    // Helper: sanitize tokens (trim, dequote, ensure Bearer)
    const dequote = s => s.replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
    const normalizeToken = raw => {
      let t = (raw || "").toString().trim();
      t = dequote(t);
      if (!t) return "";
      // If user pasted a bare JWT, prefix Bearer
      if (!/^Bearer\s+/i.test(t)) t = "Bearer " + t;
      return t;
    };

    // Prefer client override for testing, else env
    let authMode = "none";
    let token =
      normalizeToken(req.get("x-aipipe-auth")) ||
      normalizeToken(req.get("authorization")) ||
      normalizeToken(process.env.AIPIPE_AUTH);

    if (token) {
      if (normalizeToken(req.get("x-aipipe-auth"))) authMode = "client-x-aipipe-auth";
      else if (normalizeToken(req.get("authorization"))) authMode = "client-authorization";
      else authMode = "env";
      headers["Authorization"] = token;
    }

    // Call downstream AI Pipe
    const r = await fetch(process.env.AIPIPE_URL, {
      method: "POST",
      headers,
      body: JSON.stringify(req.body || {})
    });

    const text = await r.text();
    let payload; try { payload = JSON.parse(text); } catch { payload = { raw: text }; }

    // Safe debug headers (no secrets)
    const len = (token || "").length;
    const isBearer = (token || "").startsWith("Bearer ");
    const hash = len ? crypto.createHash("sha256").update(token).digest("hex").slice(0, 12) : "";

    res.set("x-aipipe-mode", "proxy");
    res.set("x-aipipe-auth-mode", authMode);
    res.set("x-aipipe-auth-len", String(len));
    res.set("x-aipipe-auth-bearer", String(isBearer));
    res.set("x-aipipe-auth-hash", hash);

    return res.status(r.status).json(payload);
  } catch (err) {
    console.error("AI Pipe error:", err);
    res.status(500).json({ ok:false, error: err.message || "AI Pipe failed" });
  }
});



/* =========================
   Static frontend
========================= */
app.use(express.static(path.join(__dirname, "public")));
app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`LLM Agent (Groq + Gemini) running on http://localhost:${PORT}`);
});
