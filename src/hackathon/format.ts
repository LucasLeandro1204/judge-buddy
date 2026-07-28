/**
 * Display identity of the payout token used for prize budgets, awards, and allowances.
 * Every amount the API stores is a *base-unit* integer string, so it must be scaled
 * before it is shown to a human.
 *
 * The deployment — not this bundle — knows which token the treasury pays with, so both
 * symbol and decimals arrive from `/api/health` at runtime via `setPayoutTokenDisplay`.
 * The `VITE_PAYOUT_TOKEN_*` vars remain only as a pre-load fallback. There is no
 * hardcoded symbol default on purpose: the first deployed bundle fell back to "USDC"
 * and labelled every jbUSD amount with it. An amount with no symbol beats a wrong one.
 */
const envDecimals = (() => {
  const raw = Number((import.meta.env.VITE_PAYOUT_TOKEN_DECIMALS as string | undefined)?.trim());
  return Number.isInteger(raw) && raw >= 0 && raw <= 18 ? raw : null;
})();
const envSymbol = (import.meta.env.VITE_PAYOUT_TOKEN_SYMBOL as string | undefined)?.trim() || null;

let runtimeDecimals: number | null = null;
let runtimeSymbol: string | null = null;

/** Record the payout token identity reported by the deployment. Idempotent. */
export function setPayoutTokenDisplay(symbol?: string | null, decimals?: number | null): void {
  if (typeof symbol === "string" && symbol.trim()) runtimeSymbol = symbol.trim();
  if (typeof decimals === "number" && Number.isInteger(decimals) && decimals >= 0 && decimals <= 18) {
    runtimeDecimals = decimals;
  }
}

export function payoutTokenDecimals(): number {
  return runtimeDecimals ?? envDecimals ?? 6;
}

/** Empty string until the deployment has reported the symbol. */
export function payoutTokenSymbol(): string {
  return runtimeSymbol ?? envSymbol ?? "";
}

function toBaseUnitsBigInt(value: string | number | bigint): bigint | null {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    return BigInt(Math.trunc(value));
  }
  const trimmed = value.trim();
  if (!/^-?\d+$/.test(trimmed)) return null;
  try {
    return BigInt(trimmed);
  } catch {
    return null;
  }
}

/**
 * Format an integer amount of token *base units* as a human token amount.
 *
 * `formatTokenAmount("1000")` at 6 decimals renders `0.001 <symbol>`, not `1,000 <symbol>`.
 * A value that is already human text (not an integer string) is returned unchanged.
 */
export function formatTokenAmount(
  baseUnits: string | number | bigint,
  decimals?: number,
  symbol?: string,
): string {
  const effectiveDecimals = decimals ?? payoutTokenDecimals();
  const effectiveSymbol = symbol ?? payoutTokenSymbol();
  const suffix = effectiveSymbol ? ` ${effectiveSymbol}` : "";

  const units = toBaseUnitsBigInt(baseUnits);
  if (units === null) {
    return String(baseUnits);
  }

  const negative = units < 0n;
  const absolute = negative ? -units : units;
  const divisor = 10n ** BigInt(effectiveDecimals);
  const whole = absolute / divisor;
  const fraction = absolute % divisor;

  const wholeText = new Intl.NumberFormat("en-US").format(whole);
  const fractionText =
    effectiveDecimals > 0 ? fraction.toString().padStart(effectiveDecimals, "0").replace(/0+$/, "") : "";

  const amountText = fractionText ? `${wholeText}.${fractionText}` : wholeText;
  return `${negative ? "-" : ""}${amountText}${suffix}`;
}

/** Render a raw base-unit integer with thousands separators, for "shows the exact integer" helper text. */
export function formatBaseUnits(baseUnits: string | number | bigint): string {
  const units = toBaseUnitsBigInt(baseUnits);
  if (units === null) return String(baseUnits);
  return new Intl.NumberFormat("en-US").format(units);
}

/**
 * Convert a human-entered decimal amount (e.g. `"1000"` or `"1000.25"`) into the
 * integer base-unit string the API expects. Returns `null` when the input is not a
 * valid non-negative decimal, or carries more precision than the token supports.
 */
export function parseTokenAmountToBaseUnits(
  humanAmount: string,
  decimals: number = payoutTokenDecimals(),
): string | null {
  const trimmed = humanAmount.trim().replace(/,/g, "");
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return null;

  const [wholePart, fractionPart = ""] = trimmed.split(".");
  if (fractionPart.length > decimals) return null;

  const padded = fractionPart.padEnd(decimals, "0");
  const combined = `${wholePart}${padded}`.replace(/^0+(?=\d)/, "");
  return combined.length ? combined : "0";
}

/** Inverse of {@link parseTokenAmountToBaseUnits}: base units to a plain decimal string (no symbol). */
export function baseUnitsToTokenAmount(
  baseUnits: string | number | bigint,
  decimals: number = payoutTokenDecimals(),
): string {
  const units = toBaseUnitsBigInt(baseUnits);
  if (units === null) return String(baseUnits);

  const negative = units < 0n;
  const absolute = negative ? -units : units;
  const divisor = 10n ** BigInt(decimals);
  const whole = (absolute / divisor).toString();
  const fraction = decimals > 0 ? (absolute % divisor).toString().padStart(decimals, "0").replace(/0+$/, "") : "";

  return `${negative ? "-" : ""}${fraction ? `${whole}.${fraction}` : whole}`;
}

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return "—";
  return new Date(value).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatDateInput(value: string): string {
  const date = new Date(value);
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function localInputToIso(value: string): string {
  return new Date(value).toISOString();
}

export function shorten(value: string | null | undefined, head = 6, tail = 4): string {
  if (!value) return "—";
  if (value.length <= head + tail + 3) return value;
  return `${value.slice(0, head)}...${value.slice(-tail)}`;
}

export function relativeTime(value: string): string {
  const diffMs = Date.now() - new Date(value).getTime();
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
