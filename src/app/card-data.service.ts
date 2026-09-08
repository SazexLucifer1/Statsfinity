import { Injectable, inject } from '@angular/core';
import { supabase } from './supabase.client';
import { chunk, normalizeCardName } from './array-utils';
import { ScryfallService, ScryfallCard } from './scryfall.service';
import type { SpellbookBracketTag } from './commander-spellbook.service';

/**
 * Die drei kuratierten Markierungen von Commander Spellbook, die es bei Scryfall nicht gibt und
 * die die offiziellen Bracket-Kriterien brauchen. Gefüllt von scripts/sync-spellbook-bracket.js,
 * Tabelle in sql/spellbook-cache-2026-09-06.sql.
 */
export interface SpellbookCardFlags {
  massLandDenial: boolean;
  extraTurn: boolean;
  tutor: boolean;
}

/**
 * Eine Zwei-Karten-Combo aus Commander Spellbook. cardA/cardB sind normalisierte
 * Vorderseiten-Namen, also derselbe Schlüssel wie in SpellbookCardFlags.
 */
export interface SpellbookTwoCardCombo {
  id: string;
  cardA: string;
  cardB: string;
  /** true = die Combo zählt nur, wenn diese Karte der Commander ist. */
  aMustBeCommander: boolean;
  bMustBeCommander: boolean;
  /** Zusätzlich nötiges Mana, um die Combo abzuschließen. */
  manaValueNeeded: number | null;
  /** Spellbooks Note für DIESE Combo (R/S/P/O/C/E/B) - bewertet Tempo und Härte der Combo. */
  bracketTag: SpellbookBracketTag | null;
  popularity: number | null;
}

/**
 * Eine Zeile aus der Combo-Finder-Suche: eine Combo, der bei der abgefragten Deckliste genau eine
 * Karte fehlt. Namen sind normalisierte Vorderseiten-Namen, also derselbe Schlüssel wie überall.
 */
export interface ComboSuggestionRow {
  comboId: string;
  /** Die eine Karte, die dem Deck für diese Combo noch fehlt. */
  missing: string;
  /** Die Karten der Combo, die das Deck schon hat. */
  present: string[];
  cardCount: number;
  /** Was die Combo am Ende erzeugt, in Spellbooks Benennung ("Infinite mana", ...). */
  produces: string[];
  /** Der Ablauf, ein Schritt je Zeile. */
  description: string;
  manaValueNeeded: number | null;
  popularity: number | null;
  /** Wie viele Combos dieselbe fehlende Karte insgesamt freischaltet. */
  comboCount: number;
  /** Wie viele fehlende Karten die Suche insgesamt gefunden hat (vor dem Farbfilter). */
  totalCards: number;
}

/**
 * Lesezugriff auf den eigenen Kartendatenbestand, den der nächtliche Abgleich füllt
 * (scripts/sync-scryfall-bulk.js, Tabellen in sql/scryfall-cache-2026-09-06.sql).
 *
 * Warum es diesen Service gibt: Die Analyse-Kacheln der Deck-Ansicht liefen über
 * ScryfallService.classifyCards() und lösten dabei rund 100 aufeinander folgende Suchanfragen pro
 * Deck aus - 12 Kategorien, je in Chunks von ~15 Kartennamen, mit 300 ms Zwangspause. Das dauerte
 * etwa eine Minute, und zwar bei jedem neuen Nutzer und auf jedem neuen Gerät erneut, weil der
 * bisherige Cache im localStorage liegt. Dieselbe Auskunft steht jetzt in einer Tabelle und
 * braucht eine einzige Abfrage.
 *
 * Bewusst NICHT ScryfallService erweitert: der spricht ausschließlich mit Scryfall, hier geht es
 * um die eigene Datenbank. Gleiche Trennung wie bei PublicDeckService gegenüber DeckService.
 */
