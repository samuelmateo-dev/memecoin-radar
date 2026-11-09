import { EXIT_GRID, HYPOTHESES, type Hypothesis, type HypothesisContext } from "./battery.js";
import { rules, type ExitRule } from "./exits.js";
import type { OutcomeRow } from "../types.js";

// Hypothèses définies par l'utilisateur (fichier JSON), validées strictement : une faute de frappe
// dans une clé ne doit JAMAIS être ignorée en silence, sinon le filtre disparaît et le test porte
// sur toute la population sans que personne ne le voie.

export class HypothesisFileError extends Error {}

export const FILTER_KEYS = [
  "minScore",
  "maxScore",
  "minEntrySol",
  "maxEntrySol",
  "minEntryUsd",
  "maxEntryUsd",
  "minTopHolderPercent",
  "maxTopHolderPercent",
  "twitterLink",
  "authoritiesRevoked",
  "minUniqueBuyers",
  "maxDevBuyPercent",
  "waveRank",
] as const;

export const EXIT_TYPES = {
  takeProfit: ["multiple"],
  trailingStop: ["dropPercent"],
  fixedTime: ["minutes"],
  bracket: ["target", "stop"],
  crossing: ["fromUsd", "toUsd"],
} as const;

type FilterKey = (typeof FILTER_KEYS)[number];
type ExitType = keyof typeof EXIT_TYPES;

const fr = (n: number) => {
  const [int, dec] = String(n).split(".");
  const spaced = int.replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  return dec ? `${spaced},${dec}` : spaced;
};

const usdToSol = (usd: number, ctx: HypothesisContext) => usd / ctx.solUsd;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function fail(path: string, message: string): never {
  throw new HypothesisFileError(`${path} : ${message}`);
}

function checkKeys(path: string, obj: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) {
      fail(`${path}.${key}`, `clé inconnue (clés acceptées : ${allowed.join(", ")})`);
    }
  }
}

function num(path: string, v: unknown, opts: { min?: number; max?: number; exclusiveMin?: boolean; exclusiveMax?: boolean } = {}): number {
  if (typeof v !== "number" || !Number.isFinite(v)) fail(path, `nombre attendu, reçu ${JSON.stringify(v)}`);
  if (opts.min !== undefined && (opts.exclusiveMin ? v <= opts.min : v < opts.min)) {
    fail(path, `doit être ${opts.exclusiveMin ? ">" : "≥"} ${opts.min} (reçu ${v})`);
  }
  if (opts.max !== undefined && (opts.exclusiveMax ? v >= opts.max : v > opts.max)) {
    fail(path, `doit être ${opts.exclusiveMax ? "<" : "≤"} ${opts.max} (reçu ${v})`);
  }
  return v;
}

type Filter = Partial<Record<Exclude<FilterKey, "twitterLink" | "authoritiesRevoked" | "waveRank">, number>> & {
  twitterLink?: boolean;
  authoritiesRevoked?: boolean;
  waveRank?: 1 | 2;
};

