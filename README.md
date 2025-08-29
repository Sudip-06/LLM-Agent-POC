# 🤖 LLM Agent POC - Browser-Based Multi-Tool Reasoning



A modern, browser-based LLM agent that combines large language model capabilities with external tools including web search, AI workflows, and live JavaScript code execution. Built with dual LLM provider support (Groq and Gemini) and featuring a sleek, responsive UI.

## 🚀 Live Demo

Try it now: [https://llm-agent-poc.onrender.com/](https://llm-agent-poc.onrender.com/)

## Features

🤖 **Dual LLM Provider Support**
- Groq (OpenAI-compatible API)
- Google Gemini (GenerativeAI API)
- Dynamic model switching
- Multi-model workflows (separate planning and answering models)

🔧 **Integrated Tool Suite**
- **Web Search**: Google Custom Search API integration
- **AI Pipe**: Configurable AI workflow proxy
- **JavaScript Execution**: Sandboxed code execution in Web Workers

🎨 **Modern UI/UX**
- Responsive glassmorphism design
- Real-time conversation interface
- Animated visual feedback
- Bootstrap 5 styling with custom enhancements
- Markdown rendering for agent responses

## Architecture

The agent follows a simple but powerful reasoning loop:

```python
def loop(llm):
    msg = [user_input()]
    while True:
        output, tool_calls = llm(msg, tools)
        print("Agent: ", output)
        if tool_calls:
            msg += [handle_tool_call(tc) for tc in tool_calls]
        else:
            msg.append(user_input())
```

This enables the agent to:
1. Take user input
2. Generate LLM responses with potential tool calls
3. Execute tools and integrate results
4. Loop until task completion

## Quick Start

### Prerequisites

- Node.js 16+ 
- API keys for your chosen services

### Installation

1. **Clone and install dependencies**
   ```bash
   git clone <your-repo-url>
   cd llm-agent-dual
   npm install
   ```

2. **Configure environment variables**
   
   Create a `.env` file in the root directory:
   ```bash
   # Required for Groq provider
   GROQ_API_KEY=your_groq_api_key_here
   DEFAULT_GROQ_MODEL=openai/gpt-oss-120b

   # Required for Gemini provider
   GEMINI_API_KEY=your_gemini_api_key_here
   DEFAULT_GEMINI_MODEL=gemini-2.5-flash

   # Required for web search functionality
   GOOGLE_API_KEY=your_google_api_key_here
   GOOGLE_CSE_ID=your_custom_search_engine_id

   # Optional: AI Pipe proxy
   AIPIPE_URL=https://your-aipipe-endpoint.com/api
   AIPIPE_AUTH=Bearer your_token_here

   # Server configuration
   PORT=7860
   ```

3. **Start the development server**
   ```bash
   npm run dev
   ```

4. **Access the application**
   
   Open your browser to `http://localhost:7860`

## API Keys Setup

### Groq API Key
1. Visit [Groq Console](https://console.groq.com)
2. Create an account and navigate to API Keys
3. Generate a new API key
4. Add to your `.env` file as `GROQ_API_KEY`

### Google Gemini API Key
1. Go to [Google AI Studio](https://makersuite.google.com/app/apikey)
2. Create a new API key
3. Add to your `.env` file as `GEMINI_API_KEY`

### Google Custom Search Setup
1. Visit [Google Cloud Console](https://console.cloud.google.com)
2. Enable the Custom Search JSON API
3. Create credentials (API key)
4. Set up a Custom Search Engine at [Google CSE](https://cse.google.com)
5. Add both keys to your `.env` file

### AI Pipe (Optional)
Configure `AIPIPE_URL` and `AIPIPE_AUTH` if you have access to an AI Pipe endpoint.

## Usage Examples

### Basic Conversation
```
User: What's the weather like today?
Agent: Let me search for current weather information...
[Tool: search("current weather today")]
Agent: Based on the search results, today's weather is...
```

### Code Execution
```
User: Calculate the factorial of 10
Agent: I'll write and execute JavaScript code to calculate that:
[Tool: exec_js("function factorial(n) { return n <= 1 ? 1 : n * factorial(n-1); } console.log(factorial(10));")]
Agent: The factorial of 10 is 3,628,800.
```

### AI Workflow
```
User: Process this text with AI analysis
Agent: I'll send this through the AI Pipe workflow:
[Tool: aipipe({"input": "your text here"})]
Agent: The AI analysis shows...
```

## Available Tools

### Search Tool
```javascript
{
  name: "search",
  description: "Google search snippets",
  parameters: {
    q: "search query string"
  }
}
```

### AI Pipe Tool
```javascript
{
  name: "aipipe", 
  description: "Call an AI Pipe workflow",
  parameters: {
    input: "text input for processing"
  }
}
```

### JavaScript Execution Tool
```javascript
{
  name: "exec_js",
  description: "Execute JavaScript in a Web Worker",
  parameters: {
    code: "JavaScript code to execute"
  }
}
```

## Configuration Options

### Single vs Multi-Model Mode

**Single Model Mode** (default)
- Uses one model for both planning and final answers
- Simpler, faster execution
- Good for most use cases

**Multi-Model Mode**
- Uses one model for tool planning/reasoning
- Uses a different model for final answer generation
- Allows optimization (fast model for tools, high-quality model for responses)

### Supported Models

**Groq Models:**
- `openai/gpt-oss-120b` (default)
- `openai/gpt-oss-20b`
- `qwen/qwen3-32b`
- `deepseek-r1-distill-llama-70b`

**Gemini Models:**
- `gemini-2.5-flash` (default)
- `gemini-2.5-pro`

## API Endpoints

### Chat Endpoints
- `POST /api/groq/chat` - Groq chat completion
- `POST /api/gemini/chat` - Gemini chat completion (with OpenAI compatibility layer)

### Tool Endpoints  
- `GET /api/search?q=<query>` - Google Custom Search
- `POST /api/aipipe` - AI Pipe workflow proxy

### Health Endpoints
- `GET /api/healthz` - Health check
- `GET /api/version` - Version info

## Development

### Project Structure
```
llm-agent-dual/
├── server.js              # Express server with API endpoints
├── public/
│   └── index.html          # Single-page frontend application
├── package.json            # Dependencies and scripts
├── render.yaml            # Render.com deployment config
└── .env                   # Environment variables (create this)
```

### Key Features

**Backend (server.js)**
- Express.js server with CORS support
- OpenAI-compatible API wrapper for Groq
- Gemini API adapter with tool calling support
- Google Custom Search integration
- AI Pipe proxy with authentication
- Error handling and logging

**Frontend (index.html)**
- Modern glassmorphism UI design
- Real-time chat interface
- Web Worker sandboxing for safe code execution
- Markdown rendering for agent responses
- Responsive design for mobile/tablet/desktop
- Animated visual feedback

## Security Features

- **Sandboxed Code Execution**: JavaScript code runs in isolated Web Workers
- **Input Sanitization**: All user inputs are properly escaped
- **CORS Protection**: Configured for safe cross-origin requests
- **No Browser Storage**: Avoids localStorage/sessionStorage security issues
- **DOMPurify Integration**: Sanitizes rendered Markdown content

## Deployment

### Local Development
```bash
npm run dev
```

### Production Deployment (Render.com)
The project includes a `render.yaml` configuration for easy deployment:

1. Push code to GitHub
2. Connect GitHub repo to Render
3. Configure environment variables in Render dashboard
4. Deploy automatically

### Environment Variables for Production
All the same variables as development, plus:
- `NODE_ENV=production`
- `PORT=10000` (or Render's assigned port)

## Troubleshooting

### Common Issues

**No API responses**
- Check that required API keys are set in `.env`
- Verify API key permissions and quotas
- Check server console for error messages

**Tool calls not working**
- Ensure Google Custom Search is properly configured
- Verify AI Pipe endpoint is accessible
- Check browser console for JavaScript errors

**UI not loading**
- Confirm all CDN resources are accessible
- Check for JavaScript errors in browser console
- Verify Bootstrap and dependencies loaded correctly

### Debug Headers

The AI Pipe endpoint includes debug headers for troubleshooting:
- `x-aipipe-mode`: "proxy" or "mock"
- `x-aipipe-auth-mode`: Authentication method used
- `x-aipipe-auth-len`: Token length (for validation)

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Test thoroughly
5. Submit a pull request

### Code Style
- Use modern JavaScript (ES6+)
- Follow existing formatting patterns
- Add comments for complex logic
- Keep functions focused and small

## License

This project is for educational purposes. Please review the terms of service for all integrated APIs before commercial use.

## Support

For issues or questions:
1. Check the troubleshooting section above
2. Review server logs for error details
3. Verify all environment variables are correctly set
4. Test individual API endpoints directly

---

**Built with**: Node.js, Express.js, Bootstrap 5, and modern web standards for a fast, reliable, and beautiful LLM agent experience.
