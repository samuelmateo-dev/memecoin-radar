import { afterEach, beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { Radar } from "../src/radar.js";
import { loadConfig } from "../src/config.js";
import { OutcomeTracker } from "../src/tracking/outcomeTracker.js";
import { WaveDetector } from "../src/tracking/waveDetector.js";
import { PositionManager } from "../src/execution/positionManager.js";
import type { Broker, TradeResult } from "../src/execution/broker.js";
import type { TokenSource } from "../src/sources/pumpListener.js";
import type { Notifier } from "../src/notify/telegramNotifier.js";
import type { AlertOutcome, CandidateStats, ScoreBreakdown } from "../src/types.js";
import { buyersTrades, makeNewTokenEvent, makeTmpDir } from "./helpers.js";

// ---- faux services -----------------------------------------------------------------

class FakeSource extends EventEmitter implements TokenSource {
  tracked = new Set<string>();
  connected = false;
  connect() {
    this.connected = true;
  }
  trackMint(m: string) {
    this.tracked.add(m);
  }
  untrackMint(m: string) {
    this.tracked.delete(m);
  }
  get trackedCount() {
    return this.tracked.size;
  }
}

class FakeNotifier implements Notifier {
  alerts: string[] = [];
  reports: AlertOutcome[] = [];
  notices: string[] = [];
  async sendAlert(c: CandidateStats) {
    this.alerts.push(c.mint);
  }
  async sendOutcomeReport(o: AlertOutcome) {
    this.reports.push(o);
  }
  async sendConnectivityNotice(t: string) {
    this.notices.push(t);
  }
}

class FakeBroker implements Broker {
  calls: string[] = [];
  async buy(mint: string): Promise<TradeResult> {
    this.calls.push(`buy:${mint}`);
    return { success: true, paper: true };
  }
  async sell(mint: string): Promise<TradeResult> {
    this.calls.push(`sell:${mint}`);
    return { success: true, paper: true };
  }
}

/** Planificateur manuel : le temps n'avance que quand le test le décide. */
class ManualScheduler {
  tasks: Array<{ fn: () => void; ms: number }> = [];
  schedule = (fn: () => void, ms: number) => void this.tasks.push({ fn, ms });
  get pending() {
    return this.tasks.length;
  }
  /** Exécute (et retire) les tâches planifiées avec ce délai. */
  run(ms: number) {
    const due = this.tasks.filter((t) => t.ms === ms);
    this.tasks = this.tasks.filter((t) => t.ms !== ms);
    due.forEach((t) => t.fn());
  }
}

async function waitFor(cond: () => boolean, label: string, timeoutMs = 2000) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) assert.fail(`délai dépassé en attendant : ${label}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

const readLines = (file: string) =>
  existsSync(file)
    ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
    : [];

// ---- montage -----------------------------------------------------------------------

function setup(options: { env?: Record<string, string>; score?: Partial<ScoreBreakdown>; signals?: Partial<ScoreBreakdown["signals"]>; solUsd?: number | null } = {}) {
  const dir = makeTmpDir();
  const config = loadConfig(options.env ?? {});
  const source = new FakeSource();
  const scheduler = new ManualScheduler();
  const notifier = new FakeNotifier();
  const broker = new FakeBroker();
  let clock = 1_000_000;
  const outcomesFile = path.join(dir, "outcomes.jsonl");
  const tradesFile = path.join(dir, "paper-trades.jsonl");
  const tracker = new OutcomeTracker(outcomesFile, () => clock);
  const positions = new PositionManager(broker, config.paper, tradesFile, () => clock);
  const scored: string[] = [];

  const scorer = {
    score: async (c: CandidateStats): Promise<ScoreBreakdown> => {
      scored.push(c.mint);
      return {
        mint: c.mint,
        totalScore: 80,
        reasons: [],
        passed: true,
        signals: {
          uniqueBuyers: 8,
          buySellRatio: 2,
          topHolderPercent: 60,
          hasTwitterLink: false,
          authoritiesRevoked: true,
          devBuyPercent: 3,
          ...options.signals,
        },
        ...options.score,
      };
    },
  };

  const radar = new Radar({
    config,
    source,
    scorer,
    notifier,
    tracker,
    positions,
    waves: new WaveDetector({ now: () => clock }),
    getSolUsdPrice: async () => (options.solUsd === undefined ? 100 : options.solUsd),
    now: () => clock,
    schedule: scheduler.schedule,
  });
  radar.attach();

  /** Lance un token : événement de création puis `buyers` achats jusqu'à `finalMc`. */
  const launch = (mint: string, buyers: number, finalMc = 60, name = mint) => {
    source.emit("newToken", makeNewTokenEvent({ mint, name, symbol: name.toUpperCase().slice(0, 4) }));
    for (const t of buyersTrades(buyers, finalMc, mint)) source.emit("trade", t);
  };

  return {
    config, source, scheduler, notifier, broker, tracker, scored, outcomesFile, tradesFile, launch,
    advance: (ms: number) => void (clock += ms),
    outcomes: () => readLines(outcomesFile),
    trades: () => readLines(tradesFile),
  };
}

// ---- tests -------------------------------------------------------------------------

describe("Radar — pipeline de bout en bout", () => {
  const silenced: Array<ReturnType<typeof mock.method>> = [];
  beforeEach(() => {
    for (const m of ["log", "warn", "error"] as const) silenced.push(mock.method(console, m, () => {}));
  });
  afterEach(() => {
    while (silenced.length) silenced.pop()!.mock.restore();
  });

  it("token prometteur : score, alerte, position papier, suivi, résultat journalisé", async () => {
    const t = setup();
    t.launch("M1", 8, 60); // 8 acheteurs, market cap ×2

    assert.equal(t.source.tracked.has("M1"), true, "le token est suivi pendant l'observation");
    assert.equal(t.scheduler.pending, 1);

    t.scheduler.run(45_000); // fin de la fenêtre d'observation
    await waitFor(() => t.tracker.has("M1"), "début du suivi");

    assert.deepEqual(t.scored, ["M1"]);
    assert.deepEqual(t.notifier.alerts, ["M1"]);
    assert.deepEqual(t.broker.calls, ["buy:M1"]); // top 10 holders à 60 % < 80 %
    await waitFor(() => t.trades().length === 1, "journal de l'achat");
    assert.equal(t.trades()[0].entryMarketCapSol, 60);

    // le prix atteint l'objectif ×1,25 (60 → 75) : la position papier est clôturée
    t.advance(30_000);
    t.source.emit("trade", { ...buyersTrades(1, 76, "M1")[0], traderPublicKey: "late", marketCapSol: 76 });
    await waitFor(() => t.broker.calls.includes("sell:M1"), "vente sur objectif");
    await waitFor(() => t.trades().length === 2, "journal de la vente");
    assert.equal(t.trades()[1].reason, "objectif atteint");

    // fin de la fenêtre de suivi : le résultat est écrit et notifié
    t.advance(15 * 60_000);
    t.scheduler.run(15 * 60_000);
    await waitFor(() => t.notifier.reports.length === 1, "rapport de résultat");

    const [outcome] = t.outcomes();
    assert.equal(outcome.mint, "M1");
    assert.equal(outcome.alerted, true);
    assert.equal(outcome.score, 80);
    assert.ok(Math.abs(outcome.multiple - 76 / 60) < 1e-9);
    assert.equal(t.source.tracked.has("M1"), false, "le suivi du flux est libéré");
  });

  it("filtre gratuit : un token sans traction n'est jamais noté ni suivi", async () => {
    const t = setup();
    t.launch("DEAD", 2, 40);
    t.scheduler.run(45_000);
    await waitFor(() => !t.source.tracked.has("DEAD"), "libération du token");

    assert.deepEqual(t.scored, []);
    assert.deepEqual(t.notifier.alerts, []);
    assert.equal(t.tracker.activeCount, 0);
    assert.deepEqual(t.broker.calls, []);
  });

  it("alerte sans acheter quand les holders sont trop concentrés", async () => {
    const t = setup({ signals: { topHolderPercent: 85 } });
    t.launch("M2", 8, 60);
    t.scheduler.run(45_000);
    await waitFor(() => t.tracker.has("M2"), "début du suivi");

    assert.deepEqual(t.notifier.alerts, ["M2"]);
    assert.deepEqual(t.broker.calls, []);
  });

  it("ne notifie pas un candidat sous le seuil, mais le suit pour la calibration", async () => {
    const t = setup({ score: { totalScore: 40, passed: false } });
    t.launch("LOW", 8, 60);
    t.scheduler.run(45_000);
    await waitFor(() => t.tracker.has("LOW"), "suivi de calibration");

    assert.deepEqual(t.notifier.alerts, []);
    assert.deepEqual(t.broker.calls, []);

    t.scheduler.run(5 * 60_000); // fenêtre plus courte pour les non-alertés
    await waitFor(() => t.outcomes().length === 1, "résultat journalisé");
    assert.equal(t.outcomes()[0].alerted, false);
    assert.equal(t.notifier.reports.length, 0, "pas de rapport pour un candidat non alerté");
  });

  it("abandonne l'échantillonnage d'un non-alerté quand la capacité de suivi est saturée", async () => {
    const t = setup({ env: { MAX_CONCURRENT_TRACKED: "1" }, score: { totalScore: 40, passed: false } });
    t.launch("FULL", 8, 60);
    t.scheduler.run(45_000);
    await waitFor(() => !t.source.tracked.has("FULL"), "libération de la place");
    assert.equal(t.tracker.has("FULL"), false);
  });

  it("ignore les nouveaux tokens quand la limite de suivi du flux est atteinte", () => {
    const t = setup({ env: { MAX_CONCURRENT_TRACKED: "2" } });
    t.launch("A", 1);
    t.launch("B", 1);
    t.launch("C", 1);
    assert.equal(t.source.trackedCount, 2);
    assert.equal(t.source.tracked.has("C"), false);
    assert.equal(t.scheduler.pending, 2);
  });

  it("ignore les événements de création incomplets", () => {
    const t = setup();
    t.source.emit("newToken", makeNewTokenEvent({ name: "" }));
    t.source.emit("newToken", makeNewTokenEvent({ mint: "" }));
    assert.equal(t.source.trackedCount, 0);
    assert.equal(t.scheduler.pending, 0);
  });

  it("vague de noms identiques : suit de force les deux premiers tokens", async () => {
    const t = setup();
    for (const mint of ["W1", "W2", "W3", "W4"]) t.launch(mint, 1, 31, "Pepe"); // aucun ne passe le filtre
    t.scheduler.run(45_000);
    await waitFor(() => t.tracker.has("W1") && t.tracker.has("W2"), "suivi forcé de la vague");

    assert.equal(t.tracker.has("W3"), false);
    assert.equal(t.source.tracked.has("W1"), true);
    assert.equal(t.source.tracked.has("W3"), false);

    t.scheduler.run(15 * 60_000);
    await waitFor(() => t.outcomes().length === 2, "résultats de vague");
    const byMint = Object.fromEntries(t.outcomes().map((o) => [o.mint, o]));
    assert.equal(byMint.W1.waveRank, 1);
    assert.equal(byMint.W2.waveRank, 2);
    assert.equal(byMint.W1.score, -1);
  });

  it("vague de noms : n'écrase pas le suivi d'un token déjà noté", async () => {
    const t = setup();
    t.launch("A", 8, 60, "Pepe"); // 1er de la vague, passe le filtre et le score
    t.scheduler.run(45_000);
    await waitFor(() => t.tracker.has("A"), "suivi du 1er token");

    for (const mint of ["B", "C", "D"]) t.launch(mint, 1, 31, "Pepe");
    t.scheduler.run(45_000);
    await waitFor(() => t.tracker.has("B"), "détection de la vague");

    t.advance(15 * 60_000);
    t.scheduler.run(15 * 60_000);
    await waitFor(() => t.outcomes().length === 2, "résultats");
    const a = t.outcomes().find((o) => o.mint === "A");
    assert.equal(a.waveRank, 1, "la vague est notée");
    assert.equal(a.score, 80, "le score d'origine est conservé");
    assert.equal(a.alerted, true);
    assert.ok(a.priceHistory.length >= 1);
    assert.equal(t.notifier.reports.length, 1, "le rapport de résultat est bien envoyé");
  });

  it("prévient en cas de longue coupure du flux, pas en cas de coupure brève", () => {
    const t = setup();
    t.source.emit("disconnected");
    t.source.emit("reconnected", 30_000);
    assert.equal(t.notifier.notices.length, 0);
    t.source.emit("reconnected", 5 * 60_000);
    assert.equal(t.notifier.notices.length, 1);
    assert.ok(t.notifier.notices[0].includes("5 min"));
  });

  it("start() connecte la source et retourne une fonction d'arrêt", () => {
    const t = setup();
    const radar = new Radar({
      config: t.config,
      source: t.source,
      scorer: { score: async () => assert.fail("inutile") },
      notifier: t.notifier,
      tracker: t.tracker,
      positions: new PositionManager(t.broker, t.config.paper, t.tradesFile),
      waves: new WaveDetector(),
      getSolUsdPrice: async () => null,
    });
    const stop = radar.start();
    assert.equal(t.source.connected, true);
    stop(); // sans cela, les minuteries périodiques garderaient le processus en vie
  });
});
