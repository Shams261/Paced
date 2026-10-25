import { Hono } from "hono";
import { snapshot } from "./fixtures.js";
export const app = new Hono();
app.use("*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  c.header("X-Content-Type-Options", "nosniff");
  if (c.req.method !== "GET")
    return c.json(
      {
        error: "READ_ONLY_SHELL",
        message: "Mutations and live execution are unavailable.",
      },
      405,
    );
  await next();
});
app.get("/api/health", (c) =>
  c.json({ status: "ok", mode: "synthetic-local", liveSending: false }),
);
app.get("/api/v1/snapshot", (c) => c.json(snapshot));
app.notFound((c) => c.json({ error: "NOT_FOUND" }, 404));
app.onError((_error, c) => c.json({ error: "INTERNAL_ERROR" }, 500));
