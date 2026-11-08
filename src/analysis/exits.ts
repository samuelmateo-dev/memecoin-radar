import type { OutcomeRow, PricePoint } from "../types.js";

// Règles de sortie simulées sur l'historique de prix d'un candidat. Chacune retourne le
// multiplicateur réalisé (prix de sortie / prix d'entrée), ou null si la ligne n'a pas
// d'historique exploitable.
//
// Hypothèses (optimistes, volontairement) :
//  - l'ordre est exécuté au premier prix observé qui déclenche la règle, sans latence ni glissement ;
//  - si la règle ne se déclenche jamais, on sort au dernier prix connu (fin de la fenêtre de suivi).

export type ExitRow = Pick<OutcomeRow, "entryMarketCapSol" | "priceHistory">;

function history(row: ExitRow): PricePoint[] | null {
  if (!row.priceHistory || row.priceHistory.length === 0 || row.entryMarketCapSol <= 0) return null;
  return row.priceHistory;
}

/** Vente à heure fixe après l'entrée. */
export function fixedTime(row: ExitRow, minutesAfter: number): number | null {
  const h = history(row);
  if (!h) return null;
  const targetT = h[0].t + minutesAfter * 60_000;
  let closest = h[0];
  for (const p of h) {
    if (p.t <= targetT) closest = p;
    else break;
  }
  return closest.marketCapSol / row.entryMarketCapSol;
}

/** Stop suiveur : vente dès que le prix retombe de `dropPercent` % depuis son plus haut observé. */
export function trailingStop(row: ExitRow, dropPercent: number): number | null {
  const h = history(row);
  if (!h) return null;
  let peak = h[0].marketCapSol;
  for (const p of h) {
    if (p.marketCapSol > peak) peak = p.marketCapSol;
    if (p.marketCapSol <= peak * (1 - dropPercent / 100)) return p.marketCapSol / row.entryMarketCapSol;
  }
  return h[h.length - 1].marketCapSol / row.entryMarketCapSol;
}

/** Objectif de gain : vente dès que `targetMultiple` est atteint. */
export function takeProfit(row: ExitRow, targetMultiple: number): number | null {
  const h = history(row);
  if (!h) return null;
  for (const p of h) {
    const m = p.marketCapSol / row.entryMarketCapSol;
    if (m >= targetMultiple) return m;
  }
  return h[h.length - 1].marketCapSol / row.entryMarketCapSol;
}

/** Ordre « à parenthèses » : objectif de gain OU stop-loss, le premier touché. */
export function bracket(row: ExitRow, targetMultiple: number, stopLossMultiple: number): number | null {
  const h = history(row);
  if (!h) return null;
  for (const p of h) {
    const m = p.marketCapSol / row.entryMarketCapSol;
    if (m >= targetMultiple || m <= stopLossMultiple) return m;
  }
  return h[h.length - 1].marketCapSol / row.entryMarketCapSol;
}

/**
 * Achat au MOMENT PRÉCIS où le prix franchit `fromSol` pour la première fois (pas à l'alerte
 * d'origine), puis vente dès que `toSol` est atteint, ou en fin de fenêtre sinon. Null si le
 * seuil n'est jamais franchi.
 */
export function fromCrossing(row: Pick<OutcomeRow, "priceHistory">, fromSol: number, toSol: number): number | null {
  const h = row.priceHistory;
  if (!h || h.length === 0) return null;
  const crossingIndex = h.findIndex((p) => p.marketCapSol >= fromSol);
  if (crossingIndex === -1) return null;
  const entryPrice = h[crossingIndex].marketCapSol;
  if (entryPrice <= 0) return null;
  for (let i = crossingIndex; i < h.length; i++) {
    if (h[i].marketCapSol >= toSol) return h[i].marketCapSol / entryPrice;
  }
  return h[h.length - 1].marketCapSol / entryPrice;
}

export interface ExitRule {
  id: string;
  label: string;
  apply(row: OutcomeRow): number | null;
}

const fr = (n: number) => String(n).replace(".", ",");

export const rules = {
  fixedTime: (minutes: number): ExitRule => ({
    id: `fixed-${minutes}`,
    label: `vente après ${fr(minutes)} min`,
    apply: (r) => fixedTime(r, minutes),
  }),
  trailingStop: (dropPercent: number): ExitRule => ({
    id: `trail-${dropPercent}`,
    label: `stop suiveur −${dropPercent} %`,
    apply: (r) => trailingStop(r, dropPercent),
  }),
  takeProfit: (target: number): ExitRule => ({
    id: `tp-${target}`,
    label: `objectif ×${fr(target)}`,
    apply: (r) => takeProfit(r, target),
  }),
  bracket: (target: number, stop: number): ExitRule => ({
    id: `bracket-${target}-${stop}`,
    label: `objectif ×${fr(target)} / stop ×${fr(stop)}`,
    apply: (r) => bracket(r, target, stop),
  }),
  crossing: (fromSol: number, toSol: number, label: string): ExitRule => ({
    id: `cross-${fromSol.toFixed(1)}-${toSol.toFixed(1)}`,
    label,
    apply: (r) => fromCrossing(r, fromSol, toSol),
  }),
};

/** Applique une règle à des lignes et ne garde que les résultats exploitables. */
export function applyRule(rows: readonly OutcomeRow[], rule: ExitRule): number[] {
  const out: number[] = [];
  for (const row of rows) {
    const m = rule.apply(row);
    if (m !== null) out.push(m);
  }
  return out;
}

export interface CostModel {
  /** Coût aller-retour (frais de plateforme + glissement), en % de la mise. */
  roundTripFeePercent: number;
  /** Frais de priorité par transaction, en SOL. */
  priorityFeeSol: number;
  /** Mise par trade, en SOL. */
  tradeAmountSol: number;
}

export const DEFAULT_COSTS: CostModel = { roundTripFeePercent: 2, priorityFeeSol: 0.0005, tradeAmountSol: 0.1 };

/** Multiplicateur net de frais, pour une mise de `tradeAmountSol` (2 transactions : achat + vente). */
export function netMultiple(grossMultiple: number, costs: CostModel = DEFAULT_COSTS): number {
  return grossMultiple - costs.roundTripFeePercent / 100 - (2 * costs.priorityFeeSol) / costs.tradeAmountSol;
}
