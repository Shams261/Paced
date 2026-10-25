const $ = (id) => document.getElementById(id);
const metadata = {
  "confirmed-rejection": [
    "Request declined",
    "Stop after confirmed rejection",
    "⊘",
  ],
  "acceptance-message": ["Connection accepted", "Follow the happy path", "↗"],
  "pending-reply": ["Reply received", "Stop before the next message", "↩"],
  "unknown-restart": ["Uncertain send", "Recover without duplicates", "⟳"],
  "provisional-defaults": [
    "Working with delays",
    "Respect the waiting period",
    "◷",
  ],
};
const descriptions = {
  "confirmed-rejection":
    "Positive fictional evidence confirms a decline. The sequence stops. A pending or missing invitation alone would not prove rejection.",
  "acceptance-message":
    "An existing invitation is accepted. Follow the first message through approval, simulated sending and confirmation.",
  "pending-reply":
    "A prospect replies while their invitation is still pending. The engine stops the sequence immediately.",
  "unknown-restart":
    "Authorization was granted, but the browser restarted before a result arrived. Watch the engine block a second attempt.",
  "provisional-defaults":
    "Acceptance does not mean send immediately. This example keeps the first message behind its configured 24-hour delay.",
};
const decisions = {
  rejection: [
    "Rejection confirmed · sequence stopped",
    "Remaining outreach stops. No automatic re-invitation or follow-up is allowed. Live LinkedIn rejection detection is still unverified.",
  ],
  configured: [
    "Rules loaded",
    "The example account now has its schedule, limits and waiting periods.",
  ],
  enrolled: [
    "Prospect added",
    "The engine checks the current relationship and reserves this prospect for one sequence.",
  ],
  observed: [
    "Connection accepted",
    "The first message can be considered, subject to approval, evidence and timing checks.",
  ],
  claimed: [
    "Action reserved",
    "One executor owns this action. Another executor cannot claim it at the same time.",
  ],
  authorized: [
    "Send authorized",
    "The engine now treats a send as possible. Losing the result will require verification, not a blind retry.",
  ],
  "simulated-send": [
    "Simulated send",
    "A fictional send effect was produced. Nothing was sent to LinkedIn.",
  ],
  "confirmed-sent": [
    "Delivery confirmed in the example",
    "The synthetic confirmation is recorded. The next follow-up follows its configured delay.",
  ],
  reply: [
    "Reply received · sequence stopped",
    "The prospect replied. Remaining outreach is stopped, even though the invitation is still pending.",
  ],
  "no-action": [
    "No further action",
    "There is no eligible action to claim. The sequence is stopped; no new message or re-invitation is scheduled.",
  ],
  "restart-reconciled": [
    "Restarted · outcome unknown",
    "The previous send might have happened. The engine holds the sequence until positive evidence resolves it.",
  ],
  "account-sender-busy": [
    "Duplicate attempt blocked",
    "An unresolved attempt still owns the account sender. A restart or expired lease cannot authorize a resend.",
  ],
  "not-due": [
    "Waiting for the configured delay",
    "The message is planned, but its due time has not arrived. The engine waits.",
  ],
};
const titles = {
  configure: "Load campaign rules",
  enroll: "Check and enroll prospect",
  observe: "Read a new observation",
  claim: "Check for an eligible action",
  authorize: "Authorize the action",
  "may-have-sent": "Produce a simulated send",
  outcome: "Record the result",
  restart: "Restart the executor",
};
let data = [],
  selected,
  position = 0;
