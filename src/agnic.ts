import { UpstreamError, type WalletBalance } from "./types.ts";

type BalanceBody = {
  has_wallet?: boolean;
  multisig_address?: string;
  available_sats?: number;
  committed_sats?: number;
  max_sats_per_tx?: number;
  daily_sats?: number;
};

export class AgnicBalances {
  private readonly baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl;
  }

  async balance(token: string): Promise<WalletBalance | null> {
    let res: Response;
    try {
      res = await fetch(new URL("/api/bitcoin/balance", this.baseUrl), {
        headers: {
          accept: "application/json",
          authorization: `Bearer ${token}`,
        },
        signal: AbortSignal.timeout(10_000),
      });
    } catch (error) {
      throw new UpstreamError(error instanceof Error ? error.message : "agnic balance failed");
    }
    if (res.status === 401 || res.status === 403) return null;
    if (!res.ok) throw new UpstreamError(`agnic balance ${res.status}`);
    const body = (await res.json()) as BalanceBody;
    if (!body.has_wallet || !body.multisig_address) return null;
    return {
      address: body.multisig_address,
      availableSats: body.available_sats ?? 0,
      committedSats: body.committed_sats ?? 0,
      maxSatsPerTx: body.max_sats_per_tx ?? 0,
      dailySats: body.daily_sats ?? 0,
    };
  }
}
