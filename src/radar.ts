import type { Config } from "./config.js";
import type { TokenSource } from "./sources/pumpListener.js";
import type { Notifier } from "./notify/telegramNotifier.js";
import type { OutcomeTracker } from "./tracking/outcomeTracker.js";
import type { WaveDetector } from "./tracking/waveDetector.js";
import type { PositionManager } from "./execution/positionManager.js";
import { lastMarketCapOf, passesStage1, uniqueBuyersOf } from "./scoring/scoring.js";
import type { CandidateStats, PumpNewTokenEvent, PumpTradeEvent, ScoreBreakdown } from "./types.js";

export interface RadarDeps {
  config: Config;
  source: TokenSource;
  scorer: { score(candidate: CandidateStats): Promise<ScoreBreakdown> };
  notifier: Notifier;
  tracker: OutcomeTracker;
  positions: PositionManager;
  waves: WaveDetector;
  getSolUsdPrice: () => Promise<number | null>;
  now?: () => number;
  /** Planifie une action différée. Remplaçable dans les tests pour contrôler le temps. */
  schedule?: (fn: () => void, delayMs: number) => void;
}

/**
 * Orchestrateur du pipeline :
 *
 *   flux → observation (45 s) → stage 1 (gratuit) → stage 2 (enrichissement + score)
 *        → alerte / position papier → suivi du prix → résultat journalisé
 *
 * Toutes les dépendances sont injectées : le même code tourne en production (flux WebSocket,
 * Helius, Telegram) et dans les tests (flux simulé, faux clients, horloge contrôlée).
 */
export class Radar {
  private readonly candidates = new Map<string, CandidateStats>();
  private readonly now: () => number;
  private readonly schedule: (fn: () => void, delayMs: number) => void;

  constructor(private readonly deps: RadarDeps) {
    this.now = deps.now ?? Date.now;
    this.schedule = deps.schedule ?? ((fn, ms) => void setTimeout(fn, ms));
  }

  /** Branche les écouteurs sur la source sans se connecter (utile en test). */
  attach(): void {
    const { source, notifier } = this.deps;
    source.on("newToken", (evt: PumpNewTokenEvent) => this.onNewToken(evt));
    source.on("trade", (evt: PumpTradeEvent) => this.onTrade(evt));
    source.on("disconnected", () => {
      console.warn("[radar] Connexion au flux perdue, tentative de reconnexion...");
    });
    source.on("reconnected", (downtimeMs: number) => {
      console.log(`[radar] Reconnecté après ${Math.round(downtimeMs / 1000)}s de coupure.`);
      if (downtimeMs > 2 * 60_000) {
        notifier
          .sendConnectivityNotice(
            `⚠️ Le bot a été déconnecté du flux pendant ${Math.round(downtimeMs / 60000)} min avant de se reconnecter. Aucun token n'a pu être détecté pendant cette période.`
          )
          .catch((err) => console.error("[radar] Échec de la notice de connectivité:", err));
      }
    });
  }

  /** Démarre le pipeline. Retourne une fonction qui arrête les tâches périodiques. */
  start(): () => void {
    this.attach();
    this.deps.source.connect();

    // Vend les positions qui ont dépassé leur délai maximum sans atteindre l'objectif.
    const timeouts = setInterval(() => {
      this.deps.positions
        .checkTimeouts()
        .catch((err) => console.error("[radar] Erreur lors de la vérification des délais:", err));
    }, 15_000);
    const cleanup = setInterval(() => this.deps.waves.cleanup(), 60_000);

    return () => {
      clearInterval(timeouts);
      clearInterval(cleanup);
    };
  }

  onNewToken(evt: PumpNewTokenEvent): void {
    if (!evt.mint || !evt.name || !evt.symbol) {
      // Événement incomplet (autre type de création mélangé dans le flux) : on l'ignore.
      return;
    }
    console.log(`[+] Nouveau token: ${evt.name} (${evt.symbol}) — ${evt.mint}`);

    // Capacité de suivi des trades atteinte (limite du service de données) : on ignore ce
    // token plutôt que d'envoyer une souscription qui serait rejetée.
    if (this.deps.source.trackedCount >= this.deps.config.maxConcurrentTracked) return;

    this.candidates.set(evt.mint, {
      mint: evt.mint,
      name: evt.name,
      symbol: evt.symbol,
      creator: evt.traderPublicKey,
      createdAt: this.now(),
      initialBuySol: evt.solAmount,
      startMarketCapSol: evt.marketCapSol,
      metadataUri: evt.uri,
      trades: [],
      evaluated: false,
    });
    this.deps.source.trackMint(evt.mint);

    this.schedule(() => {
      this.evaluateCandidate(evt.mint).catch((err) =>
        console.error(`[radar] Erreur d'évaluation pour ${evt.mint}:`, err)
      );
    }, this.deps.config.observationWindowMs);
  }

  onTrade(evt: PumpTradeEvent): void {
    const candidate = this.candidates.get(evt.mint);
    if (candidate && !candidate.evaluated) candidate.trades.push(evt);

    // Met à jour le pic d'un mint en cours de suivi (sans effet sinon).
    this.deps.tracker.onTrade(evt.mint, evt.marketCapSol, this.now());

    // Vend si une position papier ouverte sur ce mint atteint son objectif ou son stop.
    this.deps.positions
      .onTrade(evt.mint, evt.marketCapSol)
      .catch((err) => console.error(`[radar] Erreur de vérification de position pour ${evt.mint}:`, err));
  }

