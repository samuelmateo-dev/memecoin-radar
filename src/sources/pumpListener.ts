import WebSocket from "ws";
import { EventEmitter } from "node:events";
import type { Config } from "../config.js";
import type { PumpNewTokenEvent, PumpTradeEvent } from "../types.js";

/**
 * Source de données temps réel : flux WebSocket PumpPortal.
 *
 * Événements émis : "newToken", "trade", "disconnected", "reconnected" (durée de coupure en ms).
 * Reconnexion automatique avec backoff exponentiel (2 s → 30 s) ; les souscriptions aux
 * trades sont rejouées après chaque reconnexion.
 */
export interface TokenSource extends EventEmitter {
  connect(): void;
  trackMint(mint: string): void;
  untrackMint(mint: string): void;
  readonly trackedCount: number;
}

export class PumpListener extends EventEmitter implements TokenSource {
  private ws: WebSocket | null = null;
  private reconnectDelayMs = 2000;
  private subscribedMints = new Set<string>();
  private disconnectedAt: number | null = null;
  private unknownLogged = 0;

  constructor(private readonly config: Pick<Config, "pumpWsUrl" | "pumpApiKey">) {
    super();
  }

  connect(): void {
    const { pumpWsUrl, pumpApiKey } = this.config;
    this.ws = new WebSocket(pumpApiKey ? `${pumpWsUrl}?api-key=${pumpApiKey}` : pumpWsUrl);

    this.ws.on("open", () => {
      console.log("[pump] Connecté au flux PumpPortal");
      if (this.disconnectedAt !== null) {
        const downtimeMs = Date.now() - this.disconnectedAt;
        this.disconnectedAt = null;
        this.emit("reconnected", downtimeMs);
      }
      this.reconnectDelayMs = 2000;
      this.send({ method: "subscribeNewToken" });
      if (this.subscribedMints.size > 0) {
        this.send({ method: "subscribeTokenTrade", keys: [...this.subscribedMints] });
      }
    });

    this.ws.on("message", (raw) => {
      let msg: unknown;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      this.handleMessage(msg);
    });

    this.ws.on("close", () => {
      if (this.disconnectedAt === null) {
        this.disconnectedAt = Date.now();
        this.emit("disconnected");
      }
      console.warn(`[pump] Connexion fermée, reconnexion dans ${this.reconnectDelayMs}ms`);
      setTimeout(() => this.connect(), this.reconnectDelayMs);
      this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, 30_000);
    });

    this.ws.on("error", (err) => {
      console.error("[pump] Erreur WebSocket:", (err as Error).message);
    });
  }

  /** Aiguille un message brut du flux vers l'événement correspondant. Public pour les tests. */
  handleMessage(msg: any): void {
    if (msg?.txType === "create") {
      this.emit("newToken", msg as PumpNewTokenEvent);
    } else if (msg?.txType === "buy" || msg?.txType === "sell") {
      this.emit("trade", msg as PumpTradeEvent);
    } else if (
      typeof msg?.message === "string" &&
      (msg.message.startsWith("Successfully subscribed") || msg.message === "Unsubscribed.")
    ) {
      // Accusés de réception normaux : rien à faire.
    } else if (msg?.txType === "create_pool") {
      // Créations sur d'autres launchpads, mélangées au flux : ignorées volontairement.
    } else if (this.unknownLogged < 10) {
      // Message de forme inattendue : on en garde quelques exemples pour diagnostiquer un
      // changement de format côté fournisseur, sans noyer la console.
      this.unknownLogged++;
      console.log(`[pump] message inattendu (${this.unknownLogged}/10):`, String(JSON.stringify(msg)).slice(0, 400));
    }
  }

  get trackedCount(): number {
    return this.subscribedMints.size;
  }

  // On envoie à chaque fois l'ensemble complet des mints suivis (et pas seulement le nouveau) :
  // si le fournisseur traite chaque appel comme un remplacement plutôt qu'un ajout, cela évite
  // de perdre silencieusement le suivi des tokens déjà en cours d'observation.
  trackMint(mint: string): void {
    if (this.subscribedMints.has(mint)) return;
    this.subscribedMints.add(mint);
    this.send({ method: "subscribeTokenTrade", keys: [...this.subscribedMints] });
  }

  untrackMint(mint: string): void {
    if (!this.subscribedMints.has(mint)) return;
    this.subscribedMints.delete(mint);
    this.send({ method: "unsubscribeTokenTrade", keys: [mint] });
  }

  private send(payload: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
    }
  }
}
