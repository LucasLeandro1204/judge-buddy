/**
 * Drives the above-the-ceiling settlement branch end to end against the deployed API.
 *
 * This deliberately goes through the public HTTP surface rather than calling the contract
 * directly: the point is to prove the product path works, not just that the Solidity does. It
 * signs in as the judge with a wallet signature, signs the EIP-712 approval the pipeline built,
 * submits it, then redeems the resulting prize-claim NFT.
 *
 *   auth/nonce → sign message → auth/verify → approvals → sign typed data
 *   → awards/:id/approve  (mints the HTS claim NFT)
 *   → claims/:id/redeem   (burns it and releases the payout)
 *
 * Env:
 *   JUDGE_PRIVATE_KEY  required, the judge account's ECDSA key
 *   JUDGE_ACCOUNT_ID   required, e.g. 0.0.9797514
 *   API_BASE           optional, defaults to the production deployment
 */
const { Wallet, verifyMessage } = require("ethers");

const API = process.env.API_BASE || "https://judge-buddy.l17s.dev/api";
const KEY = process.env.JUDGE_PRIVATE_KEY;
const ACCOUNT = process.env.JUDGE_ACCOUNT_ID;

let cookie = "";

async function call(path, { method = "GET", body } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const setCookie = res.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";")[0];
  const text = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${text.slice(0, 300)}`);
  return parsed;
}

async function main() {
  if (!KEY || !ACCOUNT) throw new Error("JUDGE_PRIVATE_KEY and JUDGE_ACCOUNT_ID must be set");
  const wallet = new Wallet(KEY);
  console.log("Judge:", ACCOUNT, wallet.address, "\n");

  // 1 — wallet sign-in
  console.log("[1/5] Requesting a challenge...");
  const challenge = await call("/auth/nonce", {
    method: "POST",
    body: { accountId: ACCOUNT, evmAddress: wallet.address },
  });
  const signature = await wallet.signMessage(challenge.message);
  // Catch a message-format drift here rather than as an opaque 401 from the server.
  if (verifyMessage(challenge.message, signature).toLowerCase() !== wallet.address.toLowerCase()) {
    throw new Error("local recovery failed — the signed message does not round-trip");
  }
  const { user } = await call("/auth/verify", {
    method: "POST",
    body: { challenge: challenge.challenge, signature },
  });
  console.log("      signed in as", user.accountId);

  // 2 — the approval the pipeline built. Re-running after a partial pass is fine: an approval
  // that has already executed is skipped rather than re-signed, so the script can be used to
  // finish a run that stopped between minting and redemption.
  console.log("[2/5] Reading the pending approval...");
  const approvals = await call("/approvals");
  const pending = approvals.find((entry) => entry.status === "pending");

  if (!pending) {
    console.log("      none pending — approval already executed, going straight to redemption");
    console.log("[3/5] skipped\n[4/5] skipped");
  } else {
    const { domain, types, value, digest } = pending.typedData;
    console.log("      award  :", pending.awardId);
    console.log("      amount :", value.amount, "· mode", value.settlementMode);
    console.log("      digest :", digest);

    // 3 — sign the typed data. ethers injects EIP712Domain itself.
    console.log("[3/5] Signing the EIP-712 approval...");
    const { EIP712Domain, ...signTypes } = types;
    const approvalSignature = await wallet.signTypedData(domain, signTypes, value);
    console.log("      signature:", approvalSignature.slice(0, 26) + "…");

    // 4 — submit it: mints the HTS prize-claim NFT
    console.log("[4/5] Submitting the approval (mints the claim NFT)...");
    const approved = await call(`/awards/${pending.awardId}/approve`, {
      method: "POST",
      body: { signature: approvalSignature },
    });
    console.log("      tx:", approved.txHash);
    console.log("      ", approved.explorer);
  }

  // 5 — redeem the claim: burns the NFT and releases the payout
  console.log("[5/5] Redeeming the claim...");
  const claims = await call("/claims");
  const claim = claims.find((entry) => entry.status !== "redeemed");
  if (!claim) {
    console.log("      no redeemable claim found; claims:", JSON.stringify(claims));
    return;
  }
  console.log("      claim:", claim.id, "· serial", claim.serialNumber);
  const redeemed = await call(`/claims/${claim.id}/redeem`, { method: "POST" });
  console.log("      tx:", redeemed.txHash);
  console.log("      ", redeemed.explorer);

  console.log("\n--- claim-token settlement complete ---");
}

main().catch((error) => {
  console.error("\n" + (error.message || error));
  process.exitCode = 1;
});
