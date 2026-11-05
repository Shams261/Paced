import type {
  ExecutorObservation,
  HeartbeatResponse,
  ObservationsResponse,
  PairResponse,
  SelfIdentity,
  WatchedPerson,
  WatchlistResponse,
} from "../../../packages/shell-contracts/src/executor.js";
/**
 * Background relay for the paired browser. It talks to the Paced API with the device token
 * on behalf of the options page and the content scripts. It opens no pages, sets no alarms
 * and never touches LinkedIn; the user's own browsing is the only trigger.
 */
export const DASHBOARD = "https://sequence-dev-etj.pages.dev";
export const ADAPTER_VERSION = "0.2.0";
const WATCHLIST_TTL_MS = 10 * 60 * 1000;
export interface StoredState {
  token?: string;
  executorId?: string;
  executionMode?: string;
  identity?: string;
  pairedAt?: string;
  lastResult?: string;
  lastError?: string;
  lastObservedAt?: string;
  observations?: number;
}
interface SessionState {
  self?: SelfIdentity & { name: string | null };
  watchlist?: { at: number; people: WatchedPerson[] };
}
export type WorkerRequest =
  | { type: "paced:pair"; code: string }
  | { type: "paced:unpair" }
  | { type: "paced:status" }
  | { type: "paced:self"; self: SelfIdentity & { name: string | null } }
  | { type: "paced:watchlist" }
  | { type: "paced:observe"; observation: ExecutorObservation };
const stored = () => chrome.storage.local.get(null) as Promise<StoredState>;
const session = () => chrome.storage.session.get(null) as Promise<SessionState>;
async function api<T>(path: string, body: unknown, token?: string): Promise<T> {
  const response = await fetch(`${DASHBOARD}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const parsed = (await response.json().catch(() => null)) as
    (T & { error?: string }) | null;
  if (!response.ok || !parsed || parsed.error)
    throw new Error(parsed?.error ?? `HTTP ${response.status}`);
  return parsed;
}
async function pair(code: string) {
  const result = await api<PairResponse>("/api/executor/pair", {
    code,
    adapterVersion: ADAPTER_VERSION,
  });
  await chrome.storage.local.set({
    token: result.token,
    executorId: result.executorId,
    executionMode: result.executionMode,
    pairedAt: new Date().toISOString(),
    lastError: "",
    lastResult:
      "Paired. Nothing is recorded until the workspace enables observation.",
    observations: 0,
  } satisfies StoredState);
  await chrome.storage.session.clear();
  return { executorId: result.executorId, executionMode: result.executionMode };
}
async function heartbeat(
  state: StoredState,
  self: SelfIdentity,
): Promise<HeartbeatResponse | null> {
  if (!state.token) return null;
  const result = await api<HeartbeatResponse>(
    "/api/executor/heartbeat",
    { adapterVersion: ADAPTER_VERSION, self },
    state.token,
  );
  await chrome.storage.local.set({
    executionMode: result.executionMode,
    identity: result.identity,
  } satisfies StoredState);
  return result;
}
function identityOf(s: SessionState): SelfIdentity {
  return {
    profileKey: s.self?.profileKey ?? null,
    profilePath: s.self?.profilePath ?? null,
  };
}
async function watchlist(force = false): Promise<{
  people: WatchedPerson[];
  reason: string | null;
}> {
  const [state, s] = await Promise.all([stored(), session()]);
  if (!state.token) return { people: [], reason: "not-paired" };
  if (!s.self?.profilePath && !s.self?.profileKey)
    return { people: [], reason: "self-unknown" };
  if (!force && s.watchlist && Date.now() - s.watchlist.at < WATCHLIST_TTL_MS)
    return { people: s.watchlist.people, reason: null };
  const result = await api<WatchlistResponse>(
    "/api/executor/watchlist",
    { self: identityOf(s) },
    state.token,
  );
  await chrome.storage.local.set({
    executionMode: result.executionMode,
    identity: result.identity,
  } satisfies StoredState);
  await chrome.storage.session.set({
    watchlist: { at: Date.now(), people: result.people },
  });
  return {
    people: result.people,
    reason: !["observe", "manual"].includes(result.executionMode)
      ? "observation-off"
      : result.identity !== "match"
        ? `identity-${result.identity}`
        : null,
  };
}
async function observe(observation: ExecutorObservation) {
  const [state, s] = await Promise.all([stored(), session()]);
  if (!state.token) throw new Error("not-paired");
  try {
    const result = await api<ObservationsResponse>(
      "/api/executor/observations",
      { self: identityOf(s), observations: [observation] },
      state.token,
    );
    await chrome.storage.local.set({
      lastObservedAt: new Date().toISOString(),
      observations: (state.observations ?? 0) + result.stored,
      lastResult: `Recorded ${result.stored} fact(s); ${result.duplicates} already known.`,
      lastError: "",
    } satisfies StoredState);
    return result;
  } catch (error) {
    await chrome.storage.local.set({
      lastError: error instanceof Error ? error.message : String(error),
    } satisfies StoredState);
    throw error;
  }
}
export async function handle(request: WorkerRequest): Promise<unknown> {
  switch (request.type) {
    case "paced:pair":
      return pair(request.code);
    case "paced:unpair":
      await chrome.storage.local.clear();
      await chrome.storage.session.clear();
      return { ok: true };
    case "paced:status": {
      const [state, s] = await Promise.all([stored(), session()]);
      let beat: HeartbeatResponse | null = null;
      let error: string | null = null;
      try {
        beat = await heartbeat(state, identityOf(s));
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      }
      const { token: _token, ...safe } = state;
      return {
        ...safe,
        paired: !!state.token,
        self: s.self ?? null,
        heartbeat: beat,
        error,
      };
    }
    case "paced:self": {
      const s = await session();
      const next = {
        profileKey: request.self.profileKey ?? s.self?.profileKey ?? null,
        profilePath: request.self.profilePath ?? s.self?.profilePath ?? null,
        name: request.self.name ?? s.self?.name ?? null,
      };
      const changed =
        next.profilePath !== s.self?.profilePath ||
        next.profileKey !== s.self?.profileKey;
      await chrome.storage.session.set({ self: next });
      if (changed) await chrome.storage.session.remove("watchlist");
      return { ok: true, self: next };
    }
    case "paced:watchlist": {
      const [list, s] = await Promise.all([watchlist(), session()]);
      return { ...list, selfName: s.self?.name ?? null };
    }
    case "paced:observe":
      return observe(request.observation);
    default:
      throw new Error("unknown-request");
  }
}
chrome.runtime.onMessage.addListener(
  (
    message: WorkerRequest,
    sender: { id?: string },
    respond: (value: unknown) => void,
  ) => {
    if (sender.id !== chrome.runtime.id) return false;
    handle(message).then(respond, (error: unknown) =>
      respond({
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return true;
  },
);
