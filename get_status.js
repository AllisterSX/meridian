import "dotenv/config";
import { getWalletBalances } from "./tools/wallet.js";
import { getMyPositions } from "./tools/dlmm.js";
import { getTopCandidates } from "./tools/screening.js";

async function main() {
  try {
    const wallet = await getWalletBalances();
    console.log("--- WALLET ---");
    console.log(JSON.stringify(wallet, null, 2));

    const positions = await getMyPositions();
    console.log("\n--- POSITIONS ---");
    console.log(JSON.stringify(positions, null, 2));

    const candidates = await getTopCandidates({ limit: 5 });
    console.log("\n--- TOP CANDIDATES ---");
    console.log(JSON.stringify(candidates, null, 2));
  } catch (err) {
    console.error(err);
  }
}

main();
