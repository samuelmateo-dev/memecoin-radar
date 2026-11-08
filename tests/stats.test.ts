import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  bonferroni,
  bootstrapMeans,
  mean,
  median,
  mulberry32,
  placeboTest,
  quantileSorted,
  shareAtLeast,
  summarizeMean,
} from "../src/analysis/stats.js";

describe("statistiques de base", () => {
  it("moyenne et médiane", () => {
    assert.equal(mean([1, 2, 3, 4]), 2.5);
    assert.equal(median([3, 1, 2]), 2);
    assert.equal(median([4, 1, 3, 2]), 2.5);
    assert.ok(Number.isNaN(mean([])));
    assert.ok(Number.isNaN(median([])));
  });

  it("ne modifie pas le tableau d'origine", () => {
    const xs = [3, 1, 2];
    median(xs);
    assert.deepEqual(xs, [3, 1, 2]);
  });

  it("quantile avec interpolation linéaire", () => {
    const sorted = [0, 10, 20, 30, 40];
    assert.equal(quantileSorted(sorted, 0), 0);
    assert.equal(quantileSorted(sorted, 0.5), 20);
    assert.equal(quantileSorted(sorted, 0.125), 5);
    assert.equal(quantileSorted(sorted, 1), 40);
  });

  it("part des valeurs au-dessus d'un seuil, en %", () => {
    assert.equal(shareAtLeast([1, 2, 3, 4], 3), 50);
    assert.ok(Number.isNaN(shareAtLeast([], 1)));
  });

  it("Bonferroni est plafonné à 1", () => {
    assert.equal(bonferroni(0.01, 10), 0.1);
    assert.equal(bonferroni(0.5, 10), 1);
  });
});

describe("générateur à graine", () => {
  it("est reproductible et reste dans [0, 1)", () => {
    const a = mulberry32(7);
    const b = mulberry32(7);
    for (let i = 0; i < 1000; i++) {
      const v = a();
      assert.equal(v, b());
      assert.ok(v >= 0 && v < 1);
    }
  });

  it("deux graines différentes donnent deux suites différentes", () => {
    assert.notEqual(mulberry32(1)(), mulberry32(2)());
  });
});

describe("bootstrap et intervalle de confiance", () => {
  it("renvoie des moyennes triées", () => {
    const means = bootstrapMeans([1, 2, 3, 4, 5], 200, mulberry32(1));
    assert.equal(means.length, 200);
    for (let i = 1; i < means.length; i++) assert.ok(means[i] >= means[i - 1]);
  });

  it("échantillon constant : intervalle dégénéré, test de rentabilité tranché", () => {
    const up = summarizeMean(Array(50).fill(1.5), { iterations: 500, rng: mulberry32(1) });
    assert.equal(up.ciLow, 1.5);
    assert.equal(up.ciHigh, 1.5);
    assert.ok(up.pMeanAbove < 0.01);

    const down = summarizeMean(Array(50).fill(0.9), { iterations: 500, rng: mulberry32(1) });
    assert.equal(down.pMeanAbove, 1);
  });

  it("l'intervalle contient la moyenne observée", () => {
    const rng = mulberry32(3);
    const xs = Array.from({ length: 200 }, () => 0.5 + rng());
    const s = summarizeMean(xs, { iterations: 1000, rng: mulberry32(4) });
    assert.ok(s.ciLow < s.mean && s.mean < s.ciHigh);
  });

  it("gère un échantillon vide sans planter", () => {
    const s = summarizeMean([], { iterations: 10, rng: mulberry32(1) });
    assert.equal(s.n, 0);
    assert.ok(Number.isNaN(s.mean));
  });
});

describe("contrôle par placebo", () => {
  const population = Array.from({ length: 1000 }, (_, i) => 0.5 + i / 1000); // 0,5 → 1,5

  it("un sous-groupe ordinaire n'est pas meilleur que le hasard", () => {
    const subset = population.filter((_, i) => i % 20 === 0); // réparti sur toute la population
    const r = placeboTest(population, mean(subset), subset.length, { iterations: 2000, rng: mulberry32(1) });
    assert.equal(r.n, 50);
    assert.ok(r.pValue > 0.2 && r.pValue < 0.8, `p = ${r.pValue}`);
    assert.ok(Math.abs(r.placeboMean - mean(population)) < 0.01);
  });

  it("un vrai sous-groupe privilégié bat le placebo", () => {
    const best = population.slice(-50); // les 50 meilleurs
    const r = placeboTest(population, mean(best), best.length, { iterations: 2000, rng: mulberry32(1) });
    assert.equal(r.pValue, 1 / 2001); // aucun tirage aléatoire ne fait aussi bien
  });

  it("un sous-groupe pire que le hasard a une p-value proche de 1", () => {
    const worst = population.slice(0, 50);
    const r = placeboTest(population, mean(worst), worst.length, { iterations: 500, rng: mulberry32(1) });
    assert.ok(r.pValue > 0.99);
  });

  it("la p-value n'est jamais nulle", () => {
    const r = placeboTest(population, 99, 10, { iterations: 100, rng: mulberry32(1) });
    assert.equal(r.pValue, 1 / 101);
  });

  it("est reproductible à graine égale", () => {
    const a = placeboTest(population, 1.0, 30, { iterations: 300, rng: mulberry32(9) });
    const b = placeboTest(population, 1.0, 30, { iterations: 300, rng: mulberry32(9) });
    assert.deepEqual(a, b);
  });

  it("refuse une taille de sous-groupe impossible", () => {
    assert.throws(() => placeboTest([1, 2, 3], 2, 4, { iterations: 10, rng: mulberry32(1) }), RangeError);
    assert.throws(() => placeboTest([1, 2, 3], 2, 0, { iterations: 10, rng: mulberry32(1) }), RangeError);
  });

  it("ne modifie pas la population fournie", () => {
    const pop = [1, 2, 3, 4, 5];
    placeboTest(pop, 3, 2, { iterations: 50, rng: mulberry32(1) });
    assert.deepEqual(pop, [1, 2, 3, 4, 5]);
  });
});
