import process from "node:process";
import { scenarios, simulate } from "./fixtures.js";
const args = process.argv.slice(2),
  json = args.includes("--json"),
  name = args.find((a) => !a.startsWith("--"));
if (args.includes("--list") || !name) {
  console.log(
    Object.entries(scenarios)
      .map(([id, s]) => `${id}: ${s.description}`)
      .join("\n"),
  );
} else if (!Object.hasOwn(scenarios, name)) {
  console.error(`Unknown scenario '${name}'. Use --list.`);
  process.exitCode = 1;
} else {
  const trace = simulate(name),
    last = trace.at(-1)!;
  if (json)
    console.log(
      JSON.stringify({ source: "SYN", scenario: name, trace }, null, 2),
    );
  else
    console.log(
      [
        scenarios[name]!.description,
        ...trace.map(
          (r, i) =>
            `${i + 1}. ${r.decision}${r.effects.length ? " (simulated effect only)" : ""}`,
        ),
      ].join("\n"),
    );
  if (last.decision !== scenarios[name]!.expectedLastDecision) {
    console.error("Scenario expectation failed");
    process.exitCode = 1;
  }
}
