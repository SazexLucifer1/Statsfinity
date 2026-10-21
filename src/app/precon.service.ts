import { Injectable } from '@angular/core';

export interface PreconSummary {
  name: string;
  code: string;
  fileName: string;
  releaseYear: number;
}

const DECK_LIST_URL = 'https://mtgjson.com/api/v5/DeckList.json';
const deckUrl = (fileName: string) => `https://mtgjson.com/api/v5/decks/${fileName}.json`;

/**
 * Lädt Precon-Decklisten (aktuell: Commander-Decks) von MTGJSON. Im Gegensatz zu Moxfield/
 * Archidekt/deckstats.net erlaubt MTGJSON direkte Browser-Anfragen (Access-Control-Allow-Origin: *),
 * ist also ohne Server-Proxy nutzbar.
 */
const COMMANDER_CACHE_KEY = 'statsfinity.preconCommanders.v1';

@Injectable({ providedIn: 'root' })
export class PreconService {
  private indexCache: PreconSummary[] | null = null;

  // --- Commander je Precon (für die Bilder in der Liste, Wunsch des Users 21.10.2026) ---
  // Der Katalog nennt keinen Commander, der steht erst in der Deck-Datei (~0,5 MB je Deck). Darum
  // höchstens drei gleichzeitig und das Ergebnis dauerhaft auf dem Gerät: ein Precon ändert seinen
  // Commander nie, jede Datei wird also nur einmal je Gerät geladen.
  private commanderCache: Record<string, string[]> = this.readCommanderCache();
  private readonly commanderJobs = new Map<string, Promise<string[]>>();
  private running = 0;
  private readonly waiting: (() => void)[] = [];

  private readCommanderCache(): Record<string, string[]> {
    try {
      return JSON.parse(localStorage.getItem(COMMANDER_CACHE_KEY) ?? '{}') ?? {};
    } catch {
      return {};
    }
  }

  /** Commander-Namen eines Precons (leer, wenn die Datei keinen nennt oder nicht lädt). */
  commandersOf(fileName: string): Promise<string[]> {
    const known = this.commanderCache[fileName];
    if (known) return Promise.resolve(known);
    const running = this.commanderJobs.get(fileName);
    if (running) return running;
    const job = this.slot().then(async (release) => {
      try {
        const res = await fetch(deckUrl(fileName));
        if (!res.ok) return [];
        const data = await res.json();
        const names = ((data.data?.commander as { name: string }[] | undefined) ?? []).map(
          (c) => c.name,
        );
        this.commanderCache[fileName] = names;
        try {
          localStorage.setItem(COMMANDER_CACHE_KEY, JSON.stringify(this.commanderCache));
        } catch {
          // Speicher voll oder gesperrt - dann eben nur für diese Sitzung.
        }
        return names;
      } catch {
        return [];
      } finally {
        release();
      }
    });
    this.commanderJobs.set(fileName, job);
    return job;
  }

  private slot(): Promise<() => void> {
    const release = () => {
      this.running--;
      this.waiting.shift()?.();
    };
    if (this.running < 3) {
      this.running++;
      return Promise.resolve(release);
    }
    return new Promise((resolve) =>
      this.waiting.push(() => {
        this.running++;
        resolve(release);
      }),
    );
  }

  private async loadIndex(): Promise<PreconSummary[]> {
    if (this.indexCache) return this.indexCache;
    try {
      const res = await fetch(DECK_LIST_URL);
      if (!res.ok) {
        console.error(`Konnte MTGJSON-Precon-Katalog nicht laden: HTTP ${res.status}`);
        return [];
      }
      const data = await res.json();
      this.indexCache = ((data.data as any[]) ?? [])
        .filter((d) => d.type === 'Commander Deck')
        .map((d) => ({
          name: d.name as string,
          code: d.code as string,
          fileName: d.fileName as string,
          releaseYear: new Date(d.releaseDate).getFullYear(),
        }));
      return this.indexCache;
    } catch (error) {
      console.error('Konnte MTGJSON-Precon-Katalog nicht laden:', error);
      return [];
    }
  }

  async getPreconsForYear(year: number): Promise<PreconSummary[]> {
    const index = await this.loadIndex();
    return index
      .filter((d) => d.releaseYear === year)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Kompletter Precon-Katalog über alle Jahre (derselbe gecachte Index wie getPreconsForYear) - für DeckService.backfillPreconReleaseYears, das per Namens-Abgleich das Release-Jahr bereits gespeicherter Precons nachträglich ermitteln muss. */
  async getAllPrecons(): Promise<PreconSummary[]> {
    return this.loadIndex();
  }

  /**
   * Baut aus den MTGJSON-Kartendaten eines Precons dieselbe Textform, die
   * DeckService.parseDecklistText erwartet - so läuft der Import über denselben,
   * schon getesteten Pfad (Scryfall-Bildersuche, Commander-Erkennung, Backfill) wie ein
   * manuell eingefügter Decklist-Text.
   */
  async loadPreconAsText(fileName: string): Promise<string | null> {
    try {
      const res = await fetch(deckUrl(fileName));
      if (!res.ok) return null;
      const data = await res.json();
      const deck = data.data;
      const lines: string[] = [];

      const commanders = (deck.commander as { name: string; count: number }[] | undefined) ?? [];
      if (commanders.length > 0) {
        lines.push('//Commander');
        for (const c of commanders) lines.push(`${c.count} ${c.name}`);
      }

      lines.push('//Main');
      for (const c of (deck.mainBoard as { name: string; count: number }[] | undefined) ?? []) {
        lines.push(`${c.count} ${c.name}`);
      }

      return lines.join('\n');
    } catch {
      return null;
    }
  }
}