@Injectable({ providedIn: 'root' })
export class CardDataService {
  private readonly scryfall = inject(ScryfallService);

  /** Spalten, aus denen sich ein vollständiges ScryfallCard zusammensetzen lässt (siehe toCard()). */
  private static readonly KARTEN_SPALTEN =
    'oracle_id, name, front_name_normalized, type_line, cmc, mana_cost, color_identity, produced_mana, game_changer, oracle_text, keywords, image_url, back_image_url, back_type_line, all_parts';

  /**
   * Nachgeschlagen wird immer mit dem normalisierten Vorderseiten-Namen - genau der Schlüssel, den
   * der Abgleich in front_name_normalized ablegt (siehe normalizedFrontName() im Sync-Skript) und
   * unter dem auch ScryfallService.classifyCards() klassifiziert. Der volle Doppelkartenname
   * ("A // B") würde nie treffen.
   */
  private lookupKey(cardName: string): string {
    return normalizeCardName(cardName.split(' // ')[0].trim());
  }

  /**
   * Obergrenze für Namen je Abfrage. Klein gehalten, weil je Name bis zu 12 Zeilen zurückkommen
   * (eine pro Kategorie): 75 Namen sind höchstens 900 Zeilen und bleiben damit sicher unter der
   * 1000-Zeilen-Grenze, die PostgREST je nach Projekteinstellung setzt - sonst würden Treffer
   * still abgeschnitten und einzelne Kacheln zeigten zu niedrige Zahlen.
   */
  private static readonly NAMEN_PRO_ABFRAGE = 75;

  /**
   * Liefert je Kategorie-Key die Menge der zutreffenden (normalisierten Vorderseiten-)Namen.
   *
   * Schlägt die Abfrage fehl (kein Netz, Tabelle noch nicht angelegt), kommt eine leere Map
   * zurück statt eines Fehlers. Der Aufrufer behandelt dann alle Karten als "unbekannt" und fällt
   * auf die bisherige Live-Abfrage bei Scryfall zurück - im schlimmsten Fall ist die App also
   * genauso langsam wie vorher, aber nie kaputt.
   */
  async effectCategories(cardNames: string[]): Promise<Map<string, Set<string>>> {
    const result = new Map<string, Set<string>>();
    const keys = [...new Set(cardNames.map((n) => this.lookupKey(n)).filter(Boolean))];
    if (keys.length === 0) return result;

    for (const block of chunk(keys, CardDataService.NAMEN_PRO_ABFRAGE)) {
      const { data, error } = await supabase
        .from('scryfall_card_effects')
        .select('category, front_name_normalized')
        .in('front_name_normalized', block);

      if (error) {
        console.warn(
          'Effekt-Kategorien konnten nicht geladen werden, Rückfall auf Scryfall:',
          error.message,
        );
        return new Map();
      }

      for (const row of data ?? []) {
        const menge = result.get(row.category) ?? new Set<string>();
        menge.add(row.front_name_normalized);
        result.set(row.category, menge);
      }
    }

    return result;
  }

  /**
   * Welche der übergebenen Namen kennt der Abgleich überhaupt?
   *
   * Nötig, um "diese Karte hat keinen einzigen Effekt-Tag" von "diese Karte kennen wir noch gar
   * nicht" zu unterscheiden. Ohne diese Unterscheidung würde eine brandneue, erst nach dem letzten
   * Nachtlauf erschienene Karte stillschweigend in allen Kacheln fehlen, statt bei Scryfall
   * nachgeschlagen zu werden.
   */
  async knownCardNames(cardNames: string[]): Promise<Set<string>> {
    const bekannt = new Set<string>();
    const keys = [...new Set(cardNames.map((n) => this.lookupKey(n)).filter(Boolean))];
    if (keys.length === 0) return bekannt;

    // Hier kommt höchstens EINE Zeile je Name zurück, deshalb dürfen die Blöcke größer sein als
    // bei effectCategories() - begrenzt nur noch durch die URL-Länge der GET-Anfrage.
    for (const block of chunk(keys, 200)) {
      const { data, error } = await supabase
        .from('scryfall_cards')
        .select('front_name_normalized')
        .in('front_name_normalized', block);

      if (error) {
        console.warn(
          'Kartenbestand konnte nicht geprüft werden, Rückfall auf Scryfall:',
          error.message,
        );
        return new Set();
      }

      for (const row of data ?? []) bekannt.add(row.front_name_normalized);
    }

    return bekannt;
  }

