import { Injectable, inject } from '@angular/core';
import * as XLSX from 'xlsx';
import JSZip from 'jszip';
import { DeckFormat, GameMode, Match, MatchPlayer, TeamName } from './models';
import { ScryfallService } from './scryfall.service';
import { sleep } from './array-utils';

export interface DetectedDeckSheet {
  sheetName: string;
  guessedPlayer: string;
}

interface DeckRow {
  deckName: string;
  /** Roher (noch ungereinigter) Text aus dem als Bild hinterlegten Zeilen-Kommentar, falls vorhanden. */
  noteTitle?: string;
  normal: { played: number; wins: number };
  archTeam: { played: number; wins: number };
  archEvil: { played: number; wins: number };
  twoHg: { played: number; wins: number };
  cube: { played: number; wins: number };
}

const ARCHENEMY_OTHERS = '__OTHERS__';
export const IMPORT_LOSS_PLACEHOLDER = 'Unbekannt (Import)';
export const IMPORT_ARCHENEMY_LOSS_PLACEHOLDER = 'Archenemy (Import)';
const IMPORT_TEAM: TeamName = 'Team 1';
const IMPORT_OPPONENT_TEAM: TeamName = 'Team 2';

@Injectable({ providedIn: 'root' })
export class ExcelImportService {
  private readonly scryfall = inject(ScryfallService);

  private workbook: XLSX.WorkBook | null = null;

  /** Spielername (lowercase) -> Jahresabschluss-Event-Stats, aus der Übersichts-Sheet gelesen. */
  private yearEndStats = new Map<string, { played: number; wins: number }>();

  /**
   * Manche Decks tragen den Commander nicht als Text in Spalte A, sondern als Bild in einem an
   * die Zeile gehefteten Excel-Kommentar (Notiz). sheetName -> (0-indexierte Zeile -> Bildtitel).
   * Der Bildtitel ist meist der (leicht verunstaltete) Kartenname, manchmal aber auch nur ein
   * bedeutungsloser Datei-Hash - deshalb wird er später über Scryfall verifiziert statt blind
   * übernommen.
   */
  private noteTitlesBySheet = new Map<string, Map<number, string>>();

  /** Liest die Datei ein und liefert alle Tabs, die wie ein Decks-Sheet aussehen. */
  async loadFile(file: File): Promise<DetectedDeckSheet[]> {
    // Verhindert, dass eine übergroße Datei den Parser (XLSX.read()) unnötig lange blockiert oder
    // den Speicher sprengt - der Aufrufer (stats-tab.ts) fängt den Fehler bereits ab und zeigt
    // eine generische Meldung.
    if (file.size > 10 * 1024 * 1024) {
      throw new Error('Datei ist zu groß (max. 10 MB).');
    }
    const buffer = await file.arrayBuffer();
    this.workbook = XLSX.read(buffer, { type: 'array' });
    this.parseYearEndStats();
    this.noteTitlesBySheet = await this.parseNoteTitles(buffer);

    return this.workbook.SheetNames.filter((name) => /decks?/i.test(name)).map((sheetName) => ({
      sheetName,
      guessedPlayer: this.guessPlayerName(sheetName),
    }));
  }

