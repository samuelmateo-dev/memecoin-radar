import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { PositionManager } from "../src/execution/positionManager.js";
import { PaperBroker, type Broker, type TradeResult } from "../src/execution/broker.js";
import { loadConfig } from "../src/config.js";
import { makeTmpDir } from "./helpers.js";

class RecordingBroker implements Broker {
  calls: Array<{ side: "buy" | "sell"; mint: string }> = [];
  buyResult: TradeResult = { success: true, paper: true };
  async buy(mint: string): Promise<TradeResult> {
    this.calls.push({ side: "buy", mint });
    return this.buyResult;
  }
  async sell(mint: string): Promise<TradeResult> {
    this.calls.push({ side: "sell", mint });
    return { success: true, paper: true };
  }
}

const paper = loadConfig({}).paper; // objectif ×1,25, stop ×0,5, 15 min, 3 positions max

describe("PositionManager", () => {
  let broker: RecordingBroker;
  let clock: number;
  let logFile: string;
  let pm: PositionManager;
  const dir = makeTmpDir();
  let counter = 0;

  beforeEach(() => {
    broker = new RecordingBroker();
    clock = 1_000_000;
    logFile = path.join(dir, `trades-${counter++}.jsonl`);
    pm = new PositionManager(broker, paper, logFile, () => clock);
  });

  const open = (mint: string, entry = 100) =>
    pm.tryOpen({ mint, name: mint, symbol: mint.toUpperCase(), entryMarketCapSol: entry });
  const logged = () =>
    existsSync(logFile)
      ? readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
      : [];

  it("ouvre une position et journalise l'achat", async () => {
    await open("a");
    assert.equal(pm.openCount, 1);
    assert.deepEqual(broker.calls, [{ side: "buy", mint: "a" }]);
    const [entry] = logged();
    assert.equal(entry.type, "buy");
    assert.equal(entry.paper, true);
    assert.equal(entry.amountSol, 0.1);
  });

  it("vend à l'objectif de gain (×1,25)", async () => {
    await open("a", 100);
    await pm.onTrade("a", 120); // pas encore
    assert.equal(pm.openCount, 1);
    await pm.onTrade("a", 126);
    assert.equal(pm.openCount, 0);
    const sell = logged().find((e) => e.type === "sell");
    assert.equal(sell.reason, "objectif atteint");
    assert.ok(Math.abs(sell.multipleAtSale - 1.26) < 1e-9);
  });

  it("vend au stop-loss (×0,5)", async () => {
    await open("a", 100);
    await pm.onTrade("a", 51);
    assert.equal(pm.openCount, 1);
    await pm.onTrade("a", 50);
    assert.equal(pm.openCount, 0);
    assert.equal(logged().find((e) => e.type === "sell").reason, "stop-loss déclenché");
  });

  it("vend au délai maximum au dernier prix connu", async () => {
    await open("a", 100);
    await pm.onTrade("a", 90);
    clock += paper.maxHoldTimeMs - 1;
    await pm.checkTimeouts();
    assert.equal(pm.openCount, 1);
    clock += 1;
    await pm.checkTimeouts();
    assert.equal(pm.openCount, 0);
    const sell = logged().find((e) => e.type === "sell");
    assert.equal(sell.reason, "délai dépassé");
    assert.ok(Math.abs(sell.multipleAtSale - 0.9) < 1e-9);
    assert.equal(sell.heldForMs, paper.maxHoldTimeMs);
  });

  it("respecte le nombre maximum de positions, même pour des achats simultanés", async () => {
    await Promise.all(["a", "b", "c", "d", "e"].map((m) => open(m)));
    assert.equal(pm.openCount, 3);
    assert.equal(broker.calls.filter((c) => c.side === "buy").length, 3);
  });

  it("n'ouvre pas deux positions sur le même token", async () => {
    await open("a");
    await open("a");
    assert.equal(broker.calls.length, 1);
  });

  it("libère la place si l'achat échoue", async () => {
    broker.buyResult = { success: false, paper: true, error: "boom" };
    await open("a");
    assert.equal(pm.openCount, 0);
    assert.equal(logged()[0].success, false);
  });

  it("ignore les trades d'un token sans position", async () => {
    await pm.onTrade("inconnu", 999);
    assert.equal(broker.calls.length, 0);
  });

  it("ne vend qu'une fois, même si plusieurs trades arrivent en rafale", async () => {
    await open("a", 100);
    await Promise.all([pm.onTrade("a", 130), pm.onTrade("a", 131), pm.onTrade("a", 132)]);
    assert.equal(broker.calls.filter((c) => c.side === "sell").length, 1);
  });
});

describe("PaperBroker", () => {
  it("ne fait jamais de transaction réelle", async () => {
    const b = new PaperBroker();
    const log = console.log;
    console.log = () => {};
    try {
      const buy = await b.buy("m", 0.1);
      const sell = await b.sell("m", "100%");
      assert.deepEqual([buy.success, buy.paper, sell.success, sell.paper], [true, true, true, true]);
      assert.equal(buy.signature, undefined);
    } finally {
      console.log = log;
    }
  });
});