  /** Wandelt eine Tabellenzeile in dasselbe ScryfallCard um, das ScryfallService.toCard() liefert. */
  private toCard(row: Record<string, unknown>): ScryfallCard {
    const wert = <T>(feld: string): T | undefined => (row[feld] ?? undefined) as T | undefined;
    return {
      name: row['name'] as string,
      imageUrl: wert<string>('image_url'),
      typeLine: wert<string>('type_line'),
      cmc: wert<number>('cmc'),
      manaCost: wert<string>('mana_cost'),
      colorIdentity: wert<string[]>('color_identity'),
      producedMana: wert<string[]>('produced_mana'),
      gameChanger: wert<boolean>('game_changer'),
      oracleText: wert<string>('oracle_text'),
      keywords: wert<string[]>('keywords'),
      backImageUrl: wert<string>('back_image_url'),
      backTypeLine: wert<string>('back_type_line'),
      allParts: wert<ScryfallCard['allParts']>('all_parts'),
      oracleId: wert<string>('oracle_id'),
    };
  }

  /**
   * Wie ScryfallService.findCardsBulk(), aber erst aus der eigenen Datenbank - nur die dort
   * unbekannten Namen gehen noch ins Netz.
   *
   * Das behebt mehr als nur Wartezeit: Scheitert die Scryfall-Abfrage (unter Last antwortet
   * Scryfall mit 429, was im Browser als CORS-Fehler ankommt und den Chunk stillschweigend
   * verschluckt), fehlen in der Deck-Analyse schlagartig Pip-Verteilung, Manaquellen, Game-Changer-
   * Kennzeichnung, Tutoren-Erkennung und die Kartenbilder - ohne dass irgendwo ein Fehler sichtbar
   * wäre. Manakurve und Typverteilung bleiben dabei korrekt, weil sie aus deck_cards kommen; genau
   * dieses halb gefüllte Bild war reproduzierbar zu sehen.
   *
   * Die Schlüssel der Ergebnis-Map sind identisch zu ScryfallService.findCardsBulk(): der
   * ursprüngliche (volle) Kartenname in Kleinschreibung, denn genau so schlägt die Deck-Ansicht
   * nach (details.get(card.cardName.toLowerCase())). Nachgeschlagen wird dagegen über den
   * normalisierten Vorderseiten-Namen - dieselbe Trennung wie dort, aus demselben Grund
   * (Scryfall liefert Apostrophe teils in einer anderen Unicode-Variante als die gespeicherten
   * Decklisten).
   */
  async findCardsBulk(cardNames: string[]): Promise<Map<string, ScryfallCard>> {
    const result = new Map<string, ScryfallCard>();
    const unique = [...new Set(cardNames.map((n) => n.trim()).filter(Boolean))];
    if (unique.length === 0) return result;

    const keyToOriginal = new Map<string, string>();
    for (const name of unique) keyToOriginal.set(this.lookupKey(name), name);

    for (const block of chunk([...keyToOriginal.keys()], 200)) {
      const { data, error } = await supabase
        .from('scryfall_cards')
        .select(CardDataService.KARTEN_SPALTEN)
        .in('front_name_normalized', block);

      if (error) {
        // Ganz auf Scryfall zurückfallen statt mit halben Daten weiterzumachen.
        console.warn(
          'Kartendaten konnten nicht geladen werden, Rückfall auf Scryfall:',
          error.message,
        );
        return this.scryfall.findCardsBulk(unique);
      }

      for (const row of (data ?? []) as unknown as Record<string, unknown>[]) {
        const original = keyToOriginal.get(row['front_name_normalized'] as string);
        if (original) result.set(original.toLowerCase(), this.toCard(row));
      }
    }

    // Was der nächtliche Abgleich noch nicht kennt (frische Spoiler), kommt weiterhin live dazu.
    const fehlend = unique.filter((name) => !result.has(name.toLowerCase()));
    if (fehlend.length > 0) {
      for (const [key, card] of await this.scryfall.findCardsBulk(fehlend)) result.set(key, card);
    }

    return result;
  }