function parseFilter(path: string, raw: unknown): Filter {
  if (!isRecord(raw)) fail(path, "objet attendu");
  checkKeys(path, raw, FILTER_KEYS);
  const f: Filter = {};
  const p = (k: string) => `${path}.${k}`;
  if ("minScore" in raw) f.minScore = num(p("minScore"), raw.minScore, { min: 0, max: 100 });
  if ("maxScore" in raw) f.maxScore = num(p("maxScore"), raw.maxScore, { min: 0, max: 100 });
  if ("minEntrySol" in raw) f.minEntrySol = num(p("minEntrySol"), raw.minEntrySol, { min: 0, exclusiveMin: true });
  if ("maxEntrySol" in raw) f.maxEntrySol = num(p("maxEntrySol"), raw.maxEntrySol, { min: 0, exclusiveMin: true });
  if ("minEntryUsd" in raw) f.minEntryUsd = num(p("minEntryUsd"), raw.minEntryUsd, { min: 0, exclusiveMin: true });
  if ("maxEntryUsd" in raw) f.maxEntryUsd = num(p("maxEntryUsd"), raw.maxEntryUsd, { min: 0, exclusiveMin: true });
  if ("minTopHolderPercent" in raw) f.minTopHolderPercent = num(p("minTopHolderPercent"), raw.minTopHolderPercent, { min: 0, max: 100 });
  if ("maxTopHolderPercent" in raw) f.maxTopHolderPercent = num(p("maxTopHolderPercent"), raw.maxTopHolderPercent, { min: 0, max: 100 });
  if ("minUniqueBuyers" in raw) f.minUniqueBuyers = num(p("minUniqueBuyers"), raw.minUniqueBuyers, { min: 0 });
  if ("maxDevBuyPercent" in raw) f.maxDevBuyPercent = num(p("maxDevBuyPercent"), raw.maxDevBuyPercent, { min: 0, max: 100 });
  for (const k of ["twitterLink", "authoritiesRevoked"] as const) {
    if (k in raw) {
      if (typeof raw[k] !== "boolean") fail(p(k), `true ou false attendu, reçu ${JSON.stringify(raw[k])}`);
      f[k] = raw[k] as boolean;
    }
  }
  if ("waveRank" in raw) {
    if (raw.waveRank !== 1 && raw.waveRank !== 2) fail(p("waveRank"), `1 ou 2 attendu, reçu ${JSON.stringify(raw.waveRank)}`);
    f.waveRank = raw.waveRank;
  }
  for (const [lo, hi] of [
    ["minScore", "maxScore"],
    ["minEntrySol", "maxEntrySol"],
    ["minEntryUsd", "maxEntryUsd"],
    ["minTopHolderPercent", "maxTopHolderPercent"],
  ] as const) {
    if (f[lo] !== undefined && f[hi] !== undefined && f[lo]! > f[hi]!) {
      fail(path, `${lo} (${f[lo]}) est supérieur à ${hi} (${f[hi]}) : aucun candidat ne peut passer`);
    }
  }
  return f;
}

function filterPredicate(f: Filter): (r: OutcomeRow, ctx: HypothesisContext) => boolean {
  return (r, ctx) => {
    if (f.minScore !== undefined && !(r.score >= f.minScore)) return false;
    // Les suivis « vague de noms » n'ont pas de vrai score (-1) : exclus d'un filtre de score.
    if (f.maxScore !== undefined && !(r.score >= 0 && r.score <= f.maxScore)) return false;
    if (f.minEntrySol !== undefined && !(r.entryMarketCapSol >= f.minEntrySol)) return false;
    if (f.maxEntrySol !== undefined && !(r.entryMarketCapSol <= f.maxEntrySol)) return false;
    if (f.minEntryUsd !== undefined && !(r.entryMarketCapSol >= usdToSol(f.minEntryUsd, ctx))) return false;
    if (f.maxEntryUsd !== undefined && !(r.entryMarketCapSol <= usdToSol(f.maxEntryUsd, ctx))) return false;
    // Un signal absent (null ou ligne ancienne sans « signals ») exclut la ligne : on ne devine pas.
    const s = r.signals;
    if (f.minTopHolderPercent !== undefined && !(s && s.topHolderPercent !== null && s.topHolderPercent >= f.minTopHolderPercent)) return false;
    if (f.maxTopHolderPercent !== undefined && !(s && s.topHolderPercent !== null && s.topHolderPercent <= f.maxTopHolderPercent)) return false;
    if (f.twitterLink !== undefined && !(s && s.hasTwitterLink === f.twitterLink)) return false;
    if (f.authoritiesRevoked !== undefined && !(s && s.authoritiesRevoked === f.authoritiesRevoked)) return false;
    if (f.minUniqueBuyers !== undefined && !(s && s.uniqueBuyers >= f.minUniqueBuyers)) return false;
    if (f.maxDevBuyPercent !== undefined && !(s && s.devBuyPercent <= f.maxDevBuyPercent)) return false;
    if (f.waveRank !== undefined && r.waveRank !== f.waveRank) return false;
    return true;
  };
}

