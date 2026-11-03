import { expect, it, vi } from "vitest";
import { scopedControls, scopedDatabase, withConnection } from "./scope.js";
it("resolves the request's own connection and refuses to run without one", async () => {
  const a = {
    database: { invoke: vi.fn().mockResolvedValue("a") },
    controls: {
      rate: vi.fn().mockResolvedValue(1),
      event: vi.fn(),
      maintain: vi.fn(),
      usage: vi.fn(),
    },
  };
  const b = {
    database: { invoke: vi.fn().mockResolvedValue("b") },
    controls: {
      rate: vi.fn().mockResolvedValue(2),
      event: vi.fn(),
      maintain: vi.fn(),
      usage: vi.fn(),
    },
  };
  const [ra, rb] = await Promise.all([
    withConnection(a, async () => {
      await new Promise((r) => setTimeout(r, 5));
      return [
        await scopedDatabase.invoke("read", {}),
        await scopedControls.rate("session", "h"),
      ];
    }),
    withConnection(b, async () => [
      await scopedDatabase.invoke("read", {}),
      await scopedControls.rate("session", "h"),
    ]),
  ]);
  expect(ra).toEqual(["a", 1]);
  expect(rb).toEqual(["b", 2]);
  expect(a.database.invoke).toHaveBeenCalledTimes(1);
  expect(b.controls.rate).toHaveBeenCalledTimes(1);
  await expect(scopedDatabase.invoke("read", {})).rejects.toThrow(
    "NO_REQUEST_CONNECTION",
  );
});
