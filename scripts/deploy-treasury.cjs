/**
 * Deploys the JudgeBuddy treasury stack to Hedera testnet.
 *
 * Order matters:
 *   1. PrizeClaimToken, owned by the deployer.
 *   2. initializeClaimCollection WITH VALUE — creates the HTS NFT collection. This must happen
 *      while the deployer still owns the contract, because the function is onlyOwner and
 *      HackathonTreasury has no call that reaches it afterwards. Skipping this step is what left
 *      the claim-token settlement path permanently broken: mintClaim reverts with
 *      ClaimCollectionMissing() while claimCollection is the zero address.
 *   3. HackathonTreasury, pointed at the claim token.
 *   4. transferOwnership of the claim token to the treasury, so only it can mint and burn claims.
 *   5. DemoPayoutToken — a plain 6-decimal ERC-20 used as the testnet payout asset.
 *
 * Env:
 *   DEPLOYER_EVM_PRIVATE_KEY  required, ECDSA hex key with testnet HBAR
 *   TREASURY_AGENT_RELAYER    optional, defaults to the deployer address
 *   CLAIM_COLLECTION_HBAR     optional, HBAR attached to HTS token creation (default 20)
 *   REUSE_PAYOUT_TOKEN        optional, address of an existing payout token to keep instead of
 *                             deploying a fresh one. The payout asset is named per hackathon at
 *                             bootstrap, so it survives a treasury redeploy untouched.
 */
const hre = require("hardhat");

// Hedera refunds at most 20% of an unused gas limit, so an over-generous limit is charged at
// 80% of the limit regardless of what the transaction actually used. Estimating per contract
// and adding a small buffer is the difference between a ~6 HBAR deploy and a ~20 HBAR one.
const GAS_BUFFER = 1.25;
const GAS_FLOOR = 300_000;

async function gasFor(factory, args, label) {
  try {
    const tx = await factory.getDeployTransaction(...args);
    const [signer] = await hre.ethers.getSigners();
    const estimate = await hre.ethers.provider.estimateGas({ ...tx, from: signer.address });
    const limit = Math.max(GAS_FLOOR, Math.ceil(Number(estimate) * GAS_BUFFER));
    console.log(`      ${label}: estimated ${Number(estimate).toLocaleString()} gas, using limit ${limit.toLocaleString()}`);
    return limit;
  } catch (error) {
    console.warn(`      ${label}: estimate failed (${error.shortMessage || error.message}); falling back to 4,000,000`);
    return 4_000_000;
  }
}

