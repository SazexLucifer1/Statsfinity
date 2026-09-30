import { ARCHENEMY_OTHERS, DRAW, isImportLossDuplicate } from './match-utils';
import { DeckFormat, GameMode, LIVE_TRACKING_START_DATE, Match } from './models';

/**
 * Elo-Wertung je Spielmodus, aus dem Match-Verlauf berechnet (nichts gespeichert, deshalb auch
 * rückwirkend immer konsistent).
 *
 * Eine Partie zählt als Bündel von Einzelduellen, aber NUR mit dem Sieger: Der Sieger gewinnt
 * gegen jeden Gegner, jeder andere verliert gegen den Sieger - Platz 2, 3 und 4 sind gleich viel
 * wert. Die Platzierung (match_players.placement) spielt für die Wertung bewusst keine Rolle
 * (Entscheidung des Users, 30.09.2026): Belohnte sie Platz 2, lohnte es sich, statt auf den Sieg
 * auf das Ausschalten eines anderen zu spielen - Kingmaking um LP. Zwischen zwei Verlierern gibt es
 * deshalb kein Duell. Je Duell die klassische Elo-Erwartung, die Summe wird durch die Zahl der
 * Gegner geteilt - ein Pod-Sieg ist so ungefähr so viel wert wie ein 1v1-Sieg. Wer einen starken
 * Tisch schlägt, bekommt mehr; wer gegen einen starken Sieger verliert, verliert weniger. Die
 * Änderung einer Partie heißt in der Oberfläche "LP".
 *
 * Teamkollegen (Two-Headed Giant) und die Verbündeten gegen den Archenemy duellieren sich nicht.
 *
 * Skala wie in League of Legends: LP (League Points), Start 800 = Holz V (ganz unten), je Division 100 LP,
 * fünf Divisionen je Rang (siehe rankFromLp()). Ein Sieg gegen gleich starke Gegner bringt rund
 * 50 LP (K / 2, im Pod wie im 1v1).
 *
 * Zwei Zahlen je Spieler: `rating` ist die reine Elo (Nullsumme) und bestimmt, wie stark ein
 * Spieler für die Erwartung seiner Gegner gilt. `lp` ist das, was angezeigt wird: dieselbe Zahl
 * plus ELO_LP_BONUS je gewerteter Partie. Ohne den Bonus bliebe die Gruppe im Schnitt ewig beim
 * Startwert - in einem 4er-Pod ist die durchschnittliche Siegquote genau 25 %, und bei reiner Elo
 * steht man damit auf der Stelle. Mit Bonus steigt schon auf, wer im Schnitt 25 % gewinnt, wer
 * besser spielt, schneller. In die Erwartung geht der Bonus bewusst NICHT ein: Viel spielen macht
 * einen Gegner nicht stärker.
 */

export const ELO_START = 800;
/** K-Faktor; in den ersten Partien höher, damit neue Spieler schneller an ihren Platz kommen. */
export const ELO_K = 100;
export const ELO_K_PROVISIONAL = 150;
export const ELO_PROVISIONAL_GAMES = 10;
/**
 * Wertungsabstand für eine 10:1-Erwartung. Klassisch 400 bei K 32 - mit K 100 streuen die Werte
 * gut dreimal so weit, der Divisor wächst mit, sonst gälte schon ein Abstand von vier Divisionen
 * als nahezu sicherer Sieg.
 */
export const ELO_SCALE = 1200;
/** LP je gewerteter Partie obendrauf, siehe Dateikopf. */
export const ELO_LP_BONUS = 5;

export interface EloEntry {
  name: string;
  /** Reine Elo (Nullsumme), maßgeblich für die Erwartung der Gegner. */
  rating: number;
  /** Angezeigte LP: rating + ELO_LP_BONUS je Partie. */
  lp: number;
  games: number;
  wins: number;
  /** Höchster erreichter LP-Wert. */
  peak: number;
  /** LP der letzten Partie in diesem Modus (inklusive Bonus). */
  lastChange: number;
  /** Noch in der Einstufungsphase (weniger als ELO_PROVISIONAL_GAMES Partien). */
  provisional: boolean;
}

/** Ein Teilnehmer einer Partie: Platz (kleiner = besser) und Seite (gleiche Seite = kein Duell). */
interface Seat {
  name: string;
  rank: number;
  side: string;
}

/**
 * Zählt diese Partie für die Wertung? Nur als Ranked gespielte (nicht frei, kein Turnier), live
 * erfasste Partien mit mindestens zwei Seiten. Ob die Gruppe überhaupt Ranked spielt
 * (groups.ranked_enabled), entscheidet der Aufrufer - dann wird gar nicht erst gerechnet.
 */
