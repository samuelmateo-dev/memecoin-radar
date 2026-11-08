import { readFileSync } from "node:fs";
import type { OutcomeRow } from "../types.js";

export interface ParsedJsonl<T> {
  rows: T[];
  /** Lignes illisibles ignorées (JSON invalide). */
  skipped: number;
}

export function parseJsonl<T = unknown>(text: string): ParsedJsonl<T> {
  const rows: T[] = [];
  let skipped = 0;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      rows.push(JSON.parse(trimmed) as T);
    } catch {
      skipped++;
    }
  }
  return { rows, skipped };
}

export function loadJsonl<T = unknown>(file: string): ParsedJsonl<T> {
  return parseJsonl<T>(readFileSync(file, "utf8"));
}

/** Lignes d'historique valides : champs obligatoires présents et numériques. */
export function loadOutcomes(file: string): ParsedJsonl<OutcomeRow> {
  const { rows, skipped } = loadJsonl<Partial<OutcomeRow>>(file);
  const valid = rows.filter(
    (r): r is OutcomeRow =>
      typeof r?.mint === "string" &&
      typeof r.name === "string" &&
      typeof r.score === "number" &&
      typeof r.multiple === "number" &&
      typeof r.alertedAt === "number" &&
      typeof r.entryMarketCapSol === "number"
  );
  return { rows: valid, skipped: skipped + (rows.length - valid.length) };
}

/** Lignes avec un historique de prix exploitable pour simuler une sortie. */
export function withHistory(rows: readonly OutcomeRow[]): OutcomeRow[] {
  return rows.filter((r) => r.priceHistory && r.priceHistory.length > 1);
}
