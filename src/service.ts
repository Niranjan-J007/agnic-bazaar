import { randomUUID } from "node:crypto";
import { FEE_ADDRESS, feeSats, isNativeSegwit, quoteAmounts } from "./fee.ts";
import {
  BadRequest,
  NotFound,
  Refusal,
  Unauthorized,
  type CatalogMarket,
  type CheckoutResult,
  type LedgerCredit,
  type MarketEvent,
  type MarketStatus,
  type OrderStatus,
  type OrderView,
  type Outcome,
  type OutcomeDraft,
  type OutcomePrice,
  type PaymentRail,
  type PaymentRequired,
  type PaymentView,
  type Payout,
  type PayoutStatus,
  type ProposalView,
  type PublishInput,
  type QuotePoint,
  type Rails,
  type RedemptionView,
  type ResolutionView,
  type ShareBalance,
  type WalletBalance,
} from "./types.ts";

const DAY_MS = 86_400_000;

type Proposal = {
  outcome: Outcome;
  evidence: string;
  source: string;
  proposer: string;
  challengeDeadline: number;
};

type StoredOutcome = {
  id: string;
  label: string;
  priceBps: number;
  tradedSats: number;
};

type Market = {
  marketId: string;
  question: string;
  description: string;
  category: string;
  tags: string[];
  closeAt: number;
  resolutionSource: string;
  resolutionRules: string;
  challengePeriod: number;
  unitSats: number;
  outcomes: StoredOutcome[];
  maxShares: number;
  status: MarketStatus;
  paused: boolean;
  sharesSold: number;
  sharesReserved: number;
  availableComplement: number;
  reservedComplement: number;
  lockedBacking: number;
  residualSats: number;
  proposal: Proposal | null;
  finalOutcome: Outcome | null;
  finalizedAt?: number;
};

type Order = {
  quoteId: string;
  marketId: string;
  outcome: Outcome;
  quantity: number;
  maxPriceBps: number;
  priceBps: number;
  shareCostSats: number;
  complementSats: number;
  feeSats: number;
  amountSats: number;
  address: string;
  wallet: string;
  status: OrderStatus;
  expiresAt: number;
  createdAt: number;
  paidAt?: number;
  capConsumed: boolean;
  held: boolean;
  txId?: string;
  reason?: string;
  paymentId?: string;
  checkoutUrl?: string;
  qrString?: string;
  billedSats?: number;
};

type CheckoutInput = {
  token: string;
  marketId: string;
  outcome: Outcome;
  quantity: number;
  maxPriceBps: number;
  quoteId?: string;
  txId?: string;
  paymentId?: string;
};

export type ServiceOptions = {
  rails: Rails;
  merchantAddress: string;
  now?: () => number;
  quoteTtlMs?: number;
  payments?: PaymentRail;
  redemptionWindowMs?: number;
};

export class MarketService {
  readonly events: MarketEvent[] = [];
  readonly feeCredits: LedgerCredit[] = [];
  readonly payouts: Payout[] = [];
  readonly quotes: QuotePoint[] = [];

  private readonly rails: Rails;
  private readonly merchantAddress: string;
  private readonly now: () => number;
  private readonly quoteTtlMs: number;
  private readonly payments: PaymentRail | undefined;
  private readonly redemptionWindowMs: number;
  private readonly markets = new Map<string, Market>();
  private readonly orders = new Map<string, Order>();
  private readonly positions = new Map<string, Map<string, ShareBalance>>();
  private readonly usedTx = new Set<string>();
  private readonly usedPayoutTx = new Set<string>();

  constructor(options: ServiceOptions) {
    if (!isNativeSegwit(options.merchantAddress)) {
      throw new BadRequest("merchant address must be a mainnet native SegWit address");
    }
    this.rails = options.rails;
    this.merchantAddress = options.merchantAddress;
    this.now = options.now ?? Date.now;
    this.quoteTtlMs = options.quoteTtlMs ?? 10 * 60 * 1000;
    this.payments = options.payments;
    this.redemptionWindowMs = options.redemptionWindowMs ?? 90 * DAY_MS;
  }

  publish(input: PublishInput): CatalogMarket {
    const closeAt = Date.parse(input.closeAt);
    if (!Number.isFinite(closeAt)) throw new BadRequest("closeAt must be an ISO-8601 time");
    if (closeAt <= this.now()) throw new BadRequest("closeAt must be in the future");
    requireText(input.question, "question");
    requireText(input.resolutionSource, "resolutionSource");
    requireText(input.resolutionRules, "resolutionRules");
    if (!Number.isSafeInteger(input.challengePeriod) || input.challengePeriod <= 0) {
      throw new BadRequest("challengePeriod must be a positive integer number of seconds");
    }
    if (!Number.isSafeInteger(input.unitSats) || input.unitSats <= 0) {
      throw new BadRequest("unitSats must be a positive integer");
    }
    if (!Number.isSafeInteger(input.maxShares) || input.maxShares <= 0) {
      throw new BadRequest("maxShares must be a positive integer");
    }
    const outcomes = assignOutcomes(draftsFrom(input));
    const tags = cleanTags(input.tags);

    const market: Market = {
      marketId: randomUUID(),
      question: input.question,
      description: input.description?.trim() ?? "",
      category: input.category?.trim() ?? "",
      tags,
      closeAt,
      resolutionSource: input.resolutionSource,
      resolutionRules: input.resolutionRules,
      challengePeriod: input.challengePeriod,
      unitSats: input.unitSats,
      outcomes,
      maxShares: input.maxShares,
      status: "DRAFT",
      paused: false,
      sharesSold: 0,
      sharesReserved: 0,
      availableComplement: 0,
      reservedComplement: 0,
      lockedBacking: 0,
      residualSats: 0,
      proposal: null,
      finalOutcome: null,
    };
    this.markets.set(market.marketId, market);
    this.emit("market.drafted", market.marketId, {
      question: market.question,
      closeAt: market.closeAt,
      resolutionSource: market.resolutionSource,
      resolutionRules: market.resolutionRules,
      challengePeriod: market.challengePeriod,
      unitSats: market.unitSats,
      outcomes: market.outcomes.map((outcome) => ({ id: outcome.id, label: outcome.label, priceBps: outcome.priceBps })),
      tags: market.tags,
      maxShares: market.maxShares,
    });
    return this.toCatalog(market);
  }

