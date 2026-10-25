import { readFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
const root = fileURLToPath(new URL("../../../", import.meta.url));
describe("package and runner boundary", () => {
  it("domain modules have no IO, browser, storage or ambient clock dependencies", () => {
    const directory = new URL("../src/", import.meta.url);
    for (const name of readdirSync(directory).filter((n) =>
      n.endsWith(".ts"),
    )) {
      const source = readFileSync(new URL(name, directory), "utf8");
      const imports = [...source.matchAll(/from\s+["']([^"']+)["']/g)].map(
        (m) => m[1]!,
      );
      expect(
        imports.every((i) => i.startsWith("./") || i === "zod"),
        name,
      ).toBe(true);
      expect(source, name).not.toMatch(
        /\b(fetch|XMLHttpRequest)\s*\(|\b(localStorage|indexedDB|window|document)\s*\.|Date\.now|Math\.random/,
      );
    }
  });
  it("CLI exports a synthetic JSON trace with expected intermediate guards", () => {
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "tools/campaign-simulator/src/cli.ts",
        "unknown-restart",
        "--json",
      ],
      { cwd: root, encoding: "utf8" },
    );
    expect(result.status, result.stderr).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.source).toBe("SYN");
    expect(parsed.trace.map((r: { decision: string }) => r.decision)).toEqual([
      "configured",
      "enrolled",
      "claimed",
      "authorized",
      "restart-reconciled",
      "account-sender-busy",
    ]);
    expect(
      parsed.trace.flatMap((r: { effects: unknown[] }) => r.effects),
    ).toEqual([]);
  });
  it("CLI rejects unknown scenarios", () => {
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "tools/campaign-simulator/src/cli.ts", "missing"],
      { cwd: root, encoding: "utf8" },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Unknown scenario");
  });
});
