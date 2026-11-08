import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { AlertOutcome, PricePoint, ScoreSignals } from "../types.js";

// Un point de prix toutes les ~10 s : assez fin pour voir la vitesse réelle de la montée ou
// de la chute (ça bouge vite), sans faire exploser la taille du log des tokens très actifs.
export const SNAPSHOT_INTERVAL_MS = 10_000;

interface TrackedOutcome {
  mint: string;
  name: string;
  symbol: string;
  alertedAt: number;
  score: number;
  entryMarketCapSol: number;
  peakMarketCapSol: number;
  peakAt: number;
  alerted: boolean;
  signals: ScoreSignals;
  priceHistory: PricePoint[];
  lastSnapshotAt: number;
  waveRank?: 1 | 2;
}

export interface StartTrackingParams {
  mint: string;
  name: string;
  symbol: string;
  alertedAt: number;
  score: number;
  entryMarketCapSol: number;
  alerted: boolean;
  signals: ScoreSignals;
  waveRank?: 1 | 2;
}

/**
 * Suit le prix d'un token après sa notation (alerté ou non) pour mesurer ce qui se passe
 * réellement ensuite. Chaque résultat terminé est ajouté en une ligne JSON au fichier de log.
 *
 * L'état en cours est volontairement en mémoire : si le processus s'arrête avant la fin de la
 * fenêtre de suivi, le résultat en cours est perdu (limite assumée, voir README).
 */
export class OutcomeTracker {
  private readonly tracked = new Map<string, TrackedOutcome>();

  constructor(
    private readonly logFile: string,
    private readonly now: () => number = Date.now
  ) {}

  get activeCount(): number {
    return this.tracked.size;
  }

  has(mint: string): boolean {
    return this.tracked.has(mint);
  }

  /** Marque un suivi déjà en cours comme appartenant à une vague de noms, sans toucher à son historique. */
  tagWave(mint: string, rank: 1 | 2): void {
    const entry = this.tracked.get(mint);
    if (entry) entry.waveRank = rank;
  }

  start(params: StartTrackingParams): void {
    this.tracked.set(params.mint, {
      ...params,
      peakMarketCapSol: params.entryMarketCapSol,
      peakAt: params.alertedAt,
      priceHistory: [{ t: params.alertedAt, marketCapSol: params.entryMarketCapSol }],
      lastSnapshotAt: params.alertedAt,
    });
  }

  /** À appeler à chaque trade reçu. Sans effet si ce mint n'est pas suivi. */
  onTrade(mint: string, marketCapSol: number, timestamp: number = this.now()): void {
    const entry = this.tracked.get(mint);
    if (!entry) return;
    if (marketCapSol > entry.peakMarketCapSol) {
      entry.peakMarketCapSol = marketCapSol;
      entry.peakAt = timestamp;
    }
    if (timestamp - entry.lastSnapshotAt >= SNAPSHOT_INTERVAL_MS) {
      entry.priceHistory.push({ t: timestamp, marketCapSol });
      entry.lastSnapshotAt = timestamp;
    }
  }

  async finish(mint: string): Promise<AlertOutcome | null> {
    const entry = this.tracked.get(mint);
    if (!entry) return null;
    this.tracked.delete(mint);

    const { lastSnapshotAt: _ignored, ...rest } = entry;
    const outcome: AlertOutcome = {
      ...rest,
      trackingEndedAt: this.now(),
      multiple: entry.entryMarketCapSol > 0 ? entry.peakMarketCapSol / entry.entryMarketCapSol : 0,
    };

    try {
      await mkdir(path.dirname(this.logFile), { recursive: true });
      await appendFile(this.logFile, JSON.stringify(outcome) + "\n", "utf8");
    } catch (err) {
      console.error("[tracker] Impossible d'écrire dans le log:", (err as Error).message);
    }
    return outcome;
  }
}