  updateDraft(marketId: string, input: Partial<PublishInput>): CatalogMarket {
    const market = this.requireMarket(marketId);
    if (market.status !== "DRAFT") throw new Refusal("market is not a draft");
    if (input.question !== undefined) {
      requireText(input.question, "question");
      market.question = input.question;
    }
    if (input.description !== undefined) market.description = input.description.trim();
    if (input.category !== undefined) market.category = input.category.trim();
    if (input.tags !== undefined) market.tags = cleanTags(input.tags);
    if (input.closeAt !== undefined) {
      const closeAt = Date.parse(input.closeAt);
      if (!Number.isFinite(closeAt) || closeAt <= this.now()) throw new BadRequest("closeAt must be a future ISO-8601 time");
      market.closeAt = closeAt;
    }
    if (input.resolutionSource !== undefined) {
      requireText(input.resolutionSource, "resolutionSource");
      market.resolutionSource = input.resolutionSource;
    }
    if (input.resolutionRules !== undefined) {
      requireText(input.resolutionRules, "resolutionRules");
      market.resolutionRules = input.resolutionRules;
    }
    if (input.challengePeriod !== undefined) {
      if (!Number.isSafeInteger(input.challengePeriod) || input.challengePeriod <= 0) {
        throw new BadRequest("challengePeriod must be a positive integer number of seconds");
      }
      market.challengePeriod = input.challengePeriod;
    }
    if (input.unitSats !== undefined) {
      if (!Number.isSafeInteger(input.unitSats) || input.unitSats <= 0) throw new BadRequest("unitSats must be a positive integer");
      market.unitSats = input.unitSats;
    }
    if (input.outcomes !== undefined) {
      market.outcomes = assignOutcomes(input.outcomes, market.outcomes);
    } else if (input.yesPriceBps !== undefined || input.noPriceBps !== undefined) {
      market.outcomes = assignOutcomes(draftsFrom({
        yesPriceBps: input.yesPriceBps ?? priceOf(market, "YES"),
        noPriceBps: input.noPriceBps ?? priceOf(market, "NO"),
      }), market.outcomes);
    }
    if (input.maxShares !== undefined) {
      if (!Number.isSafeInteger(input.maxShares) || input.maxShares <= 0) throw new BadRequest("maxShares must be a positive integer");
      market.maxShares = input.maxShares;
    }
    this.emit("market.updated", market.marketId, {});
    return this.toCatalog(market);
  }

  submit(marketId: string): CatalogMarket {
    const market = this.requireMarket(marketId);
    if (market.status !== "DRAFT") throw new Refusal("market is not a draft");
    market.status = "REVIEW";
    this.emit("market.submitted", market.marketId, {});
    return this.toCatalog(market);
  }

  open(marketId: string): CatalogMarket {
    const market = this.requireMarket(marketId);
    if (market.status !== "REVIEW") throw new Refusal("market is not in review");
    if (market.closeAt <= this.now()) throw new BadRequest("closeAt must be in the future");
    assertPriceSum(market.outcomes);
    market.status = "OPEN";
    this.recordQuote(market);
    this.emit("market.opened", market.marketId, {});
    return this.toCatalog(market);
  }

  reject(marketId: string): CatalogMarket {
    const market = this.requireMarket(marketId);
    if (market.status !== "REVIEW") throw new Refusal("market is not in review");
    market.status = "DRAFT";
    this.emit("market.rejected", market.marketId, {});
    return this.toCatalog(market);
  }

  setQuote(marketId: string, prices: OutcomePrice[]): CatalogMarket {
    const market = this.requireMarket(marketId);
    if (market.status !== "OPEN") throw new Refusal("market is not open");
    if (prices.length !== market.outcomes.length) throw new BadRequest("prices must cover every outcome");
    const byId = new Map<string, number>();
    for (const price of prices) {
      if (byId.has(price.id)) throw new BadRequest("outcome id is repeated");
      requireBps(price.priceBps, "priceBps");
      byId.set(price.id, price.priceBps);
    }
    const next = market.outcomes.map((outcome) => {
      const priceBps = byId.get(outcome.id);
      if (priceBps === undefined) throw new BadRequest("prices must cover every outcome");
      return { ...outcome, priceBps };
    });
    assertPriceSum(next);
    market.outcomes = next;
    this.recordQuote(market);
    this.emit("market.quote_changed", market.marketId, {
      outcomes: next.map((outcome) => ({ id: outcome.id, priceBps: outcome.priceBps })),
    });
    return this.toCatalog(market);
  }

  pause(marketId: string): CatalogMarket {
    this.sweep();
    const market = this.requireMarket(marketId);
    if (market.status !== "OPEN") throw new Refusal("market is not open");
    market.paused = true;
    this.emit("market.paused", market.marketId, {});
    return this.toCatalog(market);
  }

  unpause(marketId: string): CatalogMarket {
    this.sweep();
    const market = this.requireMarket(marketId);
    if (market.status !== "OPEN") throw new Refusal("market is not open");
    market.paused = false;
    this.emit("market.unpaused", market.marketId, {});
    return this.toCatalog(market);
  }

  async postBacking(marketId: string, transactionId: string): Promise<{ marketId: string; availableComplementSats: number }> {
    this.sweep();
    const market = this.requireMarket(marketId);
    if (!transactionId) throw new BadRequest("transactionId is required");
    if (this.usedTx.has(transactionId)) throw new Refusal("transaction already used");
    const view = await this.rails.payment(transactionId);
    if (view.state !== "confirmed") throw new Refusal("complement payment is not confirmed");
    const amount = paidTo(view, this.merchantAddress);
    if (amount <= 0) throw new Refusal("complement payment is not to the merchant address");
    this.usedTx.add(transactionId);
    market.availableComplement += amount;
    this.emit("market.backing", market.marketId, { transactionId, amountSats: amount });
    return { marketId: market.marketId, availableComplementSats: market.availableComplement };
  }

