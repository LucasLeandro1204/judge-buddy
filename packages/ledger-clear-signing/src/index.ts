import type { AwardApproval, SettlementMode } from "../../shared/src/index.js";

export type ClearSigningField = {
  label: string;
  value: string;
  format?: "address" | "amount" | "text" | "timestamp";
};

export type ClearSigningManifest = {
  version: "1.0";
  action: "approve_award" | "mint_claim" | "release_payout" | "refund_payout";
  contractName: string;
  contractAddress: string;
  chainId: number;
  digest: string;
  summary: string;
  fields: ClearSigningField[];
  calldataPreview?: string;
};

function settlementLabel(mode: SettlementMode): string {
  return mode === "claim_token" ? "Mint prize claim NFT" : "Release autonomous payout";
}

/** Display identity of the token an amount is denominated in. */
export type TokenDisplay = { symbol: string; decimals: number };

function shortAddress(address: string): string {
  return address.length > 14 ? `${address.slice(0, 6)}…${address.slice(-6)}` : address;
}

/** "2,500 jbUSD" when the token is known; "2500000000 base units" when it is not. */
function formatAmount(baseUnits: string, token?: TokenDisplay): string {
  if (!token || !/^-?\d+$/.test(baseUnits)) return `${baseUnits} base units`;
  const units = BigInt(baseUnits);
  const negative = units < 0n;
  const absolute = negative ? -units : units;
  const divisor = 10n ** BigInt(token.decimals);
  const whole = new Intl.NumberFormat("en-US").format(absolute / divisor);
  const fraction =
    token.decimals > 0 ? (absolute % divisor).toString().padStart(token.decimals, "0").replace(/0+$/, "") : "";
  return `${negative ? "-" : ""}${fraction ? `${whole}.${fraction}` : whole} ${token.symbol}`;
}

/** "Aug 4, 2026, 00:15 UTC" — unambiguous for a signer in any locale. */
function formatExpiry(expiresAtSeconds: number): string {
  const formatted = new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(expiresAtSeconds * 1000));
  return `${formatted} UTC`;
}

/**
 * The sentence a signer reads before anything else. It must carry no raw base units and
 * no ISO timestamps — the structured `fields[]` keep the machine values, and renderers
 * format those separately.
 */
export function summarizeAwardApproval(approval: AwardApproval, token?: TokenDisplay): string {
  const mode = settlementLabel(approval.settlementMode);
  return `${mode} for ${formatAmount(approval.amount, token)} to ${shortAddress(approval.winner)} on track ${
    approval.trackId
  }. Approval expires ${formatExpiry(approval.expiresAt)}.`;
}

export function buildClearSigningManifest(input: {
  action: ClearSigningManifest["action"];
  chainId: number;
  contractAddress: string;
  contractName: string;
  digest: string;
  approval: AwardApproval;
  token?: TokenDisplay;
  calldataPreview?: string;
}): ClearSigningManifest {
  return {
    version: "1.0",
    action: input.action,
    chainId: input.chainId,
    contractAddress: input.contractAddress,
    contractName: input.contractName,
    digest: input.digest,
    calldataPreview: input.calldataPreview,
    summary: summarizeAwardApproval(input.approval, input.token),
    fields: [
      { label: "Award ID", value: input.approval.awardId, format: "text" },
      { label: "Hackathon", value: input.approval.hackathonId, format: "text" },
      { label: "Submission", value: input.approval.submissionId, format: "text" },
      { label: "Track", value: input.approval.trackId, format: "text" },
      { label: "Recipient", value: input.approval.winner, format: "address" },
      { label: "Amount", value: input.approval.amount, format: "amount" },
      { label: "Settlement", value: settlementLabel(input.approval.settlementMode), format: "text" },
      { label: "Expires", value: new Date(input.approval.expiresAt * 1000).toISOString(), format: "timestamp" },
    ],
  };
}

export function validateClearSigningManifest(manifest: ClearSigningManifest): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!manifest.contractAddress.startsWith("0x")) errors.push("contractAddress must be an EVM address");
  if (!manifest.digest.startsWith("0x")) errors.push("digest must be a hex string");
  if (!manifest.summary.trim()) errors.push("summary is required");
  if (manifest.fields.length < 4) errors.push("at least four fields are required");
  return { ok: errors.length === 0, errors };
}