function describeFilter(f: Filter): string[] {
  const parts: string[] = [];
  if (f.minScore !== undefined) parts.push(`Score ≥ ${fr(f.minScore)}`);
  if (f.maxScore !== undefined) parts.push(`Score ≤ ${fr(f.maxScore)}`);
  if (f.minEntrySol !== undefined) parts.push(`Entrée ≥ ${fr(f.minEntrySol)} SOL`);
  if (f.maxEntrySol !== undefined) parts.push(`Entrée ≤ ${fr(f.maxEntrySol)} SOL`);
  if (f.minEntryUsd !== undefined) parts.push(`Entrée ≥ ${fr(f.minEntryUsd)} $`);
  if (f.maxEntryUsd !== undefined) parts.push(`Entrée ≤ ${fr(f.maxEntryUsd)} $`);
  if (f.minTopHolderPercent !== undefined) parts.push(`holders ≥ ${fr(f.minTopHolderPercent)} %`);
  if (f.maxTopHolderPercent !== undefined) parts.push(`holders ≤ ${fr(f.maxTopHolderPercent)} %`);
  if (f.twitterLink !== undefined) parts.push(f.twitterLink ? "lien X" : "sans lien X");
  if (f.authoritiesRevoked !== undefined) parts.push(f.authoritiesRevoked ? "autorités révoquées" : "autorités non révoquées");
  if (f.minUniqueBuyers !== undefined) parts.push(`≥ ${fr(f.minUniqueBuyers)} acheteurs uniques`);
  if (f.maxDevBuyPercent !== undefined) parts.push(`achat du créateur ≤ ${fr(f.maxDevBuyPercent)} %`);
  if (f.waveRank !== undefined) parts.push(f.waveRank === 1 ? "premier d'une vague de noms" : "deuxième d'une vague de noms");
  return parts;
}

interface ParsedExit {
  type: ExitType;
  build: (ctx: HypothesisContext) => ExitRule;
  label: string;
}

function parseExit(path: string, raw: unknown): ParsedExit {
  if (!isRecord(raw)) fail(path, "objet attendu, par exemple { \"type\": \"takeProfit\", \"multiple\": 1.5 }");
  const type = raw.type;
  if (typeof type !== "string" || !(type in EXIT_TYPES)) {
    fail(`${path}.type`, `type de sortie inconnu ${JSON.stringify(type)} (types acceptés : ${Object.keys(EXIT_TYPES).join(", ")})`);
  }
  const t = type as ExitType;
  checkKeys(path, raw, ["type", ...EXIT_TYPES[t]]);
  for (const field of EXIT_TYPES[t]) {
    if (!(field in raw)) fail(`${path}.${field}`, `champ obligatoire pour le type ${t}`);
  }
  const p = (k: string) => `${path}.${k}`;
  switch (t) {
    case "takeProfit": {
      const multiple = num(p("multiple"), raw.multiple, { min: 1, exclusiveMin: true });
      return { type: t, build: () => rules.takeProfit(multiple), label: rules.takeProfit(multiple).label };
    }
    case "trailingStop": {
      const drop = num(p("dropPercent"), raw.dropPercent, { min: 0, max: 100, exclusiveMin: true, exclusiveMax: true });
      return { type: t, build: () => rules.trailingStop(drop), label: rules.trailingStop(drop).label };
    }
    case "fixedTime": {
      const minutes = num(p("minutes"), raw.minutes, { min: 0, exclusiveMin: true });
      return { type: t, build: () => rules.fixedTime(minutes), label: rules.fixedTime(minutes).label };
    }
    case "bracket": {
      const target = num(p("target"), raw.target, { min: 1, exclusiveMin: true });
      const stop = num(p("stop"), raw.stop, { min: 0, max: 1, exclusiveMin: true, exclusiveMax: true });
      return { type: t, build: () => rules.bracket(target, stop), label: rules.bracket(target, stop).label };
    }
    case "crossing": {
      const from = num(p("fromUsd"), raw.fromUsd, { min: 0, exclusiveMin: true });
      const to = num(p("toUsd"), raw.toUsd, { min: 0, exclusiveMin: true });
      if (!(from < to)) fail(path, `fromUsd (${from}) doit être inférieur à toUsd (${to})`);
      const label = `achat au franchissement de ${fr(from)} $, vente à ${fr(to)} $`;
      return { type: t, build: (ctx) => rules.crossing(usdToSol(from, ctx), usdToSol(to, ctx), label), label };
    }
  }
}

/**
 * Transforme le contenu d'un fichier JSON en hypothèses prêtes pour `runBattery`.
 * Format : un tableau d'objets `{ id?, label?, filter?, exit }`. Sans `filter`, l'hypothèse teste la
 * règle de sortie sur tous les candidats (pas de placebo : il n'y a pas de sous-groupe à comparer).
 */
