import { Match, MatchPlayer } from './models';
import { DRAW, isImportLossDuplicate, isPlayerWinner } from './match-utils';

/**
 * Auswertungen über Partien, die es vor dem Partie-Verlauf (sql/partie-verlauf-2026-10-04.sql)
 * nicht geben konnte oder die bisher fehlten: Zugreihenfolge, Spieldauer, Lieblingsgegner,
 * Deck-gegen-Deck, Form. Alles reine Funktionen über eine Match-Liste - die Komponente
 * match-insights reicht nur die schon gefilterten Partien des Statistik-Tabs herein.
 */

/** Partien, die als echte Partie zählen (ohne Import-Duplikate). */
function countable(matches: readonly Match[]): Match[] {
  return matches.filter((m) => !isImportLossDuplicate(m));
}

export function winnersOf(match: Match): MatchPlayer[] {
  if (match.winner === DRAW) return [];
  return match.players.filter((p) => isPlayerWinner(match.mode, match.winner, p.name, p.team, p.isArchenemy));
}

export function didWin(match: Match, playerName: string): boolean {
  return winnersOf(match).some((p) => p.name === playerName);
}

// --- Zugreihenfolge ---

export interface SeatStat {
  /** Platz in der Zugreihenfolge, 1 = hat angefangen. */
  seat: number;
  games: number;
  wins: number;
  winRate: number;
}

/**
 * Winrate je Platz in der Zugreihenfolge. Ohne player über alle Spieler der Partien (jede Partie
 * zählt einmal je Platz), mit player nur seine Plätze. Partien ohne bekannte Reihenfolge fallen
 * heraus.
 */
export function turnOrderStats(matches: readonly Match[], player?: string | null): SeatStat[] {
  const bySeat = new Map<number, { games: number; wins: number }>();
  for (const match of countable(matches)) {
    const winners = new Set(winnersOf(match).map((p) => p.name));
    for (const p of match.players) {
      if (!p.turnOrder) continue;
      if (player && p.name !== player) continue;
      const entry = bySeat.get(p.turnOrder) ?? { games: 0, wins: 0 };
      entry.games++;
      if (winners.has(p.name)) entry.wins++;
      bySeat.set(p.turnOrder, entry);
    }
  }
  return [...bySeat.entries()]
    .sort(([a], [b]) => a - b)
    .map(([seat, { games, wins }]) => ({ seat, games, wins, winRate: games ? (wins / games) * 100 : 0 }));
}

// --- Spieldauer ---

/** Kürzer ist ein Fehlstart, länger eine vergessene offene Partie - beides verzerrt jeden Schnitt. */
const MIN_DURATION_MIN = 3;
const MAX_DURATION_MIN = 8 * 60;

export function durationMinutes(match: Pick<Match, 'date' | 'startedAt'>): number | null {
  if (!match.startedAt) return null;
  const minutes = (new Date(match.date).getTime() - new Date(match.startedAt).getTime()) / 60_000;
  if (!Number.isFinite(minutes) || minutes < MIN_DURATION_MIN || minutes > MAX_DURATION_MIN) return null;
  return Math.round(minutes);
}

export interface DurationGroup {
  label: string;
  games: number;
  avgMinutes: number;
}

export interface DurationStats {
  games: number;
  avgMinutes: number;
  longest: { match: Match; minutes: number };
  shortest: { match: Match; minutes: number };
  byDeck: DurationGroup[];
  byPlayerCount: DurationGroup[];
}

/** Bezeichnung eines Decks in einer Partie: Deckname, sonst Commander, sonst null. */
export function deckLabel(p: MatchPlayer): string | null {
  return p.deckName ?? p.commander ?? null;
}

function deckKey(p: MatchPlayer): string | null {
  return p.deckId ?? (p.commander ? `cmd:${p.commander}` : null);
}

export function durationStats(matches: readonly Match[], player?: string | null): DurationStats | null {
  const timed = countable(matches)
    .filter((m) => !player || m.players.some((p) => p.name === player))
    .map((match) => ({ match, minutes: durationMinutes(match) }))
    .filter((e): e is { match: Match; minutes: number } => e.minutes !== null);
  if (timed.length === 0) return null;

  const decks = new Map<string, { label: string; total: number; games: number }>();
  const counts = new Map<number, { total: number; games: number }>();
  for (const { match, minutes } of timed) {
    for (const p of match.players) {
      if (player && p.name !== player) continue;
      const key = deckKey(p);
      const label = deckLabel(p);
      if (!key || !label) continue;
      const entry = decks.get(key) ?? { label, total: 0, games: 0 };
      entry.total += minutes;
      entry.games++;
      decks.set(key, entry);
    }
    const n = match.players.length;
    const c = counts.get(n) ?? { total: 0, games: 0 };
    c.total += minutes;
    c.games++;
    counts.set(n, c);
  }

  const sorted = [...timed].sort((a, b) => a.minutes - b.minutes);
  return {
    games: timed.length,
    avgMinutes: Math.round(timed.reduce((s, e) => s + e.minutes, 0) / timed.length),
    shortest: sorted[0],
    longest: sorted[sorted.length - 1],
    byDeck: [...decks.values()]
      .filter((d) => d.games >= 2)
      .map((d) => ({ label: d.label, games: d.games, avgMinutes: Math.round(d.total / d.games) }))
      .sort((a, b) => b.avgMinutes - a.avgMinutes),
    byPlayerCount: [...counts.entries()]
      .sort(([a], [b]) => a - b)
      .map(([n, c]) => ({ label: String(n), games: c.games, avgMinutes: Math.round(c.total / c.games) })),
  };
}

