import { spawnSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";

const roots = ["server", "src"];
const tests: string[] = [];

for (const root of roots) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".test.ts")) tests.push(path.join(root, entry.name));
  }
}

tests.sort();
if (!tests.length) {
  console.error("No test files were found.");
  process.exit(1);
}

const result = spawnSync(process.execPath, ["--import", "tsx", "--test", ...tests], {
  stdio: "inherit"
});

if (result.error) throw result.error;
process.exit(result.status ?? 1);
