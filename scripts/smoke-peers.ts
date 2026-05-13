import { getCompany, getLatestFiling } from "../src/lib/data/source";
import { assemblePeerSnapshot } from "../src/lib/pdf/peer-snapshot";

process.env.PROXYMINER_USE_FIXTURES = "1";

async function main() {
  const id = process.argv[2] ?? "aapl";
  const company = await getCompany(id);
  const latest = await getLatestFiling(id);
  console.log(`focal=${company?.id}  latest=${latest?.id}  peer_groups=${latest?.peer_groups.length}`);
  if (!latest) return;
  const peers = await assemblePeerSnapshot(id, latest, { getCompany, getLatestFiling });
  console.log(`peers (${peers.length}):`);
  for (const p of peers) console.log(" ", p);
}
main();