  listMarkets(): CatalogMarket[] {
    this.sweep();
    return [...this.markets.values()]
      .filter((market) => market.status !== "DRAFT" && market.status !== "REVIEW")
      .map((market) => this.toCatalog(market));
  }

  listOperatorMarkets() {
    this.sweep();
    return [...this.markets.values()].map((market) => ({
      ...this.toCatalog(market),
      sharesSold: market.sharesSold,
      sharesReserved: market.sharesReserved,
      availableComplementSats: market.availableComplement,
    }));
  }

  listQuotes(marketId: string): QuotePoint[] {
    this.requirePublic(marketId);
    return this.quotes.filter((quote) => quote.marketId === marketId);
  }

  listEvents(marketId?: string): MarketEvent[] {
    const events = marketId ? this.events.filter((event) => event.marketId === marketId) : this.events;
    return [...events].reverse();
  }

  async listMyOrders(token: string): Promise<OrderView[]> {
    const wallet = await this.requireWallet(token);
    this.sweep();
    return [...this.orders.values()].filter((order) => order.wallet === wallet.address).map((order) => this.toOrder(order));
  }

  async listMyPositions(token: string) {
    const wallet = await this.requireWallet(token);
    const byMarket = this.positions.get(wallet.address);
    const rows = [];
    for (const [marketId, shares] of byMarket ?? []) {
      const market = this.markets.get(marketId);
      rows.push({
        marketId,
        question: market?.question ?? "",
        status: market?.status ?? "OPEN",
        shares,
        outcomes: (market?.outcomes ?? []).map((outcome) => ({ id: outcome.id, label: outcome.label })),
      });
    }
    return { wallet: wallet.address, positions: rows, payouts: this.payouts.filter((payout) => payout.to === wallet.address) };
  }

  ledger() {
    return { feeCredits: this.feeCredits, payouts: this.payouts };
  }

  getMarket(marketId: string): CatalogMarket {
    this.sweep();
    return this.toCatalog(this.requirePublic(marketId));
  }

  getResolution(marketId: string): ResolutionView {
    this.sweep();
    return this.toResolution(this.requirePublic(marketId));
  }

  async checkout(input: CheckoutInput): Promise<CheckoutResult> {
    console.log("checkout")
    const wallet = await this.requireWallet(input.token);
    this.sweep();
    if (typeof input.outcome !== "string" || input.outcome.trim() === "") throw new BadRequest("outcome is required");
    if (!Number.isSafeInteger(input.quantity) || input.quantity <= 0) {
      throw new BadRequest("quantity must be a positive integer");
    }
    if (!Number.isSafeInteger(input.maxPriceBps) || input.maxPriceBps < 0 || input.maxPriceBps > 10_000) {
      throw new BadRequest("maxPriceBps must be an integer from 0 to 10000");
    }
    if (input.paymentId || (input.quoteId && this.orders.get(input.quoteId)?.paymentId)) {
      return this.settle(input, wallet);
    }
    if (input.txId) return this.prove(input, wallet);
    if (input.quoteId) return this.replay(input, wallet);
    return this.quote(input, wallet);
  }

  async getOrder(token: string, quoteId: string): Promise<OrderView> {
    const wallet = await this.requireWallet(token);
    this.sweep();
    const order = this.orders.get(quoteId);
    if (!order || order.wallet !== wallet.address) throw new NotFound("order not found");
    if (order.status === "pending") {
      const result = order.paymentId ? await this.advanceRail(order, wallet) : await this.advance(order, wallet);
      if (result.http === 402) throw new Error("pending order returned a new quote");
      return result.order;
    }
    return this.toOrder(order);
  }

  propose(input: { marketId: string; outcome: Outcome; evidence: string }): ResolutionView {
    this.sweep();
    const market = this.requireMarket(input.marketId);
    if (market.status !== "CLOSED") throw new Refusal(market.status === "OPEN" ? "market is open" : "market is not closed");
    requireText(input.evidence, "evidence");
    if (!market.outcomes.some((outcome) => outcome.id === input.outcome)) throw new BadRequest("unknown outcome");
    const deadline = this.now() + market.challengePeriod * 1000;
    market.proposal = {
      outcome: input.outcome,
      evidence: input.evidence,
      source: market.resolutionSource,
      proposer: "oracle",
      challengeDeadline: deadline,
    };
    market.status = "PROPOSED";
    this.emit("resolution.proposed", market.marketId, {
      outcome: input.outcome,
      source: market.resolutionSource,
      proposer: "oracle",
      challengeDeadline: deadline,
    });
    return this.toResolution(market);
  }

  async challenge(token: string, input: { marketId: string; reason: string }): Promise<ResolutionView> {
    await this.requireWallet(token);
    this.sweep();
    const market = this.requireMarket(input.marketId);
    if (market.status !== "PROPOSED" || !market.proposal) throw new Refusal("market is not proposed");
    if (this.now() >= market.proposal.challengeDeadline) throw new Refusal("challenge window closed");
    requireText(input.reason, "reason");
    const voided = market.proposal;
    market.proposal = null;
    market.status = "CLOSED";
    this.emit("resolution.challenged", market.marketId, {
      outcome: voided.outcome,
      reason: input.reason,
      challengeDeadline: voided.challengeDeadline,
    });
    return this.toResolution(market);
  }

  finalize(marketId: string): ResolutionView {
    this.sweep();
    const market = this.requireMarket(marketId);
    if (market.status !== "PROPOSED" || !market.proposal) throw new Refusal("market is not proposed");
    if (this.now() < market.proposal.challengeDeadline) throw new Refusal("challenge window open");
    market.finalOutcome = market.proposal.outcome;
    market.finalizedAt = this.now();
    market.status = "FINALIZED";
    this.emit("resolution.finalized", market.marketId, { outcome: market.finalOutcome });
    market.status = "REDEEMABLE";
    return this.toResolution(market);
  }

