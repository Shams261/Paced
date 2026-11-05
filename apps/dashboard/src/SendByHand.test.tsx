// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SendByHand, stepLabel } from "./SendByHand";
const item = {
  actionId: "33333333-3333-4333-8333-333333333333",
  enrollmentId: "44444444-4444-4444-8444-444444444444",
  prospectId: "p1",
  displayName: "Ada Example",
  profilePath: "/in/ada-example/",
  campaignName: "Sample",
  step: 0,
  kind: "Invitation" as const,
  dueAt: "2026-11-05T09:00:00Z",
  text: "Hi Ada, I would like to connect.",
  blocked: null,
};
const person = {
  enrollmentId: item.enrollmentId,
  prospectId: "p1",
  displayName: "Ada Example",
  profilePath: "/in/ada-example/",
  campaignName: "Sample",
  status: "Held",
  stopReason: "execution-disabled",
  connection: "NotConnected",
  lastReport: null,
  lastObserved: null,
};
const view = {
  executionMode: "manual" as const,
  timezone: "Asia/Kolkata",
  invitationsToday: 1,
  invitationCap: 18,
  messagesToday: 0,
  messageCap: 20,
  spacingMinutes: 5,
  nextAllowedAt: null,
  current: null,
  items: [
    item,
    { ...item, actionId: "a2", displayName: "Ben", blocked: "spacing" },
  ],
  people: [person],
};
const started = {
  ...view,
  items: [],
  current: {
    attemptId: "55555555-5555-4555-8555-555555555555",
    actionId: item.actionId,
    startedAt: "2026-11-05T09:01:00Z",
    displayName: "Ada Example",
    profilePath: "/in/ada-example/",
    step: 0,
    kind: "Invitation" as const,
    text: item.text,
  },
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
it("labels steps by their position and note", () => {
  expect(stepLabel(0, "")).toBe("Invitation without note");
  expect(stepLabel(0, "Hi")).toBe("Invitation with note");
  expect(stepLabel(1, "x")).toBe("First message");
  expect(stepLabel(3, "x")).toBe("Follow-up 2");
});
it("starts a due step, shows the text to send with the person's link, and records the user's answer", async () => {
  const posts: unknown[] = [];
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    expect(url).toBe("/api/v1/queue");
    if (!init || init.method !== "POST") return response(view);
    const body = JSON.parse(init.body as string);
    posts.push(body);
    expect((init.headers as Record<string, string>)["X-CSRF-Token"]).toBe(
      "synthetic-csrf",
    );
    return response(body.operation === "start" ? started : view);
  });
  vi.stubGlobal("fetch", fetcher);
  const onChanged = vi.fn();
  render(
    <SendByHand
      csrfToken="synthetic-csrf"
      mode="manual"
      onAccessLost={() => undefined}
      onChanged={onChanged}
    />,
  );
  await screen.findByText(/Today: 1 of 18 invitations, 0 of 20 messages/);
  expect(screen.getByText(/wait for the spacing interval/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Start Ada Example" }));
  await screen.findByRole("group", { name: "Open step" });
  expect(
    (screen.getByLabelText("Text to send") as HTMLTextAreaElement).value,
  ).toBe(item.text);
  expect(
    screen
      .getByRole("link", { name: "Open Ada Example's profile" })
      .getAttribute("href"),
  ).toBe("https://www.linkedin.com/in/ada-example/");
  expect(onChanged).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "I sent it" }));
  await screen.findByText("Recorded as sent, reported by you.");
  expect(posts).toEqual([
    { operation: "start", actionId: item.actionId },
    { operation: "sent", attemptId: started.current.attemptId },
  ]);
  fireEvent.click(screen.getByRole("button", { name: "Replied: Ada Example" }));
  await screen.findByText("Recorded, reported by you.");
  expect(posts[2]).toEqual({
    operation: "report",
    enrollmentId: person.enrollmentId,
    event: "replied",
  });
});
it("keeps starts disabled outside manual mode and explains a blocked start without claiming success", async () => {
  const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
    if (!init || init.method !== "POST") return response(view);
    return response({ error: "QUEUE_BLOCKED" }, 409);
  });
  vi.stubGlobal("fetch", fetcher);
  const { rerender } = render(
    <SendByHand
      csrfToken="synthetic-csrf"
      mode="observe"
      onAccessLost={() => undefined}
      onChanged={() => undefined}
    />,
  );
  const start = await screen.findByRole("button", {
    name: "Start Ada Example",
  });
  expect((start as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText("off")).toBeTruthy();
  rerender(
    <SendByHand
      csrfToken="synthetic-csrf"
      mode="manual"
      onAccessLost={() => undefined}
      onChanged={() => undefined}
    />,
  );
  await screen.findByText("on");
  fireEvent.click(screen.getByRole("button", { name: "Start Ada Example" }));
  await screen.findByText(/That step cannot start right now/);
  expect(screen.queryByText(/Step started/)).toBeNull();
});
