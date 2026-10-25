import { snapshotSchema } from "@outreach/shell-contracts";
export async function loadSnapshot(signal: AbortSignal) {
  const response = await fetch("/api/v1/snapshot", { signal });
  if (!response.ok)
    throw new Error(
      "The local API could not be reached. Check that the app server is running, then retry.",
    );
  const parsed = snapshotSchema.safeParse(await response.json());
  if (!parsed.success)
    throw new Error(
      "The API returned an unsupported response. No data was displayed.",
    );
  return parsed.data;
}
