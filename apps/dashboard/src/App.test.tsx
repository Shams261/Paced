// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { App } from "./App.js";
import { snapshot } from "../../api/src/fixtures.js";
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.location.hash = "";
});
function mockResponse(body: unknown = snapshot) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({ ok: true, json: async () => body }),
  );
}
it("shows loading then fictional prospects and disabled creation", async () => {
  mockResponse();
  render(<App />);
  expect(screen.getByRole("status").textContent).toContain("Loading");
  await screen.findByText("Alex Parker");
  expect(
    (
      screen.getByRole("button", {
        name: "+ Add prospects",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  expect(screen.getByText(/Login, saving and live outreach/)).toBeDefined();
});
it("filters by search and list, including an explicit empty result", async () => {
  mockResponse();
  render(<App />);
  await screen.findByText("Alex Parker");
  fireEvent.click(screen.getByRole("button", { name: "Product builders" }));
  expect(screen.queryByText("Alex Parker")).toBeNull();
  fireEvent.change(screen.getByRole("textbox"), {
    target: { value: "nothing matches" },
  });
  expect(screen.getByText("No matching examples")).toBeDefined();
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "Casey" } });
  expect(screen.getByText("Casey Brooks")).toBeDefined();
});
it("navigates campaigns and queue through hash changes without inventing persistence", async () => {
  mockResponse();
  render(<App />);
  await screen.findByText("Alex Parker");
  window.location.hash = "#campaigns";
  fireEvent(window, new HashChangeEvent("hashchange"));
  await screen.findByText("Engineering introductions");
  expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
    "Campaigns",
  );
  window.location.hash = "#queue";
  fireEvent(window, new HashChangeEvent("hashchange"));
  await screen.findByText(/Relationship evidence is incomplete/);
  expect(screen.getByText("Held")).toBeDefined();
});
it("surfaces API failure and retries successfully", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockRejectedValueOnce(new Error("API offline"))
      .mockResolvedValue({ ok: true, json: async () => snapshot }),
  );
  render(<App />);
  await screen.findByRole("alert");
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  await screen.findByText("Alex Parker");
  expect(screen.queryByRole("alert")).toBeNull();
});
it("rejects a response that claims live sending", async () => {
  mockResponse({ ...snapshot, liveSending: true });
  render(<App />);
  expect((await screen.findByRole("alert")).textContent).toContain(
    "unsupported response",
  );
  expect(screen.queryByText("Alex Parker")).toBeNull();
});
it("ignores a superseded request after refresh", async () => {
  let resolve!: (value: unknown) => void;
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockReturnValueOnce(
        new Promise((r) => {
          resolve = r;
        }),
      )
      .mockResolvedValue({
        ok: true,
        json: async () => ({ ...snapshot, prospects: [] }),
      }),
  );
  render(<App />);
  fireEvent.click(screen.getByRole("button", { name: /Refresh/ }));
  await screen.findByText("No matching examples");
  resolve({ ok: true, json: async () => snapshot });
  await waitFor(() => expect(screen.queryByText("Alex Parker")).toBeNull());
});
