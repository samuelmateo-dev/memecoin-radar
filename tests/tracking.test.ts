import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { OutcomeTracker, SNAPSHOT_INTERVAL_MS } from "../src/tracking/outcomeTracker.js";
import { WaveDetector, normalizeName } from "../src/tracking/waveDetector.js";
import type { ScoreSignals } from "../src/types.js";
import { makeTmpDir } from "./helpers.js";

const signals: ScoreSignals = {
  uniqueBuyers: 10,
  buySellRatio: 2,
  topHolderPercent: 60,
  hasTwitterLink: false,
  authoritiesRevoked: true,
  devBuyPercent: 3,
};

describe("OutcomeTracker", () => {
  const dir = makeTmpDir();
  const start = (tracker: OutcomeTracker, mint = "m", alertedAt = 0) =>
    tracker.start({
      mint,
      name: "Nom",
      symbol: "SYM",
      alertedAt,
      score: 80,
      entryMarketCapSol: 100,
      alerted: true,
      signals,
    });

  it("mesure le pic et écrit une ligne JSON à la fin du suivi", async () => {
    const file = path.join(dir, "a", "outcomes.jsonl"); // le dossier est créé à la volée
    let clock = 0;
    const tracker = new OutcomeTracker(file, () => clock);
    start(tracker);

    tracker.onTrade("m", 130, 1_000);
    tracker.onTrade("m", 180, 2_000);
    tracker.onTrade("m", 120, 3_000);
    clock = 60_000;
    const outcome = await tracker.finish("m");

    assert.equal(outcome?.peakMarketCapSol, 180);
    assert.equal(outcome?.peakAt, 2_000);
    assert.ok(Math.abs(outcome!.multiple - 1.8) < 1e-9);
    assert.equal(outcome?.trackingEndedAt, 60_000);
    assert.equal(tracker.activeCount, 0);

    const lines = readFileSync(file, "utf8").trim().split("\n");
    assert.equal(lines.length, 1);
    assert.equal(JSON.parse(lines[0]).mint, "m");
  });

  it("enregistre un point de prix au plus toutes les 10 s", async () => {
    const tracker = new OutcomeTracker(path.join(dir, "b.jsonl"), () => 0);
    start(tracker);
    tracker.onTrade("m", 101, 3_000);
    tracker.onTrade("m", 102, SNAPSHOT_INTERVAL_MS - 1);
    tracker.onTrade("m", 103, SNAPSHOT_INTERVAL_MS);
    tracker.onTrade("m", 104, SNAPSHOT_INTERVAL_MS + 5_000);
    tracker.onTrade("m", 105, 2 * SNAPSHOT_INTERVAL_MS);
    const outcome = await tracker.finish("m");
    assert.deepEqual(
      outcome?.priceHistory.map((p) => p.marketCapSol),
      [100, 103, 105]
    );
  });

  it("ignore les trades et les fins de suivi sur un token non suivi", async () => {
    const tracker = new OutcomeTracker(path.join(dir, "c.jsonl"), () => 0);
    tracker.onTrade("inconnu", 999, 0);
    assert.equal(await tracker.finish("inconnu"), null);
  });

  it("tagWave marque un suivi existant sans écraser son historique", async () => {
    const tracker = new OutcomeTracker(path.join(dir, "d.jsonl"), () => 0);
    start(tracker);
    tracker.onTrade("m", 150, 20_000);
    assert.equal(tracker.has("m"), true);
    tracker.tagWave("m", 1);
    const outcome = await tracker.finish("m");
    assert.equal(outcome?.waveRank, 1);
    assert.equal(outcome?.score, 80);
    assert.equal(outcome?.alerted, true);
    assert.equal(outcome?.priceHistory.length, 2);
  });
});

describe("WaveDetector", () => {
  const rec = (d: WaveDetector, i: number, name = "Pepe") =>
    d.record({ mint: `m${i}`, name, entryMarketCapSol: 30 + i });

  it("normalise les noms (casse, espaces)", () => {
    assert.equal(normalizeName("  PEPE   Coin "), "pepe coin");
  });

  it("déclenche une seule fois, au 4e token, sur les 2 premiers", () => {
    const d = new WaveDetector({ now: () => 0 });
    assert.deepEqual(rec(d, 1), []);
    assert.deepEqual(rec(d, 2), []);
    assert.deepEqual(rec(d, 3), []);
    const hits = rec(d, 4);
    assert.deepEqual(
      hits.map((h) => h.mint),
      ["m1", "m2"]
    );
    assert.deepEqual(rec(d, 5), []);
    assert.deepEqual(rec(d, 6), []);
  });

  it("regroupe des noms qui ne diffèrent que par la casse ou les espaces", () => {
    const d = new WaveDetector({ now: () => 0 });
    rec(d, 1, "Pepe Coin");
    rec(d, 2, "pepe coin");
    rec(d, 3, " PEPE  COIN");
    assert.equal(rec(d, 4, "Pepe coin").length, 2);
  });

  it("ne mélange pas des noms différents", () => {
    const d = new WaveDetector({ now: () => 0 });
    rec(d, 1, "A");
    rec(d, 2, "B");
    rec(d, 3, "C");
    assert.deepEqual(rec(d, 4, "D"), []);
  });

  it("repart de zéro une fois la fenêtre de 10 minutes écoulée", () => {
    let clock = 0;
    const d = new WaveDetector({ now: () => clock });
    rec(d, 1);
    rec(d, 2);
    rec(d, 3);
    clock = 10 * 60_000 + 1;
    assert.deepEqual(rec(d, 4), []); // nouvelle vague : 1er token seulement
  });

  it("nettoie les groupes expirés", () => {
    let clock = 0;
    const d = new WaveDetector({ now: () => clock });
    rec(d, 1, "A");
    rec(d, 2, "B");
    assert.equal(d.bucketCount, 2);
    clock = 10 * 60_000 + 1;
    d.cleanup();
    assert.equal(d.bucketCount, 0);
  });
});