  /**
   * Liest aus der rohen .xlsx-ZIP-Struktur (SheetJS bildet Kommentar-Bilder nicht ab) für jedes
   * Sheet die an Zeilen gehefteten Kommentar-Notizen aus und extrahiert deren Bild-Titel
   * (o:title-Attribut in der zugehörigen VML-Datei). Bricht bei Problemen sauber ab - fehlende
   * Kommentare sind kein Fehler, dann greift einfach der bisherige Deckname-Fallback.
   */
  private async parseNoteTitles(buffer: ArrayBuffer): Promise<Map<string, Map<number, string>>> {
    const result = new Map<string, Map<number, string>>();
    try {
      const zip = await JSZip.loadAsync(buffer);
      const parser = new DOMParser();

      const workbookXml = await zip.file('xl/workbook.xml')?.async('text');
      const workbookRelsXml = await zip.file('xl/_rels/workbook.xml.rels')?.async('text');
      if (!workbookXml || !workbookRelsXml) return result;

      const wbDoc = parser.parseFromString(workbookXml, 'application/xml');
      const relsDoc = parser.parseFromString(workbookRelsXml, 'application/xml');

      const relIdBySheetName = new Map<string, string>();
      for (const node of Array.from(wbDoc.getElementsByTagName('sheet'))) {
        const name = node.getAttribute('name');
        const rId = node.getAttribute('r:id');
        if (name && rId) relIdBySheetName.set(name, rId);
      }

      const targetByRelId = new Map<string, string>();
      for (const rel of Array.from(relsDoc.getElementsByTagName('Relationship'))) {
        const id = rel.getAttribute('Id');
        const target = rel.getAttribute('Target');
        if (id && target) targetByRelId.set(id, target);
      }

      for (const [sheetName, rId] of relIdBySheetName) {
        const target = targetByRelId.get(rId);
        if (!target) continue;

        const sheetFile = this.resolveZipPath('xl', target);
        const sheetFileName = target.split('/').pop()!;
        const sheetRelsPath = this.resolveZipPath('xl/worksheets', `_rels/${sheetFileName}.rels`);
        const sheetRelsXml = await zip.file(sheetRelsPath)?.async('text');
        if (!sheetRelsXml) continue;

        const sheetRelsDoc = parser.parseFromString(sheetRelsXml, 'application/xml');
        let vmlTarget: string | null = null;
        for (const rel of Array.from(sheetRelsDoc.getElementsByTagName('Relationship'))) {
          if ((rel.getAttribute('Type') ?? '').endsWith('/vmlDrawing')) {
            vmlTarget = rel.getAttribute('Target');
            break;
          }
        }
        if (!vmlTarget) continue;

        const vmlPath = this.resolveZipPath(this.dirname(sheetFile), vmlTarget);
        const vmlXml = await zip.file(vmlPath)?.async('text');
        if (!vmlXml) continue;

        const titleByRow = this.parseVmlNoteTitles(vmlXml, parser);
        if (titleByRow.size > 0) result.set(sheetName, titleByRow);
      }
    } catch (err) {
      console.error('Konnte Kommentar-Bilder nicht auslesen, nutze Deckname-Fallback:', err);
    }
    return result;
  }

  private parseVmlNoteTitles(vmlXml: string, parser: DOMParser): Map<number, string> {
    const result = new Map<number, string>();
    const doc = parser.parseFromString(vmlXml, 'application/xml');

    for (const shape of Array.from(doc.getElementsByTagName('v:shape'))) {
      const clientData = shape.getElementsByTagName('x:ClientData')[0];
      if (!clientData || clientData.getAttribute('ObjectType') !== 'Note') continue;

      const rowText = clientData.getElementsByTagName('x:Row')[0]?.textContent;
      const row = rowText ? parseInt(rowText, 10) : NaN;
      if (Number.isNaN(row)) continue;

      const title = shape.getElementsByTagName('v:fill')[0]?.getAttribute('o:title')?.trim();
      if (title) result.set(row, title);
    }

    return result;
  }

  private resolveZipPath(baseDir: string, relativeTarget: string): string {
    if (relativeTarget.startsWith('/')) return relativeTarget.slice(1);
    const parts = baseDir.split('/').filter(Boolean);
    for (const part of relativeTarget.split('/')) {
      if (part === '..') parts.pop();
      else if (part !== '.') parts.push(part);
    }
    return parts.join('/');
  }

  private dirname(path: string): string {
    const idx = path.lastIndexOf('/');
    return idx === -1 ? '' : path.slice(0, idx);
  }

  /**
   * Bereinigt einen aus dem Bildtitel gewonnenen Rohtext grob (Datei-Slugs nutzen "_"/"-" statt
   * Leerzeichen und hängen oft Set-/Sprachkürzel oder Shop-Metadaten an), bevor er über Scryfalls
   * Fuzzy-Suche verifiziert wird. Muss nicht perfekt sein - dafür ist die Fuzzy-Suche da.
   */
  private cleanNoteTitle(raw: string): string {
    let text = raw.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
    text = text.replace(
      /\b(mtg|magic the gathering|karte|kaufen|eng|de|lnen|cn\d+|s\d+|\d{3,4}x\d{3,4})\b.*$/i,
      ''
    );
    return text.trim();
  }

