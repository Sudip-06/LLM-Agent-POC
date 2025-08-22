// server.js (ESM)
// Robust Express server for: static UI, Groq chat, Gemini chat, Google CSE search,
// and AI Pipe proxy with env/override auth. Serves files from /public to fix ENOENT errors.

import "dotenv/config";
import express from "express";
import cors from "cors";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto"; // only once

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();

const PORT = process.env.PORT || 7860;

// CORS + JSON
app.use(cors());
app.use(express.json({ limit: "1mb" }));

// Small helper
const pick = (obj, keys) =>
  Object.fromEntries(keys.filter(k => k in obj).map(k => [k, obj[k]]));

// ---------- Health ----------
app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    mode: process.env.NODE_ENV || "production",
    time: new Date().toISOString()
  });
});

// ---------- Google Search (CSE) ----------
app.get("/api/search", async (req, res) => {
  try {
    const q = String(req.query.q || "").trim();
    if (!q) return res.status(400).json({ ok: false, error: "Missing q" });

    const key = process.env.GOOGLE_API_KEY;
    const cx  = process.env.GOOGLE_CSE_ID;
    if (!key || !cx) {
      return res.status(500).json({
        ok: false,
        error: "Google CSE not configured (set GOOGLE_API_KEY and GOOGLE_CSE_ID)"
      });
    }

    const url = new URL("https://www.googleapis.com/customsearch/v1");
    url.searchParams.set("key", key);
    url.searchParams.set("cx", cx);
    url.searchParams.set("q", q);

    const r = await fetch(url.toString());
    if (!r.ok) {
      const text = await r.text().catch(() => "");
      return res.status(r.status).json({ ok: false, error: `CSE error ${r.status}`, detail: text });
    }
    const data = await r.json();
    const items = (data.items || []).map(it => pick(it, ["title", "link", "snippet"]));
    res.json({ ok: true, items });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message || String(err) });
  }
});

// ---------- AI Pipe proxy ----------
app.post("/api/aipipe", async (req, res) => {
  const AIPIPE_URL  = process.env.AIPIPE_URL;   // e.g., https://custom-aipipe-url.onrender.com/run
  const AIPIPE_AUTH = process.env.AIPIPE_AUTH;  // e.g., Bearer <token>
  const headerAuth  = req.get("x-aipipe-auth");

  // Response metadata for easy debugging
  res.setHeader("x-aipipe-mode", AIPIPE_URL ? "proxy" : "mock");
  res.setHeader("x-aipipe-auth-mode", AIPIPE_AUTH ? "env" : (headerAuth ? "header" : "none"));

  try {
    // If no proxy URL configured, return a local mock so UI always works.
    if (!AIPIPE_URL) {
      const input = String(req.body?.input ?? "");
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
        summary: `AI Pipe mock processed: "${input}"`,
        timestamp: now
      });
    }

    // Require an auth token: prefer header override, else env; otherwise 401
    const token = headerAuth || AIPIPE_AUTH;
    if (!token) {
      return res.status(401).json({ ok: false, error: "Unauthorized" });
    }

    // Forward request body to AIPIPE_URL
    const upstream = await fetch(AIPIPE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": token
      },
      body: JSON.stringify(req.body || {})
    });

    res.setHeader("x-aipipe-auth-bearer", String(token.startsWith("Bearer ")));
    res.setHeader("x-aipipe-auth-len", String(token.length));
    res.setHeader("x-aipipe-auth-hash", crypto.createHash("sha1").update(token).digest("hex").slice(0, 12));

    if (!upstream.ok) {
      const text = await upstream.text().catch(() => "");
      return res.status(upstream.status).json({ ok: false, error: `AI Pipe upstream ${upstream.status}`, detail: text });
    }
    const data = await upstream.json();
    return res.json(data);
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message || String(err) });
  }
});

