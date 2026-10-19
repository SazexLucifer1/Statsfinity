import { CubeCardData, CubeColumnKey, colorCategory, expandCopies } from './cube-layout';

/**
 * Booster für den Cube-Builder (Wunsch des Users, 19.10.2026): Packgröße und Mindestanteile je
 * Pack ("mind. 3 je Monofarbe, 2 Hybrid, 1 Land, 2 Spontanzauber, 1 Legende"), daraus Probe-Booster
 * und die Aufteilung des ganzen Cubes in Packs zum Vorbereiten. Reine Funktionen, damit sie ohne
 * Datenbank prüfbar sind (cube-packs.spec.ts).
 */

/** Wofür eine Regel zählt: eine Spalte der Cube-Tabelle, ein Kartentyp oder "legendär". */
export type PackRuleKind = 'column' | 'type' | 'legendary';

export interface PackRule {
  kind: PackRuleKind;
  /** Spalte (W/U/B/R/G/H/M/C/L) bzw. englisches Typwort ("Instant", "Creature", ...). */
  key: string;
  min: number;
}

export interface PackSettings {
  size: number;
  rules: PackRule[];
}

export const DEFAULT_PACK_SETTINGS: PackSettings = { size: 15, rules: [] };

/** Typwörter, nach denen sich eine Regel richten kann (englisch wie in der Typzeile). */
export const PACK_RULE_TYPES = [
  'Creature',
  'Instant',
  'Sorcery',
  'Artifact',
  'Enchantment',
  'Planeswalker',
  'Land',
] as const;

export function matchesRule(card: CubeCardData, rule: PackRule): boolean {
  const front = (card.typeLine ?? '').split(' // ')[0];
  switch (rule.kind) {
    case 'column':
      return colorCategory(card) === (rule.key as CubeColumnKey);
    case 'type':
      return front.includes(rule.key);
    case 'legendary':
      return front.includes('Legendary');
  }
}

/** Gültige Einstellungen aus gespeicherten Daten (fehlende/kaputte Felder fallen auf Standard). */
export function normalizePackSettings(raw: unknown): PackSettings {
  const value = (raw ?? {}) as Partial<PackSettings>;
  const size = Math.round(Number(value.size));
  return {
    size: Number.isFinite(size) && size >= 1 && size <= 60 ? size : DEFAULT_PACK_SETTINGS.size,
    rules: Array.isArray(value.rules)
      ? value.rules
          .filter(
            (r): r is PackRule =>
              !!r && ['column', 'type', 'legendary'].includes(r.kind) && typeof r.key === 'string',
          )
          .map((r) => ({
            kind: r.kind,
            key: r.key,
            min: Math.max(0, Math.min(60, Math.round(r.min) || 0)),
          }))
      : [],
  };
}

function shuffled<T>(items: readonly T[], random: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** Eine Regel, die in einem Pack nicht erfüllt werden konnte. */
export interface PackShortfall {
  rule: PackRule;
  /** So viele passende Karten liegen im Pack. */
  have: number;
}

export interface PackSplit<T> {
  packs: T[][];
  /** Exemplare, die in kein volles Pack mehr passten. */
  leftover: T[];
  /** Je Pack (gleicher Index) die nicht erfüllten Regeln. */
  shortfalls: PackShortfall[][];
}

/**
 * Teilt Exemplare auf `count` Packs der Größe `settings.size` auf. Erst bekommt jedes Pack
 * reihum seine Mindestanteile - die knappste Regel zuerst, damit eine häufige Regel ("Kreatur")
 * nicht die Karten einer seltenen ("Hybrid") aufbraucht -, dann wird zufällig aufgefüllt. Eine Karte
 * zählt für jede Regel, auf die sie passt (eine rote Hexerei für "Rot" und für "Hexerei").
 */
function deal<T extends CubeCardData>(
  pool: T[],
  count: number,
  settings: PackSettings,
  random: () => number,
): PackSplit<T> {
  const packs: T[][] = Array.from({ length: count }, () => []);
  let rest = shuffled(pool, random);
  const rules = settings.rules.filter((r) => r.min > 0);
  const supply = (rule: PackRule) => rest.filter((c) => matchesRule(c, rule)).length / rule.min;
  const ordered = [...rules].sort((a, b) => supply(a) - supply(b));

  for (const rule of ordered) {
    // Reihum, damit bei knappen Karten jedes Pack wenigstens etwas abbekommt.
    for (let round = 0; round < rule.min; round++) {
      for (const pack of packs) {
        if (pack.length >= settings.size) continue;
        if (pack.filter((c) => matchesRule(c, rule)).length >= rule.min) continue;
        const i = rest.findIndex((c) => matchesRule(c, rule));
        if (i < 0) break;
        pack.push(rest[i]);
        rest = [...rest.slice(0, i), ...rest.slice(i + 1)];
      }
    }
  }
  for (const pack of packs) {
    while (pack.length < settings.size && rest.length) pack.push(rest.shift()!);
  }
  const shortfalls = packs.map((pack) => packShortfalls(pack, rules));
  return { packs: packs.map((p) => shuffled(p, random)), leftover: rest, shortfalls };
}

/** Regeln, die ein fertiges Pack nicht erfüllt. */
export function packShortfalls(
  pack: readonly CubeCardData[],
  rules: readonly PackRule[],
): PackShortfall[] {
  return rules
    .filter((r) => r.min > 0)
    .map((rule) => ({ rule, have: pack.filter((c) => matchesRule(c, rule)).length }))
    .filter((s) => s.have < s.rule.min);
}

/** Ein Probe-Booster nach den Einstellungen. */
export function buildPack<T extends CubeCardData>(
  cards: readonly T[],
  settings: PackSettings,
  random: () => number = Math.random,
): { pack: T[]; shortfalls: PackShortfall[] } {
  const split = deal(expandCopies(cards), 1, settings, random);
  return { pack: split.packs[0], shortfalls: split.shortfalls[0] };
}

/** Den ganzen Cube in so viele volle Packs aufteilen, wie er hergibt. */
export function splitIntoPacks<T extends CubeCardData>(
  cards: readonly T[],
  settings: PackSettings,
  random: () => number = Math.random,
): PackSplit<T> {
  const pool = expandCopies(cards);
  const count = Math.floor(pool.length / Math.max(1, settings.size));
  if (count === 0) return { packs: [], leftover: pool, shortfalls: [] };
  return deal(pool, count, settings, random);
}