  /**
   * Das "Jahres Abschluss Event" steht nicht pro Deck, sondern nur einmal pro
   * Spieler in der Übersichts-Sheet (z.B. "Winrate "), Spalten Name/Played/Wins
   * direkt rechts vom Header "Jahres Abschluss Event". Wird über alle Sheets
   * gesucht, damit ein abweichender Sheet-Name nichts kaputt macht.
   */
  private parseYearEndStats(): void {
    this.yearEndStats.clear();
    if (!this.workbook) return;

    for (const sheetName of this.workbook.SheetNames) {
      const raw = XLSX.utils.sheet_to_json(this.workbook.Sheets[sheetName], {
        header: 1,
        defval: null,
      }) as unknown[][];

      const headerRow = raw[0] ?? [];
      const colIdx = headerRow.findIndex((v) => typeof v === 'string' && v.trim() === 'Jahres Abschluss Event');
      if (colIdx === -1) continue;


      for (let i = 2; i < raw.length; i++) {
        const r = raw[i];
        const name = typeof r[colIdx] === 'string' ? (r[colIdx] as string).trim() : '';
        // Leere Zeile = Tabellenende. Wichtig: manche Sheets haben darunter in
        // denselben Spalten noch eine ZWEITE, andere Tabelle (z.B. "Jahres
        // Ergebnis" mit Gesamt-Spielzahlen) – die darf hier nicht mit eingelesen werden.
        if (!name) break;
        const played = typeof r[colIdx + 1] === 'number' ? (r[colIdx + 1] as number) : 0;
        const wins = typeof r[colIdx + 2] === 'number' ? (r[colIdx + 2] as number) : 0;
        this.yearEndStats.set(name.toLowerCase(), { played, wins });
      }
      return;
    }
  }
  /** Nur ein Vorschlag fürs Zuordnungs-Formular – nicht bei jedem Tab-Namen zuverlässig (z.B. Tippfehler). */
  private guessPlayerName(sheetName: string): string {
    return sheetName
      .replace(/decks?\s*$/i, '')
      .replace(/['’]s?\s*$/i, '')
      .trim();
  }

  /**
   * Baut aus den bestätigten Sheet->Spieler-Zuordnungen synthetische Match-Objekte (ohne id).
   * `assignCube`: wenn gesetzt, bekommen ALLE importierten Cube-Modus-Spiele diesen konkreten
   * Cube zugeordnet (statt ohne Cube-Bezug reinzukommen).
   * `onProgress`: optionaler Fortschritts-Callback während der Commander-Erkennung (kann dauern,
   * da jeder unbekannte Kandidat einzeln über Scryfall verifiziert wird).
   */
  async buildMatches(
    mapping: { sheetName: string; player: string }[],
    importDate: string,
    assignCube?: { id: string; name: string; isCommander: boolean },
    onProgress?: (done: number, total: number) => void
  ): Promise<Omit<Match, 'id' | 'countsInGeneralStats'>[]> {
    if (!this.workbook) return [];

    const rowsBySheet = new Map<string, DeckRow[]>();
    for (const { sheetName } of mapping) {
      rowsBySheet.set(sheetName, this.parseDeckSheet(sheetName));
    }

    const commanderNames = await this.resolveCommanderNames(rowsBySheet, onProgress);

    const result: Omit<Match, 'id' | 'countsInGeneralStats'>[] = [];

    for (const { sheetName, player } of mapping) {
      const trimmedPlayer = player.trim();
      if (!trimmedPlayer) continue;

      for (const row of rowsBySheet.get(sheetName) ?? []) {
        const commander = commanderNames.get(this.rowKey(row)) ?? row.deckName;
        result.push(...this.buildSimpleMode('Normal', trimmedPlayer, commander, row.normal, importDate));
        result.push(...this.buildArchenemyTeam(trimmedPlayer, commander, row.archTeam, importDate));
        result.push(...this.buildArchenemyEvil(trimmedPlayer, commander, row.archEvil, importDate));
        result.push(...this.buildTwoHeadedGiant(trimmedPlayer, commander, row.twoHg, importDate));
        result.push(...this.buildCubeMode(trimmedPlayer, commander, row.cube, importDate, assignCube));
      }

      // Jahresabschluss-Event ist pro Spieler (nicht pro Deck) gezählt -> nur einmal pro Mapping-Eintrag.
      const guessedName = this.guessPlayerName(sheetName);
      const yearEnd = this.yearEndStats.get(guessedName.toLowerCase()) ?? this.yearEndStats.get(trimmedPlayer.toLowerCase());
      if (yearEnd) {
        result.push(...this.buildSimpleMode('Spezialevent', trimmedPlayer, undefined, yearEnd, importDate, null));
      }
    }

    return result;
  }

  /** Eindeutiger Schlüssel je Zeilen-"Form" (Deckname + evtl. Bildtitel), zum Cachen der Auflösung. */
  private rowKey(row: DeckRow): string {
    return `${row.deckName} ${row.noteTitle ?? ''}`;
  }

  /**
   * Verifiziert alle einzigartigen Zeilen über Scryfall (siehe ScryfallService.resolveCommanderCandidate)
   * und liefert eine Map Zeilen-Schlüssel -> offizieller Kartenname. Pro Zeile wird ZUERST der
   * Deckname versucht (der Nutzer pflegt dort inzwischen die korrekten Commander-Namen) und NUR
   * falls das nichts findet, ersatzweise der Bildtitel aus einem eingebetteten Kommentar (falls
   * vorhanden) - vorher war das umgekehrt. Zeilen ohne Treffer fehlen in der Map (Aufrufer fällt
   * dann auf den Rohtext zurück). Läuft sequenziell (Scryfall erlaubt keine Bulk-Fuzzy-/Wort-Suche),
   * daher der Progress-Callback.
   */
  private async resolveCommanderNames(
    rowsBySheet: Map<string, DeckRow[]>,
    onProgress?: (done: number, total: number) => void
  ): Promise<Map<string, string>> {
    const uniqueRows = new Map<string, DeckRow>();
    for (const rows of rowsBySheet.values()) {
      for (const row of rows) {
        if (!row.deckName && !row.noteTitle) continue;
        uniqueRows.set(this.rowKey(row), row);
      }
    }

    const result = new Map<string, string>();
    const entries = [...uniqueRows.entries()];
    let done = 0;

    for (const [key, row] of entries) {
      let resolvedName = row.deckName ? await this.scryfall.resolveCommanderCandidate(row.deckName) : null;
      if (!resolvedName && row.noteTitle) {
        resolvedName = await this.scryfall.resolveCommanderCandidate(this.cleanNoteTitle(row.noteTitle));
      }
      if (resolvedName) result.set(key, resolvedName);
      done++;
      onProgress?.(done, entries.length);
      await sleep(400); // Scryfalls Rate-Limit respektieren, sonst schlagen die Anfragen mit 429 fehl.
    }

    return result;
  }

  private parseDeckSheet(sheetName: string): DeckRow[] {
    const sheet = this.workbook!.Sheets[sheetName];
    const raw = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null }) as unknown[][];
    const noteTitles = this.noteTitlesBySheet.get(sheetName);

    const num = (v: unknown): number => (typeof v === 'number' ? v : 0);
    const rows: DeckRow[] = [];

    // Zeile 1+2 sind der zweizeilige Header, Daten beginnen ab Index 2 (Zeile 3).
    for (let i = 2; i < raw.length; i++) {
      const r = raw[i];
      const deckName = typeof r[0] === 'string' ? r[0].trim() : '';
      if (!deckName) continue;

      rows.push({
        deckName,
        noteTitle: noteTitles?.get(i),
        normal: { played: num(r[1]), wins: num(r[2]) },
        archTeam: { played: num(r[4]), wins: num(r[5]) },
        archEvil: { played: num(r[7]), wins: num(r[8]) },
        twoHg: { played: num(r[10]), wins: num(r[11]) },
        cube: { played: num(r[13]), wins: num(r[14]) },
      });
    }
    return rows;
  }


