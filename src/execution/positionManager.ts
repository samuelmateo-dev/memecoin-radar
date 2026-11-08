import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { Config } from "../config.js";
import type { Broker } from "./broker.js";

export type ExitReason = "objectif atteint" | "stop-loss déclenché" | "délai dépassé";

interface OpenPosition {
  mint: string;
  name: string;
  symbol: string;
  entryMarketCapSol: number;
  entryAt: number;
  amountSol: number;
  buySignature?: string;
  timeoutAt: number;
  lastKnownMarketCapSol: number;
}

/**
 * Gère les positions ouvertes : sortie sur objectif de gain, stop-loss large, ou délai maximum.
 * Chaque achat et chaque vente est journalisé en JSON (une ligne par ordre).
 *
 * Les règles de sortie sont celles du paramétrage « papier » (objectif ×1,25, stop ×0,5,
 * 15 min) ; le prix utilisé est celui du dernier trade reçu, sans latence ni glissement.
 */
export class PositionManager {
  private readonly open = new Map<string, OpenPosition>();

  constructor(
    private readonly broker: Broker,
    private readonly paper: Config["paper"],
    private readonly logFile: string,
    private readonly now: () => number = Date.now
  ) {}

  get openCount(): number {
    return this.open.size;
  }

  canOpenNewPosition(): boolean {
    return this.open.size < this.paper.maxConcurrentPositions;
  }

  private async log(entry: Record<string, unknown>): Promise<void> {
    try {
      await mkdir(path.dirname(this.logFile), { recursive: true });
      await appendFile(this.logFile, JSON.stringify({ ...entry, loggedAt: this.now() }) + "\n", "utf8");
    } catch (err) {
      console.error("[positions] Impossible d'écrire dans le log de trades:", (err as Error).message);
    }
  }

  async tryOpen(params: { mint: string; name: string; symbol: string; entryMarketCapSol: number }): Promise<void> {
    if (!this.canOpenNewPosition()) {
      console.log(
        `[positions] ${params.name}: achat ignoré — ${this.open.size}/${this.paper.maxConcurrentPositions} positions déjà ouvertes`
      );
      return;
    }
    if (this.open.has(params.mint)) return;

    // Réservation immédiate : deux candidats évalués en même temps ne doivent pas dépasser la limite.
    const reservedAt = this.now();
    this.open.set(params.mint, {
      ...params,
      entryAt: reservedAt,
      amountSol: this.paper.tradeAmountSol,
      timeoutAt: reservedAt + this.paper.maxHoldTimeMs,
      lastKnownMarketCapSol: params.entryMarketCapSol,
    });

    const result = await this.broker.buy(params.mint, this.paper.tradeAmountSol);

    await this.log({
      type: "buy",
      mint: params.mint,
      name: params.name,
      amountSol: this.paper.tradeAmountSol,
      entryMarketCapSol: params.entryMarketCapSol,
      success: result.success,
      paper: result.paper,
      signature: result.signature,
      error: result.error,
    });

    if (!result.success) {
      this.open.delete(params.mint);
      console.error(`[positions] Achat échoué pour ${params.name}: ${result.error}`);
      return;
    }

    this.open.get(params.mint)!.buySignature = result.signature;
    console.log(
      `[positions] Position ouverte sur ${params.name} (${this.paper.tradeAmountSol} SOL, objectif x${this.paper.takeProfitMultiple}, stop x${this.paper.stopLossMultiple})`
    );
  }

  /** Appelé à chaque trade reçu : vend si l'objectif ou le stop-loss est touché. */
  async onTrade(mint: string, marketCapSol: number): Promise<void> {
    const pos = this.open.get(mint);
    if (!pos) return;

    pos.lastKnownMarketCapSol = marketCapSol;
    const multiple = marketCapSol / pos.entryMarketCapSol;
    if (multiple >= this.paper.takeProfitMultiple) {
      await this.close(mint, "objectif atteint", multiple);
    } else if (multiple <= this.paper.stopLossMultiple) {
      await this.close(mint, "stop-loss déclenché", multiple);
    }
  }

  /** À appeler périodiquement : vend les positions qui ont dépassé leur délai maximum. */
  async checkTimeouts(): Promise<void> {
    const now = this.now();
    for (const [mint, pos] of [...this.open]) {
      if (now >= pos.timeoutAt) {
        await this.close(mint, "délai dépassé", pos.lastKnownMarketCapSol / pos.entryMarketCapSol);
      }
    }
  }

  private async close(mint: string, reason: ExitReason, multipleAtSale: number): Promise<void> {
    const pos = this.open.get(mint);
    if (!pos) return;
    this.open.delete(mint); // retiré tout de suite pour éviter une vente en double

    const result = await this.broker.sell(mint, "100%");

    await this.log({
      type: "sell",
      mint,
      name: pos.name,
      reason,
      multipleAtSale,
      entryMarketCapSol: pos.entryMarketCapSol,
      heldForMs: this.now() - pos.entryAt,
      success: result.success,
      paper: result.paper,
      signature: result.signature,
      error: result.error,
    });

    if (result.success) {
      console.log(`[positions] Position fermée sur ${pos.name} (${reason}, x${multipleAtSale.toFixed(2)})`);
    } else {
      console.error(`[positions] Échec de vente pour ${pos.name}: ${result.error}`);
    }
  }
}
