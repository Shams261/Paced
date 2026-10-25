import { describe, expect, it } from "vitest";
import { generateKeyPair, SignJWT } from "jose";
import { GoogleProvider } from "./provider.js";
import {
  ABSOLUTE_SECONDS,
  configuredOrigin,
  constantTimeEqual,
  csrfToken,
  digest,
  LOGIN_COOKIE,
  opaqueToken,
  readCookie,
  sameOrigin,
  sessionCookie,
  SESSION_COOKIE,
  TokenVault,
  validOpaque,
} from "./security.js";

describe("opaque session security", () => {
  it("generates independent 256-bit canonical identifiers and rejects malformed cookies", () => {
    const token = opaqueToken();
    expect(validOpaque(token)).toBe(true);
    expect(token).not.toBe(opaqueToken());
    expect(validOpaque(`${token}=`)).toBe(false);
    const req = (cookie: string) =>
      new Request("https://app.example/", { headers: { cookie } });
    expect(readCookie(req(`${SESSION_COOKIE}=${token}`), SESSION_COOKIE)).toBe(
      token,
    );
    expect(
      readCookie(
        req(`${SESSION_COOKIE}=${token}; ${SESSION_COOKIE}=${token}`),
        SESSION_COOKIE,
      ),
    ).toBeNull();
    expect(readCookie(req(`${SESSION_COOKIE}=%61`), SESSION_COOKIE)).toBeNull();
  });
  it("uses host-only secure HttpOnly cookies and matching clearing attributes", () => {
    const value = sessionCookie(
      SESSION_COOKIE,
      opaqueToken(),
      ABSOLUTE_SECONDS,
    );
    expect(value).toContain(
      "Path=/; Max-Age=86400; HttpOnly; Secure; SameSite=Lax",
    );
    expect(value).not.toContain("Domain=");
    expect(sessionCookie(LOGIN_COOKIE, "", 0)).toContain(
      "Max-Age=0; HttpOnly; Secure; SameSite=Lax",
    );
    expect(() => sessionCookie("other", "", 0)).toThrow();
    expect(() =>
      sessionCookie(SESSION_COOKIE, opaqueToken(), Infinity),
    ).toThrow();
  });
  it("requires exact HTTPS origin, rejecting sibling origins, null and spoofed request URLs", () => {
    const origin = "https://sequence.example";
    expect(configuredOrigin(origin)).toBe(origin);
    for (const bad of [
      "http://sequence.example",
      `${origin}/`,
      `${origin}/path`,
      "https://user@sequence.example",
    ])
      expect(() => configuredOrigin(bad)).toThrow();
    for (const bad of [
      "null",
      "https://evil.example",
      "https://sequence.example.evil",
      "https://sub.sequence.example",
    ])
      expect(
        sameOrigin(
          new Request(`${origin}/api/auth/logout`, {
            headers: { Origin: bad },
          }),
          origin,
        ),
      ).toBe(false);
    expect(
      sameOrigin(
        new Request(`${origin}/api/auth/logout`, {
          headers: { Origin: origin },
        }),
        origin,
      ),
    ).toBe(true);
    expect(
      sameOrigin(
        new Request("https://evil.example/", { headers: { Origin: origin } }),
        origin,
      ),
    ).toBe(false);
    expect(
      sameOrigin(
        new Request(origin, {
          headers: { Origin: origin, "Sec-Fetch-Site": "cross-site" },
        }),
        origin,
      ),
    ).toBe(false);
  });
  it("binds CSRF token to a session and server key", async () => {
    const key = opaqueToken(),
      hash = await digest(opaqueToken());
    const token = await csrfToken(key, hash);
    expect(constantTimeEqual(token, await csrfToken(key, hash))).toBe(true);
    expect(
      constantTimeEqual(
        token,
        await csrfToken(key, await digest(opaqueToken())),
      ),
    ).toBe(false);
    expect(constantTimeEqual(token, await csrfToken(opaqueToken(), hash))).toBe(
      false,
    );
    expect(constantTimeEqual("", "")).toBe(false);
  });
});

