import { createHmac, timingSafeEqual } from "node:crypto";
import { UpstreamError, type CreatedPayment, type PaymentRail, type RailPayment, type RailPaymentState } from "./types.ts";

const STATES = new Set(["initiated", "detected", "paid", "failed", "expired", "canceled", "cleared"]);

type Success = Record<string, unknown>;

/**
 * Merchant payments from GoBTC Pay wallet API v1.2.
 * `currency` stays BTC: amount is `amountSats / 1e8`. A live merchant account
 * is still required to confirm the gateway accepts that pair for an exact satoshi total.
 */
export class GobtcPay implements PaymentRail {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly webhookSecret: string;
  private readonly currency: string;

  constructor(options: { baseUrl: string; token: string; webhookSecret: string; currency?: string }) {
    this.baseUrl = options.baseUrl;
    this.token = options.token;
    this.webhookSecret = options.webhookSecret;
    this.currency = options.currency ?? "BTC";
  }

  async create(input: { externalId: string; amountSats: number; ttlSeconds: number; description: string }): Promise<CreatedPayment> {
    if (this.currency !== "BTC") throw new UpstreamError("GoBTC Pay currency must be BTC");
    const success = await this.post("/merchant/payment/create", {
      amount: input.amountSats / 100_000_000,
      currency: this.currency,
      externalId: input.externalId,
      ttlSeconds: input.ttlSeconds,
      description: input.description,
    });
    const amountSats = integerString(success.amountSats);
    return {
      paymentId: text(success.paymentId),
      amountSats,
      address: text(success.btcAddress),
      expiresAt: unixToIso(success.expiresAt),
      checkoutUrl: text(success.checkoutUrl),
      qrString: text(success.qrString),
    };
  }

  async status(paymentId: string): Promise<RailPayment> {
    const success = await this.post("/merchant/payment/get", { paymentId }, false);
    const state = text(success.status);
    if (!STATES.has(state)) throw new UpstreamError("unexpected payment status");
    const transactions = Array.isArray(success.transactions) ? success.transactions : [];
    const paidFromTx = transactions.reduce((sum, row) => {
      const record = row as Record<string, unknown>;
      return sum + integerString(record.amountSats);
    }, 0);
    const paidSats = paidFromTx > 0 ? paidFromTx : (state === "paid" || state === "cleared" ? integerString(success.amountSats) : 0);
    return {
      state: state as RailPaymentState,
      paidSats,
      txids: transactions.map((row) => text((row as Record<string, unknown>).txid)).filter(Boolean),
    };
  }

  verifyWebhook(rawBody: string, signature: string | undefined): boolean {
    if (!signature || !this.webhookSecret) return false;
    const given = signature.replace(/^sha256=/, "").trim();
    const expected = createHmac("sha256", this.webhookSecret).update(rawBody).digest("hex");
    const left = Buffer.from(given);
    const right = Buffer.from(expected);
    return left.length === right.length && timingSafeEqual(left, right);
  }

  private async post(path: string, body: unknown, authorized = true): Promise<Success> {
    let res: Response;
    try {
      res = await fetch(new URL(path, this.baseUrl), {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          ...(authorized ? { authorization: `Bearer ${this.token}` } : {}),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (error) {
      throw new UpstreamError(error instanceof Error ? error.message : "gobtc pay failed");
    }
    const payload = await res.json().catch(() => ({})) as { result?: { success?: Success }; error?: { description?: string } };
    if (!res.ok || !payload.result?.success) {
      throw new UpstreamError(payload.error?.description ?? `gobtc pay ${res.status}`);
    }
    return payload.result.success;
  }
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function integerString(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function unixToIso(value: unknown): string {
  const seconds = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(seconds)) return new Date(0).toISOString();
  return new Date(seconds * 1000).toISOString();
}
