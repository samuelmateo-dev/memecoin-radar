// Client RPC Helius minimal. Toutes les requêtes passent par une file séquentielle pour
// rester sous le quota du plan gratuit (10 req/s), avec une marge volontaire.

export interface HeliusClientOptions {
  apiKey: string;
  fetchImpl?: typeof fetch;
  /** Délai minimal entre deux requêtes (~6-7 req/s par défaut). */
  minDelayMs?: number;
}

export class HeliusClient {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly fetchImpl: typeof fetch;
  private readonly minDelayMs: number;
  private readonly apiKey: string;

  constructor(options: HeliusClientOptions) {
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.minDelayMs = options.minDelayMs ?? 150;
  }

  private rpcCall(method: string, params: unknown[]): Promise<any> {
    const run = this.queue.then(async () => {
      const res = await this.fetchImpl(`https://mainnet.helius-rpc.com/?api-key=${this.apiKey}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      const json: any = await res.json();
      if (this.minDelayMs > 0) await new Promise((r) => setTimeout(r, this.minDelayMs));
      if (json.error) throw new Error(`Helius RPC ${method}: ${JSON.stringify(json.error)}`);
      return json.result;
    });
    // L'erreur reste propagée à l'appelant de `run`, mais ne bloque pas les appels suivants.
    this.queue = run.catch(() => undefined);
    return run;
  }

  async getTopHolderConcentration(mint: string): Promise<{ topHolderPercent: number; holderCount: number } | null> {
    try {
      const [largest, supply] = await Promise.all([
        this.rpcCall("getTokenLargestAccounts", [mint]),
        this.rpcCall("getTokenSupply", [mint]),
      ]);
      const totalSupply = Number(supply?.value?.amount ?? 0);
      if (!totalSupply) return null;

      const accounts: Array<{ amount: string }> = largest?.value ?? [];
      const top10Sum = accounts.slice(0, 10).reduce((sum, acc) => sum + Number(acc.amount), 0);

      return { topHolderPercent: (top10Sum / totalSupply) * 100, holderCount: accounts.length };
    } catch (err) {
      console.error(`[helius] getTopHolderConcentration(${mint}):`, (err as Error).message);
      return null;
    }
  }

  async getMintAuthorities(
    mint: string
  ): Promise<{ mintAuthorityRevoked: boolean; freezeAuthorityRevoked: boolean } | null> {
    try {
      const info = await this.rpcCall("getAccountInfo", [mint, { encoding: "jsonParsed" }]);
      const parsed = info?.value?.data?.parsed?.info;
      if (!parsed) return null;

      return {
        mintAuthorityRevoked: parsed.mintAuthority === null,
        freezeAuthorityRevoked: parsed.freezeAuthority === null,
      };
    } catch (err) {
      console.error(`[helius] getMintAuthorities(${mint}):`, (err as Error).message);
      return null;
    }
  }
}
