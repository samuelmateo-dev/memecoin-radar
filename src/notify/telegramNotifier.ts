import type { AlertOutcome, CandidateStats, ScoreBreakdown } from "../types.js";
import { formatUsd } from "../enrichment/solPrice.js";

export interface Notifier {
  sendAlert(candidate: CandidateStats, result: ScoreBreakdown): Promise<void>;
  sendOutcomeReport(outcome: AlertOutcome): Promise<void>;
  sendConnectivityNotice(text: string): Promise<void>;
}

export function escapeMd(s: string): string {
  return s.replace(/([_*`[\]])/g, "\\$1");
}

export interface TelegramNotifierOptions {
  botToken: string;
  chatId: string;
  getSolUsdPrice: () => Promise<number | null>;
  fetchImpl?: typeof fetch;
}

/**
 * Envoie les alertes sur Telegram. Si le bot n'est pas configuré, le message est simplement
 * affiché dans la console : le pipeline fonctionne de bout en bout sans aucun compte externe.
 */
export class TelegramNotifier implements Notifier {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: TelegramNotifierOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private async send(text: string, consoleFallback: string): Promise<void> {
    const { botToken, chatId } = this.options;
    if (!botToken || !chatId) {
      console.log(consoleFallback);
      return;
    }
    try {
      const res = await this.fetchImpl(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text,
          parse_mode: "Markdown",
          disable_web_page_preview: true,
        }),
      });
      if (!res.ok) console.error("[telegram] Réponse non-OK:", await res.text());
    } catch (err) {
      console.error("[telegram] Échec d'envoi:", (err as Error).message);
    }
  }

  async sendAlert(candidate: CandidateStats, result: ScoreBreakdown): Promise<void> {
    const text = [
      `🚨 *${escapeMd(candidate.name)}* (${escapeMd(candidate.symbol)}) — score *${result.totalScore}/100*`,
      ``,
      ...result.reasons.map((r) => `• ${escapeMd(r)}`),
      ``,
      `Mint: \`${candidate.mint}\``,
      `[Pump.fun](https://pump.fun/${candidate.mint}) · [Solscan](https://solscan.io/token/${candidate.mint})`,
      ...(result.twitterLink ? [`🐦 [Voir le tweet/profil lié](${result.twitterLink})`] : []),
      ...(result.tweetText ? [`📝 _"${escapeMd(result.tweetText)}"_`] : []),
    ].join("\n");

    await this.send(text, `ALERTE: ${candidate.name} (${candidate.symbol}) — score ${result.totalScore}/100`);
  }

  async sendConnectivityNotice(text: string): Promise<void> {
    await this.send(text, text);
  }

  // Rapport envoyé une fois la fenêtre de suivi terminée : ce qui s'est réellement passé,
  // pour le comparer au score donné au moment de l'alerte.
  async sendOutcomeReport(outcome: AlertOutcome): Promise<void> {
    const verdict = outcome.multiple >= 2 ? "✅" : outcome.multiple >= 1.2 ? "➖" : "❌";
    const solPrice = await this.options.getSolUsdPrice();
    const show = (sol: number) => (solPrice ? formatUsd(sol * solPrice) : `${sol.toFixed(1)} SOL`);
    const entryDisplay = show(outcome.entryMarketCapSol);
    const peakDisplay = show(outcome.peakMarketCapSol);

    const text = [
      `${verdict} *Résultat — ${escapeMd(outcome.name)}*`,
      ``,
      `Score au moment de l'alerte : ${outcome.score}/100`,
      `Market cap à l'alerte : ${entryDisplay}`,
      `Pic observé (${Math.round((outcome.trackingEndedAt - outcome.alertedAt) / 60000)} min de suivi) : ${peakDisplay}`,
      `Multiplicateur théorique : x${outcome.multiple.toFixed(2)}`,
      ``,
      `_Le pic est un maximum mesuré après coup : il n'est pas atteignable en pratique. Basé sur la bonding curve Pump.fun uniquement._`,
    ].join("\n");

    await this.send(
      text,
      `RÉSULTAT: ${outcome.name} — entrée ${entryDisplay}, pic ${peakDisplay} (x${outcome.multiple.toFixed(2)})`
    );
  }
}
