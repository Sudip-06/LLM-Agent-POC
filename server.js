// server.js
// LLM Agent POC — Dual provider (Groq + Gemini) + Google CSE + AI Pipe proxy
// Requires Node >= 18 (global fetch); tested on Node 22.x with "type": "module"

import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: false }));

/* ---------- Static ---------- */
app.use(express.static(__dirname, { index: false }));

/* ---------- ENV ---------- */
const PORT = process.env.PORT || 3000;

// Search
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY || "";
const GOOGLE_CSE_ID  = process.env.GOOGLE_CSE_ID  || "";

// Groq (OpenAI-compatible)
const GROQ_API_KEY   = process.env.GROQ_API_KEY   || "";

// Gemini (native Gemini API)
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";

// AI Pipe proxy
const AIPIPE_URL     = process.env.AIPIPE_URL     || "";  // e.g. https://custom-aipipe-url.onrender.com/run
const AIPIPE_AUTH    = process.env.AIPIPE_AUTH    || "";  // e.g. "Bearer eyJ..." (optional but recommended)

/* ---------- Helpers ---------- */
function ok(v) { return v !== undefined && v !== null && v !== ""; }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function uuid() { return crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2); }

/* ---------- Health ---------- */
app.get("/api/health", (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

/* ---------- Google Search (CSE) ---------- */
app.get("/api/search", async (req, res) => {
  const q = String(req.query.q || "").trim();
  if (!ok(GOOGLE_API_KEY) || !ok(GOOGLE_CSE_ID)) {
    return res.json({
      ok: true,
      items: [],
      warning: "GOOGLE_API_KEY / GOOGLE_CSE_ID not set",
    });
  }
  if (!q) return res.json({ ok: true, items: [] });

  const url = new URL("https://www.googleapis.com/customsearch/v1");
  url.searchParams.set("key", GOOGLE_API_KEY);
  url.searchParams.set("cx", GOOGLE_CSE_ID);
  url.searchParams.set("q", q);

  try {
    const r = await fetch(url, { method: "GET" });
    if (!r.ok) {
      const text = await r.text().catch(() => "");
      return res.status(r.status).json({ ok: false, error: text || `CSE ${r.status}` });
    }
    const data = await r.json();
    const items = (data.items || []).map(it => ({
      title: it.title,
      link: it.link,
      snippet: it.snippet,
    }));
    res.json({ ok: true, items });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

/* ---------- AI Pipe Proxy (robust) ---------- */
app.post("/api/aipipe", async (req, res) => {
  try {
    const input = (req.body && typeof req.body.input === "string") ? req.body.input : "";

    // Dev-friendly mock if no upstream configured
    if (!AIPIPE_URL) {
      res.set("x-aipipe-mode", "mock");
      return res.json({
        ok: true,
        engine: "mock",
        received_input: input,
        steps: [
          { name: "parse", status: "ok" },
          { name: "analyze", status: "ok" },
          { name: "summarize", status: "ok" },
        ],
        summary: `AI Pipe mock processed: "${input}"`,
        timestamp: new Date().toISOString(),
      });
    }

    // Allow caller override; else use env
    const bearer = req.get("x-aipipe-auth") || AIPIPE_AUTH;
    const headers = { "Content-Type": "application/json" };
    if (bearer) headers.Authorization = bearer;

    const body = JSON.stringify({ input });

    let lastErr;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 7000); // 7s timeout
        const r = await fetch(AIPIPE_URL, { method: "POST", headers, body, signal: ctrl.signal });
        clearTimeout(timer);

        if (!r.ok) {
          const text = await r.text().catch(()=> "");
          throw new Error(`Upstream ${r.status}: ${text.slice(0, 200)}`);
        }
        const data = await r.json();

        // Diagnostics
        res.set("x-aipipe-mode", "proxy");
        res.set("x-aipipe-auth-mode", AIPIPE_AUTH ? "env" : (bearer ? "header" : "none"));
        if (bearer) {
          res.set("x-aipipe-auth-bearer", "true");
          res.set("x-aipipe-auth-len", String(bearer.length));
          // Small hash (for debugging only)
          const hash = crypto.createHash("sha1").update(bearer).digest("hex").slice(0, 12);
          res.set("x-aipipe-auth-hash", hash);
        }

        return res.json(data);
      } catch (e) {
        lastErr = e;
        const msg = String(e?.message || e || "");
        const retriable = e?.name === "AbortError" || /ECONNRESET|ENETUNREACH|fetch failed|socket hang up|TLS/i.test(msg);
        if (retriable && attempt === 0) {
          await sleep(300);
          continue;
        }
        break;
      }
    }
    return res.status(502).json({ ok: false, error: String(lastErr?.message || lastErr) });
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

/* ---------- Groq Chat (OpenAI-compatible) ---------- */
app.post("/api/groq/chat", async (req, res) => {
  try {
    if (!ok(GROQ_API_KEY)) {
      return res.status(400).json({ error: "GROQ_API_KEY not set" });
    }
    const { model, messages, tools, temperature = 0.3 } = req.body || {};
    const payload = {
      model: model || "openai/gpt-oss-120b",
      messages: Array.isArray(messages) ? messages : [],
      temperature,
    };
    if (Array.isArray(tools) && tools.length) payload.tools = tools;

    const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${GROQ_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    const txt = await r.text();
    if (!r.ok) return res.status(r.status).send(txt);
    res.type("application/json").send(txt);
  } catch (err) {
    res.status(500).json({ error: String(err?.message || err) });
  }
});

/* ---------- Gemini Chat (native Gemini API) ---------- */
/*  Converts OpenAI-style messages/tools into Gemini's generateContent request,
    and converts Gemini function calls back into OpenAI-style tool_calls. */
function oaiToGemini({ messages = [], tools = [], system = "", temperature = 0.3 }) {
  const functionDeclarations = (tools || [])
    .filter(t => t?.type === "function" && t.function?.name)
    .map(t => ({
      name: t.function.name,
      description: t.function.description || "",
      parameters: t.function.parameters || { type: "object", properties: {} },
    }));

  const contents = [];
  for (const m of messages) {
    const role = m.role;
    if (role === "system") continue; // put into systemInstruction
    if (role === "user") {
      contents.push({ role: "user", parts: [{ text: String(m.content || "") }] });
      continue;
    }
    if (role === "assistant") {
      const text = String(m.content || "");
      if (text) contents.push({ role: "model", parts: [{ text }] });
      // (If assistant previously made tool_calls, we ignore here — subsequent 'tool' messages carry responses)
      continue;
    }
    if (role === "tool") {
      // Convert tool result into functionResponse part
      const name = m.name || "tool";
      let response;
      try { response = JSON.parse(m.content); } catch { response = { content: m.content }; }
      contents.push({
        role: "user",
        parts: [{ functionResponse: { name, response } }],
      });
      continue;
    }
  }

  const body = {
    model: "", // we set in URL
    contents,
    generationConfig: { temperature },
  };

  if (system) {
    body.systemInstruction = { role: "system", parts: [{ text: String(system) }] };
  }
  if (functionDeclarations.length) {
    body.tools = [{ functionDeclarations }];
    // body.toolConfig = { functionCallingConfig: { mode: "AUTO" } }; // optional
  }

  return body;
}

function geminiToOAI(resp) {
  // Returns {choices: [{ message: { role, content, tool_calls? } }]}
  const cand = resp?.candidates?.[0];
  const parts = cand?.content?.parts || [];
  let content = "";
  const tool_calls = [];

  for (const p of parts) {
    if (p.text) content += (content ? "\n" : "") + p.text;
    if (p.functionCall) {
      const name = p.functionCall.name || "tool";
      const args = p.functionCall.args || {};
      tool_calls.push({
        id: `call_${uuid().slice(0, 8)}`,
        type: "function",
        function: { name, arguments: JSON.stringify(args) },
      });
    }
  }
  return {
    choices: [
      {
        message: {
          role: "assistant",
          content,
          ...(tool_calls.length ? { tool_calls } : {}),
        },
      },
    ],
  };
}

app.post("/api/gemini/chat", async (req, res) => {
  try {
    if (!ok(GEMINI_API_KEY)) {
      return res.status(400).json({ error: "GEMINI_API_KEY not set" });
    }
    const { model = "gemini-2.5-flash", messages = [], tools = [], system = "", temperature = 0.3 } = req.body || {};
    const body = oaiToGemini({ messages, tools, system, temperature });

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;

    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const txt = await r.text();
    if (!r.ok) return res.status(r.status).send(txt);

    const data = JSON.parse(txt);
    const out = geminiToOAI(data);
    res.json(out);
  } catch (err) {
    res.status(500).json({ error: String(err?.message || err) });
  }
});

/* ---------- Fallback to index.html ---------- */
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

/* ---------- Start ---------- */
app.listen(PORT, () => {
  console.log(`LLM Agent POC listening on http://localhost:${PORT}`);
});