const GAS = {
  initCollection: 1_200_000,
  ownership: 120_000,
};

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const agentRelayer = process.env.TREASURY_AGENT_RELAYER || deployer.address;
  const collectionHbar = process.env.CLAIM_COLLECTION_HBAR || "20";

  const balance = await hre.ethers.provider.getBalance(deployer.address);
  console.log("Network:      ", hre.network.name);
  console.log("Deployer EVM: ", deployer.address);
  console.log("Balance:      ", hre.ethers.formatEther(balance), "HBAR");
  console.log("Agent relayer:", agentRelayer);
  console.log("");

  if (balance === 0n) {
    throw new Error("Deployer has no HBAR. Fund it from the Hedera testnet faucet first.");
  }

  // 1 — Prize claim token, temporarily owned by the deployer.
  console.log("[1/5] Deploying PrizeClaimToken...");
  const ClaimFactory = await hre.ethers.getContractFactory("PrizeClaimToken");
  const claim = await ClaimFactory.deploy(deployer.address, {
    gasLimit: await gasFor(ClaimFactory, [deployer.address], "PrizeClaimToken"),
  });
  await claim.waitForDeployment();
  const claimAddress = await claim.getAddress();
  console.log("      PrizeClaimToken:", claimAddress);

  // 2 — Create the HTS collection while the deployer is still the owner.
  console.log(`[2/5] Creating HTS claim collection (${collectionHbar} HBAR fee)...`);
  let claimCollection = null;
  if (Number(collectionHbar) <= 0) {
    console.warn("      Skipped: CLAIM_COLLECTION_HBAR=0.");
    console.warn("      Autonomous payout works; claim-token settlement stays unavailable until this runs.");
  } else try {
    const initTx = await claim.initializeClaimCollection("JudgeBuddy Prize Claim", "JBPC", {
      value: hre.ethers.parseEther(collectionHbar),
      gasLimit: GAS.initCollection,
    });
    await initTx.wait();
    claimCollection = await claim.claimCollection();
    console.log("      Claim collection:", claimCollection);
  } catch (error) {
    // Non-fatal: the autonomous payout path never touches the claim collection, so the rest of
    // the deployment is still useful. Surface it loudly rather than failing silently later.
    console.warn("      WARNING: HTS collection creation failed:", error.shortMessage || error.message);
    console.warn("      The claim-token settlement path stays unavailable until this succeeds.");
    console.warn("      Re-run initializeClaimCollection before transferring ownership.");
  }

  // 3 — Treasury.
  console.log("[3/5] Deploying HackathonTreasury...");
  const TreasuryFactory = await hre.ethers.getContractFactory("HackathonTreasury");
  const treasuryArgs = [deployer.address, agentRelayer, claimAddress];
  const treasury = await TreasuryFactory.deploy(...treasuryArgs, {
    gasLimit: await gasFor(TreasuryFactory, treasuryArgs, "HackathonTreasury"),
  });
  await treasury.waitForDeployment();
  const treasuryAddress = await treasury.getAddress();
  console.log("      HackathonTreasury:", treasuryAddress);

  // 4 — Hand the claim token to the treasury so only it can mint and burn.
  console.log("[4/5] Transferring PrizeClaimToken ownership to the treasury...");
  await (await claim.transferOwnership(treasuryAddress, { gasLimit: GAS.ownership })).wait();
  console.log("      Owner is now:", treasuryAddress);

  // 5 — Payout asset for the testnet demo.
  let payoutAddress = process.env.REUSE_PAYOUT_TOKEN || "";
  if (payoutAddress) {
    console.log("[5/5] Reusing existing DemoPayoutToken:", payoutAddress);
  } else {
    console.log("[5/5] Deploying DemoPayoutToken...");
    const PayoutFactory = await hre.ethers.getContractFactory("DemoPayoutToken");
    const payout = await PayoutFactory.deploy(deployer.address, {
      gasLimit: await gasFor(PayoutFactory, [deployer.address], "DemoPayoutToken"),
    });
    await payout.waitForDeployment();
    payoutAddress = await payout.getAddress();
    console.log("      DemoPayoutToken:", payoutAddress, "(6 decimals, public faucet)");
  }

  const env = [
    `TREASURY_CONTRACT_ADDRESS=${treasuryAddress}`,
    `PRIZE_CLAIM_TOKEN_ADDRESS=${claimAddress}`,
    `PAYOUT_TOKEN_ADDRESS=${payoutAddress}`,
    `TREASURY_AGENT_RELAYER=${agentRelayer}`,
    claimCollection ? `PRIZE_CLAIM_COLLECTION=${claimCollection}` : null,
  ].filter(Boolean);

  console.log("\n--- deployment complete ---\n");
  console.log(env.join("\n"));
  console.log("\nFrontend equivalents:");
  console.log(`VITE_TREASURY_CONTRACT_ADDRESS=${treasuryAddress}`);
  console.log(`VITE_PRIZE_CLAIM_TOKEN_ADDRESS=${claimAddress}`);
  console.log(`VITE_PAYOUT_TOKEN_ADDRESS=${payoutAddress}`);
  console.log("\nHashScan:");
  console.log(`  https://hashscan.io/testnet/contract/${treasuryAddress}`);
  console.log(`  https://hashscan.io/testnet/contract/${payoutAddress}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
