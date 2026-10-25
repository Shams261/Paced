/** Security primitives shared by the hosted session routes. Never log their inputs. */
export const SESSION_COOKIE = "__Host-sequence_session";
export const LOGIN_COOKIE = "__Host-sequence_login";
export const IDLE_SECONDS = 30 * 60;
export const ABSOLUTE_SECONDS = 24 * 60 * 60;
export const LOGIN_SECONDS = 10 * 60;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const opaquePattern = /^[A-Za-z0-9_-]{43}$/;

export function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
function decode(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("INVALID_ENCODING");
  const bytes = Uint8Array.from(
    atob(value.replace(/-/g, "+").replace(/_/g, "/")),
    (c) => c.charCodeAt(0),
  );
  if (base64url(bytes) !== value) throw new Error("INVALID_ENCODING");
  return bytes;
}
export function opaqueToken(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}
export async function digest(value: string): Promise<string> {
  return base64url(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", encoder.encode(value)),
    ),
  );
}
export function validOpaque(value: unknown): value is string {
  if (typeof value !== "string" || !opaquePattern.test(value)) return false;
  try {
    return decode(value).length === 32;
  } catch {
    return false;
  }
}
export function readCookie(request: Request, name: string): string | null {
  const values = (request.headers.get("Cookie") ?? "")
    .split(";")
    .map((p) => p.trim())
    .filter((p) => p.startsWith(`${name}=`));
  // Ambiguous cookies must not let a proxy/parser disagreement select an identity.
  if (values.length !== 1) return null;
  const value = values[0]!.slice(name.length + 1);
  return validOpaque(value) ? value : null;
}
export function sessionCookie(
  name: string,
  value: string,
  seconds: number,
): string {
  if (
    ![SESSION_COOKIE, LOGIN_COOKIE].includes(name) ||
    (value !== "" && !validOpaque(value)) ||
    !Number.isInteger(seconds) ||
    seconds < 0 ||
    seconds > ABSOLUTE_SECONDS
  )
    throw new Error("INVALID_COOKIE");
  return `${name}=${value}; Path=/; Max-Age=${seconds}; HttpOnly; Secure; SameSite=Lax`;
}
export function configuredOrigin(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.origin !== value ||
    url.username ||
    url.password
  )
    throw new Error("INVALID_APP_ORIGIN");
  return value;
}
export function sameOrigin(request: Request, origin: string): boolean {
  configuredOrigin(origin);
  return (
    new URL(request.url).origin === origin &&
    request.headers.get("Origin") === origin &&
    !["cross-site", "same-site"].includes(
      request.headers.get("Sec-Fetch-Site") ?? "",
    )
  );
}
export function constantTimeEqual(a: string, b: string): boolean {
  if (!validOpaque(a) || !validOpaque(b)) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i++)
    difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return difference === 0;
}
export async function csrfToken(
  secret: string,
  sessionHash: string,
): Promise<string> {
  if (!validOpaque(secret) || !validOpaque(sessionHash))
    throw new Error("INVALID_CSRF_INPUT");
  const key = await crypto.subtle.importKey(
    "raw",
    decode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return base64url(
    new Uint8Array(
      await crypto.subtle.sign(
        "HMAC",
        key,
        encoder.encode(`csrf:${sessionHash}`),
      ),
    ),
  );
}
export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}
export interface SealedTokens {
  version: string;
  iv: string;
  ciphertext: string;
}
export class TokenVault {
  constructor(
    private readonly keys: Readonly<Record<string, string>>,
    private readonly active: string,
  ) {
    if (!/^[a-zA-Z0-9_-]{1,32}$/.test(active) || !keys[active])
      throw new Error("INVALID_KEY_VERSION");
    for (const value of Object.values(keys))
      if (!validOpaque(value)) throw new Error("INVALID_ENCRYPTION_KEY");
  }
  private async key(version: string, usage: KeyUsage[]) {
    const value = this.keys[version];
    if (!value) throw new Error("UNKNOWN_KEY_VERSION");
    return crypto.subtle.importKey(
      "raw",
      decode(value),
      "AES-GCM",
      false,
      usage,
    );
  }
  async seal(tokens: TokenPair, sessionHash: string): Promise<SealedTokens> {
    if (
      !validOpaque(sessionHash) ||
      !tokens.accessToken ||
      !tokens.refreshToken ||
      tokens.accessToken.length > 32768 ||
      tokens.refreshToken.length > 32768
    )
      throw new Error("INVALID_TOKEN_PAIR");
    return this.sealData(tokens, sessionHash, "session");
  }
  async sealVerifier(
    verifier: string,
    transactionHash: string,
  ): Promise<SealedTokens> {
    if (
      !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) ||
      !validOpaque(transactionHash)
    )
      throw new Error("INVALID_PKCE_VERIFIER");
    return this.sealData(verifier, transactionHash, "login");
  }
  async openVerifier(
    sealed: SealedTokens,
    transactionHash: string,
  ): Promise<string> {
    const value = await this.openData(sealed, transactionHash, "login");
    if (typeof value !== "string" || !/^[A-Za-z0-9._~-]{43,128}$/.test(value))
      throw new Error("INVALID_PKCE_VERIFIER");
    return value;
  }
  private async sealData(
    value: unknown,
    sessionHash: string,
    purpose: string,
  ): Promise<SealedTokens> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv,
        additionalData: encoder.encode(
          `sequence:${purpose}:${this.active}:${sessionHash}`,
        ),
      },
      await this.key(this.active, ["encrypt"]),
      encoder.encode(JSON.stringify(value)),
    );
    return {
      version: this.active,
      iv: base64url(iv),
      ciphertext: base64url(new Uint8Array(ciphertext)),
    };
  }
  private async openData(
    sealed: SealedTokens,
    sessionHash: string,
    purpose: string,
  ): Promise<unknown> {
    if (!validOpaque(sessionHash) || sealed.ciphertext.length > 100000)
      throw new Error("INVALID_SEALED_TOKENS");
    const iv = decode(sealed.iv);
    if (iv.length !== 12) throw new Error("INVALID_IV");
    const plain = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv,
        additionalData: encoder.encode(
          `sequence:${purpose}:${sealed.version}:${sessionHash}`,
        ),
      },
      await this.key(sealed.version, ["decrypt"]),
      decode(sealed.ciphertext),
    );
    return JSON.parse(decoder.decode(plain));
  }
  async open(sealed: SealedTokens, sessionHash: string): Promise<TokenPair> {
    const value = await this.openData(sealed, sessionHash, "session");
    if (
      !value ||
      typeof value !== "object" ||
      !("accessToken" in value) ||
      !("refreshToken" in value) ||
      typeof value.accessToken !== "string" ||
      typeof value.refreshToken !== "string" ||
      !value.accessToken ||
      !value.refreshToken
    )
      throw new Error("INVALID_TOKEN_PAIR");
    return { accessToken: value.accessToken, refreshToken: value.refreshToken };
  }
}
