#!/usr/bin/env bash
#
# Completes the Hedera half of the JudgeBuddy deployment.
#
# Everything here was blocked on one thing: the deployer account having HBAR. The testnet faucet
# gates disbursement behind a reCAPTCHA, so a human has to click it once. This script does the
# rest — it waits for the balance to appear, deploys the contracts, wires the addresses into the
# live Worker and verifies the result.
#
#   1. Open https://portal.hedera.com/faucet
#   2. Paste the deployer address printed below, solve the checkbox, confirm
#      (sign in first if you can — 100 HBAR/day instead of 10; the deploy needs ~40)
#   3. Run this script. It can be started before or after step 2.
#
# Usage:
#   ./scripts/finish-hedera.sh
#
# Env (optional):
#   SKIP_CLAIM_COLLECTION=1   deploy without the HTS NFT collection, needs only ~20 HBAR.
#                             The autonomous payout path works fully; claim-token settlement
#                             stays unavailable until the collection exists.
set -euo pipefail
cd "$(dirname "$0")/.."

# shellcheck disable=SC1091
[ -f .env ] && set -a && . ./.env && set +a

RPC="${HEDERA_EVM_RPC:-https://testnet.hashio.io/api}"
MIRROR="${HEDERA_MIRROR_BASE:-https://testnet.mirrornode.hedera.com}"
NEEDED_HBAR="${NEEDED_HBAR:-20}"

info() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31mxx\033[0m %s\n' "$*" >&2; exit 1; }

[ -n "${DEPLOYER_EVM_PRIVATE_KEY:-}" ] || die "DEPLOYER_EVM_PRIVATE_KEY is not set in .env"

ADDRESS="$(node -e 'console.log(new (require("ethers").Wallet)(process.env.DEPLOYER_EVM_PRIVATE_KEY).address)')"

balance_hbar() {
  curl -s -X POST "$RPC" -H 'Content-Type: application/json' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_getBalance\",\"params\":[\"$ADDRESS\",\"latest\"]}" \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const r=JSON.parse(s).result;process.stdout.write(r?String(Number(BigInt(r))/1e18):"0")}catch{process.stdout.write("0")}})'
}

cat <<BANNER

  ─────────────────────────────────────────────────────────────────
   Fund this address, then this script continues automatically:

     $ADDRESS

     https://portal.hedera.com/faucet
     Needs ~${NEEDED_HBAR} HBAR. Signed in gives 100/day, anonymous gives 10/day.
  ─────────────────────────────────────────────────────────────────

BANNER

info "Waiting for funds (Ctrl-C to abort)…"
while :; do
  BAL="$(balance_hbar)"
  READY="$(node -e "process.stdout.write(String(Number(process.argv[1]) >= Number(process.argv[2])))" "$BAL" "$NEEDED_HBAR")"
  if [ "$READY" = "true" ]; then
    info "Balance: $BAL HBAR — proceeding"
    break
  fi
  printf '\r    balance: %-12s (need %s)  ' "$BAL" "$NEEDED_HBAR"
  sleep 15
done
echo

# ── deploy contracts ────────────────────────────────────────────────────────
info "Compiling"
npx hardhat compile

info "Deploying to Hedera testnet"
if [ "${SKIP_CLAIM_COLLECTION:-0}" = "1" ]; then
  warn "SKIP_CLAIM_COLLECTION=1 — the HTS claim collection will not be created"
  CLAIM_COLLECTION_HBAR=0 npx hardhat run scripts/deploy-treasury.cjs --network hedera_testnet | tee /tmp/jb-deploy.log
else
  npx hardhat run scripts/deploy-treasury.cjs --network hedera_testnet | tee /tmp/jb-deploy.log
fi

TREASURY=$(grep -oE '^TREASURY_CONTRACT_ADDRESS=0x[0-9a-fA-F]+' /tmp/jb-deploy.log | cut -d= -f2 | tail -1)
CLAIM=$(grep -oE '^PRIZE_CLAIM_TOKEN_ADDRESS=0x[0-9a-fA-F]+' /tmp/jb-deploy.log | cut -d= -f2 | tail -1)
PAYOUT=$(grep -oE '^PAYOUT_TOKEN_ADDRESS=0x[0-9a-fA-F]+' /tmp/jb-deploy.log | cut -d= -f2 | tail -1)

[ -n "$TREASURY" ] || die "Could not read the treasury address from the deploy output"
info "Treasury: $TREASURY"
info "Claim:    $CLAIM"
info "Payout:   $PAYOUT"

# Persist so a later redeploy keeps the same wiring.
{
  echo "TREASURY_CONTRACT_ADDRESS=$TREASURY"
  echo "PRIZE_CLAIM_TOKEN_ADDRESS=$CLAIM"
  echo "PAYOUT_TOKEN_ADDRESS=$PAYOUT"
} >> .env

# ── wire the Worker ─────────────────────────────────────────────────────────
# NOTE: contract addresses are written into wrangler.jsonc rather than passed as `--var`.
# CLI vars apply only to that one invocation, so any later `wrangler deploy` wipes them.
info "Pushing the relayer key as a Worker secret"
printf '%s' "$TREASURY_RELAYER_PRIVATE_KEY" | npx wrangler secret put TREASURY_RELAYER_PRIVATE_KEY

info "Rebuilding the frontend with the contract addresses"
VITE_TREASURY_CONTRACT_ADDRESS="$TREASURY" \
VITE_PRIZE_CLAIM_TOKEN_ADDRESS="$CLAIM" \
VITE_PAYOUT_TOKEN_ADDRESS="$PAYOUT" \
  npm run build

info "Redeploying the Worker with contract vars"
npx wrangler deploy \
  --var "TREASURY_CONTRACT_ADDRESS:$TREASURY" \
  --var "PRIZE_CLAIM_TOKEN_ADDRESS:$CLAIM" \
  --var "PAYOUT_TOKEN_ADDRESS:$PAYOUT"

# ── verify ──────────────────────────────────────────────────────────────────
info "Verifying"
sleep 5
curl -s https://judge-buddy.l17s.dev/api/health \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const h=JSON.parse(s);console.log("   api ok            :",h.ok);console.log("   treasury configured:",h.treasuryContractConfigured);console.log("   chain writable     :",h.chain.canWrite);console.log("   explorer           :",h.chain.explorer)})'

info "Re-queueing the demo submissions so they settle on-chain"
npx wrangler d1 execute judge-buddy --remote \
  --command="delete from award_proposals; delete from evaluation_runs; delete from events; delete from jobs; delete from similarity_clusters;" >/dev/null
npx wrangler d1 execute judge-buddy --remote --file=cf/src/db/seed.sql >/dev/null

cat <<DONE

  ─────────────────────────────────────────────────────────────────
   Done. The cron drains the queue within a few minutes.

     Site      https://judge-buddy.l17s.dev
     Treasury  https://hashscan.io/testnet/contract/$TREASURY
     Payout    https://hashscan.io/testnet/contract/$PAYOUT

   Watch it settle:
     npx wrangler tail --name judge-buddy --format pretty
  ─────────────────────────────────────────────────────────────────

DONE
