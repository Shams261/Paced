/** Options page: pair this browser with the workspace using a one-time code, show status, disconnect. */
interface Status {
  paired: boolean;
  executorId?: string;
  executionMode?: string;
  identity?: string;
  pairedAt?: string;
  lastResult?: string;
  lastError?: string;
  lastObservedAt?: string;
  observations?: number;
  self: { profilePath: string | null; name: string | null } | null;
  heartbeat: { executionMode: string; identity: string } | null;
  error: string | null;
}
const $ = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T;
function send<T>(message: unknown): Promise<T> {
  return chrome.runtime.sendMessage(message) as Promise<T>;
}
function line(label: string, value: string | number | null | undefined) {
  const li = document.createElement("li");
  li.textContent = `${label}: ${value === null || value === undefined || value === "" ? "none" : String(value)}`;
  return li;
}
async function refresh() {
  const status = await send<Status>({ type: "paced:status" });
  const list = $<HTMLUListElement>("status");
  list.replaceChildren(
    line("Paired", status.paired ? "yes" : "no"),
    line("Browser id", status.executorId),
    line(
      "Workspace mode",
      status.heartbeat?.executionMode ?? status.executionMode,
    ),
    line(
      "Signed-in LinkedIn account",
      status.self?.profilePath
        ? `${status.self.profilePath}${status.heartbeat ? ` (${status.heartbeat.identity})` : ""}`
        : "not seen yet: open your LinkedIn account menu or your own profile once",
    ),
    line("Facts recorded", status.observations ?? 0),
    line("Last recorded", status.lastObservedAt),
    line("Last result", status.lastResult),
    line("Last error", status.lastError || status.error),
  );
  $<HTMLElement>("pair").hidden = status.paired;
  $<HTMLElement>("unpair").hidden = !status.paired;
}
$<HTMLFormElement>("pair").addEventListener("submit", async (event) => {
  event.preventDefault();
  const code = $<HTMLInputElement>("code").value;
  const out = $<HTMLElement>("pair-result");
  out.textContent = "Pairing…";
  const result = await send<{ executorId?: string; error?: string }>({
    type: "paced:pair",
    code,
  });
  out.textContent = result.error
    ? `Pairing failed: ${result.error}. Generate a new code in Paced and try again.`
    : "Paired. This browser can now record what you see on enrolled people's pages once observation is enabled in Paced.";
  $<HTMLInputElement>("code").value = "";
  await refresh();
});
$<HTMLButtonElement>("unpair").addEventListener("click", async () => {
  await send({ type: "paced:unpair" });
  $<HTMLElement>("pair-result").textContent =
    "Disconnected here. Also remove this browser in Paced so its token cannot be used again.";
  await refresh();
});
void refresh();