  private buildSimpleMode(
    mode: GameMode,
    player: string,
    commander: string | undefined,
    stats: { played: number; wins: number },
    date: string,
    format: DeckFormat | null = 'Commander',
  ): Omit<Match, 'id' | 'countsInGeneralStats'>[] {
    const matches: Omit<Match, 'id' | 'countsInGeneralStats'>[] = [];
    const losses = Math.max(0, stats.played - stats.wins);

    for (let i = 0; i < stats.wins; i++) {
      matches.push(this.makeMatch(mode, date, [{ name: player, commander }], player, format));
    }
    for (let i = 0; i < losses; i++) {
      matches.push(this.makeMatch(mode, date, [{ name: player, commander }], IMPORT_LOSS_PLACEHOLDER, format));
    }
    return matches;
  }

  private buildCubeMode(
    player: string,
    commander: string | undefined,
    stats: { played: number; wins: number },
    date: string,
    assignCube?: { id: string; name: string; isCommander: boolean },
  ): Omit<Match, 'id' | 'countsInGeneralStats'>[] {
    const matches = this.buildSimpleMode('Cube', player, commander, stats, date);
    if (!assignCube) return matches;
    return matches.map((m) => ({ ...m, cube: assignCube }));
  }

  private buildArchenemyTeam(
    player: string,
    commander: string,
    stats: { played: number; wins: number },
    date: string,
  ): Omit<Match, 'id' | 'countsInGeneralStats'>[] {
    const matches: Omit<Match, 'id' | 'countsInGeneralStats'>[] = [];
    const losses = Math.max(0, stats.played - stats.wins);

    for (let i = 0; i < stats.wins; i++) {
      matches.push(this.makeMatch('Archenemy', date, [{ name: player, commander, isArchenemy: false }], ARCHENEMY_OTHERS));
    }
    for (let i = 0; i < losses; i++) {
      matches.push(
        this.makeMatch('Archenemy', date, [{ name: player, commander, isArchenemy: false }], IMPORT_ARCHENEMY_LOSS_PLACEHOLDER),
      );
    }
    return matches;
  }

