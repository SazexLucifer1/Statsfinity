import { Injectable } from '@angular/core';
import { sleep } from './array-utils';

export interface EdhrecCardview {
  name: string;
  synergy: number;
  numDecks: number;
  potentialDecks: number;
}

export interface EdhrecCardlist {
  tag: string;
  header: string;
  cards: EdhrecCardview[];
}

export interface EdhrecTag {
  slug: string;
  value: string;
  count: number;
}

@Injectable({ providedIn: 'root' })
export class EdhrecService {
  /**
   * EDHRECs eigene Slug-Regel fuer Commander-URLs (kein offizieller Standard, aus mehreren echten
   * Beispielen abgeleitet: Kommas/Apostrophe/Punkte weg, alles andere zu Bindestrichen).
   */
  private slugify(name: string): string {
    return name
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '') // Akzente entfernen
      .replace(/['’,.]/g, '') // Apostroph-Varianten und Satzzeichen entfernen
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  /**
   * Baut die Pfad-Kandidaten fuer 1 oder 2 Commander. Bei einem Paar (Partner, "Choose a
   * Background" + Background, Doctor's companion + Time Lord Doctor) kombiniert EDHREC beide
   * Slugs zu einer eigenen Seite (z.B. "thrasios-triton-hero-tymna-the-weaver") - welche
   * Reihenfolge EDHREC dabei erwartet ist nicht offiziell dokumentiert, deshalb werden beide
   * Reihenfolgen als Kandidaten zurückgegeben; der Aufrufer probiert sie der Reihe nach durch.
   */
  private buildCommanderSlugCandidates(commanderNames: string[]): string[] {
    const slugs = commanderNames.map((n) => this.slugify(n)).filter((s) => s.length > 0);
    if (slugs.length < 2) return slugs;
    return [`${slugs[0]}-${slugs[1]}`, `${slugs[1]}-${slugs[0]}`];
  }

  // dauerhafter Cache mit 24h-TTL (anders als Scryfalls Tag-Cache, siehe ScryfallService,
  // ändern sich EDHRECs Empfehlungen mit der Zeit - deshalb TTL statt für immer). Hält die
  // Zusage aus der Erlaubnis-Anfrage an EDHREC ein ("cache all responses for 24 hours") und
  // reduziert die Anfragelast deutlich, da dieselbe Commander-Seite bei jedem Deck-Öffnen bzw.
  // jeder Tag-Auswahl sonst immer wieder frisch abgefragt würde.
  private static readonly CACHE_KEY = 'statsfinity-edhrec-cache-v1';
  private static readonly CACHE_TTL_MS = 24 * 60 * 60 * 1000;
  private cache: Record<string, { data: any; cachedAt: number }> | null = null;

  private getCache(): Record<string, { data: any; cachedAt: number }> {
    if (!this.cache) {
      try {
        this.cache = JSON.parse(localStorage.getItem(EdhrecService.CACHE_KEY) ?? '{}');
      } catch {
        this.cache = {};
      }
    }
    return this.cache!;
  }

  private saveCache(): void {
    try {
      localStorage.setItem(EdhrecService.CACHE_KEY, JSON.stringify(this.cache ?? {}));
    } catch {
      // z.B. Speicher voll oder privater Modus - Cache bleibt dann nur für diese Sitzung im Speicher, kein Beinbruch.
    }
  }

  /**
   * EDHRECs Nutzungsrichtlinie erlaubt max. 1 Request/Sekunde (besonders wichtig bei Fehlern) -
   * instanzweiter statt pro-Aufruf-Zeitstempel, damit sich ALLE Aufrufer denselben Takt teilen.
   * Nötig, weil z.B. deck-viewer.service.ts Tags und Empfehlungen aus zwei unabhängigen Angular-
   * effect()s gleichzeitig laden kann, sobald sich der betrachtete Commander ändert - ohne
   * gemeinsame Bremse hier würden diese (und ggf. mehrere sequentielle Fallback-Versuche bei
   * seltenen Commander/Tag-Kombinationen) das Limit reißen, ohne dass jede Aufrufstelle das selbst
   * wissen müsste.
   */
  private lastRequestAt = 0;

  private async throttle(): Promise<void> {
    const elapsed = Date.now() - this.lastRequestAt;
    if (elapsed < 1000) await sleep(1000 - elapsed);
    this.lastRequestAt = Date.now();
  }

  /**
   * Gemeinsame Fetch-/Fehlerbehandlung für die commanders-JSON-Endpunkte - liefert das rohe JSON
   * oder null. Bei 429 verlangt EDHRECs Policy mind. 2s Wartezeit vor einem erneuten Versuch -
   * analog zu ScryfallService.fetchWithRetry() wird dabei auch ein geworfener Fehler wie ein 429
   * behandelt, falls der Browser eine ohne CORS-Header ausgelieferte 429-Antwort als Promise-
   * Rejection statt als lesbaren Status durchreicht.
   */
  private async fetchCommanderPage(path: string): Promise<any | null> {
    const cache = this.getCache();
    const cached = cache[path];
    if (cached && Date.now() - cached.cachedAt < EdhrecService.CACHE_TTL_MS) {
      return cached.data;
    }
    for (let attempt = 0; attempt <= 2; attempt++) {
      await this.throttle();
      try {
        const res = await fetch(`https://json.edhrec.com/pages/commanders/${path}.json`);
        if (res.ok) {
          const data = await res.json();
          cache[path] = { data, cachedAt: Date.now() };
          this.saveCache();
          return data;
        }
        if (res.status !== 429) return null;
      } catch {
        // Siehe Kommentar oben - im Zweifel wie ein 429 behandeln statt sofort aufzugeben.
      }
      if (attempt < 2) await sleep(2000);
    }
    return null;
  }

  /**
   * EDHRECs Kartenempfehlungen für einen Commander oder ein Paar, optional mit Theme-Tag ("ramp").
   * Liest dasselbe JSON wie EDHRECs Webseite - inoffiziell, kann sich ohne Vorwarnung ändern.
   */
  async getCommanderRecommendations(
    commanderNames: string[],
    tagSlug?: string | null
  ): Promise<EdhrecCardlist[] | null> {
    for (const slug of this.buildCommanderSlugCandidates(commanderNames)) {
      const path = tagSlug ? `${slug}/${tagSlug}` : slug;
      const data = await this.fetchCommanderPage(path);
      const cardlists = data?.container?.json_dict?.cardlists;
      if (!Array.isArray(cardlists)) continue;

      return cardlists.map((list: any) => ({
        tag: list.tag,
        header: list.header,
        cards: ((list.cardviews ?? []) as any[]).map((c) => ({
          name: c.name,
          synergy: c.synergy ?? 0,
          numDecks: c.num_decks ?? 0,
          potentialDecks: c.potential_decks ?? 0,
        })),
      }));
    }
    return null;
  }

  /** Liefert die auf EDHREC verfügbaren Theme-Tags für einen Commander/ein Commander-Paar (z.B. Ramp, Aristocrats, Stax, ...), sortiert nach Häufigkeit. */
  async getCommanderTags(commanderNames: string[]): Promise<EdhrecTag[] | null> {
    for (const slug of this.buildCommanderSlugCandidates(commanderNames)) {
      const data = await this.fetchCommanderPage(slug);
      const taglinks = data?.panels?.taglinks;
      if (!Array.isArray(taglinks)) continue;

      return taglinks.map((t: any) => ({
        slug: t.slug,
        value: t.value,
        count: t.count ?? 0,
      }));
    }
    return null;
  }
}
