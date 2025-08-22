# 🤖 LLM Agent POC (Groq + Multi-Tool Browser App)

A **browser-based multi-tool reasoning agent** that integrates **Groq LLM API** with **OpenAI-style tool calling** and connects to three tools:

- 🔍 **Google Search** – fetch fresh web snippets using Google Custom Search API  
- 🔄 **AI Pipe API** – workflow-style transforms (proxy or built-in mock)  
- 💻 **Code Execution** – run JavaScript in a secure browser sandbox  

**Features:**
- Clean Bootstrap UI (responsive)  
- Multi-model routing: one model for planning, another for final answer  
- System prompt support for behavioral control  
- Tool loop: LLM calls tools repeatedly until the task is complete  
- One-click deploy on **Render** (no Dockerfile required)  

---

## 📑 Table of Contents
- [Demo](#demo)  
- [Architecture](#architecture)  
- [Tools](#tools)  
- [Installation](#installation)  
- [Environment Variables](#environment-variables)  
- [Run Locally](#run-locally)  
- [Deploy to Render](#deploy-to-render)  
- [Usage](#usage)  
- [Customizing System Prompt](#customizing-system-prompt)  
- [Screenshots](#screenshots)  
- [Credits](#credits)  

---

## 🚀 Demo

Once deployed, open:  https://<your-render-service>.onrender.com


Browser (UI)
├─ Bootstrap UI + Chat Window
├─ Web Worker for safe JS execution
└─ fetch() -> Express API

Express Server
├─ /api/chat → proxies Groq LLM (OpenAI-style)
├─ /api/search → calls Google Custom Search API
├─ /api/aipipe → AI Pipe proxy or mock
└─ static → serves index.html



### Flow:
- Messages = [system + user + assistant + tool]  
- Sent to `/api/chat` → Groq → model may request tools  
- If tool calls present → frontend executes tools → sends tool responses  
- Repeat until no more tools → optional **final pass** with larger model for polished answer  

---

## 🔌 Tools

### 1. 🔍 Google Search
- Uses [Google Programmable Search Engine](https://programmablesearchengine.google.com/) + [Custom Search JSON API](https://developers.google.com/custom-search/v1/overview)  
- Enable “Search entire web” in PSE  
- Requires `GOOGLE_API_KEY` and `GOOGLE_CSE_ID`  

### 2. 🔄 AI Pipe API
- **Proxy mode:** Set `AIPIPE_URL` to real service  
- **Mock mode:** Leave empty → returns a helpful mock  

### 3. 💻 Code Execution
- Runs user-provided JS code inside a **Web Worker**  
- Isolated, no DOM/network access → safe sandbox  
- Example:




---

## ⚙ Installation

Clone the repo:

```bash
git clone https://github.com/yourusername/llm-agent-groq.git
cd llm-agent-groq
npm install


## 🔑 Environment Variables

Create .env or set on Render:

PORT=7860
DEFAULT_MODEL=llama-3.1-70b-versatile

# Required
GROQ_API_KEY=your_groq_api_key_here

# Optional for Google Search tool
GOOGLE_API_KEY=your_google_api_key
GOOGLE_CSE_ID=your_custom_search_cx

# Optional for AI Pipe tool
AIPIPE_URL=https://aipipe.example.com/run



🧑‍💻 Usage

Choose a model (Groq offers LLaMA, Mixtral, Gemma, etc.).

(Optional) Toggle multi-model mode: small model plans tool usage; large model writes polished final answer.

Add a system prompt (behavior instructions). Example:

You are a tool-using assistant.
- Use `search` for fresh info from the web.
- Use `aipipe` for workflow-style transforms.
- Use `exec_js` for quick calculations or scripts.
After each tool, explain what you learned. Stop when the task is complete.
