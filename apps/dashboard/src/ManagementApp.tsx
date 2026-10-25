import { useEffect, useRef, useState } from "react";
import {
  DELETE_CONFIRMATION,
  sampleCatalog,
  type ApprovalPreview,
  type Campaign,
  type Content,
  type DeletionSummary,
  type ManagementRequest,
  type ManagementSnapshot,
  type QuotaStatus,
} from "../../../packages/shell-contracts/src/management";
const emptyContent: Content = {
  note: "Hi {{name}}, I would like to connect.",
  firstMessage: "Thanks for connecting, {{name}}.",
  followups: [],
};
export function ManagementApp({
  csrfToken,
  onAccessLost,
  onDeleted,
}: {
  csrfToken: string;
  onAccessLost: () => void;
  onDeleted: (summary: DeletionSummary) => void;
}) {
  const [data, setData] = useState<ManagementSnapshot | null>(null);
  const [page, setPage] = useState(0);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [keys, setKeys] = useState<string[]>(["sample-ada", "sample-ben"]);
  const [importPreview, setImportPreview] = useState(false);
  const [listName, setListName] = useState("Fictional engineering prospects");
  const [campaign, setCampaign] = useState<Campaign | null>(null);
  const [name, setName] = useState("My sample campaign");
  const [recipients, setRecipients] = useState<string[]>([]);
  const [content, setContent] = useState<Content>(emptyContent);
  const [approval, setApproval] = useState<ApprovalPreview | null>(null);
  const [pending, setPending] = useState<ManagementRequest | null>(null);
  const [status, setStatus] = useState<QuotaStatus | null>(null);
  const [confirmation, setConfirmation] = useState("");
  const [deleteRequest, setDeleteRequest] = useState<string | null>(null);
  const alive = useRef(true);
  async function request(body?: ManagementRequest): Promise<unknown> {
    const response = await fetch(
      `/api/v1/management${body ? "" : `?page=${page}`}`,
      {
        method: body ? "POST" : "GET",
        credentials: "same-origin",
        cache: "no-store",
        signal: AbortSignal.timeout(10_000),
        ...(body
          ? {
              headers: {
                "Content-Type": "application/json",
                "X-CSRF-Token": csrfToken,
              },
              body: JSON.stringify(body),
            }
          : {}),
      },
    );
    if (response.status === 401 || response.status === 403) {
      if (alive.current) onAccessLost();
      throw new Error("Access must be checked again.");
    }
    if (response.status === 409) throw new Error("CONFLICT");
    if (response.status === 400) throw new Error("INVALID");
    if (!response.ok) {
      const data = (await response.json().catch(() => null)) as {
        error?: string;
      } | null;
      throw new Error(
        data?.error === "GROWTH_BLOCKED" ? "GROWTH_BLOCKED" : "UNCONFIRMED",
      );
    }
    return response.json();
  }
  async function loadStatus() {
    try {
      const response = await fetch("/api/v1/status", {
        credentials: "same-origin",
        cache: "no-store",
        signal: AbortSignal.timeout(10_000),
      });
      // The main snapshot load already hands lost access back to the login boundary.
      if (!response.ok) throw new Error("UNAVAILABLE");
      const next = (await response.json()) as Partial<QuotaStatus> | null;
      if (
        !next ||
        !Array.isArray(next.meters) ||
        !Array.isArray(next.reasons) ||
        typeof next.growthAllowed !== "boolean" ||
        !next.recovery
      )
        throw new Error("INVALID");
      if (alive.current) setStatus(next as QuotaStatus);
    } catch {
      if (alive.current) setStatus(null);
    }
  }
  async function exportData() {
    if (busy) return;
    setBusy(true);
    setNotice("");
    try {
      const response = await fetch("/api/v1/export", {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: { "X-CSRF-Token": csrfToken },
        signal: AbortSignal.timeout(120_000),
      });
      if (response.status === 401 || response.status === 403) {
        if (alive.current) onAccessLost();
        return;
      }
      if (!response.ok) throw new Error("UNAVAILABLE");
      const text = await response.text();
      const lines = text.trimEnd().split("\n");
      const last = JSON.parse(lines[lines.length - 1] ?? "{}") as {
        type?: string;
      };
      if (last.type !== "end") throw new Error("INCOMPLETE");
      if (typeof URL.createObjectURL === "function") {
        const url = URL.createObjectURL(
          new Blob([text], { type: "application/x-ndjson" }),
        );
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = `sequence-export-${new Date().toISOString().slice(0, 10)}.ndjson`;
        anchor.click();
        URL.revokeObjectURL(url);
      }
      if (alive.current)
        setNotice(
          `Export downloaded: ${lines.length} lines. Nothing was stored on the server.`,
        );
    } catch (error) {
      if (alive.current)
        setNotice(
          error instanceof Error && error.message === "INCOMPLETE"
            ? "Export was incomplete and was not kept. Retry the download."
            : "Export unavailable. Retry after checking your connection.",
        );
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  async function deleteWorkspace() {
    if (busy || confirmation !== DELETE_CONFIRMATION) return;
    const requestId = deleteRequest ?? crypto.randomUUID();
    setDeleteRequest(requestId);
    setBusy(true);
    setNotice("");
    try {
      const response = await fetch("/api/v1/delete-workspace", {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": csrfToken,
        },
        body: JSON.stringify({ requestId, confirmation }),
        signal: AbortSignal.timeout(30_000),
      });
      const data = (await response.json().catch(() => null)) as
        (DeletionSummary & { error?: string }) | { error?: string } | null;
      if (
        response.status === 403 &&
        data?.error === "REAUTHENTICATION_REQUIRED"
      ) {
        setNotice(
          "Deletion needs a fresh sign-in. Sign out, sign in with Google again, then delete within five minutes.",
        );
        return;
      }
      if (response.status === 401 || response.status === 403) {
        if (alive.current) onAccessLost();
        return;
      }
      if (
        !response.ok ||
        !data ||
        !("deleted" in data) ||
        data.deleted !== true
      )
        throw new Error("UNCONFIRMED");
      setDeleteRequest(null);
      onDeleted(data);
    } catch {
      if (alive.current)
        setNotice(
          "Deletion could not be confirmed. Do not assume it happened. Retry with the same request.",
        );
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  async function load() {
    setBusy(true);
    try {
      const next = (await request()) as ManagementSnapshot;
      if (alive.current) setData(next);
    } catch {
      if (alive.current)
        setNotice("Saved data could not be loaded. Retry loading.");
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  useEffect(() => {
    alive.current = true;
    void load();
    void loadStatus();
    return () => {
      alive.current = false;
    };
  }, [page]);
  function selectCampaign(c: Campaign | null) {
    setCampaign(c);
    setName(c?.name ?? "My sample campaign");
    setRecipients(c?.recipients ?? []);
    setContent(c?.content ?? emptyContent);
    setApproval(null);
  }
  async function run(body: ManagementRequest) {
    if (busy) return;
    setBusy(true);
    setNotice("");
    const write = "requestId" in body;
    let confirmed = false;
    if (write) setPending(body);
    try {
      const result = await request(body);
      if (!alive.current) return;
      confirmed = write;
      if (body.operation === "import-preview") {
        setImportPreview(true);
        setNotice("Preview ready. These are fictional records only.");
      } else if (body.operation === "approval-preview")
        setApproval(result as ApprovalPreview);
      else {
        setPending(null);
        setApproval(null);
        setImportPreview(false);
        setNotice("Saved by the server. No LinkedIn action was sent.");
        const next = (await request()) as ManagementSnapshot;
        if (!alive.current) return;
        setData(next);
        const id = (result as { campaignId?: string }).campaignId;
        if (id) selectCampaign(next.campaigns.find((c) => c.id === id) ?? null);
      }
    } catch (error) {
      if (!alive.current) return;
      if (confirmed) {
        setNotice(
          "Save confirmed, but updated data could not be loaded. Reload saved data.",
        );
        return;
      }
      const kind = error instanceof Error ? error.message : "UNCONFIRMED";
      if (kind === "GROWTH_BLOCKED") {
        setPending(null);
        setNotice(
          "Growth is blocked by the quota guard. Pause, stop, export and delete remain available; see workspace status.",
        );
        void loadStatus();
      } else if (kind === "CONFLICT" || kind === "INVALID") {
        setPending(null);
        setApproval(null);
        setImportPreview(false);
        setNotice(
          kind === "CONFLICT"
            ? "Data or approval changed, or a recipient is already enrolled. Reload saved data and review again."
            : "Request rejected. Check required fields, substitutions, selection and account limits.",
        );
      } else
        setNotice(
          write
            ? "Save could not be confirmed. Do not assume pause or stop succeeded. Retry the same request below."
            : "Preview unavailable. Retry after checking your connection.",
        );
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  const dirty =
    !!campaign &&
    (name !== campaign.name ||
      JSON.stringify(content) !== JSON.stringify(campaign.content) ||
      JSON.stringify([...recipients].sort()) !==
        JSON.stringify([...campaign.recipients].sort()));
  const toggle = (values: string[], value: string) =>
    values.includes(value)
      ? values.filter((v) => v !== value)
      : [...values, value];
  return (
    <section
      className="management"
      aria-label="Saved workspace"
      aria-busy={busy}
    >
      <h2>Prospects and campaigns</h2>
      <p className="capability-notice">
        Fictional data only · LinkedIn import and sending are disabled.
      </p>
      {notice && <p role="status">{notice}</p>}
      <section aria-label="Workspace status">
        <h3>Workspace status</h3>
        {status ? (
          <>
            <p>
              {status.growthAllowed
                ? "New imports, campaigns and approvals are allowed."
                : `Growth is blocked: ${status.reasons.join(", ")}. Pause, stop, export and delete remain available.`}
            </p>
            <ul>
              {status.meters.map((m) => (
                <li key={m.name}>
                  {m.name}: {m.percent}% of limit — {m.state}
                  {m.providerVerified ? "" : " — no recent operator reading"}
                </li>
              ))}
            </ul>
            <p>
              Recovery: {status.recovery.state}. {status.recovery.note}
            </p>
          </>
        ) : (
          <p>Status not loaded.</p>
        )}
        <button disabled={busy} onClick={() => void loadStatus()}>
          Refresh status
        </button>
      </section>
      {pending && (
        <button disabled={busy} onClick={() => void run(pending)}>
          Retry unconfirmed save
        </button>
      )}
      <button
        disabled={busy || !!pending}
        onClick={() => {
          setApproval(null);
          selectCampaign(null);
          void load();
        }}
      >
        Reload saved data
      </button>
      <fieldset disabled={busy || !!pending}>
        <legend>1. Import fictional prospects</legend>
        {sampleCatalog.map((p) => (
          <label className="choice" key={p.key}>
            <input
              type="checkbox"
              checked={keys.includes(p.key)}
              onChange={() => {
                setKeys(toggle(keys, p.key));
                setImportPreview(false);
              }}
            />
            {p.name} — {p.connection}
            {!p.company && " — company missing"}
          </label>
        ))}
        <label>
          List name
          <input
            value={listName}
            maxLength={100}
            onChange={(e) => {
              setListName(e.target.value);
              setImportPreview(false);
            }}
          />
        </label>
        <button
          onClick={() =>
            void run({
              operation: "import-preview",
              keys: keys as Extract<
                ManagementRequest,
                { operation: "import-preview" }
              >["keys"],
            })
          }
        >
          Preview import
        </button>
        {importPreview && (
          <div>
            <p>
              {keys.length} selected fictional people. Existing people will be
              reused in the new list; no campaign enrollment occurs.
            </p>
            <button
              onClick={() =>
                void run({
                  operation: "import",
                  requestId: crypto.randomUUID(),
                  keys: keys as Extract<
                    ManagementRequest,
                    { operation: "import" }
                  >["keys"],
                  listName,
                })
              }
            >
              Confirm import
            </button>
          </div>
        )}
      </fieldset>
      {data && (
        <>
          <h3>Saved lists</h3>
          {data.lists.length ? (
            <ul>
              {data.lists.map((l) => (
                <li key={l.id}>
                  {l.name} ({l.count})
                </li>
              ))}
            </ul>
          ) : (
            <p>No lists saved yet.</p>
          )}
          <fieldset disabled={busy || !!pending}>
            <legend>2. Draft and select recipients</legend>
            <label>
              Campaign
              <select
                value={campaign?.id ?? ""}
                onChange={(e) =>
                  selectCampaign(
                    data.campaigns.find((c) => c.id === e.target.value) ?? null,
                  )
                }
              >
                <option value="">New campaign</option>
                {data.campaigns.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} — {c.status}
                    {c.approved ? " (approved)" : ""}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Campaign name
              <input
                value={name}
                maxLength={100}
                onChange={(e) => {
                  setName(e.target.value);
                  setApproval(null);
                }}
              />
            </label>
            <p>
              {data.totalProspects} saved prospects. Select explicitly;
              importing never enrolls people.
            </p>
            {data.prospects.map((p) => (
              <label className="choice" key={p.id}>
                <input
                  type="checkbox"
                  checked={recipients.includes(p.id)}
                  onChange={() => {
                    setRecipients(toggle(recipients, p.id));
                    setApproval(null);
                  }}
                />
                {p.display_name} — {p.company ?? "Company missing"} —{" "}
                {p.connection}
              </label>
            ))}
            <p>{recipients.length} selected across pages.</p>
            <label>
              Invitation note (optional)
              <textarea
                value={content.note}
                maxLength={2000}
                onChange={(e) => {
                  setContent({ ...content, note: e.target.value });
                  setApproval(null);
                }}
              />
            </label>
            <label>
              First message
              <textarea
                value={content.firstMessage}
                maxLength={2000}
                onChange={(e) => {
                  setContent({ ...content, firstMessage: e.target.value });
                  setApproval(null);
                }}
              />
            </label>
            <p>
              Fields: {"{{name}}, {{company}}, {{role}}"}. Missing values
              prevent approval.
            </p>
            {content.followups.map((f, i) => (
              <div key={i}>
                <label>
                  Follow-up {i + 1}
                  <textarea
                    value={f.text}
                    maxLength={2000}
                    onChange={(e) => {
                      setContent({
                        ...content,
                        followups: content.followups.map((v, n) =>
                          n === i ? { ...v, text: e.target.value } : v,
                        ),
                      });
                      setApproval(null);
                    }}
                  />
                </label>
                <label>
                  Delay in days
                  <input
                    type="number"
                    min={1}
                    max={365}
                    value={f.delayDays}
                    onChange={(e) => {
                      setContent({
                        ...content,
                        followups: content.followups.map((v, n) =>
                          n === i
                            ? { ...v, delayDays: Number(e.target.value) }
                            : v,
                        ),
                      });
                      setApproval(null);
                    }}
                  />
                </label>
                <button
                  onClick={() => {
                    setContent({
                      ...content,
                      followups: content.followups.filter((_, n) => n !== i),
                    });
                    setApproval(null);
                  }}
                >
                  Remove follow-up {i + 1}
                </button>
              </div>
            ))}
            <button
              disabled={content.followups.length >= 3}
              onClick={() => {
                setContent({
                  ...content,
                  followups: [
                    ...content.followups,
                    { text: "Following up, {{name}}.", delayDays: 3 },
                  ],
                });
                setApproval(null);
              }}
            >
              Add follow-up
            </button>
            <button
              disabled={campaign?.status === "Stopped"}
              onClick={() =>
                void run({
                  operation: "save-draft",
                  requestId: crypto.randomUUID(),
                  campaignId: campaign?.id ?? null,
                  revision: campaign?.revision ?? null,
                  name,
                  content,
                  recipients,
                })
              }
            >
              Save draft
            </button>
          </fieldset>
          {campaign && (
            <fieldset
              disabled={busy || !!pending || campaign.status === "Stopped"}
            >
              <legend>3. Review saved revision {campaign.revision}</legend>
              <p>Preview uses the saved draft. Save edits before reviewing.</p>
              <button
                disabled={
                  dirty || campaign.status === "Paused" || campaign.approved
                }
                onClick={() =>
                  void run({
                    operation: "approval-preview",
                    campaignId: campaign.id,
                    revision: campaign.revision,
                  })
                }
              >
                Review exact outreach
              </button>
              {approval && (
                <>
                  <ul>
                    {approval.recipients.map((p) => (
                      <li key={p.id}>
                        <strong>
                          {p.name} — {p.disposition}
                        </strong>
                        <p>Note: {p.content.note || "None"}</p>
                        <p>First message: {p.content.firstMessage}</p>
                        {p.content.followups.map((f, i) => (
                          <p key={i}>
                            After {f.delayDays} days: {f.text}
                          </p>
                        ))}
                      </li>
                    ))}
                  </ul>
                  <button
                    onClick={() =>
                      void run({
                        operation: "approve",
                        requestId: crypto.randomUUID(),
                        campaignId: campaign.id,
                        revision: campaign.revision,
                        preview: approval.fingerprint,
                      })
                    }
                  >
                    Approve this saved revision
                  </button>
                </>
              )}
              <button
                onClick={() =>
                  void run({
                    operation: "control",
                    requestId: crypto.randomUUID(),
                    campaignId: campaign.id,
                    revision: campaign.revision,
                    action: campaign.status === "Paused" ? "resume" : "pause",
                  })
                }
              >
                {campaign.status === "Paused"
                  ? "Resume for review"
                  : "Pause campaign"}
              </button>
              <button
                onClick={() =>
                  void run({
                    operation: "control",
                    requestId: crypto.randomUUID(),
                    campaignId: campaign.id,
                    revision: campaign.revision,
                    action: "stop",
                  })
                }
              >
                Stop campaign
              </button>
            </fieldset>
          )}
          <h3>Recipient progress</h3>
          <p>
            Waiting means invitation pending. Held means verification, approval
            or execution capability is missing. Missing evidence never means
            rejection.
          </p>
          {data.enrollments.length ? (
            <ul>
              {data.enrollments.map((e) => (
                <li key={e.id}>
                  {e.display_name}: <strong>{e.status}</strong> —{" "}
                  {e.stop_reason ?? "No reason recorded"}
                </li>
              ))}
            </ul>
          ) : (
            <p>No enrollments on this page.</p>
          )}
          <fieldset disabled={busy || !!pending}>
            <legend>4. Export my data</legend>
            <p>
              Downloads your saved prospects, lists, campaigns, approvals and
              history as newline-delimited JSON. Nothing is stored on the
              server.
            </p>
            <button onClick={() => void exportData()}>Download my data</button>
          </fieldset>
          <fieldset disabled={busy || !!pending}>
            <legend>5. Delete workspace</legend>
            <p>
              Deleting removes your saved prospects, lists, campaigns, approvals
              and history now and signs you out. Your sign-in identity is
              removed by the operator within seven days. This does not withdraw
              LinkedIn invitations or remove LinkedIn messages. A Google sign-in
              within the last five minutes is required.
            </p>
            <label>
              Type {DELETE_CONFIRMATION} to confirm
              <input
                value={confirmation}
                maxLength={40}
                onChange={(e) => setConfirmation(e.target.value)}
              />
            </label>
            <button
              disabled={confirmation !== DELETE_CONFIRMATION}
              onClick={() => void deleteWorkspace()}
            >
              Delete my workspace
            </button>
          </fieldset>
          <nav aria-label="Saved records pages">
            <button
              disabled={busy || !!pending || page === 0}
              onClick={() => setPage(page - 1)}
            >
              Previous page
            </button>
            <span> Page {page + 1} </span>
            <button
              disabled={
                busy ||
                !!pending ||
                (page + 1) * 50 >=
                  Math.max(data.totalProspects, data.totalEnrollments)
              }
              onClick={() => setPage(page + 1)}
            >
              Next page
            </button>
          </nav>
        </>
      )}
    </section>
  );
}