  async evaluateCandidate(mint: string): Promise<void> {
    const { config, source, scorer, notifier, tracker, positions, waves } = this.deps;
    const candidate = this.candidates.get(mint);
    if (!candidate || candidate.evaluated) return;
    candidate.evaluated = true;

    console.log(
      `[eval] ${candidate.name}: ${candidate.trades.length} trades observés, ${uniqueBuyersOf(candidate)} acheteurs uniques`
    );

    // Détection de vague de noms similaires : indépendante du stage 1, puisque la plupart des
    // copies sont du spam sans acheteurs. On force le suivi des 1er/2e tokens dès que le seuil
    // est atteint, même si CE candidat échoue au stage 1.
    const waveHits = waves.record({
      mint: candidate.mint,
      name: candidate.name,
      entryMarketCapSol: lastMarketCapOf(candidate),
    });
    for (const [i, hit] of waveHits.entries()) {
      const rank = (i + 1) as 1 | 2;
      console.log(`[radar] ${hit.name}: ${rank}er/e apparu d'une vague de noms similaires — suivi forcé`);
      source.trackMint(hit.mint); // re-souscrit si on l'avait relâché après un échec du stage 1
      if (tracker.has(hit.mint)) {
        // Déjà suivi avec son score : on ajoute l'information de vague sans écraser l'historique.
        tracker.tagWave(hit.mint, rank);
      } else {
        tracker.start({
          mint: hit.mint,
          name: hit.name,
          symbol: "",
          alertedAt: this.now(),
          score: -1, // n'a pas de sens ici : ce suivi ne vient pas du système de score
          entryMarketCapSol: hit.entryMarketCapSol,
          alerted: false,
          signals: {
            uniqueBuyers: 0,
            buySellRatio: 0,
            topHolderPercent: null,
            hasTwitterLink: false,
            authoritiesRevoked: null,
            devBuyPercent: 0,
          },
          waveRank: rank,
        });
      }
      this.schedule(() => {
        tracker
          .finish(hit.mint)
          .then(() => source.untrackMint(hit.mint))
          .catch((err) => console.error(`[radar] Erreur de suivi de vague pour ${hit.mint}:`, err));
      }, config.paper.maxHoldTimeMs);
    }

    if (!passesStage1(candidate, config.stage1)) {
      source.untrackMint(mint);
      this.candidates.delete(mint);
      return;
    }

    console.log(`[stage1 ✓] ${candidate.name} passe le premier filtre — enrichissement en cours...`);
    const result = await scorer.score(candidate);
    console.log(`[score] ${candidate.name}: ${result.totalScore}/100`, result.reasons);

    const entryMarketCapSol = lastMarketCapOf(candidate);

    if (result.passed) {
      await notifier.sendAlert(candidate, result);

      // Position papier uniquement sur le sous-groupe le mieux noté : score au-dessus du seuil
      // ET concentration des holders dans la « zone idéale ».
      if (result.signals.topHolderPercent !== null && result.signals.topHolderPercent < config.paper.buyMaxHolderPercent) {
        positions
          .tryOpen({ mint: candidate.mint, name: candidate.name, symbol: candidate.symbol, entryMarketCapSol })
          .catch((err) => console.error(`[radar] Erreur d'ouverture de position pour ${candidate.name}:`, err));
      }
    }

    // Hypothèse « market cap d'entrée élevé + lien X » : suivie même si la capacité est
    // serrée, sinon on ne mesurerait jamais ces cas simplement parce que le bot était occupé
    // ailleurs au même moment — ce qui fausserait la mesure.
    const solPrice = await this.deps.getSolUsdPrice();
    const entryMarketCapUsd = solPrice ? entryMarketCapSol * solPrice : null;
    const matchesHypothesis =
      entryMarketCapUsd !== null &&
      entryMarketCapUsd >= config.hypothesisMinEntryMcUsd &&
      result.signals.hasTwitterLink;

    // Qu'il alerte ou non, on garde une trace du résultat réel pour calibrer le score : sinon
    // on ne saurait jamais si un score de 50 aurait fait aussi bien qu'un score de 75.
    const headroom = config.maxConcurrentTracked - source.trackedCount;
    if (!result.passed && !matchesHypothesis && headroom < config.minTrackingHeadroom) {
      console.log(
        `[radar] ${candidate.name}: échantillon non alerté ignoré (capacité: ${source.trackedCount}/${config.maxConcurrentTracked})`
      );
      source.untrackMint(mint);
      this.candidates.delete(mint);
      return;
    }

    tracker.start({
      mint: candidate.mint,
      name: candidate.name,
      symbol: candidate.symbol,
      alertedAt: this.now(),
      score: result.totalScore,
      entryMarketCapSol,
      alerted: result.passed,
      signals: result.signals,
    });

    const trackingWindowMs = result.passed ? config.postAlertTrackingMs : config.scoringTrackingMs;
    this.schedule(() => {
      tracker
        .finish(mint)
        .then((outcome) => {
          source.untrackMint(mint);
          if (outcome?.alerted) return notifier.sendOutcomeReport(outcome);
        })
        .catch((err) => console.error(`[radar] Erreur de suivi pour ${mint}:`, err));
    }, trackingWindowMs);

    this.candidates.delete(mint);
  }
}
