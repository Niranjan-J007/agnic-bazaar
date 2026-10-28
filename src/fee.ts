export const FEE_ADDRESS =
  "bc1qz5twv72h6a8kguuc2y5zceu5umz44j6qkpa8k37qg59zytjzzn4sj7530k";

const NATIVE_SEGWIT = /^bc1q[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{38,80}$/;

export function isNativeSegwit(address: string): boolean {
  return NATIVE_SEGWIT.test(address);
}

/** Tiered fee from PRODUCT_SPEC_AGNIC §12. A larger base pays at least as much as a smaller one. */
export function feeSats(baseSats: number): number {
  if (!Number.isSafeInteger(baseSats) || baseSats < 0) {
    throw new RangeError("baseSats must be a non-negative integer");
  }
  const first = Math.min(baseSats, 1000);
  const middle = Math.min(Math.max(baseSats - 1000, 0), 9000);
  const rest = Math.max(baseSats - 10000, 0);
  return Math.floor(first / 100) + Math.floor(middle / 1000) + Math.floor(rest / 10000);
}

export type QuoteAmounts = {
  shareCostSats: number;
  complementSats: number;
  feeSats: number;
  amountSats: number;
};

/** Buyer share cost plus the operator complement equals `unitSats` per share. */
export function quoteAmounts(unitSats: number, priceBps: number, quantity: number): QuoteAmounts {
  const product = unitSats * priceBps * quantity;
  const gross = unitSats * quantity;
  if (!Number.isSafeInteger(product) || !Number.isSafeInteger(gross)) {
    throw new RangeError("amount too large");
  }
  const shareCostSats = Math.floor(product / 10_000);
  const complementSats = gross - shareCostSats;
  const fee = feeSats(shareCostSats);
  const amountSats = shareCostSats + fee;
  if (!Number.isSafeInteger(amountSats)) {
    throw new RangeError("amount too large");
  }
  return { shareCostSats, complementSats, feeSats: fee, amountSats };
}
