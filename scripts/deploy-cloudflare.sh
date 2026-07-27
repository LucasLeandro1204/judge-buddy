#!/usr/bin/env bash
#
# Deploys JudgeBuddy to Cloudflare Workers.
#
# Idempotent: safe to re-run. Creates the D1 database on first run, wires its id into
# wrangler.jsonc, applies the schema, pushes secrets, builds the SPA and deploys the Worker.
#
# Prerequisites:
#   wrangler login                      (interactive, once)
#   npm run deploy:treasury:testnet     (so the contract addresses exist)
#
# Usage:
#   ./scripts/deploy-cloudflare.sh
#
# Env (optional):
#   WORKER_NAME     defaults to judge-buddy
#   CUSTOM_DOMAIN   e.g. judge-buddy.l17s.dev — attached as a Workers custom domain
set -euo pipefail

cd "$(dirname "$0")/.."

WORKER_NAME="${WORKER_NAME:-judge-buddy}"
DB_NAME="judge-buddy"
WRANGLER="${WRANGLER:-npx wrangler}"

info() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31mxx\033[0m %s\n' "$*" >&2; exit 1; }

# ── preflight ───────────────────────────────────────────────────────────────
$WRANGLER whoami >/dev/null 2>&1 || die "Not logged in. Run: wrangler login"

[ -f .env ] || warn ".env not found — contract addresses will not be published as vars"
# shellcheck disable=SC1091
[ -f .env ] && set -a && . ./.env && set +a

# ── 1. D1 ───────────────────────────────────────────────────────────────────
info "Ensuring D1 database '$DB_NAME' exists"
if ! $WRANGLER d1 info "$DB_NAME" >/dev/null 2>&1; then
  $WRANGLER d1 create "$DB_NAME"
fi

DB_ID="$($WRANGLER d1 info "$DB_NAME" --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);process.stdout.write(j.uuid||j.database_id||"")})')"
[ -n "$DB_ID" ] || die "Could not determine the D1 database id"
info "D1 id: $DB_ID"

node -e '
  const fs = require("fs");
  const path = "wrangler.jsonc";
  const before = fs.readFileSync(path, "utf8");
  const after = before.replace(/"database_id":\s*"[^"]*"/, `"database_id": "${process.argv[1]}"`);
  if (before !== after) { fs.writeFileSync(path, after); console.log("   wrangler.jsonc updated"); }
' "$DB_ID"

info "Applying schema to remote D1"
$WRANGLER d1 execute "$DB_NAME" --remote --file=cf/src/db/schema.sql

# ── 2. secrets ──────────────────────────────────────────────────────────────
info "Setting secrets"
if [ -z "${SESSION_SECRET:-}" ]; then
  SESSION_SECRET="$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')"
  warn "SESSION_SECRET was not set; generated one. Existing sessions will be invalidated."
  echo "SESSION_SECRET=$SESSION_SECRET" >> .env
fi
printf '%s' "$SESSION_SECRET" | $WRANGLER secret put SESSION_SECRET --name "$WORKER_NAME"

if [ -n "${TREASURY_RELAYER_PRIVATE_KEY:-}" ]; then
  printf '%s' "$TREASURY_RELAYER_PRIVATE_KEY" | $WRANGLER secret put TREASURY_RELAYER_PRIVATE_KEY --name "$WORKER_NAME"
else
  warn "TREASURY_RELAYER_PRIVATE_KEY not set — agents will score but cannot write to the chain"
fi

# ── 3. contract addresses as plain vars ─────────────────────────────────────
# Kept out of wrangler.jsonc so a redeploy of the contracts does not require a source edit.
VAR_ARGS=()
for name in TREASURY_CONTRACT_ADDRESS PRIZE_CLAIM_TOKEN_ADDRESS PAYOUT_TOKEN_ADDRESS; do
  value="${!name:-}"
  if [ -n "$value" ]; then
    VAR_ARGS+=(--var "$name:$value")
    info "var $name=$value"
  else
    warn "$name is unset"
  fi
done

# ── 4. build the SPA ────────────────────────────────────────────────────────
info "Building frontend"
# Same-origin API: the Worker serves both, so no absolute API URL is baked in.
VITE_TREASURY_CONTRACT_ADDRESS="${TREASURY_CONTRACT_ADDRESS:-}" \
VITE_PRIZE_CLAIM_TOKEN_ADDRESS="${PRIZE_CLAIM_TOKEN_ADDRESS:-}" \
VITE_PAYOUT_TOKEN_ADDRESS="${PAYOUT_TOKEN_ADDRESS:-}" \
VITE_HEDERA_EVM_RPC="${HEDERA_EVM_RPC:-https://testnet.hashio.io/api}" \
VITE_HEDERA_MIRROR_BASE="${HEDERA_MIRROR_BASE:-https://testnet.mirrornode.hedera.com}" \
  npm run build

# ── 5. deploy ───────────────────────────────────────────────────────────────
info "Deploying Worker '$WORKER_NAME'"
$WRANGLER deploy --name "$WORKER_NAME" "${VAR_ARGS[@]}"

# ── 6. custom domain ────────────────────────────────────────────────────────
if [ -n "${CUSTOM_DOMAIN:-}" ]; then
  info "Attaching custom domain $CUSTOM_DOMAIN"
  # A Workers custom domain creates the DNS record and the route together. Already-exists is fine.
  $WRANGLER deploy --name "$WORKER_NAME" --route "${CUSTOM_DOMAIN}/*" "${VAR_ARGS[@]}" || \
    warn "Could not attach $CUSTOM_DOMAIN automatically — add it under Workers > Settings > Domains"
fi

info "Done."
echo
echo "  Worker:  https://${WORKER_NAME}.workers.dev"
[ -n "${CUSTOM_DOMAIN:-}" ] && echo "  Custom:  https://${CUSTOM_DOMAIN}"
echo "  Health:  https://${CUSTOM_DOMAIN:-${WORKER_NAME}.workers.dev}/api/health"
echo "  Logs:    $WRANGLER tail --name $WORKER_NAME"
