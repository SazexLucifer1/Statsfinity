import { Injectable, inject } from '@angular/core';
import { supabase } from './supabase.client';
import { chunk, normalizeCardName } from './array-utils';
import { ScryfallService, ScryfallCard } from './scryfall.service';
import type { SpellbookBracketTag } from './commander-spellbook.service';
import {
  BracketBenchmark,
  BracketBenchmarkRow,
  DEFAULT_BRACKET_BENCHMARK,
  bracketBenchmarkFromRows,
} from './bracket';

/**
 * Die drei kuratierten Spellbook-Markierungen, die Scryfall nicht hat (sync-spellbook-bracket.js,
 * sql/spellbook-cache-2026-09-06.sql).
 */
export interface SpellbookCardFlags {
  massLandDenial: boolean;
  extraTurn: boolean;
  tutor: boolean;
}

/** Zwei-Karten-Combo aus Spellbook; cardA/cardB sind normalisierte Vorderseiten-Namen. */
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

/** Combo-Finder-Zeile: eine Combo, der genau eine Karte fehlt (normalisierte Namen). */
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
  /** Zusätzlich nötiges Mana in Kartenschreibweise ("{1}{R}{R}"), null = keins nötig. */
  manaNeeded: string | null;
  manaValueNeeded: number | null;
  popularity: number | null;
  /** Wie viele Combos dieselbe fehlende Karte insgesamt freischaltet. */
  comboCount: number;
  /** Wie viele fehlende Karten die Suche insgesamt gefunden hat (vor dem Farbfilter). */
  totalCards: number;
}

/**
 * Lesezugriff auf den eigenen, nachts gefüllten Kartenbestand (sync-scryfall-bulk.js,
 * sql/scryfall-cache-2026-09-06.sql). Ersetzt ~100 Scryfall-Suchen je Deck durch eine Abfrage.
 * Getrennt von ScryfallService, der nur mit Scryfall spricht.
 */
@Injectable({ providedIn: 'root' })
export class CardDataService {
  private readonly scryfall = inject(ScryfallService);

  /** Spalten, aus denen sich ein vollständiges ScryfallCard zusammensetzen lässt (siehe toCard()). */
  private static readonly KARTEN_SPALTEN =
    'oracle_id, name, front_name_normalized, type_line, cmc, mana_cost, color_identity, produced_mana, game_changer, oracle_text, keywords, image_url, back_image_url, back_type_line, back_oracle_text, all_parts';

  /**
   * Schlüssel ist der normalisierte Vorderseiten-Name (front_name_normalized), "A // B" träfe nie.
   */
  private lookupKey(cardName: string): string {
    return normalizeCardName(cardName.split(' // ')[0].trim());
  }

  /**
   * Höchstens 75 Namen je Abfrage: bis zu 12 Zeilen je Name bleiben unter der 1000-Zeilen-Grenze
   * von PostgREST.
   */
  private static readonly NAMEN_PRO_ABFRAGE = 75;

  /**
   * Je Kategorie-Key die zutreffenden Namen. Bei Fehler eine leere Map - der Aufrufer fällt dann
   * auf Scryfall zurück.
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
   * Welche Namen kennt der Abgleich? Unterscheidet "kein Tag" von "Karte unbekannt" (neue Karten
   * gehen an Scryfall).
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
      backOracleText: wert<string>('back_oracle_text'),
      allParts: wert<ScryfallCard['allParts']>('all_parts'),
      oracleId: wert<string>('oracle_id'),
    };
  }

  /**
   * Wie ScryfallService.findCardsBulk(), aber zuerst aus der eigenen DB. Verhindert auch halb
   * gefüllte Analysen, wenn Scryfall mit 429 still Chunks verschluckt. Schlüssel: voller Name klein
   * (wie dort), nachgeschlagen über den normalisierten Vorderseiten-Namen.
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

    // Die Tabelle kennt nur englische Bilder; bei anderer Artwork-Sprache gebündelt tauschen.
    return this.scryfall.karteMapInKartensprache(result);
  }

  /**
   * Wie ScryfallService.findCard(), erst exakt in der DB. Der Scryfall-Rückfall fängt Tippfehler
   * und fremdsprachige Namen auf (Fuzzy-Suche).
   */
  async findCard(cardName: string): Promise<ScryfallCard | null> {
    if (!cardName.trim()) return null;

    const { data, error } = await supabase
      .from('scryfall_cards')
      .select(CardDataService.KARTEN_SPALTEN)
      .eq('front_name_normalized', this.lookupKey(cardName))
      .limit(1);

    if (!error && data && data.length > 0) {
      const karte = this.toCard(data[0] as unknown as Record<string, unknown>);
      return (await this.scryfall.inKartensprache([karte]))[0];
    }
    return this.scryfall.findCard(cardName);
  }

  /** Einmal je Sitzung geladen (~200 Zeilen, ändert sich nur nachts). */
  private spellbookFlagsPromise: Promise<Map<string, SpellbookCardFlags>> | null = null;

