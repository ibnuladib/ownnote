import { Hono } from "hono";
import { HttpError, type AppEnv } from "./env";
import { auth, originCheck, requireAuth } from "./routes/auth";
import { misc } from "./routes/misc";
import { notes } from "./routes/notes";
import { videos } from "./routes/videos";

const app = new Hono<AppEnv>();

// --- API: /api/* -----------------------------------------------------------
const api = new Hono<AppEnv>();

api.use("*", async (c, next) => {
  await next();
  c.res.headers.set("Cache-Control", "no-store");
  c.res.headers.set("X-Content-Type-Options", "nosniff");
});
api.use("*", originCheck);
api.use("*", requireAuth);

api.route("/", auth);
api.route("/", notes);
api.route("/", videos);
api.route("/", misc);

app.route("/api", api);
// Unknown /api paths must never fall through to the SPA index.html
app.all("/api/*", (c) => c.json({ error: "Not found" }, 404));

app.onError((err, c) => {
  if (err instanceof HttpError) {
    return c.json({ error: err.message }, err.status, err.headers);
  }
  // Log only the error name/message — never request bodies, cookies or tokens.
  console.error("unhandled error:", err instanceof Error ? `${err.name}: ${err.message}` : "unknown");
  return c.json({ error: "Internal server error" }, 500);
});

// --- Everything else: static SPA assets -------------------------------------
app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;
