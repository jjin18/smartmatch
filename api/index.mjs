/**
 * Vercel serverless entry: forwards all requests to the Express app.
 * Rewrites in vercel.json send "/" and "/api/*" here so static files + API work.
 */
import app from "../server.mjs";

export default app;
