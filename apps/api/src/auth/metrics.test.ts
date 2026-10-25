import { expect, it, vi } from "vitest";
const calls = vi.hoisted(() => ({ count: 0 }));
vi.mock("postgres", () => ({
  default: () => {
    const sql = async (parts: TemplateStringsArray) => {
      calls.count++;
      if (parts[0]?.includes("current_user"))
        return [{ name: "sequence_auth_runtime", restricted: true }];
      return [{ result: 0 }];
    };
    return Object.assign(sql, {
      json: (value: unknown) => value,
      end: async () => undefined,
    });
  },
}));
import { postgresAuthDatabase } from "./store.js";
it("counts submitted SQL calls including one role check per connection", async () => {
  calls.count = 0;
  let measured = 0;
  const connection = postgresAuthDatabase(
    "postgres://transport:unused@localhost/test",
    () => {
      measured++;
    },
  );
  await connection.controls.rate("session", "A".repeat(43));
  await connection.database.invoke("read", { hash: "A".repeat(43) });
  expect(measured).toBe(3);
  expect(calls.count).toBe(measured);
  await connection.controls.event("session_denied", crypto.randomUUID());
  expect(measured).toBe(4);
  await connection.close();
  expect(measured).toBe(4);
});