  async redeem(
    token: string,
    input: { marketId: string; outcome?: Outcome; quantity?: number; wallet?: string },
  ): Promise<RedemptionView> {
    const wallet = await this.requireWallet(token);
    if (input.wallet && input.wallet !== wallet.address) throw new Refusal("wallet does not match");
    this.sweep();
    const market = this.requireMarket(input.marketId);
    if (market.status === "ARCHIVED") throw new Refusal("archived");
    if ((market.status !== "FINALIZED" && market.status !== "REDEEMABLE") || !market.finalOutcome) {
      throw new Refusal("market is not finalized");
    }
    const outcome = input.outcome ?? market.finalOutcome;
    if (!market.outcomes.some((row) => row.id === outcome)) throw new BadRequest("unknown outcome");
    const pos = this.ensurePosition(wallet.address, market.marketId);
    const quantity = input.quantity ?? pos[outcome] ?? 0;
    if (!Number.isSafeInteger(quantity) || quantity <= 0) throw new BadRequest("quantity must be a positive integer");
    if (quantity > (pos[outcome] ?? 0)) throw new Refusal("quantity exceeds share balance");

    const unitGross = market.unitSats * quantity;
    if (!Number.isSafeInteger(unitGross)) throw new BadRequest("amount too large");
    if (market.lockedBacking < unitGross) throw new Error("backing shortfall");
    market.lockedBacking -= unitGross;
    pos[outcome] = (pos[outcome] ?? 0) - quantity;

    const winning = outcome === market.finalOutcome;
    const grossSats = winning ? unitGross : 0;
    const fee = winning ? feeSats(unitGross) : 0;
    const payoutSats = winning ? unitGross - fee : 0;
    if (!winning) market.residualSats += unitGross;
    if (fee > 0) this.owe(FEE_ADDRESS, fee, market.marketId, "fee_sweep");
    if (payoutSats > 0) this.owe(wallet.address, payoutSats, market.marketId, "redemption", outcome, quantity);
    this.maybeArchive(market);
    this.emit("redemption.paid", market.marketId, {
      wallet: wallet.address,
      outcome,
      quantity,
      payoutSats,
      feeSats: fee,
    });
    return {
      marketId: market.marketId,
      wallet: wallet.address,
      outcome,
      quantity,
      grossSats,
      feeSats: fee,
      payoutSats,
      feeAddress: FEE_ADDRESS,
    };
  }

  private async quote(input: CheckoutInput, wallet: WalletBalance): Promise<CheckoutResult> {
    const market = this.marketForCheckout(input.marketId);
    const chosen = market.outcomes.find((outcome) => outcome.id === input.outcome);
    if (!chosen) throw new BadRequest("unknown outcome");
    const priceBps = chosen.priceBps;
    if (priceBps > input.maxPriceBps) throw new Refusal("price");
    if (market.sharesSold + market.sharesReserved + input.quantity > market.maxShares) {
      throw new Refusal("share cap");
    }
    let amounts;
    try {
      amounts = quoteAmounts(market.unitSats, priceBps, input.quantity);
    } catch (error) {
      if (error instanceof RangeError) throw new BadRequest(error.message);
      throw error;
    }
    if (amounts.complementSats > market.availableComplement) throw new Refusal("complement unavailable");
    this.assertSpendable(wallet, amounts.amountSats);

    const order: Order = {
      quoteId: randomUUID(),
      marketId: market.marketId,
      outcome: input.outcome,
      quantity: input.quantity,
      maxPriceBps: input.maxPriceBps,
      priceBps,
      shareCostSats: amounts.shareCostSats,
      complementSats: amounts.complementSats,
      feeSats: amounts.feeSats,
      amountSats: amounts.amountSats,
      address: this.merchantAddress,
      wallet: wallet.address,
      status: "quoted",
      expiresAt: this.now() + this.quoteTtlMs,
      createdAt: this.now(),
      capConsumed: false,
      held: true,
    };
    market.sharesReserved += order.quantity;
    market.availableComplement -= order.complementSats;
    market.reservedComplement += order.complementSats;
    this.orders.set(order.quoteId, order);
    if (this.payments) {
      try {
        const created = await this.payments.create({
          externalId: order.quoteId,
          amountSats: order.amountSats,
          ttlSeconds: Math.max(1, Math.ceil(this.quoteTtlMs / 1000)),
          description: order.quoteId,
        });
        if (created.amountSats < order.amountSats) {
          this.refuse(order, "payment amount");
          throw new Refusal("payment amount");
        }
        this.assertSpendable(wallet, created.amountSats);
        order.paymentId = created.paymentId;
        order.address = created.address;
        order.checkoutUrl = created.checkoutUrl;
        order.qrString = created.qrString;
        order.billedSats = created.amountSats;
      } catch (error) {
        if (order.status === "quoted") this.refuse(order, error instanceof Refusal ? error.message : "payment unavailable");
        throw error;
      }
    }
    return { http: 402, payment: this.toPayment(order) };
  }

  private async settle(input: CheckoutInput, wallet: WalletBalance): Promise<CheckoutResult> {
    console.log("settle")
    const order = this.orderFor(input, wallet);
    if (input.paymentId && order.paymentId && input.paymentId !== order.paymentId) throw new Refusal("payment does not match");
    if (order.status === "filled") return { http: 200, order: this.toOrder(order) };
    if (order.status === "expired") throw new Refusal("expired");
    if (order.status === "refused") throw new Refusal(order.reason ?? "refused");
    return this.advanceRail(order, wallet);
  }

  private async advanceRail(order: Order, wallet: WalletBalance): Promise<CheckoutResult> {
    console.log("advanceRail")
    if (!this.payments || !order.paymentId) throw new Refusal("payment missing");
    if (order.status === "filled") return { http: 200, order: this.toOrder(order) };
    const payment = await this.payments.status(order.paymentId);
    if (payment.state === "detected") {
      this.acceptPayment(order, wallet);
      return { http: 202, order: this.toOrder(order) };
    }
    if (payment.state === "failed" || payment.state === "expired" || payment.state === "canceled") {
      this.refuse(order, payment.state);
      throw new Refusal(payment.state);
    }
    if (payment.state === "paid" || payment.state === "cleared") {
      if (payment.paidSats < order.amountSats) {
        this.refuse(order, "payment does not match");
        throw new Refusal("payment does not match");
      }
      this.acceptPayment(order, wallet);
      if (payment.txids[0]) order.txId = payment.txids[0];
      this.fill(order);
      return { http: 200, order: this.toOrder(order) };
    }
    return { http: 402, payment: this.toPayment(order) };
  }

