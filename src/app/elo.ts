import { ARCHENEMY_OTHERS, DRAW, isImportLossDuplicate } from './match-utils';
import { GameMode, LIVE_TRACKING_START_DATE, Match } from './models';

/**
 * Elo-Wertung je Spielmodus, aus dem Match-Verlauf berechnet (nichts gespeichert, deshalb auch
 * rückwirkend immer konsistent).
 *
 * Eine Partie mit mehreren Spielern zählt als Bündel von Einzelduellen: gegen jeden Gegner, der
 * schlechter platziert ist, ein Sieg, gleich platziert ein Remis, besser platziert eine Niederlage.
 * Je Duell die klassische Elo-Erwartung, die Summe wird durch die Zahl der Gegner geteilt - ein
 * Pod-Sieg ist so ungefähr so viel wert wie ein 1v1-Sieg, und wer starke Gegner schlägt, bekommt
 * mehr. Die Änderung einer Partie heißt in der Oberfläche "LP".
 *
 * Teamkollegen (Two-Headed Giant) und die Verbündeten gegen den Archenemy duellieren sich nicht.
 *
 * Skala wie in League of Legends: LP (League Points), Start 800 = Holz II, je Division 100 LP,
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

/** Zählt diese Partie für die Wertung? Nur echte, live erfasste Partien mit mindestens zwei Seiten. */
export function isRatedMatch(match: Match): boolean {
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

  // Jeder für sich: eingetragene Platzierungen, der Sieger ist Platz 1, alle übrigen teilen sich den
  // Platz hinter der schlechtesten eingetragenen Platzierung.
  const known = players
    .map((p) => (p.name === match.winner ? 1 : p.placement))
    .filter((r): r is number => r != null);
  const rest = Math.max(1, ...known) + 1;
  return players.map((p) => ({
    name: p.name,
    rank: p.name === match.winner ? 1 : (p.placement ?? rest),
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
      const score = me.rank < o.rank ? 1 : me.rank === o.rank ? 0.5 : 0;
      sum += score - expectedScore(rating(me.name), rating(o.name));
    }
    const k = games(me.name) < ELO_PROVISIONAL_GAMES ? ELO_K_PROVISIONAL : ELO_K;
    changes.set(me.name, (k * sum) / opponents.length);
  }
  return changes;
}

/** Rangliste eines Modus, nach Wertung absteigend. Matches werden chronologisch verrechnet. */
export function eloRanking(matches: readonly Match[], mode: GameMode): EloEntry[] {
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
    .filter((m) => m.mode === mode && isRatedMatch(m))
    .sort((a, b) => a.date.localeCompare(b.date));

  for (const match of rated) {
    const seats = seatsOf(match);
    const changes = matchChanges(
      seats,
      (n) => entry(n).rating,
      (n) => entry(n).games,
    );
    for (const seat of seats) {
      const e = entry(seat.name);
      const change = changes.get(seat.name) ?? 0;
      e.rating += change;
      e.lp += change + ELO_LP_BONUS;
      e.lastChange = change + ELO_LP_BONUS;
      e.games++;
      if (seat.rank === 1 && seats.some((s) => s.rank > 1)) e.wins++;
      e.peak = Math.max(e.peak, e.lp);
      e.provisional = e.games < ELO_PROVISIONAL_GAMES;
    }
  }

  return [...table.values()].sort((a, b) => b.lp - a.lp || b.games - a.games);
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
export const RANK_FLOOR = 500;
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
