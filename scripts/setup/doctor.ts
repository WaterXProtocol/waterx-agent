/** Preflight: is this agent pointed at a live, matching deployment? Signs nothing. */
import dotenv from "dotenv";
dotenv.config();

import { runDoctor } from "../../src/doctor.ts";
import { run } from "../lib/cli.ts";

const ICON = { ok: "✓", warn: "!", fail: "✗" } as const;

await run(async () => {
  const report = await runDoctor();
  console.log("");
  for (const check of report.checks) {
    console.log(`  ${ICON[check.status]}  ${check.name.padEnd(18)} ${check.detail}`);
  }
  console.log("");
  if (!report.healthy) {
    console.error("Preflight failed — resolve the ✗ items before trading.");
    process.exit(1);
  }
  console.log("Preflight passed.");
});
