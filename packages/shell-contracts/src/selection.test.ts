import { expect, it } from "vitest";
import {
  decodeSelection,
  encodeSelection,
  selectionSchema,
} from "./selection.js";
const selection = {
  contract: "paced-selection-1" as const,
  extensionVersion: "0.1.0",
  capturedAt: "2026-11-03T20:00:00.000Z",
  pageType: "people-search" as const,
  self: {
    profileKey: "urn:li:fsd_profile:ACoAAself",
    profilePath: "/in/self-person/",
  },
  rows: [
    {
      profileKey: "urn:li:fsd_profile:ACoAA1",
      profilePath: "/in/ada-example/",
      displayName: "Ada Example",
      headline: "Software Engineer at Example",
      location: "Toronto, Canada",
      current: null,
      relationship: "2nd" as const,
      action: "Connect" as const,
      missing: [],
    },
    {
      profileKey: null,
      profilePath: "/in/no-key/",
      displayName: "No Key",
      headline: null,
      location: null,
      current: null,
      relationship: "3rd" as const,
      action: "Follow" as const,
      missing: ["profileKey", "headline", "location"],
    },
  ],
};
it("round-trips through the URL fragment encoding with unicode intact", () => {
  const withUnicode = {
    ...selection,
    rows: [{ ...selection.rows[0]!, displayName: "Zoë Ünal 李" }],
  };
  const fragment = encodeSelection(withUnicode);
  expect(fragment).toMatch(/^[A-Za-z0-9_-]+$/);
  expect(decodeSelection(fragment)).toEqual(withUnicode);
});
it("rejects malformed keys, oversized batches, unknown fields and garbage fragments", () => {
  expect(
    selectionSchema.safeParse({
      ...selection,
      rows: [{ ...selection.rows[0], profileKey: "urn:li:member:123" }],
    }).success,
  ).toBe(true);
  expect(
    selectionSchema.safeParse({
      ...selection,
      rows: Array.from({ length: 101 }, () => selection.rows[0]),
    }).success,
  ).toBe(false);
  expect(selectionSchema.safeParse({ ...selection, cookie: "x" }).success).toBe(
    false,
  );
  expect(decodeSelection("not-base64!!")).toBeNull();
  expect(decodeSelection(encodeSelection(selection).slice(0, 20))).toBeNull();
});
