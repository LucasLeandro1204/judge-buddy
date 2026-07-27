/**
 * Settlement logic for HackathonTreasury, exercised against a plain ERC-20 payout token.
 *
 * Runs on the local hardhat EVM, so the HTS paths (prize-claim NFT minting) are out of scope —
 * there is no Hedera system contract at 0x167 here. Everything below is the part that must hold
 * before we spend real testnet HBAR: budget accounting, the autonomy ceiling, EIP-712 approval
 * recovery, expiry, and the refund path.
 */
const { expect } = require("chai");
const hre = require("hardhat");

const ethers = hre.ethers;

const MODE_AUTONOMOUS = 0;
const MODE_CLAIM_TOKEN = 1;

const STATUS = { None: 0, Proposed: 1, Approved: 2, ClaimMinted: 3, Redeemed: 4, PaidOut: 5, Refunded: 6 };

const usd = (n) => BigInt(Math.round(n * 1e6));
const id = (s) => ethers.id(s);

async function deployStack() {
  const [deployer, organizer, judge, relayer, winner, outsider] = await ethers.getSigners();

  const claim = await (await ethers.getContractFactory("PrizeClaimToken")).deploy(deployer.address);
  await claim.waitForDeployment();

  const treasury = await (
    await ethers.getContractFactory("HackathonTreasury")
  ).deploy(deployer.address, relayer.address, await claim.getAddress());
  await treasury.waitForDeployment();

  await (await claim.transferOwnership(await treasury.getAddress())).wait();

  const token = await (await ethers.getContractFactory("DemoPayoutToken")).deploy(deployer.address);
  await token.waitForDeployment();

  return { deployer, organizer, judge, relayer, winner, outsider, claim, treasury, token };
}

/** Bootstraps a hackathon with one track, funded by the organizer. */
async function bootstrap(ctx, { threshold = usd(500), trackBudget = usd(10_000) } = {}) {
  const { treasury, token, organizer, judge } = ctx;
  const hackathonId = id("hack-1");
  const trackId = id("track-1");

  await (await token.mint(organizer.address, trackBudget)).wait();
  await (await token.connect(organizer).approve(await treasury.getAddress(), trackBudget)).wait();

  await (
    await treasury
      .connect(organizer)
      .bootstrapHackathon(hackathonId, judge.address, await token.getAddress(), threshold, [
        { trackId, budget: trackBudget },
      ])
  ).wait();

  return { hackathonId, trackId };
}

async function registerAndPropose(ctx, ids, { amount, mode }) {
  const { treasury, relayer, winner } = ctx;
  const submissionId = id(`sub-${amount}-${mode}`);
  const awardId = id(`award-${amount}-${mode}`);

  await (
    await treasury
      .connect(relayer)
      .registerSubmission(submissionId, ids.hackathonId, ids.trackId, winner.address, id("repo"))
  ).wait();

  await (
    await treasury.connect(relayer).proposeAward(awardId, submissionId, winner.address, amount, mode, id("evidence"))
  ).wait();

  return { submissionId, awardId };
}

/** Builds and signs the EIP-712 AwardApproval the contract expects. */
async function signApproval(ctx, approval, signer) {
  const { treasury } = ctx;
  const domain = {
    name: "JudgeBuddyTreasury",
    version: "1",
    chainId: (await ethers.provider.getNetwork()).chainId,
    verifyingContract: await treasury.getAddress(),
  };
  const types = {
    AwardApproval: [
      { name: "awardId", type: "bytes32" },
      { name: "hackathonId", type: "bytes32" },
      { name: "submissionId", type: "bytes32" },
      { name: "trackId", type: "bytes32" },
      { name: "winner", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "settlementMode", type: "uint8" },
      { name: "expiresAt", type: "uint256" },
    ],
  };
  return signer.signTypedData(domain, types, approval);
}

const futureExpiry = async () => (await ethers.provider.getBlock("latest")).timestamp + 3600;

