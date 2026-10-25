import { expect, it, vi } from "vitest";
import { Sessions } from "./sessions.js";
import { SessionStore } from "./store.js";
import { digest, opaqueToken, TokenVault } from "./security.js";
async function fixture(expiresAt = 2000) {
  const cookie = opaqueToken(),
    hash = await digest(cookie);
  const vault = new TokenVault({ v1: opaqueToken() }, "v1");
  const tokens = { accessToken: "old-access", refreshToken: "old-refresh" };
  const identity = {
    userId: crypto.randomUUID(),
    providerSessionId: crypto.randomUUID(),
    expiresAt: 3000,
  };
  const row = {
    hash,
    userId: identity.userId,
    providerSessionId: identity.providerSessionId,
    tokenExpiresAt: expiresAt,
    absoluteExpiresAt: 4000,
    revision: 1,
    refreshing: false,
    workspaceId: null,
    sealed: await vault.seal(tokens, hash),
  };
  const invoke = vi.fn(async (operation: string): Promise<unknown> =>
    operation === "read" ? row : { ok: true },
  );
  const provider = {
    verify: vi.fn().mockResolvedValue(identity),
    refresh: vi.fn().mockResolvedValue({
      accessToken: "new-access",
      refreshToken: "new-refresh",
    }),
    signOut: vi.fn().mockResolvedValue(undefined),
  };
  return {
    service: new Sessions(
      new SessionStore({ invoke }),
      provider,
      vault,
      () => 1000,
    ),
    invoke,
    provider,
    cookie,
    row,
  };
}
it("checks live database state on every authentication request", async () => {
  const f = await fixture();
  expect((await f.service.authenticate(f.cookie))?.identity).toEqual(
    await f.provider.verify("old-access"),
  );
  f.invoke.mockResolvedValue(null);
  expect(await f.service.authenticate(f.cookie)).toBeNull();
  expect(f.provider.refresh).not.toHaveBeenCalled();
});
it("claims ownership before provider refresh and commits its new version", async () => {
  const f = await fixture(1005);
  expect((await f.service.authenticate(f.cookie))?.accessToken).toBe(
    "new-access",
  );
  expect(f.invoke.mock.calls.map((c) => c[0])).toEqual([
    "read",
    "refresh_claim",
    "refresh_complete",
    "read",
  ]);
  expect(f.provider.refresh).toHaveBeenCalledTimes(1);
});
it("never refreshes when another request owns the token", async () => {
  const f = await fixture(1005);
  f.row.refreshing = true;
  await expect(f.service.authenticate(f.cookie)).rejects.toThrow(
    "REFRESH_IN_PROGRESS",
  );
  expect(f.provider.refresh).not.toHaveBeenCalled();
});
it("revokes an ambiguous refresh instead of retrying the token", async () => {
  const f = await fixture(1005);
  f.provider.refresh.mockRejectedValue(new Error("timeout"));
  await expect(f.service.authenticate(f.cookie)).rejects.toThrow(
    "REFRESH_REAUTHENTICATION_REQUIRED",
  );
  expect(f.invoke.mock.calls.map((c) => c[0])).toEqual([
    "read",
    "refresh_claim",
    "revoke",
  ]);
  expect(f.provider.refresh).toHaveBeenCalledTimes(1);
});
it("rejects a refreshed identity change", async () => {
  const f = await fixture(1005);
  f.provider.verify.mockResolvedValue({
    userId: crypto.randomUUID(),
    providerSessionId: f.row.providerSessionId,
    expiresAt: 3000,
  });
  await expect(f.service.authenticate(f.cookie)).rejects.toThrow(
    "REFRESH_REAUTHENTICATION_REQUIRED",
  );
  expect(f.invoke.mock.calls.map((c) => c[0])).not.toContain(
    "refresh_complete",
  );
});
it("commits local revocation first and accurately reports provider failure", async () => {
  const f = await fixture();
  f.provider.signOut.mockImplementation(async () => {
    expect(f.invoke.mock.calls.map((c) => c[0])).toEqual(["read", "revoke"]);
    throw new Error("provider unavailable");
  });
  expect(await f.service.logout(f.cookie)).toEqual({
    providerConfirmed: false,
  });
});
it("does not report successful logout when database revocation fails", async () => {
  const f = await fixture();
  f.invoke.mockImplementation(async (operation) => {
    if (operation === "revoke") throw new Error("database unavailable");
    return f.row;
  });
  await expect(f.service.logout(f.cookie)).rejects.toThrow(
    "database unavailable",
  );
  expect(f.provider.signOut).not.toHaveBeenCalled();
});