// ---------- Groq (OpenAI-compatible) ----------
app.post("/api/groq/chat", async (req, res) => {
  try {
    const GROQ_API_KEY = process.env.GROQ_API_KEY;
    if (!GROQ_API_KEY) {
      return res.status(500).json({ error: "GROQ_API_KEY not set" });
    }
    const { model, messages, tools, temperature = 0.3 } = req.body || {};
    if (!model || !Array.isArray(messages)) {
      return res.status(400).json({ error: "Missing model or messages" });
    }

    const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${GROQ_API_KEY}`
      },
      body: JSON.stringify({
        model,
        messages,
        temperature,
        tools
      })
    });

    if (!r.ok) {
      const text = await r.text().catch(() => "");
      return res.status(r.status).json({ error: `Groq error ${r.status}`, detail: text });
    }

    const data = await r.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message || String(err) });
  }
});

// ---------- Gemini (Adapter to OpenAI-ish schema) ----------
/**
 * Convert OpenAI messages -> Gemini contents
 * role: user|assistant -> user|model
 * content string -> [{text: "..."}]
 */
function toGeminiContents(messages = []) {
  return messages
    .filter(m => m && typeof m.content === "string")
    .map(m => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }]
    }));
}

/**
 * Convert OpenAI-style tools -> Gemini functionDeclarations
 * We pass through JSON Schema if provided.
 */
function toGeminiFunctionDeclarations(tools = []) {
  return (tools || [])
    .filter(t => t?.type === "function" && t.function?.name)
    .map(t => ({
      name: t.function.name,
      description: t.function.description || "",
      parameters: t.function.parameters || { type: "object" }
    }));
}

/**
 * Convert Gemini candidate -> OpenAI-like message { content, tool_calls? }
 */
function fromGeminiCandidate(candidate = {}) {
  const parts = candidate?.content?.parts || [];
  let textOut = "";
  const tool_calls = [];

  for (const p of parts) {
    if (p?.text) {
      textOut += (textOut ? "\n" : "") + p.text;
    }
    if (p?.functionCall) {
      tool_calls.push({
        id: crypto.randomUUID(),
        type: "function",
        function: {
          name: p.functionCall.name,
          arguments: JSON.stringify(p.functionCall.args || {})
        }
      });
    }
  }

  return {
    role: "assistant",
    content: textOut,
    ...(tool_calls.length ? { tool_calls } : {})
  };
}

app.post("/api/gemini/chat", async (req, res) => {
  try {
    const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
    if (!GEMINI_API_KEY) {
      return res.status(500).json({ error: "GEMINI_API_KEY not set" });
    }
    const { model, messages = [], tools = [], temperature = 0.3, system = "" } = req.body || {};
    if (!model) return res.status(400).json({ error: "Missing model" });

    const contents = toGeminiContents(messages);
    const functionDeclarations = toGeminiFunctionDeclarations(tools);

    const url = new URL(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`);
    url.searchParams.set("key", GEMINI_API_KEY);

    const payload = {
      contents,
      generationConfig: { temperature },
      ...(system ? { systemInstruction: { role: "system", parts: [{ text: system }] } } : {}),
      ...(functionDeclarations.length ? { tools: [{ functionDeclarations }] } : {})
    };

    const r = await fetch(url.toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    if (!r.ok) {
      const text = await r.text().catch(() => "");
      return res.status(r.status).json({ error: `Gemini error ${r.status}`, detail: text });
    }

    const data = await r.json();
    const cand = data?.candidates?.[0];
    if (!cand) return res.json({ choices: [{ message: { role: "assistant", content: "" } }] });

    const converted = fromGeminiCandidate(cand);
    res.json({ choices: [{ message: converted }] });
  } catch (err) {
    res.status(500).json({ error: err.message || String(err) });
  }
});

// ---------- Static assets (fixes ENOENT by serving /public/index.html) ----------
const publicDir = path.join(__dirname, "public");
app.use(express.static(publicDir, { extensions: ["html"] }));

// Root -> index.html
app.get("/", (_req, res) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

// Safety: 404 for unknown non-API paths (so Render logs don't spam)
app.use((req, res, next) => {
  if (req.path.startsWith("/api/")) return next();
  // Try file in public first; if not, 404 JSON
  res.status(404).json({ ok: false, error: "Not found" });
});

// ---------- Start ----------
app.listen(PORT, () => {
  console.log(`LLM Agent POC listening on http://localhost:${PORT}`);
});
