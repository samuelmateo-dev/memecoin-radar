import type { OutcomeRow } from "../types.js";
import { applyRule, netMultiple, rules, type CostModel, type ExitRule, DEFAULT_COSTS } from "./exits.js";
import {
  bonferroni,
  mean,
  median,
  mulberry32,
  placeboTest,
  shareAtLeast,
  summarizeMean,
  type MeanSummary,
  type PlaceboResult,
} from "./stats.js";

// ---------------------------------------------------------------------------------------
// 1. Calibration du score : le score classe-t-il les candidats ?
// ---------------------------------------------------------------------------------------

export interface BucketStats {
  label: string;
  n: number;
  /** Pic atteint / prix d'entrée. C'est un MAXIMUM mesuré après coup, pas un gain encaissable. */
  medianPeak: number;
  meanPeak: number;
  /** Part des candidats dont le pic dépasse ×2, en %. */
  shareReachingX2: number;
}

export function summarizePeaks(label: string, rows: readonly OutcomeRow[]): BucketStats {
  const peaks = rows.map((r) => r.multiple);
  return {
    label,
    n: rows.length,
    medianPeak: median(peaks),
    meanPeak: mean(peaks),
    shareReachingX2: shareAtLeast(peaks, 2),
  };
}

export function scoreBucket(score: number): string {
  if (score < 50) return "< 50";
  if (score < 60) return "50-59";
  if (score < 70) return "60-69";
  if (score < 80) return "70-79";
  if (score < 90) return "80-89";
  return "90-100";
}

export const SCORE_BUCKETS = ["< 50", "50-59", "60-69", "70-79", "80-89", "90-100"];

export function calibrateScore(rows: readonly OutcomeRow[]): BucketStats[] {
  // Les suivis « vague de noms » n'ont pas de vrai score (-1) : exclus de cette table.
  const scored = rows.filter((r) => r.score >= 0);
  return SCORE_BUCKETS.map((b) =>
    summarizePeaks(
      b,
      scored.filter((r) => scoreBucket(r.score) === b)
    )
  );
}

export function calibrateHolders(rows: readonly OutcomeRow[]): BucketStats[] {
  const withSignal = rows.filter((r) => r.signals && r.signals.topHolderPercent !== null);
  const buckets: Array<[string, (p: number) => boolean]> = [
    ["< 40 %", (p) => p < 40],
    ["40-60 %", (p) => p >= 40 && p < 60],
    ["60-80 %", (p) => p >= 60 && p < 80],
    ["80-95 %", (p) => p >= 80 && p < 95],
    ["≥ 95 %", (p) => p >= 95],
  ];
  return buckets.map(([label, test]) =>
    summarizePeaks(
      label,
      withSignal.filter((r) => test(r.signals!.topHolderPercent as number))
    )
  );
}

// ---------------------------------------------------------------------------------------
// 2. Grille de règles de sortie : existe-t-il une règle de sortie rentable ?
// ---------------------------------------------------------------------------------------

export interface RuleRow {
  label: string;
  n: number;
  mean: number;
  median: number;
  meanNet: number;
}

export const EXIT_GRID: ExitRule[] = [
  ...[0.5, 1, 2, 3, 5, 10].map((m) => rules.fixedTime(m)),
  ...[5, 10, 15, 25, 40].map((d) => rules.trailingStop(d)),
  ...[1.15, 1.2, 1.25, 1.3, 1.5, 2].map((t) => rules.takeProfit(t)),
  ...(
    [
      [1.2, 0.8],
      [1.25, 0.7],
      [1.25, 0.5],
      [1.25, 0.3],
    ] as const
  ).map(([t, s]) => rules.bracket(t, s)),
];

