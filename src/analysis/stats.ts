// Statistiques de base, sans dépendance externe. Tout ce qui est aléatoire passe par un
// générateur à graine (mulberry32) : un même rapport est reproductible au chiffre près.

export function mean(xs: readonly number[]): number {
  if (xs.length === 0) return NaN;
  let sum = 0;
  for (const x of xs) sum += x;
  return sum / xs.length;
}

export function median(xs: readonly number[]): number {
  if (xs.length === 0) return NaN;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Quantile par interpolation linéaire sur un tableau DÉJÀ trié (q entre 0 et 1). */
export function quantileSorted(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/** Part des valeurs supérieures ou égales à `threshold`, en %. */
export function shareAtLeast(xs: readonly number[], threshold: number): number {
  if (xs.length === 0) return NaN;
  return (100 * xs.filter((x) => x >= threshold).length) / xs.length;
}

export type Rng = () => number;

/** Générateur pseudo-aléatoire à graine (mulberry32). Retourne des nombres dans [0, 1). */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Moyennes de `iterations` rééchantillons bootstrap (avec remise), triées. */
export function bootstrapMeans(xs: readonly number[], iterations: number, rng: Rng): number[] {
  const n = xs.length;
  const means = new Array<number>(iterations);
  for (let i = 0; i < iterations; i++) {
    let sum = 0;
    for (let j = 0; j < n; j++) sum += xs[Math.floor(rng() * n)];
    means[i] = sum / n;
  }
  return means.sort((a, b) => a - b);
}

export interface MeanSummary {
  n: number;
  mean: number;
  median: number;
  /** Intervalle de confiance bootstrap à (1 - alpha) sur la moyenne. */
  ciLow: number;
  ciHigh: number;
  /** Part des rééchantillons dont la moyenne est ≤ `benchmark` : p-value unilatérale de « moyenne > benchmark ». */
  pMeanAbove: number;
}

/** Résume un échantillon et teste si sa moyenne dépasse `benchmark` (1 = rendement nul). */
export function summarizeMean(
  xs: readonly number[],
  options: { iterations: number; rng: Rng; benchmark?: number; alpha?: number }
): MeanSummary {
  const { iterations, rng, benchmark = 1, alpha = 0.05 } = options;
  if (xs.length === 0) {
    return { n: 0, mean: NaN, median: NaN, ciLow: NaN, ciHigh: NaN, pMeanAbove: NaN };
  }
  const boots = bootstrapMeans(xs, iterations, rng);
  let atOrBelow = 0;
  for (const m of boots) {
    if (m <= benchmark) atOrBelow++;
    else break; // le tableau est trié
  }
  return {
    n: xs.length,
    mean: mean(xs),
    median: median(xs),
    ciLow: quantileSorted(boots, alpha / 2),
    ciHigh: quantileSorted(boots, 1 - alpha / 2),
    pMeanAbove: (atOrBelow + 1) / (iterations + 1),
  };
}

export interface PlaceboResult {
  /** Taille du sous-groupe testé. */
  n: number;
  observedMean: number;
  /** Moyenne attendue pour un sous-groupe tiré au hasard, de même taille. */
  placeboMean: number;
  placeboLow: number;
  placeboHigh: number;
  /**
   * P(un sous-groupe aléatoire de même taille fait au moins aussi bien). Unilatéral.
   * Petit = le filtre capte autre chose que du hasard.
   */
  pValue: number;
  iterations: number;
}

/**
 * Contrôle par placebo (test de permutation) : le sous-groupe filtré fait-il mieux que des
 * sous-groupes de même taille tirés au hasard dans la même population ?
 *
 * Répond à la question « le filtre sert-il à quelque chose ? », pas à « est-ce rentable ? »
 * (pour ça : `summarizeMean` contre 1, après frais).
 */
export function placeboTest(
  population: readonly number[],
  observedMean: number,
  n: number,
  options: { iterations: number; rng: Rng; alpha?: number }
): PlaceboResult {
  const { iterations, rng, alpha = 0.05 } = options;
  if (n <= 0 || n > population.length) {
    throw new RangeError(`Taille de sous-groupe invalide : n=${n} pour une population de ${population.length}.`);
  }
  const pool = [...population];
  const means = new Array<number>(iterations);
  let atLeastAsGood = 0;

  for (let it = 0; it < iterations; it++) {
    // Mélange de Fisher-Yates partiel : les n premiers éléments forment un tirage uniforme sans remise.
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const j = i + Math.floor(rng() * (pool.length - i));
      [pool[i], pool[j]] = [pool[j], pool[i]];
      sum += pool[i];
    }
    const m = sum / n;
    means[it] = m;
    if (m >= observedMean) atLeastAsGood++;
  }
  means.sort((a, b) => a - b);

  return {
    n,
    observedMean,
    placeboMean: mean(means),
    placeboLow: quantileSorted(means, alpha / 2),
    placeboHigh: quantileSorted(means, 1 - alpha / 2),
    pValue: (atLeastAsGood + 1) / (iterations + 1),
    iterations,
  };
}

/** Correction de Bonferroni pour `k` hypothèses testées sur les mêmes données. */
export function bonferroni(p: number, k: number): number {
  return Math.min(1, p * k);
}