  async settleExternal(externalId: string): Promise<void> {
    const order = this.orders.get(externalId);
    if (!order?.paymentId) return;
    if (order.status === "filled" || order.status === "refused" || order.status === "expired") return;
    const wallet: WalletBalance = {
      address: order.wallet,
      availableSats: order.billedSats ?? order.amountSats,
      committedSats: 0,
      maxSatsPerTx: order.billedSats ?? order.amountSats,
      dailySats: order.billedSats ?? order.amountSats,
    };
    try {
      await this.advanceRail(order, wallet);
    } catch (error) {
      if (error instanceof Refusal) return;
      throw error;
    }
  }

  verifyWebhook(rawBody: string, signature: string | undefined): boolean {
    return this.payments?.verifyWebhook(rawBody, signature) ?? false;
  }

  private replay(input: CheckoutInput, wallet: WalletBalance): CheckoutResult {
    const order = this.orderFor(input, wallet);
    if (order.status === "expired") throw new Refusal("expired");
    if (order.status === "refused") throw new Refusal(order.reason ?? "refused");
    if (order.status === "quoted") return { http: 402, payment: this.toPayment(order) };
    return { http: order.status === "pending" ? 202 : 200, order: this.toOrder(order) };
  }

  private async prove(input: CheckoutInput, wallet: WalletBalance): Promise<CheckoutResult> {
    const order = input.quoteId
      ? this.orderFor(input, wallet)
      : this.latestQuoted(input, wallet);
    if (order.status === "filled") return { http: 200, order: this.toOrder(order) };
    if (order.status === "expired") throw new Refusal("expired");
    if (order.status === "refused") throw new Refusal(order.reason ?? "refused");
    if (order.txId && order.txId !== input.txId) return this.alreadySubmitted(order);
    if (!order.txId && input.txId && this.usedTx.has(input.txId)) throw new Refusal("transaction already used");
    const previous = order.txId;
    order.txId = input.txId;
    try {
      return await this.advance(order, wallet);
    } catch (error) {
      if (order.status === "quoted") order.txId = previous;
      throw error;
    }
  }

  private alreadySubmitted(order: Order): CheckoutResult {
    if (order.status === "pending") return { http: 202, order: this.toOrder(order) };
    if (order.status === "filled") return { http: 200, order: this.toOrder(order) };
    throw new Refusal(order.reason ?? order.status);
  }

  private async advance(order: Order, wallet: WalletBalance): Promise<CheckoutResult> {
    if (!order.txId) throw new Refusal("payment missing");
    const view = await this.rails.payment(order.txId);
    if (order.status === "filled") return { http: 200, order: this.toOrder(order) };
    if (order.status === "expired" || order.status === "refused") {
      throw new Refusal(order.reason ?? order.status);
    }
    if (view.state === "missing") throw new Refusal("payment missing");
    if (view.state === "rejected") {
      this.usedTx.add(order.txId);
      this.refuse(order, "payment rejected");
      throw new Refusal("payment rejected");
    }
    if (view.state === "seen") {
      this.acceptPayment(order, wallet);
      return { http: 202, order: this.toOrder(order) };
    }
    this.acceptPayment(order, wallet);
    this.assertPaid(order, view);
    this.fill(order);
    return { http: 200, order: this.toOrder(order) };
  }

  private acceptPayment(order: Order, wallet: WalletBalance): void {
    if (order.status !== "quoted" && order.status !== "pending") return;
    if (!order.capConsumed) {
      if (order.amountSats > wallet.maxSatsPerTx) {
        this.refuse(order, "per-transaction cap");
        throw new Refusal("per-transaction cap");
      }
      const spent = this.spentLastDay(order.wallet, order.quoteId);
      if (order.amountSats > wallet.dailySats - spent) {
        this.refuse(order, "daily cap");
        throw new Refusal("daily cap");
      }
      order.capConsumed = true;
      order.paidAt = this.now();
    }
    if (order.txId) this.usedTx.add(order.txId);
    if (order.status === "quoted") order.status = "pending";
  }

  private assertPaid(order: Order, view: Extract<PaymentView, { state: "confirmed" }>): void {
    const fromWallet = view.from.length > 0 && view.from.every((address) => address === order.wallet);
    const paid = paidTo(view, order.address);
    if (!fromWallet || paid !== order.amountSats) {
      this.refuse(order, "payment does not match");
      throw new Refusal("payment does not match");
    }
  }

  private fill(order: Order): void {
    if (order.status === "filled") return;
    const market = this.requireMarket(order.marketId);
    if (order.held) {
      market.sharesReserved -= order.quantity;
      market.reservedComplement -= order.complementSats;
      order.held = false;
    }
    market.sharesSold += order.quantity;
    market.lockedBacking += order.shareCostSats + order.complementSats;
    const chosen = market.outcomes.find((outcome) => outcome.id === order.outcome);
    if (chosen) chosen.tradedSats += order.shareCostSats;
    const position = this.ensurePosition(order.wallet, order.marketId);
    position[order.outcome] = (position[order.outcome] ?? 0) + order.quantity;
    if (order.feeSats > 0) this.owe(FEE_ADDRESS, order.feeSats, order.marketId, "fee_sweep");
    order.status = "filled";
    this.emit("order.filled", order.marketId, {
      quoteId: order.quoteId,
      wallet: order.wallet,
      outcome: order.outcome,
      quantity: order.quantity,
      feeSats: order.feeSats,
    });
  }

  private orderFor(input: CheckoutInput, wallet: WalletBalance): Order {
    const order = input.quoteId ? this.orders.get(input.quoteId) : undefined;
    if (!order) throw new Refusal("no quote");
    this.sameRequest(order, input, wallet);
    return order;
  }

  private latestQuoted(input: CheckoutInput, wallet: WalletBalance): Order {
    let found: Order | undefined;
    for (const order of this.orders.values()) {
      if (order.wallet !== wallet.address || order.marketId !== input.marketId) continue;
      if (order.outcome !== input.outcome || order.quantity !== input.quantity) continue;
      if (order.maxPriceBps !== input.maxPriceBps) continue;
      if (!found || order.createdAt > found.createdAt) found = order;
    }
    if (!found) throw new Refusal("no quote");
    return found;
  }

