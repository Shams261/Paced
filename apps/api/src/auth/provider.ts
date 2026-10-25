import { createClient } from "@supabase/supabase-js";
import {
  createRemoteJWKSet,
  jwtVerify,
  type JWTVerifyGetKey,
  errors,
} from "jose";
import type { TokenPair } from "./security.js";
export interface VerifiedIdentity {
  userId: string;
  providerSessionId: string;
  expiresAt: number;
}
export class AuthenticationRejected extends Error {}
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export class GoogleProvider {
  private readonly jwks: JWTVerifyGetKey;
  constructor(
    private readonly url: string,
    private readonly publishableKey: string,
    jwks?: JWTVerifyGetKey,
  ) {
    if (!/^https:\/\/[a-z]{20}\.supabase\.co$/.test(url))
      throw new Error("INVALID_AUTH_URL");
    this.jwks =
      jwks ??
      createRemoteJWKSet(new URL(`${url}/auth/v1/.well-known/jwks.json`), {
        timeoutDuration: 5000,
      });
  }
  private client(verifier?: string) {
    // Storage belongs to one request/transaction. Never share an SDK session between users.
    const memory = new Map<string, string>();
    const storageKey = "sequence-server-auth";
    if (verifier)
      memory.set(`${storageKey}-code-verifier`, JSON.stringify(verifier));
    const client = createClient(this.url, this.publishableKey, {
      global: {
        fetch: (input, init) =>
          fetch(input, {
            ...init,
            signal: AbortSignal.any([
              ...(init?.signal ? [init.signal] : []),
              AbortSignal.timeout(10000),
            ]),
          }),
      },
      auth: {
        flowType: "pkce",
        // Persist only into this request-local Map so SDK PKCE storage is used.
        persistSession: true,
        autoRefreshToken: false,
        detectSessionInUrl: false,
        storageKey,
        storage: {
          getItem: (k) => memory.get(k) ?? null,
          setItem: (k, v) => {
            memory.set(k, v);
          },
          removeItem: (k) => {
            memory.delete(k);
          },
        },
      },
    });
    return { client, memory, storageKey };
  }
  async begin(callback: string): Promise<{ url: string; verifier: string }> {
    const { client, memory, storageKey } = this.client();
    const { data, error } = await client.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: callback,
        scopes: "openid email profile",
        skipBrowserRedirect: true,
      },
    });
    const storedVerifier = memory.get(`${storageKey}-code-verifier`);
    const verifier: unknown = storedVerifier
      ? JSON.parse(storedVerifier)
      : null;
    if (
      error ||
      !data.url ||
      typeof verifier !== "string" ||
      !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)
    )
      throw new Error("AUTH_PROVIDER_UNAVAILABLE");
    const destination = new URL(data.url);
    if (
      destination.origin !== this.url ||
      destination.pathname !== "/auth/v1/authorize"
    )
      throw new Error("INVALID_PROVIDER_REDIRECT");
    return { url: data.url, verifier };
  }
  async exchange(code: string, verifier: string): Promise<TokenPair> {
    const { data, error } =
      await this.client(verifier).client.auth.exchangeCodeForSession(code);
    if (error || !data.session) {
      if (!error?.status || error.status >= 500 || error.status === 429)
        throw new Error("AUTH_PROVIDER_UNAVAILABLE");
      throw new AuthenticationRejected("CODE_EXCHANGE_FAILED");
    }
    return {
      accessToken: data.session.access_token,
      refreshToken: data.session.refresh_token,
    };
  }
  async refresh(refreshToken: string): Promise<TokenPair> {
    const { data, error } = await this.client().client.auth.refreshSession({
      refresh_token: refreshToken,
    });
    if (error || !data.session)
      throw new AuthenticationRejected("REFRESH_FAILED");
    return {
      accessToken: data.session.access_token,
      refreshToken: data.session.refresh_token,
    };
  }
  async verify(token: string): Promise<VerifiedIdentity> {
    const { payload } = await jwtVerify(token, this.jwks, {
      issuer: `${this.url}/auth/v1`,
      audience: "authenticated",
      algorithms: ["ES256", "RS256"],
      requiredClaims: ["sub", "exp", "iat", "session_id"],
      clockTolerance: 0,
    }).catch((error: unknown) => {
      if (
        error instanceof errors.JWTExpired ||
        error instanceof errors.JWTClaimValidationFailed ||
        error instanceof errors.JWSSignatureVerificationFailed ||
        error instanceof errors.JWSInvalid ||
        error instanceof errors.JWTInvalid ||
        error instanceof errors.JOSEAlgNotAllowed
      )
        throw new AuthenticationRejected("INVALID_IDENTITY");
      throw error;
    });
    if (
      !payload.sub ||
      !uuid.test(payload.sub) ||
      typeof payload.session_id !== "string" ||
      !uuid.test(payload.session_id) ||
      typeof payload.exp !== "number" ||
      payload.role !== "authenticated" ||
      !payload.app_metadata ||
      typeof payload.app_metadata !== "object" ||
      !("provider" in payload.app_metadata) ||
      payload.app_metadata.provider !== "google" ||
      !Array.isArray(payload.amr) ||
      !payload.amr.some(
        (v: unknown) =>
          v && typeof v === "object" && "method" in v && v.method === "oauth",
      )
    )
      throw new AuthenticationRejected("INVALID_IDENTITY");
    return {
      userId: payload.sub,
      providerSessionId: payload.session_id,
      expiresAt: payload.exp,
    };
  }
  async signOut(token: string): Promise<void> {
    const { error } = await this.client().client.auth.admin.signOut(
      token,
      "local",
    );
    if (error) throw new Error("PROVIDER_LOGOUT_UNCONFIRMED");
  }
}
