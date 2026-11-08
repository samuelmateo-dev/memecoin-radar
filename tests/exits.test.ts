import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_COSTS,
  applyRule,
  bracket,
  fixedTime,
  fromCrossing,
  netMultiple,
  rules,
  takeProfit,
  trailingStop,
  type ExitRow,
} from "../src/analysis/exits.js";
import type { OutcomeRow } from "../src/types.js";

// Entrée à 100 ; prix relevés toutes les 10 s : 100, 110, 125, 90, 200
const row: ExitRow = {
  entryMarketCapSol: 100,
  priceHistory: [100, 110, 125, 90, 200].map((marketCapSol, i) => ({ t: i * 10_000, marketCapSol })),
};
const approx = (a: number | null, b: number) => assert.ok(a !== null && Math.abs(a - b) < 1e-9, `${a} ≠ ${b}`);

describe("règles de sortie", () => {
  it("objectif de gain : sort au premier prix qui atteint la cible", () => {
    approx(takeProfit(row, 1.25), 1.25);
    approx(takeProfit(row, 1.1), 1.1);
  });

  it("objectif jamais atteint : sort au dernier prix connu", () => {
    approx(takeProfit(row, 5), 2);
  });

  it("stop-loss : le premier seuil touché décide (stop avant objectif)", () => {
    approx(bracket(row, 2.5, 0.95), 0.9);
    approx(bracket(row, 1.25, 0.5), 1.25);
    approx(bracket(row, 5, 0.1), 2); // aucun seuil touché → dernier prix
  });

  it("stop suiveur : vend quand le prix retombe sous son plus haut", () => {
    approx(trailingStop(row, 10), 0.9); // plus haut 125 → seuil 112,5 → touché à 90
    approx(trailingStop(row, 50), 2); // jamais touché
  });

  it("vente à heure fixe : dernier point observé avant l'échéance", () => {
    approx(fixedTime(row, 0.5), 0.9); // 30 s → point à 30 s (prix 90)
    approx(fixedTime(row, 0.2), 1.1); // 12 s → point à 10 s
    approx(fixedTime(row, 60), 2); // au-delà de l'historique → dernier point
  });

  it("achat au franchissement d'un seuil, vente au suivant", () => {
    approx(fromCrossing(row, 120, 190), 200 / 125);
    approx(fromCrossing(row, 120, 1000), 200 / 125); // objectif jamais atteint → dernier prix
    assert.equal(fromCrossing(row, 500, 600), null); // seuil jamais franchi
  });

  it("renvoie null sans historique exploitable", () => {
    assert.equal(takeProfit({ entryMarketCapSol: 100, priceHistory: [] }, 1.2), null);
    assert.equal(takeProfit({ entryMarketCapSol: 100 }, 1.2), null);
    assert.equal(takeProfit({ entryMarketCapSol: 0, priceHistory: row.priceHistory }, 1.2), null);
    assert.equal(fromCrossing({ priceHistory: [] }, 1, 2), null);
  });

  it("applyRule ignore les lignes sans historique", () => {
    const rows = [
      { ...row },
      { entryMarketCapSol: 100 },
    ] as OutcomeRow[];
    assert.equal(applyRule(rows, rules.takeProfit(1.25)).length, 1);
  });

  it("les libellés utilisent la virgule décimale", () => {
    assert.equal(rules.takeProfit(1.25).label, "objectif ×1,25");
    assert.equal(rules.fixedTime(0.5).label, "vente après 0,5 min");
    assert.equal(rules.bracket(1.25, 0.5).label, "objectif ×1,25 / stop ×0,5");
  });
});

describe("modèle de coûts", () => {
  it("retranche ~3 % de la mise avec les paramètres par défaut", () => {
    // 2 % de frais + 2 × 0,0005 SOL de priorité sur une mise de 0,1 SOL = 1 %
    approx(netMultiple(1, DEFAULT_COSTS), 0.97);
    approx(netMultiple(1.25, DEFAULT_COSTS), 1.22);
  });

  it("s'adapte à la taille de la mise", () => {
    approx(netMultiple(1, { roundTripFeePercent: 2, priorityFeeSol: 0.0005, tradeAmountSol: 1 }), 0.979);
  });
});