export function parseHypotheses(text: string): Hypothesis[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new HypothesisFileError(`JSON illisible : ${(e as Error).message}`);
  }
  if (!Array.isArray(data) || data.length === 0) {
    throw new HypothesisFileError("le fichier doit contenir un tableau non vide d'hypothèses");
  }
  const seen = new Set<string>();
  return data.map((raw, i): Hypothesis => {
    const path = `hypotheses[${i}]`;
    if (!isRecord(raw)) fail(path, "objet attendu");
    checkKeys(path, raw, ["id", "label", "filter", "exit"]);
    if (!("exit" in raw)) fail(`${path}.exit`, "champ obligatoire");

    let id = `custom-${i + 1}`;
    if ("id" in raw) {
      if (typeof raw.id !== "string" || !/^[A-Za-z0-9_.-]{1,60}$/.test(raw.id)) {
        fail(`${path}.id`, "chaîne de 1 à 60 caractères (lettres, chiffres, _ . -) attendue");
      }
      id = raw.id;
    }
    if (seen.has(id)) fail(`${path}.id`, `identifiant « ${id} » déjà utilisé`);
    seen.add(id);

    const exit = parseExit(`${path}.exit`, raw.exit);
    const filter = "filter" in raw ? parseFilter(`${path}.filter`, raw.filter) : undefined;
    if (exit.type === "crossing" && filter && Object.keys(filter).length > 0) {
      fail(`${path}.filter`, "un filtre n'est pas accepté avec une sortie de type crossing (l'entrée est le franchissement lui-même)");
    }
    const hasFilter = filter !== undefined && Object.keys(filter).length > 0;

    let label: string;
    if ("label" in raw) {
      if (typeof raw.label !== "string" || raw.label.trim() === "" || raw.label.length > 120) {
        fail(`${path}.label`, "texte de 1 à 120 caractères attendu");
      }
      label = raw.label.trim();
    } else if (hasFilter) {
      label = `${describeFilter(filter!).join(" et ")}, ${exit.label}`;
    } else {
      label = `${exit.label.charAt(0).toUpperCase()}${exit.label.slice(1)}, tous les candidats`;
    }

    return {
      id,
      label,
      kind: hasFilter ? "filter" : "entry",
      exit: exit.build,
      ...(hasFilter ? { filter: filterPredicate(filter!) } : {}),
    };
  });
}

/** Choisit des hypothèses de la batterie d'origine par identifiant, dans l'ordre demandé, sans doublon. */
export function selectBuiltIn(ids: readonly string[]): Hypothesis[] {
  const byId = new Map(HYPOTHESES.map((h) => [h.id, h]));
  const chosen: Hypothesis[] = [];
  for (const id of ids) {
    const h = byId.get(id);
    if (!h) {
      throw new HypothesisFileError(`hypothèse inconnue « ${id} » (voir --list pour les identifiants valides)`);
    }
    if (!chosen.includes(h)) chosen.push(h);
  }
  if (chosen.length === 0) throw new HypothesisFileError("--only attend au moins un identifiant");
  return chosen;
}

/** Texte de `--list` : tout ce qu'on peut choisir ou écrire dans un fichier. */
export function describeCatalogue(): string {
  const idWidth = Math.max(...HYPOTHESES.map((h) => h.id.length), ...EXIT_GRID.map((r) => r.id.length));
  const line = (id: string, label: string) => `  ${id.padEnd(idWidth)}  ${label}`;
  return [
    "Hypothèses de la batterie d'origine (à choisir avec --only id1,id2) :",
    ...HYPOTHESES.map((h) => line(h.id, h.label)),
    "",
    "Règles de sortie de la grille (section « exits ») :",
    ...EXIT_GRID.map((r) => line(r.id, r.label)),
    "",
    "Sections du rapport (--sections score,exits,battery,paper) : score, exits, battery, paper",
    "",
    "Fichier --hypotheses : tableau JSON d'objets { id?, label?, filter?, exit }",
    `  filter (tous facultatifs) : ${FILTER_KEYS.join(", ")}`,
    "  exit (obligatoire) :",
    ...Object.entries(EXIT_TYPES).map(([type, fields]) => `    ${type} : ${fields.join(", ")}`),
    "  Exemple : voir examples/hypotheses.example.json",
  ].join("\n");
}
