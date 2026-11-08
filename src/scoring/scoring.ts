import type { Config } from "../config.js";
import type { CandidateStats, PumpTradeEvent, ScoreBreakdown, ScoreSignals } from "../types.js";
import type { HeliusClient } from "../enrichment/heliusClient.js";
import type { TokenSocials } from "../enrichment/metadata.js";
import { looksLikeRealTwitterLink } from "../enrichment/metadata.js";

export function uniqueBuyersOf(candidate: Pick<CandidateStats, "trades">): number {
  return new Set(candidate.trades.filter((t) => t.txType === "buy").map((t) => t.traderPublicKey)).size;
}

export function lastMarketCapOf(candidate: Pick<CandidateStats, "trades" | "startMarketCapSol">): number {
  const last: PumpTradeEvent | undefined = candidate.trades[candidate.trades.length - 1];
  return last?.marketCapSol ?? candidate.startMarketCapSol;
}

// --- Stage 1 : filtre rapide et 100 % gratuit, basé uniquement sur les données déjà reçues ---
export function passesStage1(candidate: CandidateStats, stage1: Config["stage1"]): boolean {
  if (uniqueBuyersOf(candidate) < stage1.minUniqueBuyers) return false;
  const growthMultiple = lastMarketCapOf(candidate) / (candidate.startMarketCapSol || 1);
  return growthMultiple >= stage1.minMarketCapGrowthMultiple;
}

/**
 * Ce que l'enrichissement a pu établir sur les liens sociaux du token :
 * - "x"           : lien X/Twitter valide
 * - "partial"     : Telegram ou site, sans X
 * - "none"        : métadonnées lisibles mais sans aucun lien
 * - "unavailable" : métadonnées introuvables (passerelle IPFS en échec, par exemple)
 */
export type SocialsStatus = "x" | "partial" | "none" | "unavailable";

export interface ScoreInputs {
  uniqueBuyers: number;
  buySellRatio: number;
  /** null si l'appel on-chain a échoué : le critère ne rapporte alors aucun point. */
  topHolderPercent: number | null;
  socials: SocialsStatus;
  /** null si l'appel on-chain a échoué. */
  authoritiesRevoked: boolean | null;
  devBuyPercent: number;
}

/**
 * Barème sur 100. Fonction pure : aucune I/O, donc entièrement testable.
 *
 *   concentration des 10 plus gros holders   25
 *   acheteurs uniques                        20
 *   mint + freeze authority révoquées        20
 *   lien X (5 si Telegram/site seulement)    15
 *   ratio achat/vente                        10
 *   achat initial du créateur                10
 */
export function scoreInputs(
  input: ScoreInputs,
  options: { maxDevInitialBuyPercent: number }
): { totalScore: number; reasons: string[] } {
  const reasons: string[] = [];
  let score = 0;

  // Vélocité des acheteurs (20)
  if (input.uniqueBuyers >= 20) {
    score += 20;
    reasons.push(`${input.uniqueBuyers} acheteurs uniques`);
  } else if (input.uniqueBuyers >= 10) {
    score += 12;
    reasons.push(`${input.uniqueBuyers} acheteurs uniques`);
  } else {
    score += 4;
  }

  // Pression acheteuse (10). Un ratio extrême à 45 s ressemble plus à du sniping qu'à un
  // engouement organique : la zone 1,5-3 est donc la mieux notée.
  if (input.buySellRatio >= 1.5 && input.buySellRatio < 3) {
    score += 10;
    reasons.push(`ratio achat/vente sain (${input.buySellRatio.toFixed(1)})`);
  } else if (input.buySellRatio >= 3) {
    score += 5;
    reasons.push(`ratio achat/vente très élevé (${input.buySellRatio.toFixed(1)}, possiblement du sniping)`);
  }

  // Concentration des holders (25). Falaise observée à 95 % ; zone 60-80 % meilleure que 80-95 %.
  if (input.topHolderPercent !== null) {
    if (input.topHolderPercent < 80) {
      score += 25;
      reasons.push(`top 10 holders = ${input.topHolderPercent.toFixed(1)}% (zone idéale)`);
    } else if (input.topHolderPercent < 95) {
      score += 15;
      reasons.push(`top 10 holders = ${input.topHolderPercent.toFixed(1)}% (dans la norme)`);
    } else {
      reasons.push(`⚠️ top 10 holders = ${input.topHolderPercent.toFixed(1)}% (extrêmement concentré)`);
    }
  }

  // Présence sociale (15)
  if (input.socials === "x") {
    score += 15;
    reasons.push("lien X/Twitter présent (voir ci-dessous)");
  } else if (input.socials === "partial") {
    score += 5;
    reasons.push("présence sociale partielle (Telegram/site, sans X)");
  } else {
    reasons.push("⚠️ aucun lien social détecté dans les métadonnées");
  }

  // Autorités révoquées (20)
  if (input.authoritiesRevoked !== null) {
    if (input.authoritiesRevoked) {
      score += 20;
      reasons.push("mint & freeze authority révoquées");
    } else {
      reasons.push("⚠️ mint ou freeze authority encore active — risque de rug élevé");
    }
  }

  // Achat initial du créateur pas dominant (10)
  if (input.devBuyPercent < options.maxDevInitialBuyPercent) {
    score += 10;
  } else {
    reasons.push(`⚠️ achat initial du créateur élevé (${input.devBuyPercent.toFixed(1)}% du market cap de départ)`);
  }

  return { totalScore: score, reasons };
}

