import {
  deleteWorkspaceSchema,
  managementRequestSchema,
  ManagementError,
  type ManagementGateway,
} from "../management.js";
import { exportSections } from "../../../../packages/shell-contracts/src/management.js";
import { Hono, type Context } from "hono";
import { AuthenticationRejected, type GoogleProvider } from "./provider.js";
import { Sessions, type AuthenticatedSession } from "./sessions.js";
import { SessionStore, type AuthControls } from "./store.js";
import {
  ABSOLUTE_SECONDS,
  LOGIN_COOKIE,
  LOGIN_SECONDS,
  SESSION_COOKIE,
  TokenVault,
  configuredOrigin,
  constantTimeEqual,
  csrfToken,
  digest,
  opaqueToken,
  readCookie,
  sameOrigin,
  sessionCookie,
} from "./security.js";
/** Deletion needs a sign-in no older than this many seconds; the database checks it again. */
export const FRESH_LOGIN_SECONDS = 300;
export const EXPORT_PAGE_SIZE = 500;
export const AUTH_CSP =
  "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
export interface AuthDependencies {
  management?: ManagementGateway;
  origin: string;
  csrfSecret: string;
  ipHashSecret: string;
  provider: Pick<
    GoogleProvider,
    "begin" | "exchange" | "verify" | "refresh" | "signOut"
  >;
  store: SessionStore;
  controls: AuthControls;
  vault: TokenVault;
}
export function createAuthApp(d: AuthDependencies) {
  const origin = configuredOrigin(d.origin);
  const sessions = new Sessions(d.store, d.provider, d.vault);
  const app = new Hono();
  // Outer middleware observes early denials as well as handler/error responses.
  app.use("*", async (c, next) => {
    const requestId = crypto.randomUUID();
    c.header("X-Request-ID", requestId);
    await next();
    const callback = new URL(c.req.url).pathname === "/api/auth/callback";
    const location = c.res.headers.get("Location");
    const reason =
      callback && location?.startsWith(`${origin}/?auth=`)
        ? new URL(location).searchParams.get("auth")
        : null;
    const unavailable = c.res.status === 503 || reason === "unavailable";
    const denied =
      [401, 403, 429].includes(c.res.status) ||
      ["denied", "expired", "rate-limited"].includes(reason ?? "");
    if (unavailable || denied) {
      await d.controls.event(
        unavailable
          ? "provider_unavailable"
          : new URL(c.req.url).pathname.startsWith("/api/auth/login") ||
              callback
            ? "login_denied"
            : "session_denied",
        requestId,
      );
    }
  });
  app.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store, private");
    c.header("Content-Security-Policy", AUTH_CSP);
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "no-referrer");
    if (new URL(c.req.url).origin !== origin)
      return c.json({ error: "ORIGIN_DENIED" }, 403);
    if (c.req.method !== "GET" && !sameOrigin(c.req.raw, origin))
      return c.json({ error: "ORIGIN_DENIED" }, 403);
    const cookie = readCookie(c.req.raw, SESSION_COOKIE);
    if (cookie) {
      const retry = await d.controls.rate("session", await digest(cookie));
      if (retry) {
        c.header("Retry-After", String(retry));
        return c.json({ error: "RATE_LIMITED" }, 429);
      }
    }
    await next();
  });
  async function ipRate(request: Request, scope: "login" | "callback") {
    // Only the private Pages service binding may supply this overwritten header.
    const ip = request.headers.get("X-Sequence-Client-IP");
    if (!ip || ip.length > 64 || !/^[0-9a-fA-F:.]+$/.test(ip))
      throw new Error("TRUSTED_IP_UNAVAILABLE");
    return d.controls.rate(scope, await digest(`${d.ipHashSecret}:${ip}`));
  }
  app.post("/api/auth/login", async (c) => {
    const retry = await ipRate(c.req.raw, "login");
    if (retry) {
      c.header("Retry-After", String(retry));
      return c.json({ error: "RATE_LIMITED" }, 429);
    }
    const pending = await d.provider.begin(`${origin}/api/auth/callback`);
    const token = opaqueToken(),
      hash = await digest(token);
    await d.store.createLogin(
      hash,
      await d.vault.sealVerifier(pending.verifier, hash),
    );
    c.header("Set-Cookie", sessionCookie(LOGIN_COOKIE, token, LOGIN_SECONDS));
    return c.redirect(pending.url, 303);
  });
  app.get("/api/auth/callback", async (c) => {
    c.header("Set-Cookie", sessionCookie(LOGIN_COOKIE, "", 0));
    try {
      const retry = await ipRate(c.req.raw, "callback");
      if (retry) {
        c.header("Retry-After", String(retry));
        return c.redirect(`${origin}/?auth=rate-limited`, 303);
      }
      const token = readCookie(c.req.raw, LOGIN_COOKIE);
      if (!token) return c.redirect(`${origin}/?auth=denied`, 303);
      const hash = await digest(token),
        sealed = await d.store.consumeLogin(hash);
      if (!sealed) return c.redirect(`${origin}/?auth=expired`, 303);
      if (c.req.query("error"))
        return c.redirect(`${origin}/?auth=cancelled`, 303);
      const codes = new URL(c.req.url).searchParams.getAll("code");
      if (codes.length !== 1 || !/^[A-Za-z0-9._~-]{1,2048}$/.test(codes[0]!))
        return c.redirect(`${origin}/?auth=denied`, 303);
      const tokens = await d.provider.exchange(
        codes[0]!,
        await d.vault.openVerifier(sealed, hash),
      );
      const cookie = await sessions.create(tokens);
      c.header(
        "Set-Cookie",
        sessionCookie(SESSION_COOKIE, cookie, ABSOLUTE_SECONDS),
        { append: true },
      );
      return c.redirect(`${origin}/`, 303);
    } catch (error) {
      // Never return or log provider errors, query strings or credentials.
      const rejected = error instanceof AuthenticationRejected;
      return c.redirect(
        `${origin}/?auth=${rejected ? "denied" : "unavailable"}`,
        303,
      );
    }
  });
  app.get("/api/auth/session", async (c) => {
    const cookie = readCookie(c.req.raw, SESSION_COOKIE);
    const session = cookie ? await sessions.authenticate(cookie) : null;
    if (!session) return c.json({ state: "signed-out" });
    return c.json({
      state: session.record.workspaceId ? "admitted" : "pending",
      csrfToken: await csrfToken(d.csrfSecret, session.record.hash),
    });
  });
  app.get("/api/v1/me", async (c) => {
    const cookie = readCookie(c.req.raw, SESSION_COOKIE);
    const session = cookie ? await sessions.authenticate(cookie) : null;
    if (!session) return c.json({ error: "INVALID_SESSION" }, 401);
    if (!session.record.workspaceId)
      return c.json({ error: "ACCESS_PENDING" }, 403);
    return c.json({
      userId: session.identity.userId,
      workspaceId: session.record.workspaceId,
    });
  });
  app.post("/api/auth/logout", async (c) => {
    const cookie = readCookie(c.req.raw, SESSION_COOKIE);
    if (!cookie) return c.json({ error: "INVALID_SESSION" }, 401);
    const expected = await csrfToken(d.csrfSecret, await digest(cookie));
    if (!constantTimeEqual(expected, c.req.header("X-CSRF-Token") ?? ""))
      return c.json({ error: "CSRF_DENIED" }, 403);
    const result = await sessions.logout(cookie);
    c.header("Set-Cookie", sessionCookie(SESSION_COOKIE, "", 0));
    return c.json({
      state: "signed-out",
      providerConfirmed: result.providerConfirmed,
    });
  });
  app.on(["GET", "POST"], "/api/v1/management", async (c) => {
    const cookie = readCookie(c.req.raw, SESSION_COOKIE);
    const session = cookie ? await sessions.authenticate(cookie) : null;
    if (!session) return c.json({ error: "INVALID_SESSION" }, 401);
    if (!session.record.workspaceId)
      return c.json({ error: "ACCESS_PENDING" }, 403);
    if (!d.management) return c.json({ error: "STORAGE_UNAVAILABLE" }, 503);
    try {
      if (c.req.method === "GET") {
        const page = Number(c.req.query("page") ?? 0);
        if (!Number.isInteger(page) || page < 0 || page > 199)
          return c.json({ error: "INVALID_PAGE" }, 400);
        return c.json(
          await d.management.call(session.accessToken, "snapshot", { page }),
        );
      }
      const expected = await csrfToken(d.csrfSecret, session.record.hash);
      if (!constantTimeEqual(expected, c.req.header("X-CSRF-Token") ?? ""))
        return c.json({ error: "CSRF_DENIED" }, 403);
      const body = await c.req.text();
      if (new TextEncoder().encode(body).length > 32_768)
        return c.json({ error: "REQUEST_TOO_LARGE" }, 400);
      let value: unknown;
      try {
        value = JSON.parse(body);
      } catch {
        return c.json({ error: "INVALID_MANAGEMENT_REQUEST" }, 400);
      }
      const parsed = managementRequestSchema.safeParse(value);
      if (!parsed.success)
        return c.json({ error: "INVALID_MANAGEMENT_REQUEST" }, 400);
      return c.json(
        await d.management.call(
          session.accessToken,
          parsed.data.operation,
          parsed.data,
        ),
      );
    } catch (error) {
      if (error instanceof ManagementError)
        return c.json({ error: error.code }, error.status);
      return c.json({ error: "STORAGE_UNAVAILABLE" }, 503);
    }
  });
  // Helpers for the S3-006 lifecycle routes; the management route above keeps its tested shape.
  type Ctx = Context;
  async function admitted(c: Ctx): Promise<AuthenticatedSession | Response> {
    const cookie = readCookie(c.req.raw, SESSION_COOKIE);
    const session = cookie ? await sessions.authenticate(cookie) : null;
    if (!session) return c.json({ error: "INVALID_SESSION" }, 401);
    if (!session.record.workspaceId)
      return c.json({ error: "ACCESS_PENDING" }, 403);
    return session;
  }
  async function csrfValid(c: Ctx, session: AuthenticatedSession) {
    const expected = await csrfToken(d.csrfSecret, session.record.hash);
    return constantTimeEqual(expected, c.req.header("X-CSRF-Token") ?? "");
  }
  function failed(c: Ctx, error: unknown) {
    if (error instanceof ManagementError)
      return c.json({ error: error.code }, error.status);
    return c.json({ error: "STORAGE_UNAVAILABLE" }, 503);
  }
  app.get("/api/v1/status", async (c) => {
    const session = await admitted(c);
    if (session instanceof Response) return session;
    if (!d.management) return c.json({ error: "STORAGE_UNAVAILABLE" }, 503);
    try {
      return c.json(await d.management.call(session.accessToken, "status", {}));
    } catch (error) {
      return failed(c, error);
    }
  });
  app.post("/api/v1/export", async (c) => {
    const session = await admitted(c);
    if (session instanceof Response) return session;
    if (!(await csrfValid(c, session)))
      return c.json({ error: "CSRF_DENIED" }, 403);
    const gateway = d.management;
    if (!gateway) return c.json({ error: "STORAGE_UNAVAILABLE" }, 503);
    const token = session.accessToken;
    let manifest: Record<string, unknown>;
    let counts: Record<string, unknown>;
    try {
      const response = await gateway.invoke(token, "seq_export", {
        section: "manifest",
        page: 0,
      });
      const value: unknown = await response.json();
      if (
        !value ||
        typeof value !== "object" ||
        !("counts" in value) ||
        !value.counts ||
        typeof value.counts !== "object"
      )
        throw new Error("INVALID_EXPORT_MANIFEST");
      manifest = value as Record<string, unknown>;
      counts = value.counts as Record<string, unknown>;
    } catch (error) {
      return failed(c, error);
    }
    const pageSize =
      typeof manifest.pageSize === "number" && manifest.pageSize > 0
        ? manifest.pageSize
        : EXPORT_PAGE_SIZE;
    // Section pages are piped through unparsed so a large export costs no Worker CPU.
    const encoder = new TextEncoder();
    const { readable, writable } = new TransformStream<
      Uint8Array,
      Uint8Array
    >();
    const writer = writable.getWriter();
    const write = (text: string) => writer.write(encoder.encode(text));
    void (async () => {
      try {
        await write(JSON.stringify({ type: "manifest", ...manifest }) + "\n");
        let pages = 0;
        for (const section of exportSections) {
          const total = counts[section];
          if (!Number.isInteger(total) || (total as number) < 0)
            throw new Error("INVALID_EXPORT_MANIFEST");
          const count = Math.max(1, Math.ceil((total as number) / pageSize));
          for (let page = 0; page < count; page++) {
            const response = await gateway.invoke(token, "seq_export", {
              section,
              page,
            });
            await write(
              `{"type":${JSON.stringify(section)},"page":${page},"rows":`,
            );
            if (response.body)
              for await (const chunk of response.body)
                await writer.write(chunk);
            else await write("[]");
            await write("}\n");
            pages++;
          }
        }
        await write(JSON.stringify({ type: "end", pages }) + "\n");
        await writer.close();
      } catch (error) {
        // A truncated download has no end line; the dashboard refuses to keep it.
        await writer.abort(error).catch(() => undefined);
      }
    })();
    c.header("Content-Type", "application/x-ndjson");
    c.header(
      "Content-Disposition",
      `attachment; filename="sequence-export-${new Date().toISOString().slice(0, 10)}.ndjson"`,
    );
    return c.body(readable);
  });
  app.post("/api/v1/delete-workspace", async (c) => {
    const cookie = readCookie(c.req.raw, SESSION_COOKIE);
    const session = await admitted(c);
    if (session instanceof Response) return session;
    if (!(await csrfValid(c, session)))
      return c.json({ error: "CSRF_DENIED" }, 403);
    if (!d.management) return c.json({ error: "STORAGE_UNAVAILABLE" }, 503);
    const body = await c.req.text();
    if (new TextEncoder().encode(body).length > 4096)
      return c.json({ error: "REQUEST_TOO_LARGE" }, 400);
    let value: unknown;
    try {
      value = JSON.parse(body);
    } catch {
      return c.json({ error: "INVALID_DELETION_REQUEST" }, 400);
    }
    const parsed = deleteWorkspaceSchema.safeParse(value);
    if (!parsed.success)
      return c.json({ error: "INVALID_DELETION_REQUEST" }, 400);
    // The application session was created at absolute expiry minus its lifetime.
    const createdAt = session.record.absoluteExpiresAt - ABSOLUTE_SECONDS;
    if (Date.now() / 1000 - createdAt > FRESH_LOGIN_SECONDS)
      return c.json({ error: "REAUTHENTICATION_REQUIRED" }, 403);
    try {
      const response = await d.management.invoke(
        session.accessToken,
        "seq_delete_workspace",
        parsed.data,
      );
      const result: unknown = await response.json();
      if (
        !result ||
        typeof result !== "object" ||
        !("deleted" in result) ||
        result.deleted !== true
      )
        throw new Error("INVALID_DELETION_RESULT");
      // Admission is already off and every application session revoked by the database.
      if (cookie) await d.store.revoke(await digest(cookie));
      let providerConfirmed = true;
      try {
        await d.provider.signOut(session.accessToken);
      } catch {
        providerConfirmed = false;
      }
      c.header("Set-Cookie", sessionCookie(SESSION_COOKIE, "", 0));
      return c.json({
        ...(result as Record<string, unknown>),
        providerConfirmed,
      });
    } catch (error) {
      return failed(c, error);
    }
  });
  app.notFound((c) => c.json({ error: "NOT_FOUND" }, 404));
  app.onError((error, c) => {
    if (new URL(c.req.url).pathname === "/api/auth/callback")
      return c.redirect(`${origin}/?auth=unavailable`, 303);
    return c.json(
      {
        error:
          error instanceof AuthenticationRejected
            ? "INVALID_SESSION"
            : "AUTH_UNAVAILABLE",
      },
      error instanceof AuthenticationRejected ? 401 : 503,
    );
  });
  return app;
}
