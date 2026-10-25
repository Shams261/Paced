const run = document.getElementById("run");
const output = document.getElementById("results");
run.addEventListener("click", async () => {
  run.disabled = true;
  const results = [];
  try {
    for (let i = 0; i < 5; i++) {
      const started = performance.now();
      const response = await fetch("/api/v1/me", {
        credentials: "same-origin",
        cache: "no-store",
        signal: AbortSignal.timeout(10000),
      });
      // Consume without parsing or exposing the identity response.
      await response.arrayBuffer();
      results.push({
        status: response.status,
        roundTripMs: Math.round((performance.now() - started) * 10) / 10,
        serverTiming: response.headers.get("Server-Timing"),
      });
      output.textContent = JSON.stringify(results, null, 2);
      if (!response.ok) break;
    }
  } catch {
    output.textContent =
      JSON.stringify(results, null, 2) +
      "\nMeasurement unavailable. Retry after checking access.";
  } finally {
    run.disabled = false;
  }
});
