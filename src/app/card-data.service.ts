import { Injectable } from '@angular/core';
import { supabase } from './supabase.client';
import { chunk, normalizeCardName } from './array-utils';

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
}
