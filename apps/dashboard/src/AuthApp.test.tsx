// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { AuthApp } from "./AuthApp.js";
import { encodeSelection } from "../../../packages/shell-contracts/src/selection";
vi.mock("./ManagementApp", () => ({
  ManagementApp: (props: {
    selection: { rows: unknown[] } | null;
    onSelectionDone: () => void;
  }) => (
    <div>
      Saved workspace
      <label>
        Unsaved draft
        <input defaultValue="Example draft" />
      </label>
      {props.selection && (
        <button onClick={props.onSelectionDone}>
          Selection with {props.selection.rows.length} rows
        </button>
      )}
    </div>
  ),
}));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.sessionStorage.clear();
  window.history.replaceState(null, "", "/");
});
const sampleSelection = {
  contract: "paced-selection-1" as const,
  extensionVersion: "0.1.0",
  capturedAt: "2026-11-03T20:00:00.000Z",
  pageType: "people-search" as const,
  self: { profileKey: null, profilePath: "/in/self/" },
  rows: [
    {
      profileKey: "urn:li:member:1",
      profilePath: "/in/a/",
      displayName: "Ada Example",
      headline: "Engineer at Example",
      location: "Toronto",
      current: null,
      relationship: "2nd" as const,
      action: "Connect" as const,
      missing: [],
    },
  ],
};
it("shows a keyboard-accessible Google sign-in form", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ state: "signed-out" }),
    }),
  );
  render(<AuthApp />);
  const button = await screen.findByRole("button", {
    name: "Sign in with Google",
  });
  button.focus();
  expect(document.activeElement).toBe(button);
  expect(button.closest("form")?.getAttribute("action")).toBe(
    "/api/auth/login",
  );
});
it("shows pending admission without a workspace", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ state: "pending", csrfToken: "synthetic" }),
    }),
  );
  render(<AuthApp />);
  await screen.findByRole("heading", { name: "Access pending" });
  expect(screen.queryByRole("heading", { name: "Access approved" })).toBeNull();
});
it("hides approved content while an unconfirmed logout remains retryable", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ state: "admitted", csrfToken: "synthetic" }),
      })
      .mockRejectedValue(new Error("offline")),
  );
  render(<AuthApp />);
  fireEvent.click(await screen.findByRole("button", { name: "Sign out" }));
  await screen.findByText(/Your session may still be active/);
  expect(screen.queryByRole("heading", { name: "Access approved" })).toBeNull();
  expect(screen.getByRole("button", { name: "Retry sign-out" })).toBeDefined();
});
it("rechecks access on focus and hides stale approved content immediately", async () => {
  let resolve: (value: unknown) => void = () => undefined;
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce({
      ok: true,
      json: async () => ({ state: "admitted", csrfToken: "synthetic" }),
    })
    .mockReturnValueOnce(
      new Promise((r) => {
        resolve = r;
      }),
    );
  vi.stubGlobal("fetch", fetcher);
  render(<AuthApp />);
  await screen.findByRole("heading", { name: "Access approved" });
  fireEvent(window, new Event("focus"));
  expect(screen.queryByRole("heading", { name: "Access approved" })).toBeNull();
  resolve({ ok: true, json: async () => ({ state: "signed-out" }) });
  await screen.findByRole("button", { name: "Sign in with Google" });
});
it("ignores an older admitted response after a newer signed-out check", async () => {
  let resolve: (value: unknown) => void = () => undefined;
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockReturnValueOnce(
        new Promise((r) => {
          resolve = r;
        }),
      )
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ state: "signed-out" }),
      }),
  );
  render(<AuthApp />);
  fireEvent(window, new Event("focus"));
  await screen.findByRole("button", { name: "Sign in with Google" });
  await act(async () => {
    resolve({
      ok: true,
      json: async () => ({ state: "admitted", csrfToken: "old" }),
    });
  });
  expect(screen.queryByRole("heading", { name: "Access approved" })).toBeNull();
});
it("does not restore content on focus while logout remains unconfirmed", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce({
      ok: true,
      json: async () => ({ state: "admitted", csrfToken: "synthetic" }),
    })
    .mockRejectedValue(new Error("offline"));
  vi.stubGlobal("fetch", fetcher);
  render(<AuthApp />);
  fireEvent.click(await screen.findByRole("button", { name: "Sign out" }));
  await screen.findByRole("button", { name: "Retry sign-out" });
  fireEvent(window, new Event("focus"));
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole("heading", { name: "Access approved" })).toBeNull();
});
it("treats confirmed invalid-session logout as signed out", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ state: "admitted", csrfToken: "synthetic" }),
      })
      .mockResolvedValueOnce({ ok: false, status: 401 }),
  );
  render(<AuthApp />);
  fireEvent.click(await screen.findByRole("button", { name: "Sign out" }));
  await screen.findByText(/session is no longer active/);
  expect(screen.queryByRole("button", { name: "Retry sign-out" })).toBeNull();
});
it("offers keyboard-focusable recovery after network timeout", async () => {
  const fetcher = vi
    .fn()
    .mockRejectedValueOnce(new DOMException("Timeout", "TimeoutError"))
    .mockResolvedValueOnce({
      ok: true,
      json: async () => ({ state: "signed-out" }),
    });
  vi.stubGlobal("fetch", fetcher);
  render(<AuthApp />);
  const retry = await screen.findByRole("button", {
    name: "Retry access check",
  });
  retry.focus();
  expect(document.activeElement).toBe(retry);
  expect(fetcher.mock.calls[0]?.[1].signal).toBeInstanceOf(AbortSignal);
  fireEvent.click(retry);
  await screen.findByRole("button", { name: "Sign in with Google" });
});
it("rechecks a restored page and removes event listeners when unmounted", async () => {
  const fetcher = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ state: "signed-out" }),
  });
  vi.stubGlobal("fetch", fetcher);
  const view = render(<AuthApp />);
  await screen.findByRole("button", { name: "Sign in with Google" });
  fireEvent(window, new PageTransitionEvent("pageshow", { persisted: true }));
  await screen.findByRole("button", { name: "Sign in with Google" });
  expect(fetcher).toHaveBeenCalledTimes(2);
  view.unmount();
  fireEvent(window, new Event("focus"));
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it("preserves unsaved workspace input across a successful hidden access recheck", async () => {
  let resolve: (value: unknown) => void = () => undefined;
  const signedIn = {
    ok: true,
    json: async () => ({ state: "admitted", csrfToken: "synthetic" }),
  };
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValueOnce(signedIn)
      .mockReturnValueOnce(
        new Promise((r) => {
          resolve = r;
        }),
      ),
  );
  render(<AuthApp />);
  const input = await screen.findByLabelText("Unsaved draft");
  fireEvent.change(input, { target: { value: "Keep my edits" } });
  fireEvent(window, new Event("focus"));
  expect(screen.queryByRole("heading", { name: "Access approved" })).toBeNull();
  await act(async () => {
    resolve(signedIn);
  });
  await screen.findByRole("heading", { name: "Access approved" });
  expect(
    (screen.getByLabelText("Unsaved draft") as HTMLInputElement).value,
  ).toBe("Keep my edits");
});

