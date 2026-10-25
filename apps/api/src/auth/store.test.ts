import { describe, expect, it, vi } from "vitest";
import {
  SessionStore,
  postgresAuthDatabase,
  assertRuntimeRole,
} from "./store.js";
const hash = "A".repeat(43);
const sealed = { version: "v1", iv: "iv", ciphertext: "ciphertext" };
const identity = {
  userId: "00000001-0000-4000-8000-000000000001",
  providerSessionId: "00000002-0000-4000-8000-000000000001",
  tokenExpiresAt: 1800000000,
};
describe("private session database boundary", () => {
  it("rejects privileged or unexpected actual database roles", () => {
    expect(() =>
      assertRuntimeRole({ name: "postgres", restricted: false }),
    ).toThrow("INVALID_RUNTIME_DATABASE_ROLE");
    expect(() =>
      assertRuntimeRole({ name: "sequence_auth_runtime", restricted: false }),
    ).toThrow("INVALID_RUNTIME_DATABASE_ROLE");
    expect(() =>
      assertRuntimeRole({ name: "sequence_auth_runtime", restricted: true }),
    ).not.toThrow();
    expect(() =>
      postgresAuthDatabase("https://sequence_auth_runtime:unused@localhost/db"),
    ).toThrow("INVALID_RUNTIME_DATABASE_PROTOCOL");
  });
  it("rejects malformed session identifiers before database access", async () => {
    const invoke = vi.fn();
    await expect(new SessionStore({ invoke }).read("invalid")).rejects.toThrow(
      "INVALID_SESSION_HASH",
    );
    expect(invoke).not.toHaveBeenCalled();
  });
  it("does not reinterpret failed or malformed writes as successful", async () => {
    const invoke = vi.fn().mockResolvedValue(null);
    const store = new SessionStore({ invoke });
    await expect(store.create(hash, identity, sealed)).rejects.toThrow(
      "SESSION_WRITE_FAILED",
    );
    expect(await store.claimRefresh(hash, 1, identity.userId)).toBe(false);
    invoke.mockResolvedValue({ ok: false });
    await expect(store.claimRefresh(hash, 1, identity.userId)).rejects.toThrow(
      "INVALID_DATABASE_RESULT",
    );
  });
  it("validates returned session binding and expiry data", async () => {
    const row = {
      hash,
      ...identity,
      sealed,
      absoluteExpiresAt: 1800001000,
      revision: 1,
      refreshing: false,
      workspaceId: null,
    };
    const invoke = vi.fn().mockResolvedValue(row);
    const store = new SessionStore({ invoke });
    expect(await store.read(hash)).toEqual(row);
    for (const change of [
      { hash: "B".repeat(43) },
      { tokenExpiresAt: NaN },
      { revision: 0 },
      { sealed: {} },
    ]) {
      invoke.mockResolvedValue({ ...row, ...change });
      await expect(store.read(hash)).rejects.toThrow("INVALID_DATABASE_RESULT");
    }
    invoke.mockResolvedValue(null);
    expect(await store.read(hash)).toBeNull();
  });
  it("passes refresh version and ownership to the atomic database operation", async () => {
    const invoke = vi.fn().mockResolvedValue({ ok: true });
    const store = new SessionStore({ invoke });
    expect(
      await store.completeRefresh(hash, 4, identity.userId, identity, sealed),
    ).toBe(true);
    expect(invoke).toHaveBeenCalledWith("refresh_complete", {
      hash,
      revision: 4,
      owner: identity.userId,
      ...identity,
      sealed,
    });
  });
});

it("separates PKCE ciphertext from session ciphertext", async () => {
  const { TokenVault, opaqueToken } = await import("./security.js");
  const vault = new TokenVault({ v1: opaqueToken() }, "v1");
  const verifier = "v".repeat(64);
  const sealed = await vault.sealVerifier(verifier, hash);
  expect(await vault.openVerifier(sealed, hash)).toBe(verifier);
  await expect(vault.open(sealed, hash)).rejects.toThrow();
});
