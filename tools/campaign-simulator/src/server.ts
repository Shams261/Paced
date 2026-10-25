import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { scenarios, simulate } from "./fixtures.js";

export function createDemoServer() {
  const assets = new Map<string, { type: string; body: string }>([
    [
      "/",
      {
        type: "text/html",
        body: readFileSync(
          new URL("../web/index.html", import.meta.url),
          "utf8",
        ),
      },
    ],
    [
      "/app.js",
      {
        type: "text/javascript",
        body: readFileSync(new URL("../web/app.js", import.meta.url), "utf8"),
      },
    ],
    [
      "/style.css",
      {
        type: "text/css",
        body: readFileSync(
          new URL("../web/style.css", import.meta.url),
          "utf8",
        ),
      },
    ],
    [
      "/scenarios.json",
      {
        type: "application/json",
        body: JSON.stringify(
          Object.entries(scenarios).map(([id, s]) => ({
            id,
            description: s.description,
            events: s.events,
            trace: simulate(id),
          })),
        ),
      },
    ],
  ]);
  return createServer((req, res) => {
    if (req.method !== "GET") {
      res.writeHead(405);
      res.end("Method not allowed");
      return;
    }
    const asset = assets.get(req.url ?? "/");
    if (!asset) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    res.writeHead(200, {
      "Content-Type": `${asset.type}; charset=utf-8`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy":
        "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'",
    });
    res.end(asset.body);
  });
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const server = createDemoServer();
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    if (address && typeof address !== "string")
      console.log(`Simulator ready: http://127.0.0.1:${address.port}`);
  });
  server.on("error", (error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.on(signal, () => server.close());
}