function badge(id, text) {
  $(id).textContent = text;
  $(id).className =
    "status" +
    (text === "Held" ? " warning" : text === "Stopped" ? " stopped" : "");
}
function render() {
  const item = data.find((s) => s.id === selected),
    trace = item.trace,
    snapshot = position ? trace[position - 1] : null;
  const state = snapshot?.state,
    enrollment = state ? Object.values(state.enrollments)[0] : null;
  $("scenario-title").textContent = metadata[selected][0];
  $("description").textContent = descriptions[selected];
  $("progress").textContent =
    position === trace.length ? "Complete" : position ? "In progress" : "Ready";
  $("step-count").textContent = `${position} of ${trace.length} events`;
  $("next").disabled = position === trace.length;
  $("run").disabled = position === trace.length;
  $("reset").disabled = position === 0;
  document
    .querySelectorAll(".scenario")
    .forEach((b) =>
      b.setAttribute("aria-pressed", String(b.dataset.id === selected)),
    );
  $("timeline").replaceChildren();
  item.events.forEach((event, index) => {
    const row = document.createElement("div");
    row.className =
      "event" +
      (index < position ? " done" : "") +
      (index === position - 1 ? " current" : "");
    const number = document.createElement("span");
    number.className = "event-number";
    number.textContent = index < position ? "✓" : String(index + 1);
    const body = document.createElement("div");
    body.className = "event-text";
    const title = document.createElement("div");
    title.className = "event-title";
    title.textContent =
      event.type === "observe" && selected === "pending-reply"
        ? "Receive a reply"
        : (titles[event.type] ?? event.type);
    body.append(title);
    if (index < position) {
      const result = document.createElement("small");
      result.textContent =
        decisions[trace[index].decision]?.[0] ?? trace[index].decision;
      body.append(result);
    }
    const time = document.createElement("span");
    time.className = "event-time";
    time.textContent = `+${((event.receivedAt - item.events[0].receivedAt) / 1000).toFixed(0)}s`;
    row.append(number, body, time);
    $("timeline").append(row);
  });
  badge("connection", enrollment?.connection ?? "Not observed");
  badge("sequence", enrollment?.status ?? "Not started");
  $("sends").textContent = String(
    trace.slice(0, position).reduce((sum, r) => sum + r.effects.length, 0),
  );
  $("events").textContent = String(position);
  const explanation = snapshot
    ? decisions[snapshot.decision]
    : [
        "Ready when you are",
        "Use Next step to follow each decision, or Run to end to see the outcome.",
      ];
  $("decision-title").textContent = explanation?.[0] ?? snapshot.decision;
  $("decision-copy").textContent =
    explanation?.[1] ?? "The engine recorded this decision.";
  $("actions").replaceChildren();
  const actions = state ? Object.values(state.actions) : [];
  if (!actions.length)
    $("actions").textContent = "Actions will appear as the scenario runs.";
  actions.forEach((action) => {
    const row = document.createElement("div");
    row.className = "action-row";
    const label = document.createElement("strong");
    label.textContent =
      action.ordinal === 0
        ? "Connection invitation"
        : action.ordinal === 1
          ? "First message"
          : `Follow-up ${action.ordinal - 1}`;
    const status = document.createElement("span");
    status.textContent = action.status.replace(/([a-z])([A-Z])/g, "$1 $2");
    row.append(label, status);
    $("actions").append(row);
  });
}
$("next").addEventListener("click", () => {
  position++;
  render();
});
$("run").addEventListener("click", () => {
  position = data.find((s) => s.id === selected).trace.length;
  render();
});
$("reset").addEventListener("click", () => {
  position = 0;
  render();
});
fetch("/scenarios.json")
  .then((r) => {
    if (!r.ok) throw new Error("Could not load scenarios");
    return r.json();
  })
  .then((items) => {
    data = items;
    for (const [id, [title, subtitle, icon]] of Object.entries(metadata)) {
      const button = document.createElement("button");
      button.className = "scenario";
      button.dataset.id = id;
      button.type = "button";
      const top = document.createElement("div");
      top.className = "scenario-top";
      const symbol = document.createElement("span");
      symbol.className = "scenario-icon";
      symbol.textContent = icon;
      const tag = document.createElement("span");
      tag.textContent = `0${Object.keys(metadata).indexOf(id) + 1}`;
      top.append(symbol, tag);
      const name = document.createElement("strong");
      name.textContent = title;
      const detail = document.createElement("small");
      detail.textContent = subtitle;
      button.append(top, name, detail);
      button.addEventListener("click", () => {
        selected = id;
        position = 0;
        render();
      });
      $("scenarios").append(button);
    }
    selected = "acceptance-message";
    render();
  })
  .catch(() => {
    $("scenario-title").textContent = "Unable to load the demo";
    $("description").textContent =
      "Restart the local simulator server and refresh this page.";
  });
