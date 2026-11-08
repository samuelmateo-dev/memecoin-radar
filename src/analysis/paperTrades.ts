import { mean, median } from "./stats.js";
import { DEFAULT_COSTS, netMultiple, type CostModel } from "./exits.js";

// Analyse du journal de la simulation de trading (une ligne JSON par ordre d'achat ou de vente).

export interface TradeLogEntry {
  type: "buy" | "sell";
  mint: string;
  name?: string;
  reason?: string;
  multipleAtSale?: number | null;
  amountSol?: number;
  success?: boolean;
  loggedAt: number;
}

export interface SessionSummary {
  start: number;
  trades: number;
  meanGross: number;
  meanNet: number;
}

export interface PaperTradeReport {
  buys: number;
  /** Ventes réussies avec un multiplicateur chiffré. */
  closedTrades: number;
  /** Ventes sans multiplicateur enregistré (anciennes versions) : exclues des moyennes. */
  unpriced: number;
  /** Achats sans vente correspondante (positions ouvertes à l'arrêt du bot). */
  stillOpen: number;
  meanGross: number;
  medianGross: number;
  meanNet: number;
  winRatePercent: number;
  /** Résultat cumulé en SOL (mise fixe), avant et après frais. */
  pnlGrossSol: number;
  pnlNetSol: number;
  exitReasons: Record<string, number>;
  sessions: SessionSummary[];
}

/**
 * @param sessionGapMs écart entre deux ordres consécutifs qui marque le début d'une nouvelle
 *                     session (le bot a été arrêté puis relancé). 30 min par défaut.
 */
export function analyzePaperTrades(
  entries: readonly TradeLogEntry[],
  options: { costs?: CostModel; sessionGapMs?: number } = {}
): PaperTradeReport {
  const costs = options.costs ?? DEFAULT_COSTS;
  const sessionGapMs = options.sessionGapMs ?? 30 * 60_000;

  const ok = entries.filter((e) => e.success !== false).sort((a, b) => a.loggedAt - b.loggedAt);
  const buys = ok.filter((e) => e.type === "buy");
  const sells = ok.filter((e) => e.type === "sell");
  const priced = sells.filter((s) => typeof s.multipleAtSale === "number" && Number.isFinite(s.multipleAtSale));

  const gross = priced.map((s) => s.multipleAtSale as number);
  const net = gross.map((m) => netMultiple(m, costs));

  const exitReasons: Record<string, number> = {};
  for (const s of sells) {
    const reason = s.reason ?? "inconnue";
    exitReasons[reason] = (exitReasons[reason] ?? 0) + 1;
  }

  // Sessions : on découpe les ventes chiffrées selon les trous d'activité.
  const sessions: SessionSummary[] = [];
  let current: { start: number; gross: number[] } | null = null;
  let lastAt = -Infinity;
  for (const s of priced) {
    if (!current || s.loggedAt - lastAt > sessionGapMs) {
      current = { start: s.loggedAt, gross: [] };
      sessions.push({ start: s.loggedAt, trades: 0, meanGross: 0, meanNet: 0 });
    }
    current.gross.push(s.multipleAtSale as number);
    const summary = sessions[sessions.length - 1];
    summary.trades = current.gross.length;
    summary.meanGross = mean(current.gross);
    summary.meanNet = mean(current.gross.map((m) => netMultiple(m, costs)));
    lastAt = s.loggedAt;
  }

  const stake = costs.tradeAmountSol;
  return {
    buys: buys.length,
    closedTrades: priced.length,
    unpriced: sells.length - priced.length,
    stillOpen: Math.max(0, buys.length - sells.length),
    meanGross: mean(gross),
    medianGross: median(gross),
    meanNet: mean(net),
    winRatePercent: gross.length === 0 ? NaN : (100 * gross.filter((m) => m > 1).length) / gross.length,
    pnlGrossSol: gross.reduce((acc, m) => acc + stake * (m - 1), 0),
    pnlNetSol: net.reduce((acc, m) => acc + stake * (m - 1), 0),
    exitReasons,
    sessions,
  };
}