export interface ScorerDeps {
  helius: Pick<HeliusClient, "getTopHolderConcentration" | "getMintAuthorities">;
  fetchSocials: (uri: string) => Promise<TokenSocials | null>;
  fetchTweetText: (url: string) => Promise<string | null>;
}

// --- Stage 2 : collecte des signaux (I/O) puis notation (fonction pure ci-dessus) ---
export class Scorer {
  constructor(
    private readonly deps: ScorerDeps,
    private readonly config: Pick<Config, "minScoreToAlert" | "stage1">
  ) {}

  async score(candidate: CandidateStats): Promise<ScoreBreakdown> {
    const buys = candidate.trades.filter((t) => t.txType === "buy").length;
    const sells = candidate.trades.filter((t) => t.txType === "sell").length;
    const uniqueBuyers = uniqueBuyersOf(candidate);
    const buySellRatio = buys / Math.max(sells, 1);
    const devBuyPercent = (candidate.initialBuySol / (candidate.startMarketCapSol || 1)) * 100;

    const holderInfo = await this.deps.helius.getTopHolderConcentration(candidate.mint);
    const topHolderPercent = holderInfo?.topHolderPercent ?? null;

    const socialsRaw = await this.deps.fetchSocials(candidate.metadataUri);
    let socials: SocialsStatus;
    let twitterLink: string | undefined;
    let tweetText: string | undefined;
    if (socialsRaw && looksLikeRealTwitterLink(socialsRaw.twitter)) {
      socials = "x";
      twitterLink = socialsRaw.twitter;
      tweetText = (await this.deps.fetchTweetText(socialsRaw.twitter!)) ?? undefined;
    } else if (socialsRaw?.telegram || socialsRaw?.website) {
      socials = "partial";
    } else if (socialsRaw) {
      socials = "none";
    } else {
      socials = "unavailable";
    }

    const authorities = await this.deps.helius.getMintAuthorities(candidate.mint);
    const authoritiesRevoked = authorities
      ? authorities.mintAuthorityRevoked && authorities.freezeAuthorityRevoked
      : null;

    const { totalScore, reasons } = scoreInputs(
      { uniqueBuyers, buySellRatio, topHolderPercent, socials, authoritiesRevoked, devBuyPercent },
      { maxDevInitialBuyPercent: this.config.stage1.maxDevInitialBuyPercent }
    );

    const signals: ScoreSignals = {
      uniqueBuyers,
      buySellRatio,
      topHolderPercent,
      hasTwitterLink: socials === "x",
      authoritiesRevoked,
      devBuyPercent,
    };

    return {
      mint: candidate.mint,
      totalScore,
      reasons,
      twitterLink,
      tweetText,
      passed: totalScore >= this.config.minScoreToAlert,
      signals,
    };
  }
}