// --- Gegner: Lieblingsgegner ("Nemesis") und Lieblingsopfer ---

export interface OpponentStat {
  name: string;
  /** Partien, in denen beide am Tisch saßen. */
  games: number;
  /** Partien, die der Gegner gewonnen hat. */
  lostTo: number;
  /** Partien, die der Spieler gewonnen hat. */
  beat: number;
}

/**
 * Bilanz eines Spielers gegen jeden, mit dem er am Tisch saß. Teamkollegen (2HG) und Verbündete
 * gegen den Archenemy sind keine Gegner und fallen heraus.
 */
export function opponentStats(matches: readonly Match[], player: string): OpponentStat[] {
  const stats = new Map<string, OpponentStat>();
  for (const match of countable(matches)) {
    const me = match.players.find((p) => p.name === player);
    if (!me) continue;
    const winners = new Set(winnersOf(match).map((p) => p.name));
    const iWon = winners.has(player);
    for (const other of match.players) {
      if (other.name === player || isAlly(match, me, other)) continue;
      const entry = stats.get(other.name) ?? { name: other.name, games: 0, lostTo: 0, beat: 0 };
      entry.games++;
      if (iWon) entry.beat++;
      else if (winners.has(other.name)) entry.lostTo++;
      stats.set(other.name, entry);
    }
  }
  return [...stats.values()].sort((a, b) => b.games - a.games);
}

function isAlly(match: Match, a: MatchPlayer, b: MatchPlayer): boolean {
  if (match.mode === 'Two-Headed Giant') return !!a.team && a.team === b.team;
  if (match.mode === 'Archenemy') return !a.isArchenemy && !b.isArchenemy;
  return false;
}

/** Ab so vielen gemeinsamen Partien ist eine Bilanz mehr als Zufall. */
export const OPPONENT_MIN_GAMES = 3;

/** Wer den Spieler am häufigsten besiegt (anteilig), oder null. */
export function nemesis(stats: readonly OpponentStat[]): OpponentStat | null {
  return pickBy(stats, (s) => s.lostTo / s.games, (s) => s.lostTo);
}

/** Wen der Spieler am häufigsten besiegt (anteilig), oder null. */
export function favoriteVictim(stats: readonly OpponentStat[]): OpponentStat | null {
  return pickBy(stats, (s) => s.beat / s.games, (s) => s.beat);
}

function pickBy(
  stats: readonly OpponentStat[],
  rate: (s: OpponentStat) => number,
  count: (s: OpponentStat) => number,
): OpponentStat | null {
  const candidates = stats.filter((s) => s.games >= OPPONENT_MIN_GAMES && count(s) > 0);
  if (candidates.length === 0) return null;
  return [...candidates].sort((a, b) => rate(b) - rate(a) || count(b) - count(a))[0];
}

// --- Deck gegen Deck ---

export interface Matchup {
  a: string;
  b: string;
  games: number;
  aWins: number;
  bWins: number;
}

/**
 * Wie oft hat Deck A gegen Deck B gewonnen und umgekehrt - aus jeder Partie, in der beide am
 * Tisch saßen. Ein Sieg zählt nur gegen die Decks am selben Tisch, nicht als Duell zwischen zwei
 * Verlierern. Mit player nur die Paarungen seiner Decks, sein Deck steht dann immer links.
 */
