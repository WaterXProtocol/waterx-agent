/**
 * Query referral info for a wallet.
 * Usage: npx tsx scripts/query/referral.ts [--codes] [--referrer] [--referees] [--stats]
 */
import { initApiClient, initSigner, parseArgs } from "../lib/init.ts";

const api = initApiClient();
const args = parseArgs(
  {
    user: { desc: "Wallet address (defaults to signer address)" },
    codes: { flag: true, desc: "Show referral codes" },
    referrer: { flag: true, desc: "Show referrer" },
    referees: { flag: true, desc: "Show referees" },
    stats: { flag: true, desc: "Show referral stats" },
  },
  "scripts/query/referral.ts",
);

const user = args.user || initSigner().address;
const noFlags =
  args.codes === "false" &&
  args.referrer === "false" &&
  args.referees === "false" &&
  args.stats === "false";

if (noFlags || args.codes === "true") {
  const result = await api.getUserReferralCodes(user);
  console.log(`\n=== Referral Codes (${result.codes.length}) ===\n`);
  for (const c of result.codes) {
    console.log(`  ${c.code}  created=${c.createdAt}`);
  }
  if (result.codes.length === 0) console.log("  (none)");
}

if (noFlags || args.referrer === "true") {
  const result = await api.getReferrer(user);
  console.log("\n=== Referrer ===\n");
  if (result.referrer) {
    console.log(`  Address: ${result.referrer.address}`);
    console.log(`  Code:    ${result.referrer.code}`);
  } else {
    console.log("  No referrer.");
  }
}

if (args.referees === "true") {
  const result = await api.getReferees(user);
  console.log(`\n=== Referees (${result.total}) ===\n`);
  for (const r of result.referees) {
    console.log(`  ${r.address}  code=${r.code}  bound=${r.boundAt}`);
  }
  if (result.referees.length === 0) console.log("  (none)");
}

if (args.stats === "true") {
  const result = await api.getReferralStats(user);
  console.log("\n=== Referral Stats ===\n");
  console.log(`  Total Referees: ${result.totalReferees}`);
  console.log(`  Total Volume:   $${result.totalVolume.toLocaleString()}`);
}
