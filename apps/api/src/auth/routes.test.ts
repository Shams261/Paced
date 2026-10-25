import { expect, it, vi } from "vitest";
import { createAuthApp } from "./routes.js";
import { SessionStore } from "./store.js";
import {
  csrfToken,
  digest,
  opaqueToken,
  TokenVault,
  LOGIN_COOKIE,
  SESSION_COOKIE,
} from "./security.js";
const origin = "https://sequence-dev-etj.pages.dev";
async function fixture() {
  const cookie = opaqueToken(),
    hash = await digest(cookie),
    csrfSecret = opaqueToken();
  const vault = new TokenVault({ v1: opaqueToken() }, "v1");
  const verifier = "v".repeat(64);
  const sealed = await vault.sealVerifier(verifier, hash);
  const identity = {
    userId: crypto.randomUUID(),
    providerSessionId: crypto.randomUUID(),
    expiresAt: Date.now() / 1000 + 3600,
  };
  const tokens = {
    accessToken: "private-access",
    refreshToken: "private-refresh",
  };
  const record = {
    hash,
    ...identity,
    tokenExpiresAt: identity.expiresAt,
    absoluteExpiresAt: identity.expiresAt + 3600,
    sealed: await vault.seal(tokens, hash),
    revision: 1,
    refreshing: false,
    workspaceId: null as string | null,
  };
  let consumed = false;
  const invoke = vi.fn(async (op: string): Promise<unknown> => {
    if (op === "login_consume") {
      if (consumed) return null;
      consumed = true;
      return sealed;
    }
    if (op === "read") return record;
    return { ok: true };
  });
  const provider = {
    begin: vi.fn().mockResolvedValue({
      url: "https://example.supabase.co/auth/v1/authorize",
      verifier,
    }),
    exchange: vi.fn().mockResolvedValue(tokens),
    verify: vi.fn().mockResolvedValue(identity),
    refresh: vi.fn().mockResolvedValue(tokens),
    signOut: vi.fn().mockResolvedValue(undefined),
  };
  const controls = {
    rate: vi.fn().mockResolvedValue(0),
    event: vi.fn().mockResolvedValue(undefined),
    maintain: vi.fn().mockResolvedValue(undefined),
    usage: vi.fn().mockResolvedValue(undefined),
  };
  const management = {
    call: vi.fn().mockResolvedValue({ sendingEnabled: false }),
    invoke:
      vi.fn<
        (
          token: string,
          fn: string,
          args: Record<string, unknown>,
        ) => Promise<Response>
      >(),
  };
  const app = createAuthApp({
    management,
    origin,
    csrfSecret,
    ipHashSecret: opaqueToken(),
    vault,
    provider,
    store: new SessionStore({ invoke }),
    controls,
  });
  const request = (path: string, init: RequestInit = {}) =>
    app.request(origin + path, init);
  const headers = {
    Cookie: `${SESSION_COOKIE}=${cookie}`,
    Origin: origin,
    "X-Sequence-Client-IP": "127.0.0.1",
  };
  return {
    management,
    request,
    headers,
    cookie,
    hash,
    record,
    provider,
    controls,
    invoke,
    csrfSecret,
  };
}
it("rejects cross-origin login before starting a provider transaction", async () => {
  const f = await fixture();
  const response = await f.request("/api/auth/login", {
    method: "POST",
    headers: { ...f.headers, Origin: "https://evil.example" },
  });
  expect(response.status).toBe(403);
  expect(f.provider.begin).not.toHaveBeenCalled();
});
it("uses secure browser-bound transaction cookies and rate limits", async () => {
  const f = await fixture();
  const response = await f.request("/api/auth/login", {
    method: "POST",
    headers: f.headers,
  });
  expect(response.status).toBe(303);
  expect(response.headers.get("set-cookie")).toContain(
    "HttpOnly; Secure; SameSite=Lax",
  );
  f.controls.rate.mockResolvedValue(60);
  const denied = await f.request("/api/auth/login", {
    method: "POST",
    headers: f.headers,
  });
  expect(denied.status).toBe(429);
  expect(denied.headers.get("Retry-After")).toBe("60");
});
it("consumes a callback once and never uses an arbitrary return URL", async () => {
  const f = await fixture();
  const headers = { ...f.headers, Cookie: `${LOGIN_COOKIE}=${f.cookie}` };
  const path =
    "/api/auth/callback?code=synthetic&returnTo=https://evil.example";
  const response = await f.request(path, { headers });
  expect(response.status).toBe(303);
  expect(response.headers.get("Location")).toBe(origin + "/");
  expect(response.headers.get("set-cookie")).toContain(SESSION_COOKIE);
  const replay = await f.request(path, { headers });
  expect(replay.headers.get("Location")).toBe(origin + "/?auth=expired");
  expect(f.provider.exchange).toHaveBeenCalledTimes(1);
  expect(await response.text()).not.toContain("private-access");
});
it("rejects missing transactions and handles owner cancellation", async () => {
  const f = await fixture();
  expect(
    (
      await f.request("/api/auth/callback?code=synthetic", {
        headers: f.headers,
      })
    ).headers.get("Location"),
  ).toBe(origin + "/?auth=denied");
  const response = await f.request("/api/auth/callback?error=access_denied", {
    headers: { ...f.headers, Cookie: `${LOGIN_COOKIE}=${f.cookie}` },
  });
  expect(response.headers.get("Location")).toBe(origin + "/?auth=cancelled");
  expect(f.provider.exchange).not.toHaveBeenCalled();
});
it("distinguishes pending and admitted without returning provider tokens", async () => {
  const f = await fixture();
  const response = await f.request("/api/auth/session", { headers: f.headers });
  expect(await response.json()).toEqual({
    state: "pending",
    csrfToken: await csrfToken(f.csrfSecret, f.hash),
  });
  expect(response.headers.get("Cache-Control")).toContain("no-store");
  expect((await f.request("/api/v1/me", { headers: f.headers })).status).toBe(
    403,
  );
  f.record.workspaceId = crypto.randomUUID();
  const admitted = await f.request("/api/v1/me", { headers: f.headers });
  expect(await admitted.json()).toEqual({
    userId: f.record.userId,
    workspaceId: f.record.workspaceId,
  });
});
it("requires CSRF for logout and fails closed on authorization outages", async () => {
  const f = await fixture();
  expect(
    (
      await f.request("/api/auth/logout", {
        method: "POST",
        headers: f.headers,
      })
    ).status,
  ).toBe(403);
  expect(f.provider.signOut).not.toHaveBeenCalled();
  const response = await f.request("/api/auth/logout", {
    method: "POST",
    headers: {
      ...f.headers,
      "X-CSRF-Token": await csrfToken(f.csrfSecret, f.hash),
    },
  });
  expect(response.status).toBe(200);
  expect(response.headers.get("Set-Cookie")).toContain("Max-Age=0");
  f.invoke.mockRejectedValue(new Error("private database error"));
  const failed = await f.request("/api/v1/me", { headers: f.headers });
  expect(failed.status).toBe(503);
  expect(await failed.text()).not.toContain("private database");
});
it("audits early denials once with the response correlation ID and no request secrets", async () => {
  const f = await fixture();
  const response = await f.request("/api/auth/login?secret=private-query", {
    method: "POST",
    headers: { ...f.headers, Origin: "https://evil.example" },
  });
  expect(f.controls.event).toHaveBeenCalledExactlyOnceWith(
    "login_denied",
    response.headers.get("X-Request-ID"),
  );
  expect(JSON.stringify(f.controls.event.mock.calls)).not.toContain("private");
  expect(JSON.stringify(f.controls.event.mock.calls)).not.toContain(f.cookie);
});
it("audits pending access, CSRF and rate-limit denials", async () => {
  const f = await fixture();
  for (const [path, init] of [
    ["/api/v1/me", { headers: f.headers }],
    ["/api/auth/logout", { method: "POST", headers: f.headers }],
  ] as const) {
    f.controls.event.mockClear();
    const response = await f.request(path, init);
    expect(response.status).toBe(403);
    expect(f.controls.event).toHaveBeenCalledExactlyOnceWith(
      "session_denied",
      response.headers.get("X-Request-ID"),
    );
  }
  f.controls.event.mockClear();
  f.controls.rate.mockResolvedValue(60);
  const limited = await f.request("/api/auth/login", {
    method: "POST",
    headers: f.headers,
  });
  expect(limited.status).toBe(429);
  expect(f.controls.event).toHaveBeenCalledExactlyOnceWith(
    "login_denied",
    limited.headers.get("X-Request-ID"),
  );
});
it("audits callback rejection and outages without provider error details", async () => {
  const f = await fixture();
  const denied = await f.request("/api/auth/callback?code=private-code", {
    headers: f.headers,
  });
  expect(f.controls.event).toHaveBeenCalledExactlyOnceWith(
    "login_denied",
    denied.headers.get("X-Request-ID"),
  );
  f.controls.event.mockClear();
  f.provider.exchange.mockRejectedValue(new Error("private provider secret"));
  const failed = await f.request("/api/auth/callback?code=private-code", {
    headers: { ...f.headers, Cookie: `${LOGIN_COOKIE}=${f.cookie}` },
  });
  expect(failed.headers.get("Location")).toBe(origin + "/?auth=unavailable");
  expect(f.controls.event).toHaveBeenCalledExactlyOnceWith(
    "provider_unavailable",
    failed.headers.get("X-Request-ID"),
  );
});
it("fails closed without recursive logging when audit storage is unavailable", async () => {
  const f = await fixture();
  f.controls.event.mockRejectedValue(new Error("private audit failure"));
  const response = await f.request("/api/v1/me", { headers: f.headers });
  expect(response.status).toBe(503);
  expect(await response.text()).toBe('{"error":"AUTH_UNAVAILABLE"}');
  expect(f.controls.event).toHaveBeenCalledTimes(1);
});
it("does not record successful or voluntarily cancelled sign-in as a denial", async () => {
  const f = await fixture();
  await f.request("/api/auth/session", { headers: f.headers });
  await f.request("/api/auth/callback?error=access_denied", {
    headers: { ...f.headers, Cookie: `${LOGIN_COOKIE}=${f.cookie}` },
  });
  expect(f.controls.event).not.toHaveBeenCalled();
});