it("keeps a LinkedIn selection in this tab across the sign-in redirect and forgets it once done", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ state: "signed-out" }),
    }),
  );
  window.history.replaceState(
    null,
    "",
    `/#selection=${encodeSelection(sampleSelection)}`,
  );
  const signedOut = render(<AuthApp />);
  await screen.findByRole("button", { name: "Sign in with Google" });
  expect(window.location.hash).toBe("");
  expect(
    screen.getByText(/Your LinkedIn selection is kept in this tab/),
  ).toBeTruthy();
  expect(window.sessionStorage.getItem("paced.selection")).not.toBeNull();
  signedOut.unmount();
  // After Google redirects back, the page loads fresh without the fragment.
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ state: "admitted", csrfToken: "synthetic" }),
    }),
  );
  render(<AuthApp />);
  const done = await screen.findByRole("button", {
    name: "Selection with 1 rows",
  });
  fireEvent.click(done);
  expect(screen.queryByRole("button", { name: /Selection with/ })).toBeNull();
  expect(window.sessionStorage.getItem("paced.selection")).toBeNull();
});

it("drops an unreadable stored selection with a notice", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ state: "signed-out" }),
    }),
  );
  window.sessionStorage.setItem("paced.selection", "not-a-selection");
  render(<AuthApp />);
  await screen.findByText(/The LinkedIn selection could not be read/);
  expect(window.sessionStorage.getItem("paced.selection")).toBeNull();
});
