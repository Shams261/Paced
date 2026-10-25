import type { GoogleProvider, VerifiedIdentity } from "./provider.js";
import { AuthenticationRejected } from "./provider.js";
import { digest, opaqueToken, TokenVault, type TokenPair } from "./security.js";
import { SessionStore, type StoredSession } from "./store.js";

export class SessionUnavailable extends Error {}
export interface AuthenticatedSession {
  record: StoredSession;
  identity: VerifiedIdentity;
  // Backend-only: routes must construct an explicit public response.
  accessToken: string;
}
export class Sessions {
  constructor(
    private readonly store: SessionStore,
    private readonly provider: Pick<
      GoogleProvider,
      "verify" | "refresh" | "signOut"
    >,
    private readonly vault: TokenVault,
    private readonly now: () => number = () => Date.now() / 1000,
  ) {}
  async create(tokens: TokenPair): Promise<string> {
    const identity = await this.provider.verify(tokens.accessToken);
    const cookie = opaqueToken();
    const hash = await digest(cookie);
    await this.store.create(
      hash,
      {
        userId: identity.userId,
        providerSessionId: identity.providerSessionId,
        tokenExpiresAt: identity.expiresAt,
      },
      await this.vault.seal(tokens, hash),
    );
    return cookie;
  }
  async authenticate(cookie: string): Promise<AuthenticatedSession | null> {
    const hash = await digest(cookie);
    let record = await this.store.read(hash);
    if (!record) return null;
    if (record.refreshing) throw new SessionUnavailable("REFRESH_IN_PROGRESS");
    let tokens = await this.vault.open(record.sealed, hash);
    if (record.tokenExpiresAt <= this.now() + 60) {
      const owner = crypto.randomUUID();
      if (!(await this.store.claimRefresh(hash, record.revision, owner)))
        throw new SessionUnavailable("REFRESH_OWNERSHIP_CHANGED");
      try {
        tokens = await this.provider.refresh(tokens.refreshToken);
        const identity = await this.provider.verify(tokens.accessToken);
        if (
          identity.userId !== record.userId ||
          identity.providerSessionId !== record.providerSessionId
        )
          throw new AuthenticationRejected("REFRESH_IDENTITY_CHANGED");
        const committed = await this.store.completeRefresh(
          hash,
          record.revision,
          owner,
          {
            userId: identity.userId,
            providerSessionId: identity.providerSessionId,
            tokenExpiresAt: identity.expiresAt,
          },
          await this.vault.seal(tokens, hash),
        );
        if (!committed)
          throw new AuthenticationRejected("REFRESH_COMMIT_REJECTED");
      } catch {
        // The provider may have rotated the refresh token. Never retry it blindly.
        // If revocation fails, let the database error surface as unavailable; the
        // outstanding refresh lease also fails closed after its deadline.
        await this.store.revoke(hash);
        throw new AuthenticationRejected("REFRESH_REAUTHENTICATION_REQUIRED");
      }
      record = await this.store.read(hash);
      if (!record) return null;
    }
    const identity = await this.provider.verify(tokens.accessToken);
    if (
      identity.userId !== record.userId ||
      identity.providerSessionId !== record.providerSessionId
    )
      throw new AuthenticationRejected("SESSION_IDENTITY_MISMATCH");
    return { record, identity, accessToken: tokens.accessToken };
  }
  async logout(cookie: string): Promise<{ providerConfirmed: boolean }> {
    const hash = await digest(cookie);
    const record = await this.store.read(hash);
    // Application revocation commits before any provider call. Errors propagate
    // so the caller must not claim successful local logout without this result.
    await this.store.revoke(hash);
    if (!record) return { providerConfirmed: true };
    try {
      const tokens = await this.vault.open(record.sealed, hash);
      await this.provider.signOut(tokens.accessToken);
      return { providerConfirmed: true };
    } catch {
      return { providerConfirmed: false };
    }
  }
}