export function isRatedMatch(match: Match): boolean {
  if (match.isRanked === false || match.tournamentMatchId) return false;
  if (match.countsInGeneralStats === false) return false;
  if (isImportLossDuplicate(match)) return false;
  if (new Date(match.date) < LIVE_TRACKING_START_DATE) return false;
  return new Set(seatsOf(match).map((s) => s.side)).size >= 2;
}

/** Platz und Seite je Spieler, modusabhängig. */
export function seatsOf(match: Match): Seat[] {
  const players = match.players;
  if (match.winner === DRAW)
    return players.map((p) => ({ name: p.name, rank: 1, side: sideOf(match, p) }));

  if (match.mode === 'Two-Headed Giant') {
    return players.map((p) => ({
      name: p.name,
      rank: p.team === match.winner ? 1 : 2,
      side: p.team ?? p.name,
    }));
  }
  if (match.mode === 'Archenemy') {
    const othersWon = match.winner === ARCHENEMY_OTHERS;
    return players.map((p) => ({
      name: p.name,
      rank: p.isArchenemy ? (othersWon ? 2 : 1) : othersWon ? 1 : 2,
      side: p.isArchenemy ? 'archenemy' : 'others',
    }));
  }

  // Jeder für sich: der Sieger ist Platz 1, alle anderen teilen sich Platz 2 - eingetragene
  // Platzierungen zählen bewusst nicht (siehe Dateikopf).
  return players.map((p) => ({
    name: p.name,
    rank: p.name === match.winner ? 1 : 2,
    side: p.name,
  }));
}

function sideOf(match: Match, p: Match['players'][number]): string {
  if (match.mode === 'Two-Headed Giant') return p.team ?? p.name;
  if (match.mode === 'Archenemy') return p.isArchenemy ? 'archenemy' : 'others';
  return p.name;
}

/** Erwartete Punkte von a gegen b (0-1). */
export function expectedScore(ratingA: number, ratingB: number): number {
  return 1 / (1 + 10 ** ((ratingB - ratingA) / ELO_SCALE));
}

/**
 * LP je Spieler für eine Partie, alle mit den Werten VOR der Partie gerechnet (die Reihenfolge der
 * Spieler spielt so keine Rolle).
 */
export function matchChanges(
  seats: readonly Seat[],
  rating: (name: string) => number,
  games: (name: string) => number,
): Map<string, number> {
  const changes = new Map<string, number>();
  for (const me of seats) {
    const opponents = seats.filter((o) => o.side !== me.side);
    if (opponents.length === 0) continue;
    let sum = 0;
    for (const o of opponents) {
      // Zwei Verlierer duellieren sich nicht - wer von ihnen länger durchhielt, ist egal.
      if (me.rank > 1 && o.rank > 1) continue;
      const score = me.rank < o.rank ? 1 : me.rank === o.rank ? 0.5 : 0;
      sum += score - expectedScore(rating(me.name), rating(o.name));
    }
    const k = games(me.name) < ELO_PROVISIONAL_GAMES ? ELO_K_PROVISIONAL : ELO_K;
    changes.set(me.name, (k * sum) / opponents.length);
  }
  return changes;
}

/** Rangliste eines Modus, nach Wertung absteigend. Matches werden chronologisch verrechnet. */
export function eloRanking(
  matches: readonly Match[],
  mode: GameMode,
  options: {
    /**
     * Gesetzt = nur Partien genau dieses Formats (null = Partien ohne Format, z. B. Spezialevent).
     * Weggelassen = alle Formate des Modus gemeinsam.
     */
    format?: DeckFormat | null;
    /** Wird je gewerteter Partie mit den LP-Änderungen (inklusive Bonus) aller Spieler aufgerufen. */
    onMatch?: (match: Match, lpChanges: Map<string, number>) => void;
  } = {},
): EloEntry[] {
  const { format, onMatch } = options;
  const table = new Map<string, EloEntry>();
  const entry = (name: string): EloEntry => {
    let e = table.get(name);
    if (!e) {
      e = {
        name,
        rating: ELO_START,
        lp: ELO_START,
        games: 0,
        wins: 0,
        peak: ELO_START,
        lastChange: 0,
        provisional: true,
      };
      table.set(name, e);
    }
    return e;
  };

  const rated = matches
    .filter(
      (m) => m.mode === mode && (format === undefined || m.format === format) && isRatedMatch(m),
    )
    .sort((a, b) => a.date.localeCompare(b.date));

  for (const match of rated) {
    const seats = seatsOf(match);
    const changes = matchChanges(
      seats,
      (n) => entry(n).rating,
      (n) => entry(n).games,
    );
    const lpChanges = new Map<string, number>();
    for (const seat of seats) {
      const e = entry(seat.name);
      const change = changes.get(seat.name) ?? 0;
      lpChanges.set(seat.name, change + ELO_LP_BONUS);
      e.rating += change;
      e.lp += change + ELO_LP_BONUS;
      e.lastChange = change + ELO_LP_BONUS;
      e.games++;
      if (seat.rank === 1 && seats.some((s) => s.rank > 1)) e.wins++;
      e.peak = Math.max(e.peak, e.lp);
      e.provisional = e.games < ELO_PROVISIONAL_GAMES;
    }
    onMatch?.(match, lpChanges);
  }

  return [...table.values()].sort((a, b) => b.lp - a.lp || b.games - a.games);
}