  private sameRequest(order: Order, input: CheckoutInput, wallet: WalletBalance): void {
    if (
      order.wallet !== wallet.address ||
      order.marketId !== input.marketId ||
      order.outcome !== input.outcome ||
      order.quantity !== input.quantity ||
      order.maxPriceBps !== input.maxPriceBps
    ) {
      throw new Refusal("quote does not match");
    }
  }

  private marketForCheckout(marketId: string): Market {
    const market = this.markets.get(marketId);
    if (!market) throw new Refusal("market not found");
    if (market.status !== "OPEN") throw new Refusal("closed");
    if (market.paused) throw new Refusal("paused");
    return market;
  }

  private assertSpendable(wallet: WalletBalance, amountSats: number): void {
    if (amountSats > wallet.maxSatsPerTx) throw new Refusal("per-transaction cap");
    if (amountSats > wallet.dailySats - this.spentLastDay(wallet.address)) throw new Refusal("daily cap");
    if (amountSats > wallet.availableSats) throw new Refusal("available balance");
  }

  private spentLastDay(address: string, exceptQuoteId?: string): number {
    const start = this.now() - DAY_MS;
    let spent = 0;
    for (const order of this.orders.values()) {
      if (order.quoteId === exceptQuoteId || order.wallet !== address || !order.capConsumed) continue;
      if (order.paidAt === undefined || order.paidAt < start) continue;
      if (order.status === "pending" || order.status === "filled") spent += order.amountSats;
    }
    return spent;
  }

  private refuse(order: Order, reason: string): void {
    if (order.status === "filled" || order.status === "refused" || order.status === "expired") return;
    this.releaseHold(order);
    order.capConsumed = false;
    order.status = "refused";
    order.reason = reason;
  }

  private expire(order: Order): void {
    if (order.status !== "quoted") return;
    this.releaseHold(order);
    order.status = "expired";
    order.reason = "expired";
  }

  private releaseHold(order: Order): void {
    if (!order.held) return;
    const market = this.markets.get(order.marketId);
    if (market) {
      market.sharesReserved -= order.quantity;
      market.reservedComplement -= order.complementSats;
      market.availableComplement += order.complementSats;
    }
    order.held = false;
  }

  private sweep(): void {
    for (const market of this.markets.values()) {
      if (market.status === "OPEN" && this.now() >= market.closeAt) {
        market.status = "CLOSED";
        this.emit("market.closed", market.marketId, {});
        for (const order of this.orders.values()) {
          if (order.marketId === market.marketId && order.status === "quoted") this.refuse(order, "closed");
        }
      }
    }
    for (const order of this.orders.values()) {
      if (order.status === "quoted" && this.now() >= order.expiresAt) this.expire(order);
    }
    for (const market of this.markets.values()) this.maybeArchive(market);
  }

  private async requireWallet(token: string): Promise<WalletBalance> {
    const wallet = token ? await this.rails.balance(token) : null;
    if (!wallet || !isNativeSegwit(wallet.address)) throw new Unauthorized();
    return wallet;
  }

  private requireMarket(marketId: string): Market {
    const market = this.markets.get(marketId);
    if (!market) throw new NotFound("market not found");
    return market;
  }

  private requirePublic(marketId: string): Market {
    const market = this.requireMarket(marketId);
    if (market.status === "DRAFT" || market.status === "REVIEW") throw new NotFound("market not found");
    return market;
  }

  private ensurePosition(wallet: string, marketId: string): ShareBalance {
    let byMarket = this.positions.get(wallet);
    if (!byMarket) {
      byMarket = new Map();
      this.positions.set(wallet, byMarket);
    }
    let position = byMarket.get(marketId);
    if (!position) {
      position = this.emptyShares(marketId);
      byMarket.set(marketId, position);
    }
    for (const outcome of this.markets.get(marketId)?.outcomes ?? []) {
      if (position[outcome.id] === undefined) position[outcome.id] = 0;
    }
    return position;
  }

  private emptyShares(marketId: string): ShareBalance {
    const shares: ShareBalance = {};
    for (const outcome of this.markets.get(marketId)?.outcomes ?? []) shares[outcome.id] = 0;
    return shares;
  }

  private readPosition(wallet: string, marketId: string): ShareBalance {
    const shares = this.emptyShares(marketId);
    const stored = this.positions.get(wallet)?.get(marketId);
    if (stored) {
      for (const [id, quantity] of Object.entries(stored)) shares[id] = quantity;
    }
    return shares;
  }

  private owe(
    to: string,
    amountSats: number,
    marketId: string,
    reason: "redemption" | "fee_sweep",
    outcome?: Outcome,
    quantity?: number,
  ): void {
    if (amountSats <= 0) return;
    this.payouts.push({
      id: randomUUID(),
      to,
      amountSats,
      marketId,
      reason,
      status: "owed",
      at: new Date(this.now()).toISOString(),
      outcome,
      quantity,
    });
  }

  listPayouts(status?: PayoutStatus) {
    return status ? this.payouts.filter((payout) => payout.status === status) : [...this.payouts];
  }

  async markPayoutSent(id: string, transactionId: string): Promise<Payout> {
    const payout = this.payouts.find((row) => row.id === id);
    if (!payout) throw new NotFound("payout not found");
    if (payout.status === "confirmed") return payout;
    if (this.usedPayoutTx.has(transactionId) && payout.transactionId !== transactionId) {
      throw new Refusal("transaction already used");
    }
    const view = await this.rails.payment(transactionId);
    if (view.state === "missing") throw new Refusal("not confirmed");
    if (view.state === "rejected") throw new Refusal("payment rejected");
    if (paidTo(view, payout.to) < payout.amountSats) throw new Refusal("payment does not match");
    payout.transactionId = transactionId;
    payout.status = view.state === "confirmed" ? "confirmed" : "sent";
    this.usedPayoutTx.add(transactionId);
    const market = this.markets.get(payout.marketId);
    if (market) this.maybeArchive(market);
    return payout;
  }

