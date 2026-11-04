/** Either stable LinkedIn namespace: fsd_profile hashes on profile pages, numeric member IDs on search rows. */
export const PROFILE_KEY_PATTERN =
  /^urn:li:(?:fsd_profile:[A-Za-z0-9_-]{4,120}|member:[0-9]{1,20})$/;
/** Fragment encoding for a selection; kept free of schema code so the extension bundle stays small. */
export function encodeSelectionJson(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
export function decodeFragmentJson(fragment: string): unknown {
  const value = fragment.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(value + "=".repeat((4 - (value.length % 4)) % 4));
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}
