import { useEffect, useState } from "react";
import type { Snapshot } from "@outreach/shell-contracts";
import { loadSnapshot } from "./api.js";
const pages = ["prospects", "campaigns", "queue"] as const;
type Page = (typeof pages)[number];
const names: Record<Page, string> = {
  prospects: "Prospects",
  campaigns: "Campaigns",
  queue: "Activity queue",
};
const labels: Record<string, string> = {
  NotConnected: "Not connected",
  Connected: "Connected",
  Pending: "Pending",
  Unknown: "Needs verification",
  RejectedConfirmed: "Declined",
  WithdrawnConfirmed: "Withdrawn",
};
function currentPage(): Page {
  return pages.find((p) => `#${p}` === window.location.hash) ?? "prospects";
}
type LoadState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "loaded"; data: Snapshot };
export function App() {
  const [page, setPage] = useState<Page>(currentPage),
    [load, setLoad] = useState<LoadState>({ kind: "loading" }),
    [query, setQuery] = useState(""),
    [filter, setFilter] = useState("All prospects"),
    [refresh, setRefresh] = useState(0);
  useEffect(() => {
    const onHash = () => {
      setPage(currentPage());
      setQuery("");
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    setLoad({ kind: "loading" });
    loadSnapshot(controller.signal)
      .then((data) => {
        if (!controller.signal.aborted) setLoad({ kind: "loaded", data });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          setLoad({
            kind: "error",
            message:
              error instanceof Error ? error.message : "Unable to load data.",
          });
      });
    return () => controller.abort();
  }, [refresh]);
  const data = load.kind === "loaded" ? load.data : null;
  const search = query.trim().toLowerCase();
  const prospects =
    data?.prospects.filter(
      (p) =>
        (filter === "All prospects" || p.list === filter) &&
        `${p.name} ${p.company} ${p.role}`.toLowerCase().includes(search),
    ) ?? [];
  const campaigns =
    data?.campaigns.filter((c) =>
      `${c.name} ${c.description}`.toLowerCase().includes(search),
    ) ?? [];
  const queue =
    data?.queue.filter((q) =>
      `${q.name} ${q.campaign} ${q.status}`.toLowerCase().includes(search),
    ) ?? [];
  return (
    <div className="app">
      <a className="skip" href="#main">
        Skip to main content
      </a>
      <aside className="sidebar">
        <a className="brand" href="#prospects">
          <span className="logo">s↗</span>sequence
          <span className="brand-dot">.</span>
        </a>
        <div className="workspace">
          <span className="workspace-icon">D</span>
          <div>
            Development workspace<small>Local preview</small>
          </div>
        </div>
        <p className="nav-label">YOUR WORKSPACE</p>
        <nav aria-label="Main navigation">
          {pages.map((p, i) => (
            <a
              key={p}
              href={`#${p}`}
              aria-current={page === p ? "page" : undefined}
            >
              <span className="nav-icon">{["◎", "▤", "◷"][i]}</span>
              {names[p]}
              {p === "prospects" && data && (
                <span className="count">{data.prospects.length}</span>
              )}
            </a>
          ))}
        </nav>
        <div className="sidebar-foot">
          <span className="status-dot" />
          Live sending disabled
          <p>
            Your LinkedIn account is not connected. This workspace uses
            fictional data.
          </p>
          <div className="local-user">
            <span>LW</span>
            <div>
              Local workspace<small>No signed-in user</small>
            </div>
          </div>
        </div>
      </aside>
      <main id="main" tabIndex={-1}>
        <header className="topbar">
          <span>
            Workspace <b>/</b> {names[page]}
          </span>
          <span className="local-badge">
            <span className="status-dot" />
            Local development
          </span>
        </header>
        <div className="content">
          <div className="demo-banner">
            <span className="banner-icon">◇</span>
            <div>
              <strong>A workspace for exploring.</strong> All records are
              fictional. Login, saving and live outreach are not enabled.
            </div>
            <span className="demo-tag">DEMO MODE</span>
          </div>
          <div className="page-heading">
            <div>
              <p className="eyebrow">BUILD MEANINGFUL CONNECTIONS</p>
              <h1>{names[page]}</h1>
              <p className="subtitle">
                {page === "prospects"
                  ? "The right people. A thoughtful first conversation."
                  : page === "campaigns"
                    ? "Shape your outreach, one intentional step at a time."
                    : "Every step has a reason. See what is waiting and why."}
              </p>
            </div>
            <div className="heading-action">
              <button
                className="primary"
                disabled
                title="Available after storage and authentication are implemented"
              >
                +{" "}
                {page === "prospects"
                  ? "Add prospects"
                  : page === "campaigns"
                    ? "New campaign"
                    : "Enable sending"}
              </button>
              <small>Unavailable in this read-only preview</small>
            </div>
          </div>
          <section className="stats" aria-label="Workspace summary">
            <Stat
              label="Example prospects"
              value={data ? String(data.prospects.length) : "—"}
              detail="Across two fictional lists"
            />
            <Stat
              label="Example campaigns"
              value={data ? String(data.campaigns.length) : "—"}
              detail="Drafts and paused sequences"
            />
            <Stat
              label="Needs attention"
              value={
                data
                  ? String(data.queue.filter((q) => q.status === "Held").length)
                  : "—"
              }
              detail="Evidence needs verification"
            />
            <Stat
              label="Live messages sent"
              value="0"
              detail="Sending is disabled"
            />
          </section>
          <section className="panel" aria-label={names[page]}>
            <div className="panel-top">
              <div className="tabs">
                {page === "prospects" ? (
                  [
                    "All prospects",
                    "Engineering leaders",
                    "Product builders",
                  ].map((f) => (
                    <button
                      key={f}
                      className={filter === f ? "selected" : ""}
                      aria-pressed={filter === f}
                      onClick={() => setFilter(f)}
                    >
                      {f}
                    </button>
                  ))
                ) : (
                  <h2>
                    {page === "campaigns"
                      ? "Your example campaigns"
                      : "Example activity"}
                  </h2>
                )}
              </div>
              <button
                className="refresh"
                onClick={() => setRefresh((r) => r + 1)}
              >
                ↻ Refresh
              </button>
            </div>
            <div className="toolbar">
              <label className="search">
                <span aria-hidden="true">⌕</span>
                <input
                  aria-label={`Search ${names[page].toLowerCase()}`}
                  placeholder={
                    page === "prospects"
                      ? "Search by name, role or company…"
                      : "Search examples…"
                  }
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </label>
              <span className="results">
                {load.kind === "loaded"
                  ? `${page === "prospects" ? prospects.length : page === "campaigns" ? campaigns.length : queue.length} results`
                  : "Loading"}
              </span>
            </div>
            {load.kind === "loading" ? (
              <div className="message-state" role="status">
                <span className="state-icon">◌</span>
                <h2>Loading your example workspace</h2>
                <p>Reading synthetic data from the local API.</p>
              </div>
            ) : load.kind === "error" ? (
              <div className="message-state" role="alert">
                <span className="state-icon">!</span>
                <h2>Could not load the workspace</h2>
                <p>{load.message}</p>
                <button
                  className="secondary"
                  onClick={() => setRefresh((r) => r + 1)}
                >
                  Try again
                </button>
              </div>
            ) : page === "prospects" ? (
              prospects.length ? (
                <div className="table-wrap">
                  <table>
                    <caption className="sr-only">
                      Fictional prospects. Live actions disabled.
                    </caption>
                    <thead>
                      <tr>
                        <th>PROSPECT</th>
                        <th>COMPANY</th>
                        <th>LIST</th>
                        <th>CONNECTION</th>
                      </tr>
                    </thead>
                    <tbody>
                      {prospects.map((p, i) => (
                        <tr key={p.id}>
                          <td>
                            <div className="person">
                              <span className={`avatar tone-${i % 3}`}>
                                {p.initials}
                              </span>
                              <div>
                                <strong>{p.name}</strong>
                                <small>{p.role}</small>
                              </div>
                            </div>
                          </td>
                          <td>
                            <span className="company-mark">{p.company[0]}</span>
                            {p.company}
                          </td>
                          <td>
                            <span className="list-label">{p.list}</span>
                          </td>
                          <td>
                            <Badge
                              value={p.connection}
                              label={labels[p.connection] ?? p.connection}
                            />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <Empty />
              )
            ) : page === "campaigns" ? (
              campaigns.length ? (
                <div className="campaign-grid">
                  {campaigns.map((c) => (
                    <article className="campaign-card" key={c.id}>
                      <div className="card-top">
                        <span className="campaign-icon">▤</span>
                        <Badge value={c.status} />
                      </div>
                      <h2>{c.name}</h2>
                      <p>{c.description}</p>
                      <div className="card-bottom">
                        <span>{c.prospects} example prospects</span>
                        <span>{c.steps} steps</span>
                      </div>
                      <p className="card-note">
                        Read-only example · no live execution
                      </p>
                    </article>
                  ))}
                </div>
              ) : (
                <Empty />
              )
            ) : queue.length ? (
              <div className="queue-list">
                {queue.map((q) => (
                  <article className="queue-row" key={q.id}>
                    <div className="queue-title">
                      <h2>{q.name}</h2>
                      <Badge value={q.status} />
                    </div>
                    <small>
                      {q.campaign} / {q.step}
                    </small>
                    <p>{q.reason}</p>
                  </article>
                ))}
              </div>
            ) : (
              <Empty />
            )}
            <div className="panel-footer">
              <span>
                <span className="status-dot" />
                Synthetic data only
              </span>
              <span>Read-only workspace</span>
            </div>
          </section>
          <div className="bottom-note">
            <span>◇</span>
            <p>
              <strong>Built for thoughtful outreach.</strong> You will review
              and approve every sequence before live execution is available.
            </p>
          </div>
          <footer>
            SEQUENCE · LOCAL FOUNDATION{" "}
            <span>No database · No account connection · No live sends</span>
          </footer>
        </div>
      </main>
    </div>
  );
}
function Stat({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <article className="stat">
      <p>{label}</p>
      <strong>{value}</strong>
      <small>{detail}</small>
    </article>
  );
}
function Badge({ value, label }: { value: string; label?: string }) {
  return (
    <span className={`badge ${value.toLowerCase()}`}>
      <span /> {label ?? value}
    </span>
  );
}
function Empty() {
  return (
    <div className="message-state" role="status">
      <span className="state-icon">⌕</span>
      <h2>No matching examples</h2>
      <p>Try a different search or choose another list.</p>
    </div>
  );
}
