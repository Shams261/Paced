import { expect, it, vi } from "vitest";
import {
  managementGateway,
  ManagementError,
  managementRequestSchema,
} from "./management.js";
it("rejects forged identifiers, duplicate selections and oversized follow-up sequences", () => {
  expect(
    managementRequestSchema.safeParse({
      operation: "import-preview",
      keys: ["sample-ada"],
      workspaceId: crypto.randomUUID(),
    }).success,
  ).toBe(false);
  expect(
    managementRequestSchema.safeParse({
      operation: "import-preview",
      keys: ["sample-ada", "sample-ada"],
    }).success,
  ).toBe(false);
  expect(
    managementRequestSchema.safeParse({
      operation: "import-preview",
      keys: ["real-profile"],
    }).success,
  ).toBe(false);
  expect(
    managementRequestSchema.safeParse({
      operation: "save-draft",
      requestId: crypto.randomUUID(),
      campaignId: null,
      revision: null,
      name: "Draft",
      recipients: [crypto.randomUUID()],
      content: {
        note: "",
        firstMessage: "Hello",
        followups: Array.from({ length: 4 }, () => ({
          text: "Again",
          delayDays: 3,
        })),
      },
    }).success,
  ).toBe(false);
});
it("uses only the verified user token for management RPC and exposes bounded errors", async () => {
  const send = vi
    .fn<typeof fetch>()
    .mockResolvedValue(
      new Response(
        JSON.stringify({ code: "40001", message: "private database details" }),
        { status: 409 },
      ),
    );
  const gateway = managementGateway(
    "https://example.supabase.co",
    "public-key",
    send,
  );
  await expect(
    gateway.call("server-only-token", "control", { revision: 1 }),
  ).rejects.toEqual(new ManagementError("REVISION_OR_REQUEST_CONFLICT", 409));
  expect(send.mock.calls[0]?.[0]).toBe(
    "https://example.supabase.co/rest/v1/rpc/seq_manage",
  );
  expect(send.mock.calls[0]?.[1]?.headers).toMatchObject({
    Authorization: "Bearer server-only-token",
  });
  send.mockResolvedValue(
    new Response("private broken response", { status: 503 }),
  );
  await expect(
    gateway.call("server-only-token", "snapshot", {}),
  ).rejects.toEqual(new ManagementError("STORAGE_UNAVAILABLE", 503));
});
