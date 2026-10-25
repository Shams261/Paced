import { managementGateway } from "./management.js";
import { countedResponse } from "./usage.js";
import { GoogleProvider } from "./auth/provider.js";
import { createAuthApp } from "./auth/routes.js";
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
function dependencies(env: Environment, onQuery: () => void = () => undefined) {
  if (
    env.APP_ORIGIN !== "https://sequence-dev-etj.pages.dev" ||
    env.SUPABASE_URL !== "https://syisdkvnkbmbsbvchdgb.supabase.co" ||
    !env.SUPABASE_PUBLISHABLE_KEY?.startsWith("sb_publishable_") ||
    !validOpaque(env.CSRF_SECRET) ||
    !validOpaque(env.IP_HASH_SECRET)
  )
    throw new Error("INVALID_DEPLOYMENT_BINDINGS");
  const keys = JSON.parse(env.TOKEN_KEYS) as Record<string, string>;
  const vault = new TokenVault(keys, env.TOKEN_KEY_VERSION);
  const connection = postgresAuthDatabase(
    env.HYPERDRIVE.connectionString,
    onQuery,
  );
  return {
    connection,
    app: createAuthApp({
      management: managementGateway(
        env.SUPABASE_URL,
        env.SUPABASE_PUBLISHABLE_KEY,
      ),
      origin: env.APP_ORIGIN,
      csrfSecret: env.CSRF_SECRET,
      ipHashSecret: env.IP_HASH_SECRET,
      vault,
      store: new SessionStore(connection.database),
      controls: connection.controls,
      provider: new GoogleProvider(
        env.SUPABASE_URL,
        env.SUPABASE_PUBLISHABLE_KEY,
      ),
    }),
  };
}
export default {
  async fetch(
    request: Request,
    env: Environment,
    ctx: Context,
  ): Promise<Response> {
    let d: ReturnType<typeof dependencies> | undefined;
    try {
      let queries = 0;
      const started = performance.now();
      d = dependencies(env, () => {
        queries++;
      });
      const deps = d;
      const response = await deps.app.fetch(request);
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
          ctx.waitUntil(
            (async () => {
              try {
                await deps.connection.controls.usage(bytes);
              } catch {
                // Never fail or delay a response for a usage estimate.
              } finally {
                await deps.connection.close().catch(() => undefined);
              }
            })(),
          );
        },
      );
    } catch (error) {
      await d?.connection.close().catch(() => undefined);
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
    const d = dependencies(env);
    try {
      await d.connection.controls.maintain();
    } finally {
      await d.connection.close();
    }
  },
};