  /**
   * Spellbook-Markierungen (MLD, Extra-Turns, Tutoren) je normalisiertem Namen. Bewusst die ganze
   * Tabelle: eine leere Map heißt dann eindeutig "noch kein Nachtlauf", nicht "keine Treffer".
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

  private bracketBenchmarkPromise: Promise<BracketBenchmark> | null = null;

  /** Gemessene Bracket-Schwellen, einmal je Sitzung. Ohne Tabelle oder Netz die Startwerte. */
  bracketBenchmark(): Promise<BracketBenchmark> {
    this.bracketBenchmarkPromise ??= (async () => {
      const basis = 'bracket, tutor_density, avg_cmc, untapped_land_percent, game_changers, combo_tutor_min';
      const gewichte = 'weight_tutors, weight_avg_cmc, weight_untapped_lands, weight_game_changers';
      let { data, error } = await supabase.from('bracket_benchmark').select(`${basis}, ${gewichte}`);
      // Gewichte-Migration noch nicht ausgeführt: ohne die Spalten, dann gelten die Start-Gewichte.
      if (error?.code === '42703') ({ data, error } = await supabase.from('bracket_benchmark').select(basis));

      if (error) {
        console.warn('Bracket-Benchmark nicht verfügbar, es gelten die Startwerte:', error.message);
        this.bracketBenchmarkPromise = null;
        return DEFAULT_BRACKET_BENCHMARK;
      }
      return bracketBenchmarkFromRows((data ?? []) as BracketBenchmarkRow[]);
    })();

    return this.bracketBenchmarkPromise;
  }

  /** Schlüssel, unter dem eine Karte in spellbookCardFlags() steht. */
  spellbookKey(cardName: string): string {
    return this.lookupKey(cardName);
  }

  /**
   * Anzahl spielbeendender Combos, vollständig im Deck (Urteil F), über die Funktion
   * winning_combos_in_deck (Namen im Rumpf statt kilobytelanger URL). 0 bei Fehler.
   */
  async winningCombosIn(cardNames: string[], commanderNames: string[]): Promise<number> {
    const keys = [...new Set(cardNames.map((n) => this.lookupKey(n)).filter(Boolean))];
    if (keys.length === 0) return 0;

    const { data, error } = await supabase.rpc('winning_combos_in_deck', {
      deck_names: keys,
      commander_names: [...new Set(commanderNames.map((n) => this.lookupKey(n)).filter(Boolean))],
    });

    if (error) {
      console.warn(
        'Gewinn-Combos konnten nicht gezählt werden, Bracket-Einstufung ohne Urteil F:',
        error.message,
      );
      return 0;
    }
    return typeof data === 'number' ? data : 0;
  }

  /**
   * Zwei-Karten-Combos, deren ERSTE Karte im Deck liegt - reicht, weil eine vollständige Combo
   * beide enthält; die zweite prüft presentCombos(). Bei Fehler leer, die Einstufung läuft ohne
   * Combos weiter.
   */
  async twoCardCombosFor(cardNames: string[]): Promise<SpellbookTwoCardCombo[]> {
    const keys = [...new Set(cardNames.map((n) => this.lookupKey(n)).filter(Boolean))];
    if (keys.length === 0) return [];

    const combos: SpellbookTwoCardCombo[] = [];
    // Blöcke à 40, damit verbreitete Karten (Sol Ring) unter der 1000-Zeilen-Grenze bleiben.
    for (const block of chunk(keys, 40)) {
      const { data, error } = await supabase
        .from('spellbook_two_card_combos')
        .select(
          'id, card_a_normalized, card_b_normalized, a_must_be_commander, b_must_be_commander, mana_value_needed, bracket_tag, popularity',
        )
        .in('card_a_normalized', block);

      if (error) {
        console.warn(
          'Spellbook-Combos konnten nicht geladen werden, Bracket-Einstufung ohne Combo-Kriterium:',
          error.message,
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
   * Combo-Finder: Combos, denen genau EINE Karte fehlt, über spellbook_combos_missing_one (die
   * Gruppierung geht nur in der DB). available === false = Funktion/Tabellen fehlen - unterschieden
   * von "keine Treffer".
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

    // Null Treffer: prüfen, ob die Combo-Tabelle überhaupt gefüllt ist (nur im Null-Fall, kostet
    // sonst nichts).
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
        manaNeeded: (row['mana_needed'] as string | null) ?? null,
        manaValueNeeded: (row['mana_value_needed'] as number | null) ?? null,
        popularity: (row['popularity'] as number | null) ?? null,
        comboCount: row['combo_count'] as number,
        totalCards: row['total_cards'] as number,
      })),
      available: true,
    };
  }

  /**
   * Volle Kartendaten zu normalisierten Namen (für Combo-Finder-Vorschläge außerhalb des Decks).
   * Ohne Scryfall-Rückfall - hunderte Einzelabfragen lohnen nicht für ein paar neue Karten.
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
