import { describe, expect, it } from "vitest";

import {
  baseUnitsToTokenAmount,
  formatBaseUnits,
  formatTokenAmount,
  parseTokenAmountToBaseUnits,
  payoutTokenSymbol,
  setPayoutTokenDisplay,
} from "./format";

describe("formatTokenAmount", () => {
  it("scales base units by the token decimals", () => {
    expect(formatTokenAmount("2500000000", 6, "jbUSD")).toBe("2,500 jbUSD");
    expect(formatTokenAmount("1000", 6, "jbUSD")).toBe("0.001 jbUSD");
    expect(formatTokenAmount("0", 6, "jbUSD")).toBe("0 jbUSD");
  });

  it("omits the suffix when no symbol is known", () => {
    expect(formatTokenAmount("2500000000", 6, "")).toBe("2,500");
  });

  it("returns non-integer input unchanged instead of mangling it", () => {
    expect(formatTokenAmount("2,500 jbUSD", 6, "jbUSD")).toBe("2,500 jbUSD");
  });
});

describe("payout token display identity", () => {
  it("has no hardcoded symbol until the deployment reports one", () => {
    // The first deployed bundle fell back to "USDC" and mislabelled every
    // jbUSD amount. An empty symbol must be the default, never a guess.
    expect(payoutTokenSymbol()).toBe("");
  });

  it("adopts the identity reported by /api/health and ignores junk", () => {
    setPayoutTokenDisplay("  jbUSD  ", 6);
    expect(payoutTokenSymbol()).toBe("jbUSD");
    setPayoutTokenDisplay(null, 99); // out of range: keep the previous value
    expect(payoutTokenSymbol()).toBe("jbUSD");
    expect(formatTokenAmount("2500000000")).toBe("2,500 jbUSD");
  });
});

describe("parseTokenAmountToBaseUnits", () => {
  it("round-trips with baseUnitsToTokenAmount", () => {
    const base = parseTokenAmountToBaseUnits("1,234.56", 6);
    expect(base).toBe("1234560000");
    expect(baseUnitsToTokenAmount(base as string, 6)).toBe("1234.56");
  });

  it("rejects negatives, junk and excess precision", () => {
    expect(parseTokenAmountToBaseUnits("-5", 6)).toBeNull();
    expect(parseTokenAmountToBaseUnits("abc", 6)).toBeNull();
    expect(parseTokenAmountToBaseUnits("0.1234567", 6)).toBeNull();
  });
});

describe("formatBaseUnits", () => {
  it("adds thousands separators to the exact integer", () => {
    expect(formatBaseUnits("2500000000")).toBe("2,500,000,000");
  });
});
