import { serve } from "@hono/node-server";
import { createServer, type ViteDevServer } from "vite";
import { fileURLToPath } from "node:url";
import { app } from "../../apps/api/src/app.js";

const api = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
let dashboard: ViteDevServer | undefined;
try {
  if (!api.listening)
    await new Promise<void>((resolve, reject) => {
      api.once("listening", resolve);
      api.once("error", reject);
    });
  const address = api.address();
  if (!address || typeof address === "string")
    throw new Error("API did not bind");
  const apiUrl = `http://127.0.0.1:${address.port}`;
  dashboard = await createServer({
    root: fileURLToPath(new URL("../../apps/dashboard", import.meta.url)),
    server: {
      host: "127.0.0.1",
      port: 0,
      strictPort: true,
      proxy: { "/api": { target: apiUrl } },
    },
  });
  await dashboard.listen();
  console.log(`API: ${apiUrl}`);
  dashboard.printUrls();
  const close = async () => {
    await dashboard?.close();
    api.close();
  };
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.once(signal, () => {
      void close();
    });
} catch (error) {
  await dashboard?.close();
  api.close();
  console.error(error instanceof Error ? error.message : "Startup failed");
  process.exitCode = 1;
}
