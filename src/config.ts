// Configuration typée, lue depuis les variables d'environnement.
// Ce module n'a aucun effet de bord à l'import (le chargement du fichier .env se fait
// dans index.ts), ce qui permet de l'utiliser tel quel dans les tests.

export interface Config {
  heliusApiKey: string;
  telegramBotToken: string;
  telegramChatId: string;
  pumpWsUrl: string;
  pumpApiKey: string;

  /** Temps d'observation d'un nouveau token avant de calculer son score final. */
  observationWindowMs: number;
  /** Score minimum (sur 100) pour déclencher une alerte. */
  minScoreToAlert: number;

  /** Nombre max de tokens dont on suit les trades en même temps (limite du service de données). */
  maxConcurrentTracked: number;
  /** Durée de suivi d'un token alerté, pour mesurer son pic réel. */
  postAlertTrackingMs: number;
  /** Durée de suivi d'un candidat non alerté (données de calibration uniquement). */
  scoringTrackingMs: number;
  /** Marge d'emplacements à garder libre avant d'échantillonner un candidat non alerté. */
  minTrackingHeadroom: number;
  /** Seuil de market cap d'entrée (USD) de l'hypothèse « market cap élevé + lien X ». */
  hypothesisMinEntryMcUsd: number;

  /** Filtre gratuit, basé uniquement sur les données déjà reçues du flux. */
  stage1: {
    minUniqueBuyers: number;
    minMarketCapGrowthMultiple: number;
    maxDevInitialBuyPercent: number;
  };

  /** Simulation de trading (papier) : aucune transaction réelle n'est jamais envoyée. */
  paper: {
    tradeAmountSol: number;
    maxConcurrentPositions: number;
    /** On n'ouvre une position que si le top 10 des holders détient moins que ce pourcentage. */
    buyMaxHolderPercent: number;
    takeProfitMultiple: number;
    stopLossMultiple: number;
    maxHoldTimeMs: number;
    /** Coût aller-retour estimé (frais de plateforme + glissement), en %. */
    roundTripFeePercent: number;
    /** Frais de priorité estimés par transaction, en SOL. */
    priorityFeeSol: number;
  };
}

type Env = Record<string, string | undefined>;

function num(env: Env, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`Variable d'environnement invalide : ${name}="${raw}" n'est pas un nombre.`);
  }
  return value;
}

function str(env: Env, name: string, fallback = ""): string {
  const raw = env[name];
  return raw === undefined || raw.trim() === "" ? fallback : raw.trim();
}

export function loadConfig(env: Env = process.env): Config {
  return {
    heliusApiKey: str(env, "HELIUS_API_KEY"),
    telegramBotToken: str(env, "TELEGRAM_BOT_TOKEN"),
    telegramChatId: str(env, "TELEGRAM_CHAT_ID"),
    pumpWsUrl: str(env, "PUMP_WS_URL", "wss://pumpportal.fun/api/data"),
    pumpApiKey: str(env, "PUMP_API_KEY"),

    observationWindowMs: num(env, "OBSERVATION_WINDOW_MS", 45_000),
    minScoreToAlert: num(env, "MIN_SCORE_TO_ALERT", 70),

    maxConcurrentTracked: num(env, "MAX_CONCURRENT_TRACKED", 8),
    postAlertTrackingMs: num(env, "POST_ALERT_TRACKING_MS", 15 * 60 * 1000),
    scoringTrackingMs: num(env, "SCORING_TRACKING_MS", 5 * 60 * 1000),
    minTrackingHeadroom: num(env, "MIN_TRACKING_HEADROOM", 1),
    hypothesisMinEntryMcUsd: num(env, "HYPOTHESIS_MIN_ENTRY_MC_USD", 10_000),

    stage1: {
      minUniqueBuyers: 5,
      minMarketCapGrowthMultiple: 1.5,
      maxDevInitialBuyPercent: 15,
    },

    paper: {
      tradeAmountSol: num(env, "TRADE_AMOUNT_SOL", 0.1),
      maxConcurrentPositions: num(env, "MAX_CONCURRENT_POSITIONS", 3),
      buyMaxHolderPercent: num(env, "BUY_MAX_HOLDER_PERCENT", 80),
      takeProfitMultiple: num(env, "TAKE_PROFIT_MULTIPLE", 1.25),
      stopLossMultiple: num(env, "STOP_LOSS_MULTIPLE", 0.5),
      maxHoldTimeMs: num(env, "MAX_HOLD_TIME_MS", 15 * 60 * 1000),
      roundTripFeePercent: num(env, "ROUND_TRIP_FEE_PERCENT", 2),
      priorityFeeSol: num(env, "PRIORITY_FEE_SOL", 0.0005),
    },
  };
}
