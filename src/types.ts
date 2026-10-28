export type Outcome = string;

export type OutcomeDraft = {
  id?: string;
  label: string;
  priceBps: number;
};

export type CatalogOutcome = {
  id: string;
  label: string;
  priceBps: number;
  tradedSats: number;
};

export type OutcomePrice = {
  id: string;
  priceBps: number;
};

export type MarketStatus =
  | "DRAFT"
  | "REVIEW"
  | "OPEN"
  | "CLOSED"
  | "PROPOSED"
  | "FINALIZED"
  | "REDEEMABLE"
  | "ARCHIVED";

export type OrderStatus = "quoted" | "pending" | "filled" | "expired" | "refused";

export type WalletBalance = {
  address: string;
  availableSats: number;
  committedSats: number;
  maxSatsPerTx: number;
  dailySats: number;
};

export type TxOutput = {
  address: string;
  amountSats: number;
};

export type PaymentView =
  | { state: "missing" }
  | { state: "rejected" }
  | { state: "seen"; from: string[]; outputs: TxOutput[] }
  | { state: "confirmed"; from: string[]; outputs: TxOutput[] };

export interface Rails {
  balance(token: string): Promise<WalletBalance | null>;
  payment(txId: string): Promise<PaymentView>;
}

export type PublishInput = {
  question: string;
  description?: string;
  category?: string;
  closeAt: string;
  resolutionSource: string;
  resolutionRules: string;
  challengePeriod: number;
  unitSats: number;
  outcomes?: OutcomeDraft[];
  yesPriceBps?: number;
  noPriceBps?: number;
  tags?: string[];
  maxShares: number;
};

export type CatalogMarket = {
  marketId: string;
  question: string;
  description: string;
  category: string;
  closeAt: string;
  resolutionSource: string;
  resolutionRules: string;
  challengePeriod: number;
  unitSats: number;
  tags: string[];
  outcomes: CatalogOutcome[];
  tradedSats: number;
  maxShares: number;
  sharesAvailable: number;
  status: MarketStatus;
  paused: boolean;
};

export type OperatorMarket = CatalogMarket & {
  sharesSold: number;
  sharesReserved: number;
  availableComplementSats: number;
};

export type QuotePoint = {
  marketId: string;
  outcomes: OutcomePrice[];
  at: string;
};

export type ProposalView = {
  outcome: Outcome;
  evidence: string;
  source: string;
  proposer: string;
  challengeDeadline: string;
};

export type ResolutionView = {
  marketId: string;
  status: MarketStatus;
  resolutionSource: string;
  resolutionRules: string;
  proposal: ProposalView | null;
  finalOutcome: Outcome | null;
};

export type PaymentRequired = {
  shareCostSats: number;
  feeSats: number;
  amountSats: number;
  priceBps: number;
  address: string;
  feeAddress: string;
  quoteId: string;
  expiresAt: string;
  paymentId?: string;
  checkoutUrl?: string;
  qrString?: string;
};

export type ShareBalance = Record<string, number>;

export type OrderView = {
  quoteId: string;
  marketId: string;
  outcome: Outcome;
  quantity: number;
  priceBps: number;
  maxPriceBps: number;
  shareCostSats: number;
  feeSats: number;
  amountSats: number;
  address: string;
  feeAddress: string;
  wallet: string;
  status: OrderStatus;
  expiresAt: string;
  transactionId?: string;
  reason?: string;
  shares: ShareBalance;
};

export type CheckoutResult =
  | { http: 402; payment: PaymentRequired }
  | { http: 202; order: OrderView }
  | { http: 200; order: OrderView };

export type RedemptionView = {
  marketId: string;
  wallet: string;
  outcome: Outcome;
  quantity: number;
  grossSats: number;
  feeSats: number;
  payoutSats: number;
  feeAddress: string;
};

export type LedgerCredit = {
  to: string;
  amountSats: number;
  marketId: string;
  reason: "purchase" | "redemption";
  at: string;
};

export type PayoutStatus = "owed" | "sent" | "confirmed";

export type Payout = {
  id: string;
  to: string;
  amountSats: number;
  marketId: string;
  reason: "redemption" | "fee_sweep";
  status: PayoutStatus;
  at: string;
  outcome?: Outcome;
  quantity?: number;
  transactionId?: string;
};

export type CreatedPayment = {
  paymentId: string;
  amountSats: number;
  address: string;
  expiresAt: string;
  checkoutUrl: string;
  qrString: string;
};

export type RailPaymentState = "initiated" | "detected" | "paid" | "failed" | "expired" | "canceled" | "cleared";

export type RailPayment = {
  state: RailPaymentState;
  paidSats: number;
  txids: string[];
};

export interface PaymentRail {
  create(input: { externalId: string; amountSats: number; ttlSeconds: number; description: string }): Promise<CreatedPayment>;
  status(paymentId: string): Promise<RailPayment>;
  verifyWebhook(rawBody: string, signature: string | undefined): boolean;
};

export type MarketEvent = {
  id: string;
  type: string;
  marketId: string;
  at: string;
  payload: Record<string, unknown>;
};

export class BadRequest extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = "BadRequest";
  }
}

export class Unauthorized extends Error {
  readonly status = 401;
  constructor() {
    super("unauthorized");
    this.name = "Unauthorized";
  }
}

export class NotFound extends Error {
  readonly status = 404;
  constructor(message: string) {
    super(message);
    this.name = "NotFound";
  }
}

export class Refusal extends Error {
  readonly status = 409;
  constructor(message: string) {
    super(message);
    this.name = "Refusal";
  }
}

export class UpstreamError extends Error {
  readonly status = 502;
  constructor(message: string) {
    super(message);
    this.name = "UpstreamError";
  }
}