it("protects management reads and writes with admission, CSRF and validated scope", async () => {
  const f = await fixture();
  expect(
    (await f.request("/api/v1/management", { headers: f.headers })).status,
  ).toBe(403);
  expect(f.management.call).not.toHaveBeenCalled();
  f.record.workspaceId = crypto.randomUUID();
  const read = await f.request("/api/v1/management?page=0", {
    headers: f.headers,
  });
  expect(read.status).toBe(200);
  expect(f.management.call).toHaveBeenCalledWith("private-access", "snapshot", {
    page: 0,
  });
  const body = JSON.stringify({
    operation: "import",
    requestId: crypto.randomUUID(),
    keys: ["sample-ada"],
    listName: "Samples",
  });
  expect(
    (
      await f.request("/api/v1/management", {
        method: "POST",
        headers: f.headers,
        body,
      })
    ).status,
  ).toBe(403);
  const headers = {
    ...f.headers,
    "X-CSRF-Token": await csrfToken(f.csrfSecret, f.hash),
  };
  const valid = await f.request("/api/v1/management", {
    method: "POST",
    headers,
    body,
  });
  expect(valid.status).toBe(200);
  expect(await valid.text()).not.toContain("private-access");
  expect(
    (
      await f.request("/api/v1/management", {
        method: "POST",
        headers,
        body: JSON.stringify({
          ...JSON.parse(body),
          workspaceId: crypto.randomUUID(),
        }),
      })
    ).status,
  ).toBe(400);
  f.management.call.mockRejectedValue(new Error("private error"));
  const outage = await f.request("/api/v1/management", { headers: f.headers });
  expect(outage.status).toBe(503);
  expect(await outage.text()).not.toContain("private error");
});

