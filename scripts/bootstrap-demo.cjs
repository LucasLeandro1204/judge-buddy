/**
 * Creates the demo program inside the deployed HackathonTreasury on Hedera testnet.
 *
 * The seeded program in D1 is only a database row. Before the agent pipeline can anchor anything
 * on-chain, the same program has to exist in the treasury contract with a funded per-track budget
 * — otherwise registerSubmission reverts with HackathonMissing.
 *
 * Steps: mint demo payout tokens, approve the treasury, bootstrap the program with its three
 * tracks. The ids must be keccak256 of the exact D1 string ids, because that is what the worker
 * derives with ethers' `id()` when it registers submissions.
 */
const hre = require("hardhat");

const HACKATHON_ID = "hackathon-demo-hedera";
const TRACKS = [
  { id: "track-demo-tooling", budget: 250_000_000n },
  { id: "track-demo-defi", budget: 2_500_000_000n },
  { id: "track-demo-infra", budget: 400_000_000n },
];
const AUTONOMOUS_THRESHOLD = 500_000_000n; // 500.000000 jbUSD

async function gasFor(contract, method, args, value, label, fallback) {
  try {
    const estimate = await contract[method].estimateGas(...args, value ? { value } : {});
    const limit = Math.ceil(Number(estimate) * 1.3);
    console.log(`      ${label}: est ${Number(estimate).toLocaleString()} → limit ${limit.toLocaleString()}`);
    return limit;
  } catch (error) {
    console.warn(`      ${label}: estimate failed (${error.shortMessage || error.message}); using ${fallback}`);
    return fallback;
  }
}

async function main() {
  const [signer] = await hre.ethers.getSigners();
  const treasuryAddress = process.env.TREASURY_CONTRACT_ADDRESS;
  const payoutAddress = process.env.PAYOUT_TOKEN_ADDRESS;
  if (!treasuryAddress || !payoutAddress) throw new Error("TREASURY_CONTRACT_ADDRESS and PAYOUT_TOKEN_ADDRESS must be set");

  const balance = await hre.ethers.provider.getBalance(signer.address);
  console.log("Signer: ", signer.address);
  console.log("Balance:", hre.ethers.formatEther(balance), "HBAR\n");

  const payout = await hre.ethers.getContractAt("DemoPayoutToken", payoutAddress, signer);
  const treasury = await hre.ethers.getContractAt("HackathonTreasury", treasuryAddress, signer);

  const total = TRACKS.reduce((sum, t) => sum + t.budget, 0n);
  console.log(`Total track budget: ${Number(total) / 1e6} jbUSD\n`);

  // 1 — mint via the public faucet
  const held = await payout.balanceOf(signer.address);
  if (held < total) {
    const need = total - held;
    console.log(`[1/3] Minting ${Number(need) / 1e6} jbUSD from the faucet...`);
    const tx = await payout.faucet(need, {
      gasLimit: await gasFor(payout, "faucet", [need], null, "faucet", 120_000),
    });
    await tx.wait();
    console.log("      minted:", tx.hash);
  } else {
    console.log("[1/3] Already holding enough jbUSD; skipping mint");
  }

  // 2 — approve the treasury to pull the budget
  const allowance = await payout.allowance(signer.address, treasuryAddress);
  if (allowance < total) {
    console.log("[2/3] Approving the treasury...");
    const tx = await payout.approve(treasuryAddress, total, {
      gasLimit: await gasFor(payout, "approve", [treasuryAddress, total], null, "approve", 100_000),
    });
    await tx.wait();
    console.log("      approved:", tx.hash);
  } else {
    console.log("[2/3] Allowance already sufficient; skipping approve");
  }

  // 3 — bootstrap, using keccak ids that match what the worker derives
  const hackathonId = hre.ethers.id(HACKATHON_ID);
  const trackInputs = TRACKS.map((t) => ({ trackId: hre.ethers.id(t.id), budget: t.budget }));

  const existing = await treasury.hackathons(hackathonId);
  if (existing.exists) {
    console.log("[3/3] Program already exists on-chain; nothing to do");
  } else {
    console.log("[3/3] Bootstrapping the program on-chain...");
    const args = [hackathonId, signer.address, payoutAddress, AUTONOMOUS_THRESHOLD, trackInputs];
    const tx = await treasury.bootstrapHackathon(...args, {
      gasLimit: await gasFor(treasury, "bootstrapHackathon", args, null, "bootstrapHackathon", 900_000),
    });
    const receipt = await tx.wait();
    console.log("      bootstrapped:", receipt.hash);
    console.log(`      https://hashscan.io/testnet/transaction/${receipt.hash}`);
  }

  const after = await treasury.hackathons(hackathonId);
  const escrowed = await payout.balanceOf(treasuryAddress);
  console.log("\n--- on-chain state ---");
  console.log("  organizer :", after.organizer);
  console.log("  judge     :", after.judge);
  console.log("  threshold :", Number(after.autonomousThreshold) / 1e6, "jbUSD");
  console.log("  budget    :", Number(after.totalBudget) / 1e6, "jbUSD");
  console.log("  escrowed  :", Number(escrowed) / 1e6, "jbUSD held by the treasury");
  console.log("  HBAR left :", hre.ethers.formatEther(await hre.ethers.provider.getBalance(signer.address)));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
