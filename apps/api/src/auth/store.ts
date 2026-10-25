import postgres from "postgres";
import type { SealedTokens } from "./security.js";
import { validOpaque } from "./security.js";
export interface StoredSession {
  hash: string;
  userId: string;
  providerSessionId: string;
  sealed: SealedTokens;
  tokenExpiresAt: number;
  absoluteExpiresAt: number;
  revision: number;
  refreshing: boolean;
  workspaceId: string | null;
}
export interface SessionIdentity {
  userId: string;
  providerSessionId: string;
  tokenExpiresAt: number;
}
export type AuthOperation =
  | "login_create"
  | "login_consume"
  | "create"
  | "read"
  | "revoke"
  | "refresh_claim"
  | "refresh_complete";
export interface AuthDatabase {
  invoke(
    operation: AuthOperation,
    args: Record<string, unknown>,
  ): Promise<unknown>;
}
export interface AuthControls {
  rate(scope: "login" | "callback" | "session", hash: string): Promise<number>;
  event(
    reason: "login_denied" | "session_denied" | "provider_unavailable",
    requestId: string,
  ): Promise<void>;
  maintain(): Promise<void>;
  /** Content-free usage estimate: one request and its response bytes. */
  usage(bytes: number): Promise<void>;
}
export function postgresAuthDatabase(
  connectionString: string,
  onQuery: () => void = () => undefined,
): {
  database: AuthDatabase;
  controls: AuthControls;
  close: () => Promise<void>;
} {
  // Hyperdrive supplies a restricted-role connection. Do not use operator credentials here.
  const url = new URL(connectionString);
  if (!["postgres:", "postgresql:"].includes(url.protocol))
    throw new Error("INVALID_RUNTIME_DATABASE_PROTOCOL");
  const sql = postgres(connectionString, {
    max: 1,
    prepare: true,
    fetch_types: false,
    connect_timeout: 10,
    idle_timeout: 5,
  });
  // Hyperdrive uses transport credentials in connectionString. Verify the
  // actual PostgreSQL role rather than trusting the transport username.
  let verification: Promise<void> | undefined;
  const verifyRole = () =>
    (verification ??= (async () => {
      onQuery();
      const rows =
        await sql`SELECT current_user AS name, NOT (rolsuper OR rolcreaterole OR rolcreatedb OR rolreplication OR rolbypassrls) AS restricted FROM pg_roles WHERE rolname=current_user`;
      assertRuntimeRole(rows[0]);
    })());
  return {
    database: {
      async invoke(operation, args) {
        await verifyRole();
        onQuery();
        const rows =
          await sql`SELECT sequence_private.auth_session_operation(${operation}, ${sql.json(args as postgres.JSONValue)}) AS result`;
        return rows[0]?.result ?? null;
      },
    },
    controls: {
      async rate(scope, hash) {
        await verifyRole();
        onQuery();
        const rows =
          await sql`SELECT sequence_private.auth_rate_limit(${scope},${hash}) AS result`;
        const value: unknown = rows[0]?.result;
        if (typeof value !== "number" || !Number.isInteger(value) || value < 0)
          throw new Error("INVALID_DATABASE_RESULT");
        return value;
      },
      async event(reason, requestId) {
        await verifyRole();
        onQuery();
        await sql`SELECT sequence_private.auth_record_event(${reason},${requestId}::uuid)`;
      },
      async maintain() {
        await verifyRole();
        onQuery();
        await sql`SELECT sequence_private.auth_maintenance()`;
      },
      async usage(bytes) {
        if (!Number.isInteger(bytes) || bytes < 0)
          throw new Error("INVALID_USAGE_VALUE");
        await verifyRole();
        onQuery();
        await sql`SELECT sequence_private.usage_record(${bytes}::bigint)`;
      },
    },
    close: () => sql.end({ timeout: 5 }),
  };
}
export function assertRuntimeRole(value: unknown): void {
  if (
    !value ||
    typeof value !== "object" ||
    !("name" in value) ||
    value.name !== "sequence_auth_runtime" ||
    !("restricted" in value) ||
    value.restricted !== true
  )
    throw new Error("INVALID_RUNTIME_DATABASE_ROLE");
}
function successful(value: unknown): boolean {
  if (value === null) return false;
  if (
    !value ||
    typeof value !== "object" ||
    !("ok" in value) ||
    value.ok !== true
  )
    throw new Error("INVALID_DATABASE_RESULT");
  return true;
}
function envelope(value: unknown): SealedTokens {
  if (
    !value ||
    typeof value !== "object" ||
    !("version" in value) ||
    typeof value.version !== "string" ||
    !("iv" in value) ||
    typeof value.iv !== "string" ||
    !("ciphertext" in value) ||
    typeof value.ciphertext !== "string"
  )
    throw new Error("INVALID_DATABASE_RESULT");
  return { version: value.version, iv: value.iv, ciphertext: value.ciphertext };
}
export class SessionStore {
  constructor(private readonly db: AuthDatabase) {}
  private call(
    operation: AuthOperation,
    hash: string,
    args: Record<string, unknown> = {},
  ) {
    if (!validOpaque(hash)) throw new Error("INVALID_SESSION_HASH");
    return this.db.invoke(operation, { ...args, hash });
  }
  async createLogin(hash: string, sealed: SealedTokens) {
    if (!successful(await this.call("login_create", hash, { sealed })))
      throw new Error("SESSION_WRITE_FAILED");
  }
  async consumeLogin(hash: string): Promise<SealedTokens | null> {
    const result = await this.call("login_consume", hash);
    return result === null ? null : envelope(result);
  }
  async create(hash: string, identity: SessionIdentity, sealed: SealedTokens) {
    if (!successful(await this.call("create", hash, { ...identity, sealed })))
      throw new Error("SESSION_WRITE_FAILED");
  }
  async read(hash: string): Promise<StoredSession | null> {
    const result = await this.call("read", hash);
    if (result === null) return null;
    if (!result || typeof result !== "object")
      throw new Error("INVALID_DATABASE_RESULT");
    const r = result as Record<string, unknown>;
    if (
      r.hash !== hash ||
      typeof r.userId !== "string" ||
      typeof r.providerSessionId !== "string" ||
      typeof r.tokenExpiresAt !== "number" ||
      typeof r.absoluteExpiresAt !== "number" ||
      typeof r.revision !== "number" ||
      !Number.isSafeInteger(r.revision) ||
      r.revision < 1 ||
      !Number.isFinite(r.tokenExpiresAt) ||
      !Number.isFinite(r.absoluteExpiresAt) ||
      typeof r.refreshing !== "boolean" ||
      !(r.workspaceId === null || typeof r.workspaceId === "string")
    )
      throw new Error("INVALID_DATABASE_RESULT");
    return {
      hash,
      userId: r.userId,
      providerSessionId: r.providerSessionId,
      sealed: envelope(r.sealed),
      tokenExpiresAt: r.tokenExpiresAt,
      absoluteExpiresAt: r.absoluteExpiresAt,
      revision: r.revision,
      refreshing: r.refreshing,
      workspaceId: r.workspaceId,
    };
  }
  async revoke(hash: string) {
    await this.call("revoke", hash);
  }
  async claimRefresh(
    hash: string,
    revision: number,
    owner: string,
  ): Promise<boolean> {
    return successful(
      await this.call("refresh_claim", hash, { revision, owner }),
    );
  }
  async completeRefresh(
    hash: string,
    revision: number,
    owner: string,
    identity: SessionIdentity,
    sealed: SealedTokens,
  ): Promise<boolean> {
    return successful(
      await this.call("refresh_complete", hash, {
        revision,
        owner,
        ...identity,
        sealed,
      }),
    );
  }
}