it("reports quota status to the admitted owner only", async () => {
  const f = await fixture();
  expect(
    (await f.request("/api/v1/status", { headers: f.headers })).status,
  ).toBe(403);
  f.record.workspaceId = crypto.randomUUID();
  f.management.call.mockResolvedValue({ growthAllowed: false, reasons: ["x"] });
  const response = await f.request("/api/v1/status", { headers: f.headers });
  expect(response.status).toBe(200);
  expect(f.management.call).toHaveBeenCalledWith(
    "private-access",
    "status",
    {},
  );
  expect(await response.json()).toMatchObject({ growthAllowed: false });
});
it("streams a tenant export as newline-delimited JSON with manifest and end lines", async () => {
  const f = await fixture();
  f.record.workspaceId = crypto.randomUUID();
  const headers = {
    ...f.headers,
    "X-CSRF-Token": await csrfToken(f.csrfSecret, f.hash),
  };
  expect(
    (
      await f.request("/api/v1/export", {
        method: "POST",
        headers: f.headers,
      })
    ).status,
  ).toBe(403);
  expect(f.management.invoke).not.toHaveBeenCalled();
  f.management.invoke.mockImplementation(async (_token, _fn, args) => {
    if (args.section === "manifest")
      return Response.json({
        formatVersion: "sequence-export-1",
        pageSize: 2,
        counts: Object.fromEntries(
          [
            "accounts",
            "prospects",
            "lists",
            "memberships",
            "campaigns",
            "revisions",
            "approvals",
            "approvalRecipients",
            "enrollments",
            "actions",
            "attempts",
            "results",
            "observations",
            "reservations",
          ].map((k) => [k, k === "prospects" ? 3 : 0]),
        ),
      });
    return new Response(`[{"section":"${args.section}","page":${args.page}}]`);
  });
  const response = await f.request("/api/v1/export", {
    method: "POST",
    headers,
  });
  expect(response.status).toBe(200);
  expect(response.headers.get("Content-Type")).toBe("application/x-ndjson");
  expect(response.headers.get("Content-Disposition")).toMatch(/attachment/);
  const lines = (await response.text()).trimEnd().split("\n");
  const parsed = lines.map(
    (line) => JSON.parse(line) as Record<string, unknown>,
  );
  expect(parsed[0]).toMatchObject({ type: "manifest", pageSize: 2 });
  expect(parsed.at(-1)).toEqual({ type: "end", pages: 15 });
  expect(
    parsed.filter((l) => l.type === "prospects").map((l) => l.page),
  ).toEqual([0, 1]);
  expect(parsed[2]).toMatchObject({
    type: "prospects",
    rows: [{ section: "prospects", page: 0 }],
  });
  expect(
    f.management.invoke.mock.calls.every(
      ([token]) => token === "private-access",
    ),
  ).toBe(true);
  const again = await f.request("/api/v1/export", { method: "POST", headers });
  expect(await again.text()).not.toContain("private-access");
});
it("deletes a workspace only with CSRF, exact confirmation and a fresh sign-in", async () => {
  const f = await fixture();
  f.record.workspaceId = crypto.randomUUID();
  const headers = {
    ...f.headers,
    "X-CSRF-Token": await csrfToken(f.csrfSecret, f.hash),
    "Content-Type": "application/json",
  };
  const body = JSON.stringify({
    requestId: crypto.randomUUID(),
    confirmation: "DELETE MY WORKSPACE",
  });
  const post = (b: string, h: Record<string, string> = headers) =>
    f.request("/api/v1/delete-workspace", {
      method: "POST",
      headers: h,
      body: b,
    });
  expect((await post(body, f.headers)).status).toBe(403);
  expect(
    (
      await post(
        JSON.stringify({
          requestId: crypto.randomUUID(),
          confirmation: "delete",
        }),
      )
    ).status,
  ).toBe(400);
  // The fixture session is far older than five minutes.
  const stale = await post(body);
  expect(stale.status).toBe(403);
  expect(await stale.json()).toEqual({ error: "REAUTHENTICATION_REQUIRED" });
  expect(f.management.invoke).not.toHaveBeenCalled();
  f.record.absoluteExpiresAt = Date.now() / 1000 + 24 * 3600 - 60;
  f.management.invoke.mockResolvedValue(
    Response.json({
      deleted: true,
      workspaceId: f.record.workspaceId,
      removed: { prospects: 6 },
    }),
  );
  const done = await post(body);
  expect(done.status).toBe(200);
  expect(await done.json()).toMatchObject({
    deleted: true,
    removed: { prospects: 6 },
    providerConfirmed: true,
  });
  expect(f.management.invoke).toHaveBeenCalledWith(
    "private-access",
    "seq_delete_workspace",
    JSON.parse(body),
  );
  expect(done.headers.get("Set-Cookie")).toContain(
    `${SESSION_COOKIE}=; Path=/; Max-Age=0`,
  );
  expect(f.provider.signOut).toHaveBeenCalledWith("private-access");
  expect(f.invoke).toHaveBeenCalledWith(
    "revoke",
    expect.objectContaining({ hash: f.hash }),
  );
});