describe("encrypted provider tokens", () => {
  const tokens = {
    accessToken: "synthetic-access",
    refreshToken: "synthetic-refresh",
  };
  it("rejects corruption, different session and version substitution; supports key rotation", async () => {
    const keys = { v1: opaqueToken(), v2: opaqueToken() },
      hash = await digest(opaqueToken());
    const old = new TokenVault(keys, "v1"),
      rotated = new TokenVault(keys, "v2");
    const sealed = await old.seal(tokens, hash);
    expect(JSON.stringify(sealed)).not.toContain(tokens.accessToken);
    expect(await rotated.open(sealed, hash)).toEqual(tokens);
    expect((await rotated.seal(tokens, hash)).version).toBe("v2");
    expect((await old.seal(tokens, hash)).iv).not.toBe(sealed.iv);
    await expect(
      rotated.open(sealed, await digest(opaqueToken())),
    ).rejects.toThrow();
    await expect(
      rotated.open({ ...sealed, version: "v2" }, hash),
    ).rejects.toThrow();
    await expect(
      rotated.open(
        {
          ...sealed,
          ciphertext:
            (sealed.ciphertext[0] === "A" ? "B" : "A") +
            sealed.ciphertext.slice(1),
        },
        hash,
      ),
    ).rejects.toThrow();
    await expect(
      new TokenVault({ v2: keys.v2 }, "v2").open(sealed, hash),
    ).rejects.toThrow();
    expect(() => new TokenVault({ v1: "bad" }, "v1")).toThrow();
  });
});

describe("provider identity verification", () => {
  const url = "https://syisdkvnkbmbsbvchdgb.supabase.co";
  const user = "11111111-1111-4111-8111-111111111111";
  const sid = "22222222-2222-4222-8222-222222222222";
  it("validates signed claims and rejects tampering, expiry, wrong project/audience and missing session", async () => {
    const keys = await generateKeyPair("ES256");
    const provider = new GoogleProvider(
      url,
      "synthetic-publishable",
      async () => keys.publicKey,
    );
    const issue = (changes: Record<string, unknown> = {}) =>
      new SignJWT({
        sub: user,
        session_id: sid,
        role: "authenticated",
        app_metadata: { provider: "google" },
        amr: [{ method: "oauth" }],
        iss: `${url}/auth/v1`,
        aud: "authenticated",
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 600,
        ...changes,
      })
        .setProtectedHeader({ alg: "ES256" })
        .sign(keys.privateKey);
    const token = await issue();
    expect(await provider.verify(token)).toMatchObject({
      userId: user,
      providerSessionId: sid,
    });
    for (const changes of [
      { iss: "https://other.supabase.co/auth/v1" },
      { aud: "anon" },
      { exp: 1 },
      { session_id: null },
      { sub: "bad" },
      { role: "service_role" },
      { app_metadata: { provider: "github" } },
      { amr: [{ method: "password" }] },
    ])
      await expect(provider.verify(await issue(changes))).rejects.toThrow();
    const pieces = token.split(".");
    pieces[1] = btoa(JSON.stringify({ sub: user }));
    await expect(provider.verify(pieces.join("."))).rejects.toThrow();
  });
  it("generates SDK PKCE challenge without issuing a network login or exposing verifier in URL", async () => {
    const provider = new GoogleProvider(url, "synthetic-publishable");
    const callback = "https://sequence-dev-etj.pages.dev/api/auth/callback";
    const first = await provider.begin(callback),
      second = await provider.begin(callback);
    const target = new URL(first.url);
    expect(target.searchParams.get("provider")).toBe("google");
    expect(target.searchParams.get("redirect_to")).toBe(callback);
    expect(target.searchParams.get("code_challenge_method")).toBe("s256");
    expect(target.searchParams.get("code_challenge")).toBe(
      await digest(first.verifier),
    );
    expect(first.verifier).not.toBe(second.verifier);
    expect(first.url).not.toContain(first.verifier);
  });
});
