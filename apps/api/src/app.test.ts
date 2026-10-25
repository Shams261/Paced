import { expect, it } from "vitest";
import { app } from "./app.js";
import { snapshotSchema } from "@outreach/shell-contracts";
it("health and snapshot advertise synthetic-only data with no authority", async () => {
  const health = await app.request("/api/health");
  expect(await health.json()).toEqual({
    status: "ok",
    mode: "synthetic-local",
    liveSending: false,
  });
  const response = await app.request("/api/v1/snapshot");
  expect(response.status).toBe(200);
  expect(snapshotSchema.parse(await response.json()).prospects).toHaveLength(6);
  expect(response.headers.get("cache-control")).toBe("no-store");
});
it.each(["POST", "PUT", "PATCH", "DELETE", "OPTIONS"])(
  "rejects %s including attempted send/approval routes",
  async (method) => {
    for (const path of [
      "/api/v1/snapshot",
      "/api/v1/claims",
      "/api/v1/authorize-send",
      "/api/v1/approvals",
    ]) {
      const response = await app.request(path, { method });
      expect(response.status).toBe(405);
      expect(await response.json()).toMatchObject({ error: "READ_ONLY_SHELL" });
    }
  },
);
it("unknown routes return JSON 404 and query strings cannot enable capabilities", async () => {
  expect((await app.request("/api/v1/missing")).status).toBe(404);
  const data = await (
    await app.request("/api/v1/snapshot?liveSending=true&workspaceId=other")
  ).json();
  expect(data.liveSending).toBe(false);
});
