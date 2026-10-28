import { UpstreamError, type PaymentView, type TxOutput } from "./types.ts";

type MempoolTx = {
  status?: { confirmed?: boolean };
  vin?: { prevout?: { scriptpubkey_address?: string } | null }[];
  vout?: { scriptpubkey_address?: string; value?: number }[];
};

export class MempoolPayments {
  private readonly baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl;
  }

  async payment(txId: string): Promise<PaymentView> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl.replace(/\/$/, "")}/tx/${encodeURIComponent(txId)}`, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(10_000),
      });
    } catch (error) {
      throw new UpstreamError(error instanceof Error ? error.message : "mempool lookup failed");
    }
    if (res.status === 404) return { state: "missing" };
    if (!res.ok) throw new UpstreamError(`mempool ${res.status}`);
    const tx = (await res.json()) as MempoolTx;
    const from = (tx.vin ?? []).map((input) => input.prevout?.scriptpubkey_address ?? "");
    const outputs: TxOutput[] = [];
    for (const output of tx.vout ?? []) {
      const amountSats = output.value;
      if (!output.scriptpubkey_address || typeof amountSats !== "number" || !Number.isSafeInteger(amountSats)) continue;
      outputs.push({ address: output.scriptpubkey_address, amountSats });
    }
    const state = tx.status?.confirmed ? "confirmed" : "seen";
    return { state, from, outputs };
  }
}