  /**
   * Wie ScryfallService.findCard(), aber erst exakt in der eigenen Datenbank.
   *
   * Der Rückfall auf Scryfall ist hier keine reine Absicherung, sondern fachlich nötig: Diese
   * Methode bekommt von Hand getippte Namen und muss deshalb Tippfehler und fremdsprachige
   * gedruckte Namen auffangen. Beides kann nur Scryfalls Fuzzy-Suche - unsere Tabelle enthält
   * ausschließlich die englischen Namen in exakter Schreibweise.
   */
  async findCard(cardName: string): Promise<ScryfallCard | null> {
    if (!cardName.trim()) return null;

    const { data, error } = await supabase
      .from('scryfall_cards')
      .select(CardDataService.KARTEN_SPALTEN)
      .eq('front_name_normalized', this.lookupKey(cardName))
      .limit(1);

    if (!error && data && data.length > 0) {
      return this.toCard(data[0] as unknown as Record<string, unknown>);
    }
    return this.scryfall.findCard(cardName);
  }

  /**
   * Einmal je Sitzung geladen und dann wiederverwendet: die Tabelle hat nur rund 200 Zeilen, und
   * die Liste ändert sich höchstens einmal pro Nacht.
   */
  private spellbookFlagsPromise: Promise<Map<string, SpellbookCardFlags>> | null = null;

  /**
   * Die kuratierten Kartenmarkierungen von Commander Spellbook (Mass Land Denial, Extra-Turns,
   * Tutoren), Schlüssel ist der normalisierte Vorderseiten-Name.
   *
   * Bewusst die GANZE Tabelle statt einer .in()-Abfrage über die Decknamen. Sie enthält nur
   * Karten mit mindestens einem Flag (~200 Zeilen), und deshalb wäre bei einer gefilterten
   * Abfrage "null Treffer" nicht mehr von "Tabelle noch leer" zu unterscheiden - genau diese
   * Unterscheidung braucht der Aufrufer aber, um zu entscheiden, ob er auf seine alte Näherung
   * zurückfallen muss. Eine leere Map heißt hier also eindeutig: noch kein Nachtlauf (oder die
   * Migration ist noch nicht ausgeführt).
   */
  async spellbookCardFlags(): Promise<Map<string, SpellbookCardFlags>> {
    this.spellbookFlagsPromise ??= (async () => {
      const { data, error } = await supabase
        .from('spellbook_card_flags')
        .select('name_normalized, mass_land_denial, extra_turn, tutor');

      if (error) {
        console.warn(
          'Spellbook-Kartenmarkierungen konnten nicht geladen werden, Rückfall auf die Textnäherung:',
          error.message,
        );
        // Nicht merken: beim nächsten Versuch soll es wieder gehen dürfen (z.B. wenn die
        // Migration zwischenzeitlich ausgeführt wurde).
        this.spellbookFlagsPromise = null;
        return new Map<string, SpellbookCardFlags>();
      }

      return new Map(
        (data ?? []).map((row) => [
          row.name_normalized as string,
          {
            massLandDenial: row.mass_land_denial as boolean,
            extraTurn: row.extra_turn as boolean,
            tutor: row.tutor as boolean,
          },
        ]),
      );
    })();

    return this.spellbookFlagsPromise;
  }