export function deckMatchups(matches: readonly Match[], player?: string | null, minGames = 2): Matchup[] {
  const pairs = new Map<string, Matchup>();
  for (const match of countable(matches)) {
    const winners = new Set(winnersOf(match).map((p) => p.name));
    const seated = match.players
      .map((p) => ({ p, key: deckKey(p), label: deckLabel(p) }))
      .filter((e): e is { p: MatchPlayer; key: string; label: string } => !!e.key && !!e.label);
    for (let i = 0; i < seated.length; i++) {
      for (let j = i + 1; j < seated.length; j++) {
        let [x, y] = [seated[i], seated[j]];
        if (x.key === y.key || isAlly(match, x.p, y.p)) continue;
        if (player) {
          if (y.p.name === player && x.p.name !== player) [x, y] = [y, x];
          if (x.p.name !== player) continue;
        } else if (x.label.localeCompare(y.label) > 0) {
          [x, y] = [y, x];
        }
        const id = `${x.key}|${y.key}`;
        const entry = pairs.get(id) ?? { a: x.label, b: y.label, games: 0, aWins: 0, bWins: 0 };
        entry.games++;
        if (winners.has(x.p.name)) entry.aWins++;
        if (winners.has(y.p.name)) entry.bWins++;
        pairs.set(id, entry);
      }
    }
  }
  return [...pairs.values()].filter((m) => m.games >= minGames).sort((a, b) => b.games - a.games);
}

// --- Form ---

export type FormResult = 'W' | 'L' | 'D';

/** Die letzten Ergebnisse eines Spielers, neueste zuerst. */
export function recentForm(matches: readonly Match[], player: string, count = 10): { match: Match; result: FormResult }[] {
  return countable(matches)
    .filter((m) => m.players.some((p) => p.name === player))
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, count)
    .map((match) => ({
      match,
      result: match.winner === DRAW ? 'D' : didWin(match, player) ? 'W' : 'L',
    }));
}

export interface MonthStat {
  /** "2026-09" */
  month: string;
  games: number;
  wins: number;
  winRate: number;
}

/** Winrate je Monat, die letzten `months` Monate mit Partien, älteste zuerst. */
export function monthlyWinRate(matches: readonly Match[], player: string, months = 12): MonthStat[] {
  const byMonth = new Map<string, { games: number; wins: number }>();
  for (const match of countable(matches)) {
    if (!match.players.some((p) => p.name === player)) continue;
    const month = match.date.slice(0, 7);
    const entry = byMonth.get(month) ?? { games: 0, wins: 0 };
    entry.games++;
    if (didWin(match, player)) entry.wins++;
    byMonth.set(month, entry);
  }
  return [...byMonth.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(-months)
    .map(([month, { games, wins }]) => ({ month, games, wins, winRate: (wins / games) * 100 }));
}

// --- Jahresrückblick ---

export interface YearReview {
  year: number;
  player: string;
  games: number;
  wins: number;
  winRate: number;
  topDeck: { label: string; games: number; wins: number } | null;
  bestDeck: { label: string; games: number; winRate: number } | null;
  nemesis: OpponentStat | null;
  victim: OpponentStat | null;
  longestMinutes: number | null;
  totalMinutes: number;
  bestStreak: number;
  firstSeatWinRate: number | null;
}

/** Kennzahlen eines Spielers für ein Jahr, oder null ohne Partien in diesem Jahr. */
export function yearReview(matches: readonly Match[], player: string, year: number): YearReview | null {
  const own = countable(matches)
    .filter((m) => new Date(m.date).getFullYear() === year && m.players.some((p) => p.name === player))
    .sort((a, b) => a.date.localeCompare(b.date));
  if (own.length === 0) return null;

  const wins = own.filter((m) => didWin(m, player)).length;
  const decks = new Map<string, { label: string; games: number; wins: number }>();
  let streak = 0;
  let bestStreak = 0;
  let totalMinutes = 0;
  let longest: number | null = null;
  for (const m of own) {
    const me = m.players.find((p) => p.name === player)!;
    const key = deckKey(me);
    const label = deckLabel(me);
    const won = didWin(m, player);
    if (key && label) {
      const d = decks.get(key) ?? { label, games: 0, wins: 0 };
      d.games++;
      if (won) d.wins++;
      decks.set(key, d);
    }
    streak = won ? streak + 1 : 0;
    bestStreak = Math.max(bestStreak, streak);
    const minutes = durationMinutes(m);
    if (minutes !== null) {
      totalMinutes += minutes;
      longest = Math.max(longest ?? 0, minutes);
    }
  }
  const deckList = [...decks.values()];
  const topDeck = [...deckList].sort((a, b) => b.games - a.games)[0] ?? null;
  const best = deckList
    .filter((d) => d.games >= 3)
    .map((d) => ({ label: d.label, games: d.games, winRate: (d.wins / d.games) * 100 }))
    .sort((a, b) => b.winRate - a.winRate || b.games - a.games)[0];
  const opponents = opponentStats(own, player);
  const seats = turnOrderStats(own, player);
  const first = seats.find((s) => s.seat === 1);

  return {
    year,
    player,
    games: own.length,
    wins,
    winRate: (wins / own.length) * 100,
    topDeck,
    bestDeck: best ?? null,
    nemesis: nemesis(opponents),
    victim: favoriteVictim(opponents),
    longestMinutes: longest,
    totalMinutes,
    bestStreak,
    firstSeatWinRate: first && first.games >= 3 ? first.winRate : null,
  };
}