export function evaluateExitGrid(rows: readonly OutcomeRow[], costs: CostModel = DEFAULT_COSTS): RuleRow[] {
  return EXIT_GRID.map((rule) => {
    const m = applyRule(rows, rule);
    return {
      label: rule.label,
      n: m.length,
      mean: mean(m),
      median: median(m),
      meanNet: mean(m.map((x) => netMultiple(x, costs))),
    };
  });
}

// ---------------------------------------------------------------------------------------
// 3. Batterie d'hypothèses : chaque idée de stratégie, testée avec le même protocole
// ---------------------------------------------------------------------------------------

export interface HypothesisContext {
  /** Prix du SOL en USD utilisé pour convertir les seuils exprimés en dollars. */
  solUsd: number;
}

export interface Hypothesis {
  id: string;
  label: string;
  /**
   * - "filter" : « sélectionner ces candidats améliore-t-il le résultat ? » → placebo applicable
   *   (tirage au hasard de sous-groupes de même taille dans la même population).
   * - "entry"  : règle d'entrée/sortie propre (ex. achat au franchissement d'un seuil) → le
   *   placebo n'a pas de sens, on teste seulement la rentabilité.
   */
  kind: "filter" | "entry";
  exit: (ctx: HypothesisContext) => ExitRule;
  filter?: (row: OutcomeRow, ctx: HypothesisContext) => boolean;
}

const holders = (r: OutcomeRow) => r.signals?.topHolderPercent ?? null;
const hasX = (r: OutcomeRow) => r.signals?.hasTwitterLink === true;
const usdToSol = (usd: number, ctx: HypothesisContext) => usd / ctx.solUsd;

export const HYPOTHESES: Hypothesis[] = [
  {
    id: "score70-holders80",
    label: "Score ≥ 70 et holders < 80 %, objectif ×1,25",
    kind: "filter",
    exit: () => rules.takeProfit(1.25),
    filter: (r) => r.score >= 70 && holders(r) !== null && (holders(r) as number) < 80,
  },
  {
    id: "score90",
    label: "Score ≥ 90, objectif ×1,25",
    kind: "filter",
    exit: () => rules.takeProfit(1.25),
    filter: (r) => r.score >= 90,
  },
  {
    id: "entry100",
    label: "Entrée ≥ 100 SOL, objectif ×1,25",
    kind: "filter",
    exit: () => rules.takeProfit(1.25),
    filter: (r) => r.entryMarketCapSol >= 100,
  },
  {
    id: "entry100-x2",
    label: "Entrée ≥ 100 SOL, objectif ×2",
    kind: "filter",
    exit: () => rules.takeProfit(2),
    filter: (r) => r.entryMarketCapSol >= 100,
  },
  {
    id: "entry300-x2",
    label: "Entrée ≥ 300 SOL, objectif ×2",
    kind: "filter",
    exit: () => rules.takeProfit(2),
    filter: (r) => r.entryMarketCapSol >= 300,
  },
  {
    id: "entry150-x",
    label: "Entrée ≥ 150 SOL + lien X, objectif ×1,25",
    kind: "filter",
    exit: () => rules.takeProfit(1.25),
    filter: (r) => r.entryMarketCapSol >= 150 && hasX(r),
  },
  {
    id: "entry100-x-x2",
    label: "Entrée ≥ 100 SOL + lien X, objectif ×2",
    kind: "filter",
    exit: () => rules.takeProfit(2),
    filter: (r) => r.entryMarketCapSol >= 100 && hasX(r),
  },
  {
    id: "usd10k-x-x2",
    label: "Entrée ≥ 10 000 $ + lien X, objectif ×2",
    kind: "filter",
    exit: () => rules.takeProfit(2),
    filter: (r, ctx) => r.entryMarketCapSol >= usdToSol(10_000, ctx) && hasX(r),
  },
  {
    id: "usd20k-x-125",
    label: "Entrée ≥ 20 000 $ + lien X, objectif ×1,25",
    kind: "filter",
    exit: () => rules.takeProfit(1.25),
    filter: (r, ctx) => r.entryMarketCapSol >= usdToSol(20_000, ctx) && hasX(r),
  },
  {
    id: "usd20k-x-x2",
    label: "Entrée ≥ 20 000 $ + lien X, objectif ×2",
    kind: "filter",
    exit: () => rules.takeProfit(2),
    filter: (r, ctx) => r.entryMarketCapSol >= usdToSol(20_000, ctx) && hasX(r),
  },
  {
    id: "wave-first",
    label: "Premier token d'une vague de noms, objectif ×1,25",
    kind: "filter",
    exit: () => rules.takeProfit(1.25),
    filter: (r) => r.waveRank === 1,
  },
  ...(
    [
      [20_000, 30_000],
      [30_000, 40_000],
      [40_000, 50_000],
    ] as const
  ).map(
    ([from, to]): Hypothesis => ({
      id: `cross-${from}-${to}`,
      label: `Achat au franchissement de ${from / 1000}k$, vente à ${to / 1000}k$`,
      kind: "entry",
      exit: (ctx) => rules.crossing(usdToSol(from, ctx), usdToSol(to, ctx), `${from / 1000}k$ → ${to / 1000}k$`),
    })
  ),
];

