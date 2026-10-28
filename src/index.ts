import pg from "pg";
import { AgnicBalances } from "./agnic.ts";
import { FEE_ADDRESS, isNativeSegwit } from "./fee.ts";
import { GobtcPay } from "./gobtcpay.ts";
import { createApp } from "./http.ts";
import { MempoolPayments } from "./mempool.ts";
import { createPersistingScope } from "./persist.ts";
import { MarketService } from "./service.ts";
import type { PaymentView, Rails, WalletBalance } from "./types.ts";

/**
 * OPERATOR_TOKEN, ORACLE_TOKEN, and MERCHANT_ADDRESS are required.
 * PORT defaults to 8787.
 * AGNIC_API_BASE defaults to https://api.agnic.ai.
 * MEMPOOL_API_BASE defaults to https://mempool.space/api.
 */
const operatorToken = required("OPERATOR_TOKEN");
const oracleToken = required("ORACLE_TOKEN");
const merchantAddress = required("MERCHANT_ADDRESS");
if (!isNativeSegwit(merchantAddress)) {
  throw new Error("MERCHANT_ADDRESS must be a mainnet native SegWit address");
}

const balances = new AgnicBalances(process.env.AGNIC_API_BASE ?? "https://api.agnic.ai");
const payments = new MempoolPayments(process.env.MEMPOOL_API_BASE ?? "https://mempool.space/api");
const rails: Rails = {
  balance(token: string): Promise<WalletBalance | null> {
    return balances.balance(token);
  },
  payment(txId: string): Promise<PaymentView> {
    return payments.payment(txId);
  },
};

const service = new MarketService({
  rails,
  merchantAddress,
  payments: process.env.GOBTCPAY_MERCHANT_TOKEN
    ? new GobtcPay({
        baseUrl: process.env.GOBTCPAY_API_BASE ?? "https://api.gobtcpay.com",
        token: process.env.GOBTCPAY_MERCHANT_TOKEN,
        webhookSecret: process.env.GOBTCPAY_WEBHOOK_SECRET ?? "",
        currency: process.env.GOBTCPAY_CURRENCY ?? "BTC",
      })
    : undefined,
  redemptionWindowMs: Number(process.env.REDEMPTION_WINDOW_DAYS ?? 90) * 86_400_000,
});
const pool = process.env.DATABASE_URL ? new pg.Pool({ connectionString: process.env.DATABASE_URL }) : undefined;
const server = createApp(service, {
  operatorToken,
  oracleToken,
  webOrigin: process.env.WEB_ORIGIN,
  scope: pool ? createPersistingScope(pool, service) : undefined,
});
const port = Number(process.env.PORT ?? 8787);

server.listen(port, () => {
  console.log(`bazaar-agnic listening on ${port}`);
  console.log(`fee address ${FEE_ADDRESS}`);
});

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
