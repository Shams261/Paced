import { ManagementApp } from "./ManagementApp";
import { useEffect, useRef, useState } from "react";
type Session =
  | { state: "signed-out" }
  | { state: "pending" | "admitted"; csrfToken: string };
const messages: Record<string, string> = {
  cancelled: "Google sign-in was cancelled. You can try again.",
  expired: "Your login attempt expired. Please sign in again.",
  denied: "Sign-in could not be verified. Please try again.",
  unavailable: "Sign-in is temporarily unavailable. Please retry shortly.",
  "rate-limited":
    "Too many sign-in attempts. Please wait ten minutes before trying again.",
};
export function AuthApp() {
  const [session, setSession] = useState<Session | null>(null);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [retryLogout, setRetryLogout] = useState(false);
  const generation = useRef(0);
  const logoutPending = useRef(false);
  async function load() {
    if (logoutPending.current) return;
    const current = ++generation.current;
    // Hide while rechecking, but retain the mounted draft until access is resolved.
    setBusy(true);
    try {
      const response = await fetch("/api/auth/session", {
        credentials: "same-origin",
        cache: "no-store",
        signal: AbortSignal.timeout(10_000),
      });
      if (current !== generation.current) return;
      if (response.status === 401) {
        setSession({ state: "signed-out" });
        setNotice("Your session expired. Please sign in again.");
        return;
      }
      if (!response.ok) throw new Error("unavailable");
      const data: unknown = await response.json();
      if (current !== generation.current) return;
      if (!data || typeof data !== "object" || !("state" in data))
        throw new Error("invalid");
      if (data.state === "signed-out") setSession({ state: "signed-out" });
      else if (
        (data.state === "pending" || data.state === "admitted") &&
        "csrfToken" in data &&
        typeof data.csrfToken === "string"
      )
        setSession({ state: data.state, csrfToken: data.csrfToken });
      else throw new Error("invalid");
    } catch {
      if (current !== generation.current) return;
      setSession(null);
      setNotice("Access could not be checked. Please retry shortly.");
    } finally {
      if (current === generation.current) setBusy(false);
    }
  }
  useEffect(() => {
    const url = new URL(window.location.href);
    const reason = url.searchParams.get("auth");
    if (reason) setNotice(messages[reason] ?? "Please sign in again.");
    window.history.replaceState(null, "", window.location.pathname);
    const recheck = () => {
      void load();
    };
    const restored = (event: PageTransitionEvent) => {
      if (event.persisted) void load();
    };
    void load();
    window.addEventListener("focus", recheck);
    window.addEventListener("pageshow", restored);
    return () => {
      generation.current++;
      window.removeEventListener("focus", recheck);
      window.removeEventListener("pageshow", restored);
    };
  }, []);
  async function logout() {
    if (!session || session.state === "signed-out") return;
    generation.current++;
    logoutPending.current = true;
    setBusy(true);
    setRetryLogout(true);
    setNotice("");
    // Hide protected content immediately; retain only the CSRF value for retry.
    try {
      const response = await fetch("/api/auth/logout", {
        method: "POST",
        credentials: "same-origin",
        headers: { "X-CSRF-Token": session.csrfToken },
        signal: AbortSignal.timeout(10_000),
      });
      if (response.status === 401) {
        setSession({ state: "signed-out" });
        setRetryLogout(false);
        logoutPending.current = false;
        setNotice("Your session is no longer active. Please sign in again.");
        return;
      }
      if (!response.ok) throw new Error("unconfirmed");
      const result = (await response.json()) as { providerConfirmed?: boolean };
      setSession({ state: "signed-out" });
      setRetryLogout(false);
      logoutPending.current = false;
      setNotice(
        result.providerConfirmed
          ? "Signed out."
          : "App access has been revoked. Google-provider sign-out could not be confirmed.",
      );
    } catch {
      setNotice(
        "Sign-out could not be confirmed by the server. Your session may still be active. Retry sign-out.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="auth-page" aria-busy={busy}>
      <h1>Paced</h1>
      <p>Private development pilot</p>
      {notice && <p role="status">{notice}</p>}
      {busy && <p role="status">Checking access…</p>}
      {retryLogout ? (
        <button disabled={busy} onClick={() => void logout()}>
          Retry sign-out
        </button>
      ) : (
        <div hidden={busy}>
          {session?.state === "signed-out" && (
            <form action="/api/auth/login" method="post">
              <button disabled={busy} type="submit">
                Sign in with Google
              </button>
            </form>
          )}
          {session?.state === "pending" && (
            <>
              <h2>Access pending</h2>
              <p>
                You are signed in. An administrator must approve your access
                before a workspace is available.
              </p>
            </>
          )}
          {session?.state === "admitted" && (
            <>
              <h2>Access approved</h2>
              <ManagementApp
                csrfToken={session.csrfToken}
                onAccessLost={() => void load()}
                onDeleted={(summary) => {
                  generation.current++;
                  setSession({ state: "signed-out" });
                  setNotice(
                    `Your workspace was deleted and you are signed out. ${summary.note}${summary.providerConfirmed === false ? " Google-provider sign-out could not be confirmed." : ""}`,
                  );
                }}
              />
            </>
          )}
          {session && session.state !== "signed-out" && (
            <button disabled={busy} onClick={() => void logout()}>
              Sign out
            </button>
          )}
          {!session && !busy && (
            <button
              onClick={() => {
                setNotice("");
                void load();
              }}
            >
              Retry access check
            </button>
          )}
        </div>
      )}
    </main>
  );
}