  archive(marketId: string): CatalogMarket {
    const market = this.requireMarket(marketId);
    if (market.status !== "REDEEMABLE") throw new Refusal("not redeemable");
    if (market.finalizedAt === undefined || this.now() < market.finalizedAt + this.redemptionWindowMs) {
      throw new Refusal("redemption window open");
    }
    market.status = "ARCHIVED";
    this.emit("market.archived", market.marketId, { unclaimed: this.outstanding(market) });
    return this.toCatalog(market);
  }

  private maybeArchive(market: Market): void {
    if (market.status !== "REDEEMABLE" || !market.finalOutcome) return;
    if (this.outstanding(market) > 0) return;
    if (this.payouts.some((payout) => payout.marketId === market.marketId && payout.status !== "confirmed")) return;
    market.status = "ARCHIVED";
    this.emit("market.archived", market.marketId, {});
  }

  private outstanding(market: Market): number {
    if (!market.finalOutcome) return 0;
    let shares = 0;
    for (const byMarket of this.positions.values()) {
      shares += byMarket.get(market.marketId)?.[market.finalOutcome] ?? 0;
    }
    return shares;
  }

  private toCatalog(market: Market): CatalogMarket {
    return {
      marketId: market.marketId,
      question: market.question,
      description: market.description,
      category: market.category,
      closeAt: new Date(market.closeAt).toISOString(),
      resolutionSource: market.resolutionSource,
      resolutionRules: market.resolutionRules,
      challengePeriod: market.challengePeriod,
      unitSats: market.unitSats,
      tags: market.tags,
      outcomes: market.outcomes.map((outcome) => ({ ...outcome })),
      tradedSats: market.outcomes.reduce((sum, outcome) => sum + outcome.tradedSats, 0),
      maxShares: market.maxShares,
      sharesAvailable: market.maxShares - market.sharesSold - market.sharesReserved,
      status: market.status,
      paused: market.paused,
    };
  }

  private toResolution(market: Market): ResolutionView {
    return {
      marketId: market.marketId,
      status: market.status,
      resolutionSource: market.resolutionSource,
      resolutionRules: market.resolutionRules,
      proposal: market.proposal ? this.toProposal(market.proposal) : null,
      finalOutcome: market.finalOutcome,
    };
  }

  private toProposal(proposal: Proposal): ProposalView {
    return {
      outcome: proposal.outcome,
      evidence: proposal.evidence,
      source: proposal.source,
      proposer: proposal.proposer,
      challengeDeadline: new Date(proposal.challengeDeadline).toISOString(),
    };
  }

  private toPayment(order: Order): PaymentRequired {
    return {
      shareCostSats: order.shareCostSats,
      feeSats: order.feeSats,
      amountSats: order.billedSats ?? order.amountSats,
      priceBps: order.priceBps,
      address: order.address,
      feeAddress: FEE_ADDRESS,
      quoteId: order.quoteId,
      expiresAt: new Date(order.expiresAt).toISOString(),
      paymentId: order.paymentId,
      checkoutUrl: order.checkoutUrl,
      qrString: order.qrString,
    };
  }

  private toOrder(order: Order): OrderView {
    const view: OrderView = {
      quoteId: order.quoteId,
      marketId: order.marketId,
      outcome: order.outcome,
      quantity: order.quantity,
      priceBps: order.priceBps,
      maxPriceBps: order.maxPriceBps,
      shareCostSats: order.shareCostSats,
      feeSats: order.feeSats,
      amountSats: order.amountSats,
      address: order.address,
      feeAddress: FEE_ADDRESS,
      wallet: order.wallet,
      status: order.status,
      expiresAt: new Date(order.expiresAt).toISOString(),
      shares: { ...this.readPosition(order.wallet, order.marketId) },
    };
    if (order.txId) view.transactionId = order.txId;
    if (order.reason) view.reason = order.reason;
    return view;
  }

  private recordQuote(market: Market): void {
    this.quotes.push({
      marketId: market.marketId,
      outcomes: market.outcomes.map((outcome) => ({ id: outcome.id, priceBps: outcome.priceBps })),
      at: new Date(this.now()).toISOString(),
    });
  }

  snapshot() {
    return {
      markets: [...this.markets.values()],
      orders: [...this.orders.values()],
      positions: [...this.positions.entries()].map(([wallet, markets]) => ({
        wallet,
        markets: [...markets.entries()],
      })),
      usedTx: [...this.usedTx],
      usedPayoutTx: [...this.usedPayoutTx],
      events: this.events,
      feeCredits: this.feeCredits,
      payouts: this.payouts,
      quotes: this.quotes,
    };
  }

  restore(body: (Omit<ReturnType<MarketService["snapshot"]>, "markets" | "quotes"> & {
    markets: Array<Market | (Omit<Market, "outcomes" | "tags"> & { yesPriceBps: number; noPriceBps: number; tags?: string[]; outcomes?: StoredOutcome[] })>;
    quotes: Array<QuotePoint | { marketId: string; yesPriceBps: number; noPriceBps: number; at: string; outcomes?: OutcomePrice[] }>;
  }) | null): void {
    this.markets.clear();
    this.orders.clear();
    this.positions.clear();
    this.usedTx.clear();
    this.usedPayoutTx.clear();
    this.events.length = 0;
    this.feeCredits.length = 0;
    this.payouts.length = 0;
    this.quotes.length = 0;
    if (!body) return;
    for (const market of body.markets) {
      const normalized = normalizeMarket(market);
      this.markets.set(normalized.marketId, normalized);
    }
    for (const order of body.orders) this.orders.set(order.quoteId, order);
    for (const row of body.positions) this.positions.set(row.wallet, new Map(row.markets));
    for (const txId of body.usedTx) this.usedTx.add(txId);
    for (const txId of body.usedPayoutTx ?? []) this.usedPayoutTx.add(txId);
    this.events.push(...body.events);
    this.feeCredits.push(...body.feeCredits);
    this.payouts.push(...body.payouts);
    this.quotes.push(...body.quotes.map((quote) => normalizeQuote(quote)));
  }