  /** Schlüssel, unter dem eine Karte in spellbookCardFlags() steht. */
  spellbookKey(cardName: string): string {
    return this.lookupKey(cardName);
  }

  /**
   * Alle Zwei-Karten-Combos, bei denen die ERSTE Karte im Deck liegt.
   *
   * Bewusst nur über card_a_normalized abgefragt, obwohl die Reihenfolge in der Quelle beliebig
   * ist: eine Combo ist nur dann vollständig, wenn BEIDE Karten im Deck liegen - dann ist auch
   * die erste dabei und die Abfrage findet sie. Die zweite Karte prüft presentCombos() in
   * bracket.ts, zusammen mit der mustBeCommander-Bedingung. Eine zusätzliche Abfrage über
   * card_b_normalized würde also nur Zeilen liefern, die ohnehin wieder wegfielen.
   *
   * Leeres Ergebnis bei einem Fehler (Tabelle noch nicht angelegt, kein Netz): die Einstufung
   * läuft dann ohne Combo-Kriterium weiter, statt ganz auszufallen.
   */
  async twoCardCombosFor(cardNames: string[]): Promise<SpellbookTwoCardCombo[]> {
    const keys = [...new Set(cardNames.map((n) => this.lookupKey(n)).filter(Boolean))];
    if (keys.length === 0) return [];

    const combos: SpellbookTwoCardCombo[] = [];
    // Klein gehalten, weil eine einzelne verbreitete Karte (Sol Ring & Co.) in vielen Combos
    // steckt - so bleibt jeder Block sicher unter der 1000-Zeilen-Grenze von PostgREST, ab der
    // Treffer stillschweigend abgeschnitten würden.
    for (const block of chunk(keys, 40)) {
      const { data, error } = await supabase
        .from('spellbook_two_card_combos')
        .select(
          'id, card_a_normalized, card_b_normalized, a_must_be_commander, b_must_be_commander, mana_value_needed, bracket_tag, popularity'
        )
        .in('card_a_normalized', block);

      if (error) {
        console.warn(
          'Spellbook-Combos konnten nicht geladen werden, Bracket-Einstufung ohne Combo-Kriterium:',
          error.message
        );
        return [];
      }

      for (const row of data ?? []) {
        combos.push({
          id: row.id as string,
          cardA: row.card_a_normalized as string,
          cardB: row.card_b_normalized as string,
          aMustBeCommander: row.a_must_be_commander as boolean,
          bMustBeCommander: row.b_must_be_commander as boolean,
          manaValueNeeded: (row.mana_value_needed as number | null) ?? null,
          bracketTag: (row.bracket_tag as SpellbookBracketTag | null) ?? null,
          popularity: (row.popularity as number | null) ?? null,
        });
      }
    }

    return combos;
  }

