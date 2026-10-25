import { once } from "node:events";
import { createServer } from "node:http";
import { expect, it } from "vitest";
import { createDemoServer } from "./server.js";
it("serves only demo assets and engine traces; rejects writes and arbitrary paths", async () => {
  const server = createDemoServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing listener");
  const url = `http://127.0.0.1:${address.port}`;
  try {
    expect(address.address).toBe("127.0.0.1");
    const page = await fetch(url);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Paced Lab");
    expect(page.headers.get("content-security-policy")).toContain(
      "default-src 'self'",
    );
    const scenarios = await (await fetch(url + "/scenarios.json")).json();
    expect(scenarios).toHaveLength(5);
    expect(
      scenarios
        .find((s: { id: string }) => s.id === "unknown-restart")
        .trace.at(-1).decision,
    ).toBe("account-sender-busy");
    expect(
      (await fetch(url + "/app.js")).headers.get("content-type"),
    ).toContain("text/javascript");
    expect((await fetch(url + "/style.css")).status).toBe(200);
    expect((await fetch(url + "/package.json")).status).toBe(404);
    expect((await fetch(url, { method: "POST", body: "ignored" })).status).toBe(
      405,
    );
  } finally {
    server.close();
    await once(server, "close");
  }
});
it("chooses a free port without interfering with an existing listener", async () => {
  const occupied = createServer((_req, res) => res.end("existing app"));
  occupied.listen(0, "127.0.0.1");
  await once(occupied, "listening");
  const demo = createDemoServer();
  demo.listen(0, "127.0.0.1");
  await once(demo, "listening");
  try {
    const a = occupied.address(),
      b = demo.address();
    if (!a || !b || typeof a === "string" || typeof b === "string")
      throw new Error("Missing listeners");
    expect(a.port).not.toBe(b.port);
    expect(await (await fetch(`http://127.0.0.1:${a.port}`)).text()).toBe(
      "existing app",
    );
  } finally {
    demo.close();
    occupied.close();
    await Promise.all([once(demo, "close"), once(occupied, "close")]);
  }
});
