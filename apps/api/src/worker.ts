import { managementGateway } from "./management.js";
import { countedResponse } from "./usage.js";
import { logEvent, requestEvent } from "./telemetry.js";
import { GoogleProvider } from "./auth/provider.js";
import { createAuthApp } from "./auth/routes.js";
import {
  scopedControls,
  scopedDatabase,
  withConnection,
} from "./auth/scope.js";
import { SessionStore, postgresAuthDatabase } from "./auth/store.js";
import { TokenVault, validOpaque } from "./auth/security.js";
interface Environment {
  HYPERDRIVE: { connectionString: string };
  APP_ORIGIN: string;
  SUPABASE_URL: string;
  SUPABASE_PUBLISHABLE_KEY: string;
  TOKEN_KEYS: string;
  TOKEN_KEY_VERSION: string;
  CSRF_SECRET: string;
  IP_HASH_SECRET: string;
}
interface Context {
  waitUntil(promise: Promise<unknown>): void;
}
function validate(env: Environment) {
  if (
    env.APP_ORIGIN !== "https://sequence-dev-etj.pages.dev" ||
    env.SUPABASE_URL !== "https://syisdkvnkbmbsbvchdgb.supabase.co" ||
    !env.SUPABASE_PUBLISHABLE_KEY?.startsWith("sb_publishable_") ||
    !validOpaque(env.CSRF_SECRET) ||
    !validOpaque(env.IP_HASH_SECRET)
  )
    throw new Error("INVALID_DEPLOYMENT_BINDINGS");
}
// The application, provider, vault and gateway hold no request state, so they are
// built once per isolate. Bindings only change with a deployment, which starts a
// new isolate; the non-secret fingerprint guards against a reused isolate anyway.
let cached:
  { fingerprint: string; app: ReturnType<typeof createAuthApp> } | undefined;
function application(env: Environment) {
  validate(env);
  const fingerprint = [
    env.APP_ORIGIN,
    env.SUPABASE_URL,
    env.SUPABASE_PUBLISHABLE_KEY,
    env.TOKEN_KEY_VERSION,
  ].join("|");
  if (cached?.fingerprint === fingerprint) return cached.app;
  const keys = JSON.parse(env.TOKEN_KEYS) as Record<string, string>;
  const app = createAuthApp({
    management: managementGateway(
      env.SUPABASE_URL,
      env.SUPABASE_PUBLISHABLE_KEY,
    ),
    origin: env.APP_ORIGIN,
    csrfSecret: env.CSRF_SECRET,
    ipHashSecret: env.IP_HASH_SECRET,
    vault: new TokenVault(keys, env.TOKEN_KEY_VERSION),
    store: new SessionStore(scopedDatabase),
    controls: scopedControls,
    provider: new GoogleProvider(
      env.SUPABASE_URL,
      env.SUPABASE_PUBLISHABLE_KEY,
    ),
  });
  cached = { fingerprint, app };
  return app;
}
export default {
  async fetch(
    request: Request,
    env: Environment,
    ctx: Context,
  ): Promise<Response> {
    let close: (() => Promise<void>) | undefined;
    try {
      let queries = 0;
      const started = performance.now();
      const app = application(env);
      const connection = postgresAuthDatabase(
        env.HYPERDRIVE.connectionString,
        () => {
          queries++;
        },
      );
      close = connection.close;
      const response = await withConnection(connection, () =>
        Promise.resolve(app.fetch(request)),
      );
      const headers = new Headers(response.headers);
      headers.set(
        "Server-Timing",
        `auth;dur=${(performance.now() - started).toFixed(1)}, sql;desc="${queries}"`,
      );
      // Usage is a content-free estimate recorded after the body finishes,
      // outside the request path; the connection closes after that record.
      return countedResponse(
        new Response(response.body, { status: response.status, headers }),
        (bytes) => {
          // Content-free event for Workers Logs; a telemetry failure never affects the response.
          try {
            logEvent(
              requestEvent(request, response, {
                started: performance.now() - started,
                queries,
                bytes,
              }),
            );
          } catch {
            // Never log anything that failed validation.
          }
          ctx.waitUntil(
            (async () => {
              try {
                await connection.controls.usage(bytes);
              } catch {
                // Never fail or delay a response for a usage estimate.
              } finally {
                await connection.close().catch(() => undefined);
              }
            })(),
          );
        },
      );
    } catch (error) {
      await close?.().catch(() => undefined);
      const known = new Set([
        "INVALID_DEPLOYMENT_BINDINGS",
        "INVALID_RUNTIME_DATABASE_ROLE",
        "INVALID_ENCRYPTION_KEY",
        "INVALID_KEY_VERSION",
      ]);
      const reason =
        error instanceof Error && known.has(error.message)
          ? error.message
          : "INITIALIZATION_FAILED";
      return Response.json(
        { error: "AUTH_UNAVAILABLE", reason },
        {
          status: 503,
          headers: {
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
          },
        },
      );
    }
  },
  async scheduled(_event: unknown, env: Environment): Promise<void> {
    validate(env);
    const connection = postgresAuthDatabase(env.HYPERDRIVE.connectionString);
    try {
      await connection.controls.maintain();
    } finally {
      await connection.close();
    }
  },
};
