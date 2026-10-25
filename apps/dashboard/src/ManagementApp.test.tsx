// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { ManagementApp } from "./ManagementApp";
const snapshot = {
  page: 0,
  sendingEnabled: false,
  totalProspects: 0,
  totalEnrollments: 0,
  prospects: [],
  lists: [],
  campaigns: [],
  enrollments: [],
};
const response = (value: unknown, status = 200) => ({
  ok: status === 200,
  status,
  json: async () => value,
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it("requires preview before confirming an explicit fictional import", async () => {
  const fetcher = vi.fn().mockResolvedValue(response(snapshot));
  vi.stubGlobal("fetch", fetcher);
  render(
    <ManagementApp
      csrfToken="synthetic-csrf"
      onAccessLost={() => undefined}
      onDeleted={() => undefined}
    />,
  );
  await screen.findByText("No lists saved yet.");
  expect(screen.queryByRole("button", { name: "Confirm import" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Preview import" }));
  fireEvent.click(
    await screen.findByRole("button", { name: "Confirm import" }),
  );
  await screen.findByText(/Saved by the server/);
  const calls = fetcher.mock.calls.filter(
    ([, init]) => init?.method === "POST",
  );
  expect(JSON.parse(calls[0]![1].body).operation).toBe("import-preview");
  expect(JSON.parse(calls[1]![1].body)).toMatchObject({
    operation: "import",
    keys: ["sample-ada", "sample-ben"],
  });
  expect(calls[1]![1].headers["X-CSRF-Token"]).toBe("synthetic-csrf");
});
it("retries an uncertain stop with the identical request and does not claim success", async () => {
  const c = {
    id: "campaign",
    name: "Sample",
    revision: 2,
    status: "Draft",
    approved: false,
    recipients: [],
    content: { note: "", firstMessage: "Hello", followups: [] },
  };
  const fetcher = vi
    .fn()
    .mockResolvedValue(response({ ...snapshot, campaigns: [c] }));
  vi.stubGlobal("fetch", fetcher);
  render(
    <ManagementApp
      csrfToken="synthetic-csrf"
      onAccessLost={() => undefined}
      onDeleted={() => undefined}
    />,
  );
  await screen.findByText("No lists saved yet.");
  fireEvent.change(screen.getByLabelText("Campaign"), {
    target: { value: "campaign" },
  });
  fetcher.mockRejectedValueOnce(new Error("lost response"));
  fireEvent.click(screen.getByRole("button", { name: "Stop campaign" }));
  await screen.findByText(/Do not assume pause or stop succeeded/);
  expect(screen.queryByText(/Saved by the server/)).toBeNull();
  fireEvent.click(
    screen.getByRole("button", { name: "Retry unconfirmed save" }),
  );
  await screen.findByText(/Saved by the server/);
  const calls = fetcher.mock.calls.filter(
    ([, init]) => init?.method === "POST",
  );
  expect(calls).toHaveLength(2);
  expect(calls[0]![1].body).toBe(calls[1]![1].body);
});
it("hands expired access back to the login boundary", async () => {
  const lost = vi.fn();
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({}, 401)));
  render(
    <ManagementApp
      csrfToken="synthetic-csrf"
      onAccessLost={lost}
      onDeleted={() => undefined}
    />,
  );
  await waitFor(() => expect(lost).toHaveBeenCalledTimes(1));
});
it("shows every persisted progress state without turning missing evidence into rejection", async () => {
  const states = ["Waiting", "Held", "Paused", "Stopped", "Completed"];
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      response({
        ...snapshot,
        totalEnrollments: 5,
        enrollments: states.map((status, i) => ({
          id: String(i),
          campaign_id: "c",
          prospect_id: String(i),
          display_name: `Person ${i}`,
          status,
          stop_reason: status === "Held" ? "needs-verification" : "example",
        })),
      }),
    ),
  );
  render(
    <ManagementApp
      csrfToken="csrf"
      onAccessLost={() => undefined}
      onDeleted={() => undefined}
    />,
  );
  for (const state of states)
    expect(await screen.findByText(state, { exact: true })).toBeDefined();
  expect(
    screen.getByText(/Missing evidence never means rejection/),
  ).toBeDefined();
});
it("requires saving edited content before reviewing its approval", async () => {
  const c = {
    id: "c",
    name: "Example",
    revision: 1,
    status: "Draft",
    approved: false,
    recipients: [],
    content: { note: "", firstMessage: "Hello", followups: [] },
  };
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(response({ ...snapshot, campaigns: [c] })),
  );
  render(
    <ManagementApp
      csrfToken="csrf"
      onAccessLost={() => undefined}
      onDeleted={() => undefined}
    />,
  );
  await screen.findByText("No lists saved yet.");
  fireEvent.change(screen.getByLabelText("Campaign"), {
    target: { value: "c" },
  });
  expect(
    (
      screen.getByRole("button", {
        name: "Review exact outreach",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(false);
  fireEvent.change(screen.getByLabelText("First message"), {
    target: { value: "Changed" },
  });
  expect(
    (
      screen.getByRole("button", {
        name: "Review exact outreach",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
});

const quota = {
  checkedAt: "now",
  sendingEnabled: false,
  growthAllowed: false,
  reasons: ["egress-unverified"],
  meters: [
    {
      name: "database_bytes",
      value: 1,
      limit: 100,
      percent: 1,
      state: "ok",
      measuredAt: "now",
      source: "pg_database_size",
      providerReadingAt: null,
      providerVerified: false,
    },
  ],
  recovery: { state: "unverified", note: "No backup has been recorded yet." },
  totalProspects: 0,
  totalCampaigns: 0,
};
function byUrl(handlers: Record<string, (init?: RequestInit) => unknown>) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    const path = url.split("?")[0]!;
    const handler = handlers[path];
    if (!handler) throw new Error(`Unexpected ${path}`);
    return handler(init);
  });
}
it("shows quota status, growth block reasons and recovery state", async () => {
  vi.stubGlobal(
    "fetch",
    byUrl({
      "/api/v1/management": () => response(snapshot),
      "/api/v1/status": () => response(quota),
    }),
  );
  render(
    <ManagementApp
      csrfToken="csrf"
      onAccessLost={() => undefined}
      onDeleted={() => undefined}
    />,
  );
  await screen.findByText(/Growth is blocked: egress-unverified/);
  expect(screen.getByText(/no recent operator reading/)).toBeDefined();
  expect(screen.getByText(/Recovery: unverified/)).toBeDefined();
});
it("downloads an export only when its end line is present", async () => {
  const lines = [
    JSON.stringify({ type: "manifest", formatVersion: "sequence-export-1" }),
    JSON.stringify({ type: "prospects", page: 0, rows: [] }),
  ];
  let text = lines.join("\n") + "\n";
  const fetcher = byUrl({
    "/api/v1/management": () => response(snapshot),
    "/api/v1/status": () => response(quota),
    "/api/v1/export": () => ({ ok: true, status: 200, text: async () => text }),
  });
  vi.stubGlobal("fetch", fetcher);
  vi.stubGlobal("URL", {
    ...URL,
    createObjectURL: vi.fn(() => "blob:export"),
    revokeObjectURL: vi.fn(),
  });
  render(
    <ManagementApp
      csrfToken="csrf"
      onAccessLost={() => undefined}
      onDeleted={() => undefined}
    />,
  );
  await screen.findByText("No lists saved yet.");
  fireEvent.click(screen.getByRole("button", { name: "Download my data" }));
  await screen.findByText(/Export was incomplete/);
  text += JSON.stringify({ type: "end", pages: 1 }) + "\n";
  fireEvent.click(screen.getByRole("button", { name: "Download my data" }));
  await screen.findByText(/Export downloaded: 3 lines/);
  const call = fetcher.mock.calls.find(([url]) => url === "/api/v1/export")!;
  expect(call[1]?.method).toBe("POST");
  expect((call[1]?.headers as Record<string, string>)["X-CSRF-Token"]).toBe(
    "csrf",
  );
});
it("requires the typed phrase, explains a stale sign-in and reports deletion", async () => {
  const deleted = vi.fn();
  const lost = vi.fn();
  let attempt = 0;
  const fetcher = byUrl({
    "/api/v1/management": () => response(snapshot),
    "/api/v1/status": () => response(quota),
    "/api/v1/delete-workspace": () =>
      ++attempt === 1
        ? response({ error: "REAUTHENTICATION_REQUIRED" }, 403)
        : response({ deleted: true, removed: { prospects: 1 }, note: "Done." }),
  });
  vi.stubGlobal("fetch", fetcher);
  render(
    <ManagementApp csrfToken="csrf" onAccessLost={lost} onDeleted={deleted} />,
  );
  await screen.findByText("No lists saved yet.");
  const button = screen.getByRole("button", {
    name: "Delete my workspace",
  }) as HTMLButtonElement;
  expect(button.disabled).toBe(true);
  fireEvent.change(screen.getByLabelText(/to confirm/), {
    target: { value: "DELETE MY WORKSPACE" },
  });
  expect(button.disabled).toBe(false);
  fireEvent.click(button);
  await screen.findByText(/needs a fresh sign-in/);
  expect(lost).not.toHaveBeenCalled();
  expect(deleted).not.toHaveBeenCalled();
  fireEvent.click(button);
  await waitFor(() => expect(deleted).toHaveBeenCalledTimes(1));
  const calls = fetcher.mock.calls.filter(
    ([url]) => url === "/api/v1/delete-workspace",
  );
  expect(calls).toHaveLength(2);
  expect(JSON.parse(calls[0]![1]!.body as string).requestId).toBe(
    JSON.parse(calls[1]![1]!.body as string).requestId,
  );
});
