import express from "express";
import cors from "cors";
import morgan from "morgan";
import { createHash, randomUUID } from "node:crypto";

// ------------ Basic app ------------
const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(morgan("tiny"));

// Serve static (index.html + assets) from project root
app.use(express.static("."));

// ------------ Health ------------
app.get("/api/healthz", (req, res) => {
  res.json({
    ok: true,
    uptime: process.uptime(),
    now: new Date().toISOString(),
    routes: ["/api/groq/chat", "/api/gemini/chat", "/api/search", "/api/aipipe", "/api/aipipe/debug"]
  });
});

// ------------ Google CSE search ------------
app.get("/api/search", async (req, res) => {
  try {
    const q = (req.query.q || "").toString();
    const key = (process.env.GOOGLE_CSE_KEY || "").trim();
    const cx  = (process.env.GOOGLE_CSE_ID  || "").trim();

    if (!q) return res.status(400).json({ ok: false, error: "Missing query ?q=" });
    if (!key || !cx) {
      return res.json({
        ok: false,
        error: "GOOGLE_CSE_KEY or GOOGLE_CSE_ID not set",
        items: []
      });
    }

    const url = new URL("https://www.googleapis.com/customsearch/v1");
    url.searchParams.set("key", key);
    url.searchParams.set("cx", cx);
    url.searchParams.set("q", q);

    const r = await fetch(url, { method: "GET" });
    const data = await r.json();
    res.json({
      ok: true,
      items: (data.items || []).map(it => ({
        title: it.title,
        link: it.link,
        snippet: it.snippet
      }))
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// ------------ AI Pipe proxy ------------
function pickAIPipeAuth(req) {
  const clientOverride = req.headers["x-aipipe-auth"];
  if (clientOverride && String(clientOverride).trim()) {
    return { token: String(clientOverride).trim(), mode: "client-x-aipipe-auth" };
  }
  const envToken = (process.env.AIPIPE_AUTH || "").trim();
  if (envToken) return { token: envToken, mode: "env" };
  return { token: "", mode: "none" };
}

app.get("/api/aipipe/debug", (req, res) => {
  const t = (process.env.AIPIPE_AUTH || "").trim();
  res.json({
    url_set: !!process.env.AIPIPE_URL,
    has_token: !!t,
    bearer: /^Bearer\s+/i.test(t),
    len: t.length,
    hash: t ? createHash("sha256").update(t).digest("hex").slice(0, 12) : ""
  });
});

app.post("/api/aipipe", async (req, res) => {
  try {
    const url = (process.env.AIPIPE_URL || "").trim();
    const { token, mode } = pickAIPipeAuth(req);

    res.set("x-aipipe-mode", "proxy");
    res.set("x-aipipe-auth-mode", mode);
    res.set("x-aipipe-auth-bearer", String(token.startsWith("Bearer ")));
    res.set("x-aipipe-auth-len", String(token.length));
    if (token) {
      res.set("x-aipipe-auth-hash", createHash("sha256").update(token).digest("hex").slice(0, 12));
    }

    if (!url) return res.status(500).json({ ok: false, error: "AIPIPE_URL not configured" });
    if (!token) return res.status(401).json({ ok: false, error: "Unauthorized" });

    const r = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": token
      },
      body: JSON.stringify(req.body || {})
    });

    // Bubble up upstream status/content
    res.status(r.status);
    res.set("cache-control", r.headers.get("cache-control") || "no-store");
    res.json(await r.json());
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// ------------ Groq chat (OpenAI-compatible) ------------
app.post("/api/groq/chat", async (req, res) => {
  try {
    const apiKey = (process.env.GROQ_API_KEY || "").trim();
    if (!apiKey) return res.status(500).json({ error: "GROQ_API_KEY not set" });

    const url = "https://api.groq.com/openai/v1/chat/completions";
    // Pass through OpenAI-like payload from frontend
    const payload = {
      model: req.body.model,
      messages: req.body.messages,
      temperature: req.body.temperature ?? 0.3,
      tools: req.body.tools,
      tool_choice: req.body.tool_choice
    };

    const r = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    const data = await r.json();
    if (!r.ok) {
      return res.status(r.status).json({ error: data.error || data });
    }
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

// ------------ Gemini chat (Generative Language API) ------------
/**
 * Convert OpenAI-style messages => Gemini contents
 * role: user/assistant -> Gemini roles "user"/"model"
 */
function toGeminiContents(messages = []) {
  return messages.map(m => {
    const role = m.role === "assistant" ? "model" : "user";
    return {
      role,
      parts: [{ text: String(m.content || "") }]
    };
  });
}

/**
 * Convert OpenAI tool schema -> Gemini functionDeclarations
 */
function toGeminiFunctionDeclarations(tools = []) {
  const decls = [];
  for (const t of tools || []) {
    if (t?.type !== "function" || !t.function) continue;
    const f = t.function;
    decls.push({
      name: f.name,
      description: f.description || "",
      // Gemini expects JSON schema expressed similarly; pass-through is okay
      parameters: f.parameters || {}
    });
  }
  return decls;
}

/**
 * Convert Gemini candidates -> OpenAI-ish {choices:[{message:{content, tool_calls}}]}
 */
function fromGeminiToOpenAIShape(gemini) {
  const choice = { message: { role: "assistant", content: "", tool_calls: [] } };

  const cand = gemini?.candidates?.[0];
  const parts = cand?.content?.parts || [];
  for (const p of parts) {
    if (p?.text) {
      choice.message.content += (choice.message.content ? "\n" : "") + p.text;
    }
    if (p?.functionCall) {
      const id = randomUUID();
      const name = p.functionCall.name;
      const args = JSON.stringify(p.functionCall.args || {});
      choice.message.tool_calls.push({
        id,
        type: "function",
        function: { name, arguments: args }
      });
    }
  }
  // If nothing at all, ensure content is at least empty string
  return { choices: [choice] };
}

app.post("/api/gemini/chat", async (req, res) => {
  try {
    const apiKey = (process.env.GEMINI_API_KEY || "").trim();
    if (!apiKey) return res.status(500).json({ error: "GEMINI_API_KEY not set" });

    const model = req.body.model || "gemini-2.5-flash";
    const systemText = (req.body.system || "").trim();
    const messages = req.body.messages || [];
    const tools = req.body.tools || [];

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${apiKey}`;

    const functionDeclarations = toGeminiFunctionDeclarations(tools);
    const hasTools = functionDeclarations.length > 0;

    const payload = {
      contents: toGeminiContents(messages),
      generationConfig: {
        temperature: req.body.temperature ?? 0.3
      },
      ...(systemText ? { systemInstruction: { role: "system", parts: [{ text: systemText }] } } : {}),
      ...(hasTools ? { tools: [{ functionDeclarations }] } : {}),
      ...(hasTools ? { toolConfig: { functionCallBehavior: { mode: "ANY" } } } : {})
    };

    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    const data = await r.json();
    if (!r.ok) {
      return res.status(r.status).json({ error: data.error || data });
    }

    // Map Gemini -> OpenAI shape for the frontend
    const mapped = fromGeminiToOpenAIShape(data);
    res.json(mapped);
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

// ------------ Fallback to index.html (single-page app) ------------
app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api/")) return next();
  res.sendFile(process.cwd() + "/index.html");
});

// ------------ Start ------------
app.listen(PORT, () => {
  console.log(`LLM Agent server running on http://localhost:${PORT}`);
});