export interface HypothesisResult {
  id: string;
  label: string;
  kind: Hypothesis["kind"];
  n: number;
  /** Moyenne brute du multiplicateur réalisé. */
  meanGross: number;
  /** Moyenne après frais. */
  meanNet: number;
  median: number;
  /** IC 95 % bootstrap sur la moyenne nette. */
  ciLow: number;
  ciHigh: number;
  /** p-value unilatérale : « la moyenne nette dépasse 1 » (le trade est rentable après frais). */
  pProfitable: number;
  /** Placebo : le filtre fait-il mieux que des sous-groupes aléatoires de même taille ? (filtres seulement) */
  placebo: PlaceboResult | null;
  /** p-value du placebo corrigée pour le nombre d'hypothèses de la batterie (Bonferroni). */
  pPlaceboAdjusted: number | null;
  /** pProfitable corrigée pour le nombre d'hypothèses de la batterie (Bonferroni). */
  pProfitableAdjusted: number;
  /** Vrai seulement si rentable après frais ET, pour un filtre, meilleur que le hasard — après correction. */
  demonstrated: boolean;
  /** Vrai si le sous-groupe est trop petit pour conclure : aucun test n'est alors calculé. */
  insufficientSample: boolean;
}

export interface BatteryOptions {
  seed?: number;
  iterations?: number;
  solUsd?: number;
  costs?: CostModel;
  alpha?: number;
  /** Taille minimale d'un sous-groupe pour être testé (défaut 20) : en dessous, un seul cas extrême décide du résultat. */
  minSampleSize?: number;
  hypotheses?: Hypothesis[];
  /**
   * Nombre de tests pris en compte par la correction de Bonferroni. Défaut : le nombre d'hypothèses
   * lancées. À augmenter quand d'autres idées ont déjà été regardées sur ces données (jamais en dessous
   * du nombre d'hypothèses lancées).
   */
  correctionCount?: number;
  /**
   * Faux (défaut) : un seul flux aléatoire partagé, comme la batterie d'origine (les chiffres d'une
   * hypothèse dépendent donc de celles qui la précèdent). Vrai : chaque hypothèse a son propre flux,
   * dérivé de la graine et de son identifiant : mêmes chiffres quel que soit le reste de la liste.
   */
  independentStreams?: boolean;
}

export interface BatteryReport {
  populationSize: number;
  hypothesesTested: number;
  /** Nombre de tests sur lequel la correction de Bonferroni est calculée (≥ hypothesesTested). */
  correctionCount: number;
  independentStreams: boolean;
  options: Required<Omit<BatteryOptions, "hypotheses" | "correctionCount" | "independentStreams">>;
  results: HypothesisResult[];
}

