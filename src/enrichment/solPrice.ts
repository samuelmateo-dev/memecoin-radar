// Prix SOL/USD, mis en cache 60 s pour ne pas appeler l'API à chaque message.
let cachedPrice: number | null = null;
let cachedAt = 0;
const CACHE_TTL_MS = 60_000;

export async function getSolUsdPrice(): Promise<number | null> {
  const now = Date.now();
  if (cachedPrice !== null && now - cachedAt < CACHE_TTL_MS) return cachedPrice;
  try {
    const res = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd");
    if (!res.ok) return cachedPrice; // on retombe sur le dernier prix connu si l'appel échoue
    const json: any = await res.json();
    const price = json?.solana?.usd;
    if (typeof price === "number") {
      cachedPrice = price;
      cachedAt = now;
      return price;
    }
    return cachedPrice;
  } catch (err) {
    console.error("[solPrice] Impossible de récupérer le prix SOL/USD:", (err as Error).message);
    return cachedPrice; // dernier prix connu plutôt que de faire échouer l'envoi de l'alerte
  }
}

export function formatUsd(amount: number): string {
  return amount.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}
