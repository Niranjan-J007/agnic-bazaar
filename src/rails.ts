import type { PaymentView, Rails, WalletBalance } from "./types.ts";

export class InMemoryRails implements Rails {
  readonly balances = new Map<string, WalletBalance>();
  readonly payments = new Map<string, PaymentView>();

  async balance(token: string): Promise<WalletBalance | null> {
    return this.balances.get(token) ?? null;
  }

  async payment(txId: string): Promise<PaymentView> {
    return this.payments.get(txId) ?? { state: "missing" };
  }
}
