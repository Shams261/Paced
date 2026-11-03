import { expect, it, vi } from "vitest";
import { logEvent, requestEvent } from "./telemetry.js";
it("maps requests to bounded routes and never includes query strings or unknown paths", () => {
  const id = crypto.randomUUID();
  const response = new Response(null, {
    status: 303,
    headers: { "X-Request-ID": id },
  });
  const callback = requestEvent(
    new Request(
      "https://sequence-dev-etj.pages.dev/api/auth/callback?code=secret-code&state=x",
    ),
    response,
    { started: 12.34, queries: 2, bytes: 0 },
  );
  expect(callback).toEqual({
    requestId: id,
    route: "/api/auth/callback",
    method: "GET",
    status: 303,
    durationMs: 12.3,
    sql: 2,
    bytes: 0,
  });
  expect(JSON.stringify(callback)).not.toContain("secret");
  const unknown = requestEvent(
    new Request(
      "https://sequence-dev-etj.pages.dev/api/v1/prospects/123?email=a@b.c",
      { method: "DELETE" },
    ),
    new Response(null, { status: 404 }),
    { started: 1, queries: 0, bytes: 10 },
  );
  expect(unknown.route).toBe("other");
  expect(unknown.requestId).toBe("none");
});
it("refuses events with extra fields or free text", () => {
  const log = vi.fn();
  const good = {
    requestId: "none",
    route: "/api/v1/me",
    method: "GET",
    status: 200,
    durationMs: 1,
    sql: 1,
    bytes: 5,
  };
  logEvent(good, log);
  expect(log).toHaveBeenCalledWith(JSON.stringify(good));
  expect(() => logEvent({ ...good, email: "a@b.c" } as never, log)).toThrow(
    "TELEMETRY_FIELDS",
  );
  expect(() =>
    logEvent({ ...good, route: "/api/v1/me?token=abc" }, log),
  ).toThrow("TELEMETRY_CONTENT");
  expect(() => logEvent({ ...good, status: "200" as never }, log)).toThrow(
    "TELEMETRY_FIELDS",
  );
  expect(log).toHaveBeenCalledTimes(1);
});