  private emit(type: string, marketId: string, payload: Record<string, unknown>): void {
    this.events.push({
      id: randomUUID(),
      type,
      marketId,
      at: new Date(this.now()).toISOString(),
      payload,
    });
  }
}

function draftsFrom(input: { outcomes?: OutcomeDraft[]; yesPriceBps?: number; noPriceBps?: number }): OutcomeDraft[] {
  if (input.outcomes && input.outcomes.length > 0) return input.outcomes;
  if (input.yesPriceBps !== undefined || input.noPriceBps !== undefined) {
    requireBps(input.yesPriceBps ?? Number.NaN, "yesPriceBps");
    requireBps(input.noPriceBps ?? Number.NaN, "noPriceBps");
    return [
      { label: "Yes", priceBps: input.yesPriceBps as number },
      { label: "No", priceBps: input.noPriceBps as number },
    ];
  }
  throw new BadRequest("outcomes are required");
}

function priceOf(market: Market, id: string): number {
  return market.outcomes.find((outcome) => outcome.id === id)?.priceBps ?? 0;
}

function assignOutcomes(drafts: OutcomeDraft[], existing: StoredOutcome[] = []): StoredOutcome[] {
  if (!Array.isArray(drafts) || drafts.length < 2 || drafts.length > 16) {
    throw new BadRequest("outcomes must be between 2 and 16");
  }
  const used = new Set<string>();
  const labels = new Set<string>();
  const next: StoredOutcome[] = [];
  for (const draft of drafts) {
    const label = typeof draft.label === "string" ? draft.label.trim() : "";
    if (!label) throw new BadRequest("outcome label is required");
    const key = label.toLowerCase();
    if (labels.has(key)) throw new BadRequest("outcome labels must be unique");
    labels.add(key);
    requireBps(draft.priceBps, "priceBps");
    const kept = draft.id && existing.some((outcome) => outcome.id === draft.id) ? draft.id : undefined;
    let id = kept && !used.has(kept) ? kept : outcomeId(label, used);
    if (used.has(id)) id = outcomeId(label, used);
    used.add(id);
    const prior = existing.find((outcome) => outcome.id === id);
    next.push({ id, label, priceBps: draft.priceBps, tradedSats: prior?.tradedSats ?? 0 });
  }
  assertPriceSum(next);
  return next;
}

function outcomeId(label: string, used: Set<string>): string {
  const classic = label.toLowerCase();
  if (classic === "yes" && !used.has("YES")) return "YES";
  if (classic === "no" && !used.has("NO")) return "NO";
  const base = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "outcome";
  let id = base;
  let n = 2;
  while (used.has(id)) id = `${base}-${n++}`;
  return id;
}

function assertPriceSum(outcomes: { priceBps: number }[]): void {
  const sum = outcomes.reduce((total, outcome) => total + outcome.priceBps, 0);
  if (sum !== 10_000) throw new BadRequest("prices must sum to 10000");
}

function cleanTags(tags: string[] | undefined): string[] {
  if (!tags) return [];
  if (!Array.isArray(tags)) throw new BadRequest("tags must be a list");
  const cleaned: string[] = [];
  const seen = new Set<string>();
  for (const tag of tags) {
    if (typeof tag !== "string") throw new BadRequest("tags must be text");
    const value = tag.trim();
    if (!value) continue;
    if (value.length > 32) throw new BadRequest("tag is too long");
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    cleaned.push(value);
  }
  if (cleaned.length > 8) throw new BadRequest("too many tags");
  return cleaned;
}

function normalizeMarket(raw: Market | (Omit<Market, "outcomes" | "tags"> & { yesPriceBps?: number; noPriceBps?: number; tags?: string[]; outcomes?: StoredOutcome[] })): Market {
  const tags = Array.isArray(raw.tags) ? raw.tags : [];
  if (Array.isArray(raw.outcomes) && raw.outcomes.length > 0) {
    const { yesPriceBps: _yes, noPriceBps: _no, ...rest } = raw as Market & { yesPriceBps?: number; noPriceBps?: number };
    return {
      ...rest,
      tags,
      outcomes: raw.outcomes.map((outcome) => ({
        id: outcome.id,
        label: outcome.label,
        priceBps: outcome.priceBps,
        tradedSats: outcome.tradedSats ?? 0,
      })),
    };
  }
  const legacy = raw as { yesPriceBps?: number; noPriceBps?: number };
  const { yesPriceBps: _yes, noPriceBps: _no, outcomes: _outcomes, ...rest } = raw as Market & { yesPriceBps?: number; noPriceBps?: number };
  return {
    ...rest,
    tags,
    outcomes: [
      { id: "YES", label: "Yes", priceBps: legacy.yesPriceBps ?? 0, tradedSats: 0 },
      { id: "NO", label: "No", priceBps: legacy.noPriceBps ?? 0, tradedSats: 0 },
    ],
  };
}

function normalizeQuote(raw: QuotePoint | { marketId: string; yesPriceBps?: number; noPriceBps?: number; at: string; outcomes?: OutcomePrice[] }): QuotePoint {
  if (Array.isArray(raw.outcomes) && raw.outcomes.length > 0) {
    return { marketId: raw.marketId, at: raw.at, outcomes: raw.outcomes.map((outcome) => ({ id: outcome.id, priceBps: outcome.priceBps })) };
  }
  const legacy = raw as { yesPriceBps?: number; noPriceBps?: number };
  return {
    marketId: raw.marketId,
    at: raw.at,
    outcomes: [
      { id: "YES", priceBps: legacy.yesPriceBps ?? 0 },
      { id: "NO", priceBps: legacy.noPriceBps ?? 0 },
    ],
  };
}

function requireText(value: string, name: string): void {
  if (typeof value !== "string" || value.trim() === "") throw new BadRequest(`${name} is required`);
}

function requireBps(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > 10_000) {
    throw new BadRequest(`${name} must be an integer from 0 to 10000`);
  }
}

function paidTo(view: Extract<PaymentView, { state: "seen" | "confirmed" }>, address: string): number {
  return view.outputs.reduce((sum, output) => sum + (output.address === address ? output.amountSats : 0), 0);
}