describe("HackathonTreasury", function () {
  describe("bootstrap and funding", function () {
    it("escrows the full track budget on creation", async function () {
      const ctx = await deployStack();
      await bootstrap(ctx, { trackBudget: usd(10_000) });

      expect(await ctx.token.balanceOf(await ctx.treasury.getAddress())).to.equal(usd(10_000));
      expect(await ctx.token.balanceOf(ctx.organizer.address)).to.equal(0n);
    });

    it("records the organizer, judge and threshold", async function () {
      const ctx = await deployStack();
      const { hackathonId } = await bootstrap(ctx, { threshold: usd(500) });

      const hackathon = await ctx.treasury.hackathons(hackathonId);
      expect(hackathon.organizer).to.equal(ctx.organizer.address);
      expect(hackathon.judge).to.equal(ctx.judge.address);
      expect(hackathon.autonomousThreshold).to.equal(usd(500));
      expect(hackathon.exists).to.equal(true);
    });

    it("rejects a duplicate hackathon id", async function () {
      const ctx = await deployStack();
      const { hackathonId, trackId } = await bootstrap(ctx);
      await expect(
        ctx.treasury
          .connect(ctx.organizer)
          .bootstrapHackathon(hackathonId, ctx.judge.address, await ctx.token.getAddress(), 1n, [
            { trackId, budget: 1n },
          ]),
      ).to.be.revertedWithCustomError(ctx.treasury, "HackathonExists");
    });
  });

  describe("agent authority", function () {
    it("lets only the relayer or owner register submissions", async function () {
      const ctx = await deployStack();
      const ids = await bootstrap(ctx);
      await expect(
        ctx.treasury
          .connect(ctx.outsider)
          .registerSubmission(id("s"), ids.hackathonId, ids.trackId, ctx.winner.address, id("r")),
      ).to.be.revertedWithCustomError(ctx.treasury, "Unauthorized");
    });

    it("refuses to propose an award beyond the track budget", async function () {
      const ctx = await deployStack();
      const ids = await bootstrap(ctx, { trackBudget: usd(1_000) });
      await (
        await ctx.treasury
          .connect(ctx.relayer)
          .registerSubmission(id("s"), ids.hackathonId, ids.trackId, ctx.winner.address, id("r"))
      ).wait();

      await expect(
        ctx.treasury
          .connect(ctx.relayer)
          .proposeAward(id("a"), id("s"), ctx.winner.address, usd(5_000), MODE_AUTONOMOUS, id("e")),
      ).to.be.revertedWithCustomError(ctx.treasury, "BudgetExceeded");
    });
  });

  describe("autonomous payout — the ceiling is the whole point", function () {
    it("pays a winner directly when the award is at or below the threshold", async function () {
      const ctx = await deployStack();
      const ids = await bootstrap(ctx, { threshold: usd(500) });
      const { awardId } = await registerAndPropose(ctx, ids, { amount: usd(500), mode: MODE_AUTONOMOUS });

      await expect(ctx.treasury.connect(ctx.relayer).executeAutonomousPayout(awardId))
        .to.emit(ctx.treasury, "PayoutReleased")
        .withArgs(awardId, ctx.winner.address, await ctx.token.getAddress(), usd(500));

      expect(await ctx.token.balanceOf(ctx.winner.address)).to.equal(usd(500));
      expect((await ctx.treasury.awards(awardId)).status).to.equal(STATUS.PaidOut);
    });

    it("REVERTS when the award exceeds the threshold, even for the relayer", async function () {
      const ctx = await deployStack();
      const ids = await bootstrap(ctx, { threshold: usd(500) });
      const { awardId } = await registerAndPropose(ctx, ids, { amount: usd(501), mode: MODE_AUTONOMOUS });

      await expect(
        ctx.treasury.connect(ctx.relayer).executeAutonomousPayout(awardId),
      ).to.be.revertedWithCustomError(ctx.treasury, "BudgetExceeded");

      expect(await ctx.token.balanceOf(ctx.winner.address)).to.equal(0n);
    });

    it("REVERTS when the contract owner tries to bypass the ceiling", async function () {
      const ctx = await deployStack();
      const ids = await bootstrap(ctx, { threshold: usd(500) });
      const { awardId } = await registerAndPropose(ctx, ids, { amount: usd(9_000), mode: MODE_AUTONOMOUS });

      await expect(
        ctx.treasury.connect(ctx.deployer).executeAutonomousPayout(awardId),
      ).to.be.revertedWithCustomError(ctx.treasury, "BudgetExceeded");
    });

    it("cannot pay the same award twice", async function () {
      const ctx = await deployStack();
      const ids = await bootstrap(ctx);
      const { awardId } = await registerAndPropose(ctx, ids, { amount: usd(100), mode: MODE_AUTONOMOUS });

      await (await ctx.treasury.connect(ctx.relayer).executeAutonomousPayout(awardId)).wait();
      await expect(
        ctx.treasury.connect(ctx.relayer).executeAutonomousPayout(awardId),
      ).to.be.revertedWithCustomError(ctx.treasury, "InvalidAwardStatus");
    });
  });

  describe("approved settlement — EIP-712", function () {
    async function proposeAbove(ctx) {
      const ids = await bootstrap(ctx, { threshold: usd(500) });
      const amount = usd(2_500);
      const { submissionId, awardId } = await registerAndPropose(ctx, ids, { amount, mode: MODE_AUTONOMOUS });
      const approval = {
        awardId,
        hackathonId: ids.hackathonId,
        submissionId,
        trackId: ids.trackId,
        winner: ctx.winner.address,
        amount,
        settlementMode: MODE_AUTONOMOUS,
        expiresAt: await futureExpiry(),
      };
      return { ids, approval, amount };
    }

    it("pays out when the judge signs", async function () {
      const ctx = await deployStack();
      const { approval, amount } = await proposeAbove(ctx);
      const signature = await signApproval(ctx, approval, ctx.judge);

      await expect(ctx.treasury.connect(ctx.outsider).executeApprovedAward(approval, signature))
        .to.emit(ctx.treasury, "PayoutReleased")
        .withArgs(approval.awardId, ctx.winner.address, await ctx.token.getAddress(), amount);

      expect(await ctx.token.balanceOf(ctx.winner.address)).to.equal(amount);
    });

    it("pays out when the organizer signs", async function () {
      const ctx = await deployStack();
      const { approval } = await proposeAbove(ctx);
      const signature = await signApproval(ctx, approval, ctx.organizer);
      await expect(ctx.treasury.executeApprovedAward(approval, signature)).to.emit(ctx.treasury, "AwardApproved");
    });

    it("rejects a signature from anyone else", async function () {
      const ctx = await deployStack();
      const { approval } = await proposeAbove(ctx);
      const signature = await signApproval(ctx, approval, ctx.outsider);
      await expect(ctx.treasury.executeApprovedAward(approval, signature)).to.be.revertedWithCustomError(
        ctx.treasury,
        "InvalidSignature",
      );
    });

    it("rejects a tampered amount — the signature no longer matches the award", async function () {
      const ctx = await deployStack();
      const { approval } = await proposeAbove(ctx);
      const signature = await signApproval(ctx, approval, ctx.judge);

      const tampered = { ...approval, amount: approval.amount * 2n };
      await expect(ctx.treasury.executeApprovedAward(tampered, signature)).to.be.revertedWithCustomError(
        ctx.treasury,
        "InvalidApprovalPayload",
      );
    });

    it("rejects a redirected winner", async function () {
      const ctx = await deployStack();
      const { approval } = await proposeAbove(ctx);
      const signature = await signApproval(ctx, approval, ctx.judge);

      const tampered = { ...approval, winner: ctx.outsider.address };
      await expect(ctx.treasury.executeApprovedAward(tampered, signature)).to.be.revertedWithCustomError(
        ctx.treasury,
        "InvalidApprovalPayload",
      );
    });

    it("rejects an expired approval", async function () {
      const ctx = await deployStack();
      const { approval } = await proposeAbove(ctx);
      const expired = { ...approval, expiresAt: 1 };
      const signature = await signApproval(ctx, expired, ctx.judge);

      await expect(ctx.treasury.executeApprovedAward(expired, signature)).to.be.revertedWithCustomError(
        ctx.treasury,
        "ApprovalExpired",
      );
    });

    it("cannot be replayed", async function () {
      const ctx = await deployStack();
      const { approval } = await proposeAbove(ctx);
      const signature = await signApproval(ctx, approval, ctx.judge);

      await (await ctx.treasury.executeApprovedAward(approval, signature)).wait();
      await expect(ctx.treasury.executeApprovedAward(approval, signature)).to.be.revertedWithCustomError(
        ctx.treasury,
        "InvalidAwardStatus",
      );
    });

    it("exposes a digest that matches what ethers computes", async function () {
      const ctx = await deployStack();
      const { approval } = await proposeAbove(ctx);

      const onchain = await ctx.treasury.getAwardApprovalDigest(approval);
      const offchain = ethers.TypedDataEncoder.hash(
        {
          name: "JudgeBuddyTreasury",
          version: "1",
          chainId: (await ethers.provider.getNetwork()).chainId,
          verifyingContract: await ctx.treasury.getAddress(),
        },
        {
          AwardApproval: [
            { name: "awardId", type: "bytes32" },
            { name: "hackathonId", type: "bytes32" },
            { name: "submissionId", type: "bytes32" },
            { name: "trackId", type: "bytes32" },
            { name: "winner", type: "address" },
            { name: "amount", type: "uint256" },
            { name: "settlementMode", type: "uint8" },
            { name: "expiresAt", type: "uint256" },
          ],
        },
        approval,
      );
      expect(onchain).to.equal(offchain);
    });
  });

  describe("budget accounting and refunds", function () {
    it("tracks paid against the track budget", async function () {
      const ctx = await deployStack();
      const ids = await bootstrap(ctx, { trackBudget: usd(10_000) });
      const { awardId } = await registerAndPropose(ctx, ids, { amount: usd(400), mode: MODE_AUTONOMOUS });
      await (await ctx.treasury.connect(ctx.relayer).executeAutonomousPayout(awardId)).wait();

      const track = await ctx.treasury.trackBudgets(ids.hackathonId, ids.trackId);
      expect(track.budget).to.equal(usd(10_000));
      expect(track.paid).to.equal(usd(400));
      expect(track.reserved).to.equal(0n);
    });

    it("returns unspent funds to the organizer", async function () {
      const ctx = await deployStack();
      const ids = await bootstrap(ctx, { trackBudget: usd(10_000) });

      await (
        await ctx.treasury
          .connect(ctx.organizer)
          .refundRemaining(ids.hackathonId, ids.trackId, ctx.organizer.address, usd(10_000))
      ).wait();

      expect(await ctx.token.balanceOf(ctx.organizer.address)).to.equal(usd(10_000));
    });

    it("refuses a refund larger than what is left", async function () {
      const ctx = await deployStack();
      const ids = await bootstrap(ctx, { trackBudget: usd(1_000) });
      const { awardId } = await registerAndPropose(ctx, ids, { amount: usd(400), mode: MODE_AUTONOMOUS });
      await (await ctx.treasury.connect(ctx.relayer).executeAutonomousPayout(awardId)).wait();

      await expect(
        ctx.treasury.connect(ctx.organizer).refundRemaining(ids.hackathonId, ids.trackId, ctx.organizer.address, usd(700)),
      ).to.be.revertedWithCustomError(ctx.treasury, "BudgetExceeded");
    });

    it("refuses a refund from a non-organizer", async function () {
      const ctx = await deployStack();
      const ids = await bootstrap(ctx);
      await expect(
        ctx.treasury.connect(ctx.outsider).refundRemaining(ids.hackathonId, ids.trackId, ctx.outsider.address, 1n),
      ).to.be.revertedWithCustomError(ctx.treasury, "Unauthorized");
    });
  });

  describe("evidence anchoring", function () {
    it("emits the evaluation hash so a rationale can be proven unchanged", async function () {
      const ctx = await deployStack();
      const ids = await bootstrap(ctx);
      const submissionId = id("sub-evidence");
      const evidenceHash = ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify({ score: 92 })));

      await (
        await ctx.treasury
          .connect(ctx.relayer)
          .registerSubmission(submissionId, ids.hackathonId, ids.trackId, ctx.winner.address, id("repo"))
      ).wait();

      await expect(ctx.treasury.connect(ctx.relayer).recordEvaluation(submissionId, true, 92, evidenceHash))
        .to.emit(ctx.treasury, "EvaluationFinalized")
        .withArgs(submissionId, true, 92, evidenceHash);
    });
  });

  describe("claim-token mode on a non-Hedera EVM", function () {
    it("fails at the HTS boundary rather than silently paying out", async function () {
      // Documents the boundary: on a chain without the HTS system contract there is no claim
      // collection, so claim-mode settlement cannot complete. It must not fall through to a
      // transfer. On Hedera testnet this path works once initializeClaimCollection has run.
      const ctx = await deployStack();
      const ids = await bootstrap(ctx, { threshold: usd(500) });
      const amount = usd(2_500);
      const { submissionId, awardId } = await registerAndPropose(ctx, ids, { amount, mode: MODE_CLAIM_TOKEN });

      const approval = {
        awardId,
        hackathonId: ids.hackathonId,
        submissionId,
        trackId: ids.trackId,
        winner: ctx.winner.address,
        amount,
        settlementMode: MODE_CLAIM_TOKEN,
        expiresAt: await futureExpiry(),
      };
      const signature = await signApproval(ctx, approval, ctx.judge);

      await expect(ctx.treasury.executeApprovedAward(approval, signature)).to.be.reverted;
      expect(await ctx.token.balanceOf(ctx.winner.address)).to.equal(0n);
    });
  });
});
