import { z } from "zod";
import {
  PROFILE_KEY_PATTERN,
  decodeFragmentJson,
  encodeSelectionJson,
} from "./selection-codec.js";
/** Selection handed from the read-only extension to the dashboard through the URL fragment. */
export const SELECTION_CONTRACT = "paced-selection-1";
export { PROFILE_KEY_PATTERN } from "./selection-codec.js";
const text = (max: number) => z.string().trim().max(max);
export const selectionRowSchema = z.strictObject({
  profileKey: z.string().regex(PROFILE_KEY_PATTERN).nullable(),
  profilePath: z
    .string()
    .regex(/^\/in\/[A-Za-z0-9%._-]{1,200}\/?$/)
    .nullable(),
  displayName: text(200).nullable(),
  headline: text(400).nullable(),
  location: text(200).nullable(),
  current: text(300).nullable(),
  relationship: z.enum(["1st", "2nd", "3rd", "other"]).nullable(),
  action: z
    .enum(["Connect", "Pending", "Message", "Follow", "other"])
    .nullable(),
  missing: z.array(z.string().max(40)).max(10),
});
export const selectionSchema = z.strictObject({
  contract: z.literal(SELECTION_CONTRACT),
  extensionVersion: z.string().regex(/^[0-9]+\.[0-9]+\.[0-9]+$/),
  capturedAt: z.string().datetime(),
  pageType: z.literal("people-search"),
  self: z.strictObject({
    profileKey: z.string().regex(PROFILE_KEY_PATTERN).nullable(),
    profilePath: z
      .string()
      .regex(/^\/in\/[A-Za-z0-9%._-]{1,200}\/?$/)
      .nullable(),
  }),
  rows: z.array(selectionRowSchema).min(1).max(100),
});
export type Selection = z.infer<typeof selectionSchema>;
export type SelectionRow = z.infer<typeof selectionRowSchema>;
export function encodeSelection(selection: Selection): string {
  return encodeSelectionJson(selection);
}
export function decodeSelection(fragment: string): Selection | null {
  try {
    const parsed = selectionSchema.safeParse(decodeFragmentJson(fragment));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