  /**
   * Combo-Finder: alle Combos, denen bei dieser Deckliste genau EINE Karte fehlt.
   *
   * Die eigentliche Arbeit macht die Datenbankfunktion spellbook_combos_missing_one (siehe
   * sql/spellbook-combos-2026-09-07.sql). Aus der App heraus wäre die Frage gar nicht stellbar:
   * "genau eine Karte fehlt" verlangt eine Gruppierung über die Karten je Combo, und ohne sie
   * müsste der Browser alle Combos herunterladen, die irgendeine Deckkarte enthalten - bei
   * 108.500 Combos und einer verbreiteten Karte wie Sol Ring zehntausende Zeilen für am Ende
   * vierzig Vorschläge.
   *
   * available === false heißt "die Funktion oder die Tabellen gibt es noch nicht" (Migration noch
   * nicht ausgeführt, Nachtlauf noch nicht gelaufen). Bewusst unterschieden von "keine Treffer":
   * die Oberfläche sagt in dem Fall, woran es liegt, statt "nichts gefunden" zu behaupten.
   */
  async combosMissingOneCard(
    deckNames: string[],
    commanderNames: string[],
  ): Promise<{ rows: ComboSuggestionRow[]; available: boolean }> {
    const keys = [...new Set(deckNames.map((n) => this.lookupKey(n)).filter(Boolean))];
    if (keys.length === 0) return { rows: [], available: true };

    const { data, error } = await supabase.rpc('spellbook_combos_missing_one', {
      deck_names: keys,
      commander_names: [...new Set(commanderNames.map((n) => this.lookupKey(n)).filter(Boolean))],
    });

    if (error) {
      console.warn('Combo-Finder: Suche fehlgeschlagen:', error.message);
      return { rows: [], available: false };
    }

    // Null Treffer heißt zweierlei, und der Unterschied ist für den Nutzer alles: Entweder gibt es
    // zu diesem Deck wirklich nichts vorzuschlagen - oder die Combo-Tabelle ist noch leer, weil
    // der Nachtlauf sie noch nie gefüllt hat. Ohne diese eine zusätzliche Abfrage behauptet die
    // Oberfläche im zweiten Fall "nichts gefunden", und niemand kommt darauf, dass schlicht die
    // Daten fehlen. Sie läuft nur im Null-Fall, kostet also im Normalbetrieb nichts.
    if ((data ?? []).length === 0) {
      const { data: probe, error: probeError } = await supabase
        .from('spellbook_combos')
        .select('id')
        .limit(1);
      if (probeError || (probe ?? []).length === 0) return { rows: [], available: false };
    }

    return {
      rows: (data ?? []).map((row: Record<string, unknown>) => ({
        comboId: row['combo_id'] as string,
        missing: row['missing_name'] as string,
        present: (row['present_names'] as string[] | null) ?? [],
        cardCount: row['card_count'] as number,
        produces: (row['produces'] as string[] | null) ?? [],
        description: (row['description'] as string | null) ?? '',
        manaValueNeeded: (row['mana_value_needed'] as number | null) ?? null,
        popularity: (row['popularity'] as number | null) ?? null,
        comboCount: row['combo_count'] as number,
        totalCards: row['total_cards'] as number,
      })),
      available: true,
    };
  }

  /**
   * Volle Kartendaten zu normalisierten Vorderseiten-Namen, wie sie in den Spellbook-Tabellen
   * stehen - Schlüssel der Ergebnis-Map ist genau dieser normalisierte Name.
   *
   * Nötig, weil die Combo-Tabelle nur Namen kennt: Für Karten, die NICHT im Deck liegen (die
   * Vorschläge des Combo-Finders), fehlen sonst Farbidentität und Bild. Bewusst ohne den
   * Scryfall-Rückfall aus findCardsBulk(): hier geht es um Hunderte Namen auf einmal, und eine
   * Handvoll frisch erschienener Karten, die der Nachtlauf noch nicht kennt, ist als fehlender
   * Vorschlag verkraftbar - Hunderte Einzelabfragen ins Netz wären es nicht.
   */
  async cardsByNormalizedNames(keys: string[]): Promise<Map<string, ScryfallCard>> {
    const result = new Map<string, ScryfallCard>();
    const eindeutig = [...new Set(keys.filter(Boolean))];
    if (eindeutig.length === 0) return result;

    for (const block of chunk(eindeutig, 200)) {
      const { data, error } = await supabase
        .from('scryfall_cards')
        .select(CardDataService.KARTEN_SPALTEN)
        .in('front_name_normalized', block);

      if (error) {
        console.warn('Kartendaten zu den Combo-Vorschlägen fehlen:', error.message);
        return result;
      }

      for (const row of (data ?? []) as unknown as Record<string, unknown>[]) {
        result.set(row['front_name_normalized'] as string, this.toCard(row));
      }
    }

    return result;
  }
}
