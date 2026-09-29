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
 */

export const ELO_START = 1000;
/** K-Faktor; in den ersten Partien höher, damit neue Spieler schneller an ihren Platz kommen. */
export const ELO_K = 32;
export const ELO_K_PROVISIONAL = 48;
export const ELO_PROVISIONAL_GAMES = 10;

export interface EloEntry {
  name: string;
  rating: number;
  games: number;
  wins: number;
  /** Höchster erreichter Wert. */
  peak: number;
  /** LP der letzten Partie in diesem Modus. */
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
  return 1 / (1 + 10 ** ((ratingB - ratingA) / 400));
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
      e.lastChange = change;
      e.games++;
      if (seat.rank === 1 && seats.some((s) => s.rank > 1)) e.wins++;
      e.peak = Math.max(e.peak, e.rating);
      e.provisional = e.games < ELO_PROVISIONAL_GAMES;
    }
  }

  return [...table.values()].sort((a, b) => b.rating - a.rating || b.games - a.games);
}

/** Modi, in denen es überhaupt gewertete Partien gibt, in der Reihenfolge von `modes`. */
export function ratedModes(matches: readonly Match[], modes: readonly GameMode[]): GameMode[] {
  const present = new Set(matches.filter(isRatedMatch).map((m) => m.mode));
  return modes.filter((m) => present.has(m));
}
