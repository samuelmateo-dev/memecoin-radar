import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  HYPOTHESES,
  calibrateScore,
  evaluateExitGrid,
  runBattery,
  scoreBucket,
  type Hypothesis,
} from "../src/analysis/battery.js";
import { rules } from "../src/analysis/exits.js";
import { mulberry32 } from "../src/analysis/stats.js";
import type { OutcomeRow } from "../src/types.js";

/**
 * Ligne synthétique dont le multiplicateur réalisé (objectif ×1,25) vaut exactement `multiple` :
 * deux points de prix, entrée à 100, sortie au dernier point.
 */
function row(i: number, multiple: number, patch: Partial<OutcomeRow> = {}): OutcomeRow {
  return {
    mint: `mint-${i}`,
    name: `Token ${i}`,
    score: 50,
    entryMarketCapSol: 100,
    peakMarketCapSol: 100 * Math.max(multiple, 1),
    multiple: Math.max(multiple, 1),
    alertedAt: 1_000_000 + i,
    priceHistory: [
      { t: 0, marketCapSol: 100 },
      { t: 10_000, marketCapSol: 100 * multiple },
    ],
    ...patch,
  };
}

const flagged: Hypothesis = {
  id: "flagged",
  label: "Score ≥ 70",
  kind: "filter",
  exit: () => rules.takeProfit(1.25),
  filter: (r) => r.score >= 70,
};

function population(edge: number): OutcomeRow[] {
  const rng = mulberry32(11);
  const noise = () => (rng() - 0.5) * 0.2;
  const rows: OutcomeRow[] = [];
  for (let i = 0; i < 400; i++) rows.push(row(i, 0.9 + noise()));
  // 100 lignes « signalées » dont le multiplicateur moyen vaut 0,9 + edge
  for (let i = 400; i < 500; i++) rows.push(row(i, 0.9 + edge + noise(), { score: 80 }));
  return rows;
}

describe("batterie d'hypothèses", () => {
  it("démontre un vrai avantage (filtre réellement meilleur ET rentable après frais)", () => {
    const report = runBattery(population(0.45), { hypotheses: [flagged], iterations: 1000 });
    const r = report.results[0];
    assert.equal(r.n, 100);
    assert.ok(r.meanNet > 1.2, `meanNet = ${r.meanNet}`);
    assert.ok(r.ciLow > 1);
    assert.ok(r.placebo && r.placebo.pValue < 0.01);
    assert.equal(r.demonstrated, true);
  });

  it("ne démontre rien quand le filtre ne change rien (aucun avantage)", () => {
    const report = runBattery(population(0), { hypotheses: [flagged], iterations: 1000 });
    const r = report.results[0];
    assert.ok(r.meanNet < 1);
    assert.equal(r.demonstrated, false);
  });

  it("distingue « meilleur que le hasard » de « rentable » : un filtre meilleur mais perdant n'est pas démontré", () => {
    // +0,1 : mieux que la population (placebo significatif) mais moyenne nette toujours sous 1
    const report = runBattery(population(0.1), { hypotheses: [flagged], iterations: 1000 });
    const r = report.results[0];
    assert.ok(r.placebo && r.placebo.pValue < 0.05, `p placebo = ${r.placebo?.pValue}`);
    assert.ok(r.meanNet < 1);
    assert.equal(r.demonstrated, false);
  });

  it("refuse de conclure sur un sous-groupe trop petit", () => {
    const rows = population(0.45);
    const tiny: Hypothesis = { ...flagged, filter: (r) => r.score >= 80 && r.mint < "mint-405" && r.mint >= "mint-400" };
    const report = runBattery(rows, { hypotheses: [tiny], iterations: 200, minSampleSize: 20 });
    const r = report.results[0];
    assert.equal(r.insufficientSample, true);
    assert.equal(r.demonstrated, false);
    assert.equal(r.placebo, null);
  });

  it("applique la correction de Bonferroni sur le nombre d'hypothèses", () => {
    const report = runBattery(population(0.45), { hypotheses: [flagged, flagged, flagged, flagged], iterations: 500 });
    const r = report.results[0];
    assert.equal(report.hypothesesTested, 4);
    assert.ok(Math.abs(r.pPlaceboAdjusted! - Math.min(1, r.placebo!.pValue * 4)) < 1e-12);
  });

  it("est reproductible à graine égale, différent sinon", () => {
    const rows = population(0.05);
    const a = runBattery(rows, { hypotheses: [flagged], iterations: 300, seed: 5 });
    const b = runBattery(rows, { hypotheses: [flagged], iterations: 300, seed: 5 });
    const c = runBattery(rows, { hypotheses: [flagged], iterations: 300, seed: 6 });
    assert.deepEqual(a, b);
    assert.notEqual(a.results[0].ciLow, c.results[0].ciLow);
  });

  it("les hypothèses fournies de série s'exécutent sans erreur sur des données vides", () => {
    const report = runBattery([], { iterations: 50 });
    assert.equal(report.results.length, HYPOTHESES.length);
    assert.ok(report.results.every((r) => r.insufficientSample && !r.demonstrated));
  });
});

describe("calibration et grille de sortie", () => {
  it("classe les scores en tranches", () => {
    assert.equal(scoreBucket(49), "< 50");
    assert.equal(scoreBucket(50), "50-59");
    assert.equal(scoreBucket(79), "70-79");
    assert.equal(scoreBucket(89), "80-89");
    assert.equal(scoreBucket(90), "90-100");
  });

  it("exclut les suivis sans vrai score (score = -1) de la calibration", () => {
    const rows = [row(1, 1, { score: -1 }), row(2, 1, { score: 75 })];
    const total = calibrateScore(rows).reduce((acc, b) => acc + b.n, 0);
    assert.equal(total, 1);
  });

  it("évalue chaque règle de la grille avec et sans frais", () => {
    const rows = [row(1, 1.5), row(2, 0.5)];
    const grid = evaluateExitGrid(rows);
    const tp = grid.find((g) => g.label === "objectif ×1,25")!;
    assert.equal(tp.n, 2);
    assert.ok(Math.abs(tp.mean - 1) < 1e-9); // (1,5 + 0,5) / 2
    assert.ok(Math.abs(tp.meanNet - 0.97) < 1e-9);
  });
});
