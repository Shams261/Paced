import { afterEach, beforeEach, expect, it, vi } from "vitest";
/** A fake of the two extension APIs the relay uses: storage areas and the runtime identity. */
function fakeChrome() {
  const area = () => {
    let data: Record<string, unknown> = {};
    return {
      get: async () => ({ ...data }),
      set: async (items: Record<string, unknown>) => {
        data = { ...data, ...items };
      },
      remove: async (keys: string | string[]) => {
        for (const k of Array.isArray(keys) ? keys : [keys]) delete data[k];
      },
      clear: async () => {
        data = {};
      },
    };
  };
  return {
    runtime: { id: "test-extension", onMessage: { addListener: vi.fn() } },
    storage: { local: area(), session: area() },
  };
}
const fetchMock = vi.fn();
beforeEach(() => {
  vi.stubGlobal("chrome", fakeChrome());
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  vi.resetModules();
});
afterEach(() => vi.unstubAllGlobals());
const json = (value: unknown, status = 200) =>
  Promise.resolve({ ok: status === 200, status, json: async () => value });
const self = { profileKey: null, profilePath: "/in/self/" };
it("pairs with a code, keeps the token only in storage and sends it as a bearer header", async () => {
  const { handle } = await import("./worker.js");
  fetchMock.mockReturnValueOnce(
    json({
      token: "t".repeat(43),
      executorId: "x1",
      executionMode: "disabled",
      accountIdentity: "linkedin:path:/in/self/",
    }),
  );
  const paired = (await handle({ type: "paced:pair", code: "ABCD2345" })) as {
    executorId: string;
  };
  expect(paired.executorId).toBe("x1");
  const [url, init] = fetchMock.mock.calls[0]!;
  expect(url).toBe("https://sequence-dev-etj.pages.dev/api/executor/pair");
  expect(JSON.parse(init.body)).toEqual({
    code: "ABCD2345",
    adapterVersion: "0.2.0",
  });
  fetchMock.mockReturnValueOnce(
    json({
      executorId: "x1",
      executionMode: "observe",
      identity: "match",
      pollSeconds: 300,
    }),
  );
  await handle({ type: "paced:self", self: { ...self, name: "Self Name" } });
  const status = (await handle({ type: "paced:status" })) as Record<
    string,
    unknown
  >;
  expect(status.paired).toBe(true);
  expect(status.token).toBeUndefined();
  expect(JSON.stringify(status)).not.toContain("t".repeat(43));
  expect(fetchMock.mock.calls[1]![1].headers.Authorization).toBe(
    `Bearer ${"t".repeat(43)}`,
  );
  expect((status.heartbeat as { identity: string }).identity).toBe("match");
});
it("fetches the watchlist only once the signed-in identity is known, caches it, and reports rejected pairing honestly", async () => {
  const { handle } = await import("./worker.js");
  fetchMock.mockReturnValueOnce(json({ error: "PAIRING_REJECTED" }, 403));
  await expect(
    handle({ type: "paced:pair", code: "ABCD2345" }),
  ).rejects.toThrow("PAIRING_REJECTED");
  expect(await handle({ type: "paced:watchlist" })).toMatchObject({
    people: [],
    reason: "not-paired",
  });
  fetchMock.mockReturnValueOnce(
    json({
      token: "t".repeat(43),
      executorId: "x1",
      executionMode: "observe",
      accountIdentity: "linkedin:path:/in/self/",
    }),
  );
  await handle({ type: "paced:pair", code: "ABCD2345" });
  expect(await handle({ type: "paced:watchlist" })).toMatchObject({
    people: [],
    reason: "self-unknown",
  });
  await handle({ type: "paced:self", self: { ...self, name: null } });
  const people = [
    {
      prospectId: "p1",
      profilePath: "/in/person/",
      recipientKey: "urn:li:member:1",
      displayName: "Person One",
      enrolledAt: "2026-11-04T00:00:00Z",
    },
  ];
  fetchMock.mockReturnValueOnce(
    json({ executionMode: "observe", identity: "match", people }),
  );
  expect(await handle({ type: "paced:watchlist" })).toMatchObject({
    people,
    reason: null,
    selfName: null,
  });
  expect(await handle({ type: "paced:watchlist" })).toMatchObject({ people });
  expect(fetchMock).toHaveBeenCalledTimes(3);
});
it("relays one observation with the known identity and records the result or the error", async () => {
  const { handle } = await import("./worker.js");
  fetchMock.mockReturnValueOnce(
    json({
      token: "t".repeat(43),
      executorId: "x1",
      executionMode: "observe",
      accountIdentity: "linkedin:path:/in/self/",
    }),
  );
  await handle({ type: "paced:pair", code: "ABCD2345" });
  await handle({ type: "paced:self", self: { ...self, name: "Self Name" } });
  const observation = {
    prospectId: "p1",
    observedAt: "2026-11-04T10:00:00.000Z",
    connection: "Pending" as const,
    complete: true,
  };
  fetchMock.mockReturnValueOnce(
    json({ stored: 1, duplicates: 0, rejected: 0 }),
  );
  await handle({ type: "paced:observe", observation });
  const body = JSON.parse(fetchMock.mock.calls[1]![1].body);
  expect(body).toEqual({ self, observations: [observation] });
  fetchMock.mockReturnValueOnce(json({ error: "IDENTITY_MISMATCH" }, 403));
  await expect(handle({ type: "paced:observe", observation })).rejects.toThrow(
    "IDENTITY_MISMATCH",
  );
  const status = (await handle({ type: "paced:status" })) as Record<
    string,
    unknown
  >;
  expect(status.observations).toBe(1);
  expect(status.lastError).toBe("IDENTITY_MISMATCH");
  await handle({ type: "paced:unpair" });
  expect(
    ((await handle({ type: "paced:status" })) as { paired: boolean }).paired,
  ).toBe(false);
});
