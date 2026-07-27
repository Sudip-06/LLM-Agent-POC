// Vercel serverless entry point.
// Vercel builds one function from every file under /api. Importing the
// existing Express app here means all routes (and their logic) live in a
// single place (server.js) and behave identically locally, on Render, and
// on Vercel.
import app from "../server.js";

export default app;