/** Graine propre à une hypothèse : FNV-1a de son identifiant, combinée à la graine globale. */
export function streamSeed(seed: number, id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (Math.floor(seed) ^ h) >>> 0;
}

/**
 * Exécute chaque hypothèse sur la population `rows` (lignes avec historique de prix) :
 * résultat moyen avant/après frais, intervalle de confiance, contrôle par placebo, puis
 * correction de Bonferroni sur l'ensemble de la batterie.
 */
export function runBattery(rows: readonly OutcomeRow[], options: BatteryOptions = {}): BatteryReport {
  const seed = options.seed ?? 42;
  const iterations = options.iterations ?? 5000;
  const solUsd = options.solUsd ?? 123;
  const costs = options.costs ?? DEFAULT_COSTS;
  const alpha = options.alpha ?? 0.05;
  const minSampleSize = options.minSampleSize ?? 20;
  const hypotheses = options.hypotheses ?? HYPOTHESES;
  const independentStreams = options.independentStreams === true;
  const sharedRng = mulberry32(seed);
  const ctx: HypothesisContext = { solUsd };
  const k = options.correctionCount ?? hypotheses.length;
  if (hypotheses.length === 0) throw new RangeError("au moins une hypothèse est nécessaire");
  if (!Number.isInteger(k) || k < hypotheses.length) {
    throw new RangeError(
      `correctionCount (${k}) doit être un entier au moins égal au nombre d'hypothèses lancées (${hypotheses.length})`
    );
  }

  const results: HypothesisResult[] = hypotheses.map((h) => {
    const rng = independentStreams ? mulberry32(streamSeed(seed, h.id)) : sharedRng;
    const exit = h.exit(ctx);
    const subsetRows = h.filter ? rows.filter((r) => h.filter!(r, ctx)) : [...rows];
    const gross = applyRule(subsetRows, exit);
    const net = gross.map((m) => netMultiple(m, costs));

    const emptyResult = (): HypothesisResult => ({
      id: h.id,
      label: h.label,
      kind: h.kind,
      n: gross.length,
      meanGross: NaN,
      meanNet: NaN,
      median: NaN,
      ciLow: NaN,
      ciHigh: NaN,
      pProfitable: NaN,
      placebo: null,
      pPlaceboAdjusted: null,
      pProfitableAdjusted: NaN,
      demonstrated: false,
      insufficientSample: true,
    });
    if (gross.length < Math.max(2, minSampleSize)) return emptyResult();

    const summary: MeanSummary = summarizeMean(net, { iterations, rng, benchmark: 1, alpha });

    let placebo: PlaceboResult | null = null;
    if (h.kind === "filter") {
      // Population de référence : toutes les lignes, avec la MÊME règle de sortie.
      const populationGross = applyRule(rows, exit);
      if (gross.length < populationGross.length) {
        placebo = placeboTest(populationGross, mean(gross), gross.length, { iterations, rng, alpha });
      }
    }

    const pProfitableAdjusted = bonferroni(summary.pMeanAbove, k);
    const pPlaceboAdjusted = placebo ? bonferroni(placebo.pValue, k) : null;
    const demonstrated = pProfitableAdjusted < alpha && (pPlaceboAdjusted === null || pPlaceboAdjusted < alpha);

    return {
      id: h.id,
      label: h.label,
      kind: h.kind,
      n: summary.n,
      meanGross: mean(gross),
      meanNet: summary.mean,
      median: median(gross),
      ciLow: summary.ciLow,
      ciHigh: summary.ciHigh,
      pProfitable: summary.pMeanAbove,
      placebo,
      pPlaceboAdjusted,
      pProfitableAdjusted,
      demonstrated,
      insufficientSample: false,
    };
  });

  return {
    populationSize: rows.length,
    hypothesesTested: hypotheses.length,
    correctionCount: k,
    independentStreams,
    options: { seed, iterations, solUsd, costs, alpha, minSampleSize },
    results,
  };
}