  private buildArchenemyEvil(
    player: string,
    commander: string,
    stats: { played: number; wins: number },
    date: string,
  ): Omit<Match, 'id' | 'countsInGeneralStats'>[] {
    const matches: Omit<Match, 'id' | 'countsInGeneralStats'>[] = [];
    const losses = Math.max(0, stats.played - stats.wins);

    for (let i = 0; i < stats.wins; i++) {
      matches.push(this.makeMatch('Archenemy', date, [{ name: player, commander, isArchenemy: true }], player));
    }
    for (let i = 0; i < losses; i++) {
      matches.push(this.makeMatch('Archenemy', date, [{ name: player, commander, isArchenemy: true }], ARCHENEMY_OTHERS));
    }
    return matches;
  }

  private buildTwoHeadedGiant(
    player: string,
    commander: string,
    stats: { played: number; wins: number },
    date: string,
  ): Omit<Match, 'id' | 'countsInGeneralStats'>[] {
    const matches: Omit<Match, 'id' | 'countsInGeneralStats'>[] = [];
    const losses = Math.max(0, stats.played - stats.wins);

    for (let i = 0; i < stats.wins; i++) {
      matches.push(this.makeMatch('Two-Headed Giant', date, [{ name: player, commander, team: IMPORT_TEAM }], IMPORT_TEAM));
    }
    for (let i = 0; i < losses; i++) {
      matches.push(
        this.makeMatch('Two-Headed Giant', date, [{ name: player, commander, team: IMPORT_TEAM }], IMPORT_OPPONENT_TEAM),
      );
    }
    return matches;
  }

  private makeMatch(
    mode: GameMode,
    date: string,
    players: MatchPlayer[],
    winner: string,
    format: DeckFormat | null = 'Commander'
  ): Omit<Match, 'id' | 'countsInGeneralStats'> {
    return { mode, format, date, players, winner };
  }
}
