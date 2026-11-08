import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { loadOutcomes, parseJsonl, withHistory } from "../src/analysis/dataset.js";
import { analyzePaperTrades, type TradeLogEntry } from "../src/analysis/paperTrades.js";
import { makeTmpDir } from "./helpers.js";

const goodRow = (mint: string) => ({
  mint,
  name: "A",
  score: 70,
  entryMarketCapSol: 100,
  peakMarketCapSol: 150,
  multiple: 1.5,
  alertedAt: 1,
});

describe("lecture des fichiers JSONL", () => {
  it("ignore les lignes vides et compte les lignes illisibles", () => {
    const { rows, skipped } = parseJsonl('{"a":1}\n\n{pas du json}\n{"a":2}\n');
    assert.deepEqual(rows, [{ a: 1 }, { a: 2 }]);
    assert.equal(skipped, 1);
  });

  it("écarte les lignes d'historique incomplètes", () => {
    const dir = makeTmpDir();
    const file = path.join(dir, "outcomes.jsonl");
    const incomplete = { ...goodRow("B"), entryMarketCapSol: undefined };
    writeFileSync(
      file,
      [JSON.stringify(goodRow("A")), JSON.stringify(incomplete), "n'importe quoi"].join("\n"),
      "utf8"
    );
    const { rows, skipped } = loadOutcomes(file);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].mint, "A");
    assert.equal(skipped, 2);
  });

  it("ne garde pour la simulation que les lignes avec au moins deux points de prix", () => {
    const p = { t: 0, marketCapSol: 1 };
    const rows = [
      { ...goodRow("A"), priceHistory: [p, p] },
      { ...goodRow("B"), priceHistory: [p] },
      { ...goodRow("C") },
    ];
    assert.deepEqual(
      withHistory(rows).map((r) => r.mint),
      ["A"]
    );
  });
});

describe("bilan de la simulation de trading", () => {
  const MIN = 60_000;
  const buy = (mint: string, at: number): TradeLogEntry => ({ type: "buy", mint, loggedAt: at });
  const sell = (mint: string, at: number, multipleAtSale: number | null, reason = "objectif atteint"): TradeLogEntry => ({
    type: "sell",
    mint,
    loggedAt: at,
    multipleAtSale,
    reason,
  });

  const entries: TradeLogEntry[] = [
    buy("A", 0),
    sell("A", MIN, 1.25),
    buy("B", 2 * MIN),
    sell("B", 3 * MIN, 0.5, "stop-loss déclenché"),
    // 2 h plus tard : nouvelle session
    buy("C", 120 * MIN),
    sell("C", 121 * MIN, 1.25),
    buy("D", 122 * MIN),
    sell("D", 123 * MIN, null, "délai dépassé"),
    buy("E", 124 * MIN), // jamais vendu
  ];

  it("calcule la moyenne, les trades gagnants et le résultat en SOL", () => {
    const r = analyzePaperTrades(entries);
    assert.equal(r.buys, 5);
    assert.equal(r.closedTrades, 3);
    assert.equal(r.unpriced, 1);
    assert.equal(r.stillOpen, 1);
    assert.ok(Math.abs(r.meanGross - (1.25 + 0.5 + 1.25) / 3) < 1e-9);
    assert.ok(Math.abs(r.winRatePercent - 200 / 3) < 1e-9);
    // 0,1 SOL de mise : +0,025 − 0,05 + 0,025 = 0
    assert.ok(Math.abs(r.pnlGrossSol) < 1e-9);
    // 3 trades × (−3 % de 0,1 SOL) de frais
    assert.ok(Math.abs(r.pnlNetSol - -0.009) < 1e-9);
  });

  it("compte les motifs de sortie, y compris pour les ventes non chiffrées", () => {
    const r = analyzePaperTrades(entries);
    assert.deepEqual(r.exitReasons, { "objectif atteint": 2, "stop-loss déclenché": 1, "délai dépassé": 1 });
  });

  it("découpe en sessions selon les trous d'activité", () => {
    const r = analyzePaperTrades(entries);
    assert.equal(r.sessions.length, 2);
    assert.equal(r.sessions[0].trades, 2);
    assert.equal(r.sessions[1].trades, 1);
    assert.ok(Math.abs(r.sessions[0].meanGross - 0.875) < 1e-9);
  });

  it("ignore les ordres échoués", () => {
    const failed: TradeLogEntry = { ...sell("Z", 5 * MIN, 9), success: false };
    assert.equal(analyzePaperTrades([...entries, failed]).closedTrades, 3);
  });
});