/**
 * LP-Änderung je Partie und Spieler (Match-ID → Name → LP), je Modus und Format getrennt
 * gerechnet wie der Rang im Profil. Für die Match-Historie; ungewertete Partien fehlen.
 */
export function lpChangesByMatch(matches: readonly Match[]): Map<string, Map<string, number>> {
  const result = new Map<string, Map<string, number>>();
  const seen = new Set<string>();
  for (const m of matches.filter(isRatedMatch)) {
    const key = `${m.mode}|${m.format ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    eloRanking(matches, m.mode, {
      format: m.format ?? null,
      onMatch: (match, changes) => result.set(match.id, changes),
    });
  }
  return result;
}

/** Formate, in denen `name` im Modus `mode` gewertete Partien hat, in der Reihenfolge von `formats`. */
export function ratedFormatsFor(
  matches: readonly Match[],
  mode: GameMode,
  name: string,
  formats: readonly DeckFormat[],
): DeckFormat[] {
  const present = new Set(
    matches
      .filter((m) => m.mode === mode && m.players.some((p) => p.name === name) && isRatedMatch(m))
      .map((m) => m.format),
  );
  return formats.filter((f) => present.has(f));
}

/** Modi, in denen es überhaupt gewertete Partien gibt, in der Reihenfolge von `modes`. */
export function ratedModes(matches: readonly Match[], modes: readonly GameMode[]): GameMode[] {
  const present = new Set(matches.filter(isRatedMatch).map((m) => m.mode));
  return modes.filter((m) => present.has(m));
}

// --- Ränge ---

export type RankTier =
  'wood' | 'iron' | 'bronze' | 'silver' | 'gold' | 'platinum' | 'diamond' | 'infinity';

/** Von unten nach oben. Holz beginnt bei RANK_FLOOR, jeder weitere Rang RANK_SPAN LP darüber. */
export const RANK_TIERS: readonly RankTier[] = [
  'wood',
  'iron',
  'bronze',
  'silver',
  'gold',
  'platinum',
  'diamond',
  'infinity',
];
/** = ELO_START: Man beginnt in Holz V mit 0 LP und arbeitet sich über Holz I nach Eisen V. */
export const RANK_FLOOR = ELO_START;
export const DIVISION_LP = 100;
export const DIVISIONS = 5;
const RANK_SPAN = DIVISION_LP * DIVISIONS;

export interface Rank {
  tier: RankTier;
  /** 5 (unterste) bis 1 (oberste); null bei Infinity - der ist nach oben offen wie Master in LoL. */
  division: number | null;
  /** LP innerhalb der Division (0-99), bei Infinity alles über der Schwelle. */
  lp: number;
}

/**
 * Rang zu einem LP-Wert. Unter Holz V geht es nicht weiter - wer tiefer fällt, bleibt bei
 * "Holz V, 0 LP" stehen, zählt intern aber weiter (sonst wäre der Weg zurück nach oben kürzer
 * als der hinunter).
 */
export function rankFromLp(total: number): Rank {
  const lp = Math.max(0, Math.round(total) - RANK_FLOOR);
  const tierIndex = Math.min(Math.floor(lp / RANK_SPAN), RANK_TIERS.length - 1);
  const tier = RANK_TIERS[tierIndex];
  const inTier = lp - tierIndex * RANK_SPAN;
  if (tier === 'infinity') return { tier, division: null, lp: inTier };
  return {
    tier,
    division: DIVISIONS - Math.floor(inTier / DIVISION_LP),
    lp: inTier % DIVISION_LP,
  };
}

/** Römische Ziffer der Division (V ... I). */
export function divisionLabel(division: number | null): string {
  return division == null ? '' : ['I', 'II', 'III', 'IV', 'V'][division - 1];
}
