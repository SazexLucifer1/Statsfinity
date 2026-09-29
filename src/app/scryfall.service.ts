import { Injectable, inject } from '@angular/core';
import { sleep, normalizeCardName } from './array-utils';
import { ColorSelection } from './color-filter-match';
import { ArtLanguageService } from './art-language.service';
import { ArtLang } from './art-languages';
import { DeckFormat, SCRYFALL_FORMAT } from './models';

export interface ScryfallCard {
  name: string;
  /**
   * Gedruckter Name des angezeigten Drucks ("Sonnenring"), nur bei nicht-englischer
   * Artwork-Sprache. Reine Anzeige - gerechnet wird immer mit `name`.
   */
  printedName?: string;
  imageUrl?: string;
  typeLine?: string;
  cmc?: number;
  manaCost?: string;
  colorIdentity?: string[];
  /**
   * Farben, die die Karte an Mana erzeugen kann (W/U/B/R/G/C); fehlt bei Karten ohne Mana.
   * Grundlage der Manaquellen-Verteilung.
   */
  producedMana?: string[];
  /** Teil der offiziellen Commander-Bracket-"Game Changers"-Liste (von Scryfall selbst gepflegt). */
  gameChanger?: boolean;
  oracleText?: string;
  /** Native Scryfall-Fähigkeiten-Liste ("Flying", "Lifelink", ...) - kein Tagger-Tag, kommt direkt mit jeder Karte. */
  keywords?: string[];
  /**
   * Nur bei echten Doppelkarten (Transform/MDFC) mit eigenem Rückseitenbild, nicht bei
   * Adventure/Split.
   */
  backImageUrl?: string;
  backTypeLine?: string;
  /** Von Scryfall mitgelieferte verwandte Karten (u.a. Marken, die diese Karte erzeugt) - component "token" ist der für den Marken-Scan relevante Fall. */
  allParts?: { id: string; component: string; name: string; typeLine?: string }[];
  /**
   * Scryfalls druckübergreifende ID - bei Marken nötig, weil viele verschiedene Marken gleich
   * heißen.
   */
  oracleId?: string;
}

/** Ein Eintrag im Vorschlags-Dropdown der Kartensuche. */
export interface CardSuggestion {
  /** Englischer Kartenname - damit arbeitet die App weiter (Decklisten, Statistik, Scryfall). */
  name: string;
  /** Gedruckter Name, über den der Treffer gefunden wurde ("Sonnenring") - nur zur Anzeige. */
  printedName?: string;
}

export interface ScryfallPrinting {
  id: string;
  setName: string;
  setCode: string;
  releasedAt: string | null;
  imageUrl: string | null;
}

export interface ScryfallSet {
  id: string;
  code: string;
  name: string;
  released_at?: string;
  set_type?: string;
}

/** Welche der 5 Partner-Commander-Mechaniken eine Karte trägt - siehe ScryfallService.partnerProfile(). */
interface PartnerProfile {
  plainPartner: boolean;
  partnerWithName: string | null;
  partnerDesignator: string | null;
  friendsForever: boolean;
  chooseBackground: boolean;
  isBackground: boolean;
  doctorsCompanion: boolean;
  isTimeLordDoctor: boolean;
}

const API = 'https://api.scryfall.com';

@Injectable({ providedIn: 'root' })
export class ScryfallService {
  private readonly artLang = inject(ArtLanguageService);

  private cachedSets: ScryfallSet[] | null = null;

  /**
   * Cache je (Sprache, Vorderseitenname) für druckeInSprache(): Rohdruck oder null = "in dieser
   * Sprache nicht gedruckt" (das null spart die meisten Wiederholungsanfragen).
   */
  private readonly druckCache = new Map<string, unknown | null>();

  private buildHeaders(): HeadersInit {
    return {
      Accept: 'application/json',
      'User-Agent': 'MTG-App/1.0',
    };
  }

  /**
   * Fetch mit Wiederholung und wachsender Pause bei JEDEM Fehler: Scryfalls 429 kommt ohne
   * CORS-Header und ist im Browser nicht von anderen Fehlern zu unterscheiden.
   */
  private async fetchWithRetry(url: string, retries = 2, init?: RequestInit): Promise<Response | null> {
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const res = await fetch(url, { ...init, headers: { ...this.buildHeaders(), ...init?.headers } });
        if (res.ok || res.status === 404) return res;
      } catch {
        // Von Scryfall geblockte 429-Antworten kommen als Promise-Rejection an - abfangen und unten erneut versuchen.
      }
      if (attempt < retries) await sleep(3000 * (attempt + 1));
    }
    return null;
  }

  /** Liefert alle Sets (caching) */
  async allSets(): Promise<ScryfallSet[]> {
    if (this.cachedSets) return this.cachedSets;
    try {
      const res = await fetch(`${API}/sets`, {
        headers: this.buildHeaders(),
      });
      if (!res.ok) return [];
      const data = await res.json();
      this.cachedSets = (data.data ?? []) as ScryfallSet[];
      return this.cachedSets;
    } catch {
      return [];
    }
  }

  private cachedCreatureTypes: string[] | null = null;

  /**
   * Katalog aller Kreaturtypen (/catalog/creature-types), alphabetisch, zwischengespeichert wie
   * allSets().
   */
  async creatureTypes(): Promise<string[]> {
    if (this.cachedCreatureTypes) return this.cachedCreatureTypes;
    const res = await this.fetchWithRetry(`${API}/catalog/creature-types`);
    if (!res?.ok) return [];
    const data = await res.json();
    this.cachedCreatureTypes = ((data.data as string[]) ?? []).slice().sort((a, b) => a.localeCompare(b));
    return this.cachedCreatureTypes;
  }

  /** Entfernt Apostrophe/Akzente, damit z.B. "Baldurs" auch "Baldur's" findet. */
  private normalizeForSearch(text: string): string {
    return text
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '') // Akzente entfernen (é -> e)
      .replace(/['’‘´`]/g, '');        // alle Apostroph-Varianten entfernen
  }

  /**
   * Set-Typen, die als Draft-/Play-Booster verkauft werden (ohne Token-, Promo-, Precon-,
   * Duel-Deck- und Alchemy-Sets).
   */
  private readonly DRAFTABLE_SET_TYPES = new Set(['core', 'expansion', 'draft_innovation', 'masters']);

  private isDraftable(set: ScryfallSet): boolean {
    return this.DRAFTABLE_SET_TYPES.has(set.set_type ?? '');
  }

  /** Suche Sets über die Scryfall-Sets-Liste. Name/Code und Jahr arbeiten unabhängig voneinander. */
  async searchSets(query: string, year?: number | null): Promise<ScryfallSet[]> {
    const normalizedQuery = this.normalizeForSearch(query.trim());
    const normalizedYear = year === null || year === undefined || Number.isNaN(Number(year)) ? null : Number(year);

    const sets = await this.allSets();
    let filtered = sets.filter((set) => this.isDraftable(set));

    if (normalizedQuery) {
      filtered = filtered.filter((set) => {
        const haystack = this.normalizeForSearch(`${set.name} ${set.code}`);
        return haystack.includes(normalizedQuery);
      });
    }

    if (normalizedYear !== null) {
      filtered = filtered.filter((set) => {
        if (!set.released_at) return false;
        return new Date(set.released_at).getFullYear() === normalizedYear;
      });
    }

    return filtered.slice(0, 30);
  }

  /**
   * Autovervollständigung für Commander (is:commander = Regel 903.3). Englische Namen direkt,
   * zusätzlich über gedruckte Namen (Deutsch); geliefert wird der englische Name.
   */
  async autocomplete(query: string): Promise<string[]> {
    if (query.trim().length < 2) return [];
    try {
      const english = await this.searchCommanderNamesByName(query);
      if (english.length >= 5) return english;

      // Wenige/keine englischen Treffer: zusätzlich deutsche gedruckte Namen durchsuchen
      const german = await this.searchGermanPrintedNames(query);
      return [...new Set([...english, ...german])].slice(0, 12);
    } catch {
      return [];
    }
  }

  /**
   * Wie autocomplete(), aber inkl. Backgrounds (die sind selbst nicht is:commander) - für den
   * zweiten Commander.
   */
  async autocompleteSecondCommander(query: string): Promise<string[]> {
    if (query.trim().length < 2) return [];
    try {
      const english = await this.searchCommanderNamesByName(query, true);
      if (english.length >= 5) return english;

      const german = await this.searchGermanPrintedNames(query, 'commanderOrBackground');
      return [...new Set([...english, ...german])].slice(0, 12);
    } catch {
      return [];
    }
  }

  /**
   * Autovervollständigung für jede Karte über Scryfalls Endpoint (nur englisch), bei wenigen
   * Treffern zusätzlich über gedruckte Namen. Liefert englischen und gedruckten Namen.
   */
  async autocompleteAnyCard(query: string): Promise<CardSuggestion[]> {
    if (query.trim().length < 2) return [];
    const res = await this.fetchWithRetry(`${API}/cards/autocomplete?q=${encodeURIComponent(query.trim())}`);
    const english = res?.ok ? (((await res.json()).data as string[]) ?? []) : [];
    const vorschlaege: CardSuggestion[] = english.map((name) => ({ name }));
    if (english.length >= 5) return vorschlaege;

    const gedruckt = await this.searchPrintedNames(query, 'any');
    const bekannt = new Set(english.map((name) => name.toLowerCase()));
    for (const vorschlag of gedruckt) {
      if (bekannt.has(vorschlag.name.toLowerCase())) continue;
      bekannt.add(vorschlag.name.toLowerCase());
      vorschlaege.push(vorschlag);
    }
    return vorschlaege.slice(0, 12);
  }

  /** Sucht englische Kartennamen, die als Commander erlaubt sind (Regel 903.3). */
  private async searchCommanderNamesByName(query: string, includeBackgrounds = false): Promise<string[]> {
    const safeQuery = query.trim().replace(/"/g, '');
    if (!safeQuery) return [];
    const legality = includeBackgrounds ? '(is:commander or type:background)' : 'is:commander';
    const q = encodeURIComponent(`${legality} name:"${safeQuery}"`);
    const res = await this.fetchWithRetry(`${API}/cards/search?q=${q}&unique=cards&order=name`);
    if (!res?.ok) return [];
    const data = await res.json();
    return ((data.data as { name: string }[]) ?? []).map((c) => c.name).slice(0, 12);
  }

  /**
   * Karte per Name (auch deutsch); geliefert wird immer der englische Druck (englischerDruck()).
   */
  async findCard(name: string): Promise<ScryfallCard | null> {
    if (!name.trim()) return null;

    // Fuzzy-Suche matcht auch viele gedruckte fremdsprachige Namen
    const res = await this.fetchWithRetry(`${API}/cards/named?fuzzy=${encodeURIComponent(name)}`);
    if (res?.ok) {
      return this.einzelnInKartensprache(await res.json());
    }

    // Fallback: exakte Suche über gedruckte Namen in beliebiger Sprache
    const q = encodeURIComponent(`lang:any !"${name}"`);
    const searchRes = await this.fetchWithRetry(`${API}/cards/search?q=${q}&unique=cards`);
    if (searchRes?.ok) {
      const data = await searchRes.json();
      if (data.data?.length > 0) {
        return this.einzelnInKartensprache(data.data[0]);
      }
    }
    return null;
  }

  /** inKartensprache() für ein einzelnes Scryfall-Rohobjekt. */
  private async einzelnInKartensprache(roh: any): Promise<ScryfallCard> {
    const [karte] = await this.inKartensprache(
      [this.toCard(roh)],
      [roh?.lang as string | undefined]
    );
    return karte;
  }

  /**
   * Löst unsaubere Kandidaten ("Sovereign Okinec Ahau +1/+1 Markendeck") zu einem Commander-Namen
   * auf: schneidet Wörter vom Ende ab und sucht je Länge Commander, erst englisch, dann deutsch;
   * bricht beim ersten Treffer ab. Englische Treffer zählen nur, wenn ihr Name mit dem Ausschnitt
   * BEGINNT (Scryfalls name: ist eine Teilstring-Suche). Zuletzt Fuzzy-Suche für Tippfehler.
   */
  async resolveCommanderCandidate(candidate: string): Promise<string | null> {
    const words = candidate.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) return null;

    // Nacheinander mit Pause, sonst greift Scryfalls Rate-Limit.
    for (let len = words.length; len >= 1; len--) {
      const attempt = words.slice(0, len).join(' ');
      const normalizedAttempt = normalizeCardName(attempt);

      const english = await this.searchCommanderNamesByName(attempt);
      const englishMatch = english.find((name) => normalizeCardName(name).startsWith(normalizedAttempt));
      if (englishMatch) return englishMatch;
      await sleep(400);

      const german = await this.searchGermanPrintedNames(attempt);
      if (german.length > 0) return german[0];
      await sleep(400);
    }

    const fuzzy = await this.findCard(candidate);
    return fuzzy?.name ?? null;
  }

  /**
   * Sucht gedruckte deutsche Namen und liefert englische. `scope`: nur Commander,
   * Commander+Backgrounds oder jede Karte. Unter lang:de vergleicht name:"..." den gedruckten
   * Namen.
   */
  private async searchGermanPrintedNames(
    query: string,
    scope: 'commander' | 'commanderOrBackground' | 'any' = 'commander'
  ): Promise<string[]> {
    return (await this.searchPrintedNames(query, scope)).map((vorschlag) => vorschlag.name);
  }

  /**
   * Wie searchGermanPrintedNames(), liefert zusätzlich den gedruckten Namen fürs Dropdown (wer
   * "Sonnenring" tippt, will das lesen).
   */
  private async searchPrintedNames(
    query: string,
    scope: 'commander' | 'commanderOrBackground' | 'any' = 'commander'
  ): Promise<CardSuggestion[]> {
    const safeQuery = query.trim().replace(/"/g, '');
    if (!safeQuery) return [];
    const legality =
      scope === 'any' ? '' : scope === 'commanderOrBackground' ? '(is:commander or type:background) ' : 'is:commander ';
    const sprachklausel = this.gedruckteSuchsprachen()
      .map((lang) => `lang:${lang} name:"${safeQuery}"`)
      .join(' or ');
    const q = encodeURIComponent(`${legality}(${sprachklausel})`);
    const res = await this.fetchWithRetry(`${API}/cards/search?q=${q}&unique=cards&order=name`);
    if (!res?.ok) return [];
    const data = await res.json();
    return ((data.data as any[]) ?? [])
      .map((c) => ({ name: c.name as string, printedName: c.printed_name as string | undefined }))
      .slice(0, 12);
  }

  /**
   * Sprachen für die Suche nach gedruckten Namen: immer Deutsch, dazu die Artwork-Sprache - in
   * einer Anfrage.
   */
  private gedruckteSuchsprachen(): ArtLang[] {
    const art = this.artLang.lang();
    return art === 'de' || art === 'en' ? ['de'] : ['de', art];
  }
  /**
   * Kartendaten für viele Namen per Collection-Endpoint (75 je Anfrage). Nicht gefundene Karten
   * fehlen einfach. `failed` sammelt Namen, deren Anfrage scheiterte (Rate-Limit) - die dürfen
   * nicht als "gibt es nicht" gecacht werden.
   */
  async findCardsBulk(names: string[], failed?: Set<string>): Promise<Map<string, ScryfallCard>> {
    const unique = [...new Set(names.map((n) => n.trim()).filter(Boolean))];
    const result = new Map<string, ScryfallCard>();

    // Der Endpoint matcht Doppelkarten nur über die Vorderseite; abgelegt wird unter dem vollen
    // Namen.
    const frontFaceName = (name: string) => name.split(' // ')[0].trim();
    // normalizeCardName() wegen abweichender Apostroph-Varianten zwischen Scryfall und Importen.
    const searchNameToOriginal = new Map<string, string>();
    for (const name of unique) {
      searchNameToOriginal.set(normalizeCardName(frontFaceName(name)), name);
    }
    const searchNames = [...new Set(unique.map(frontFaceName))];

    const chunks: string[][] = [];
    for (let i = 0; i < searchNames.length; i += 75) chunks.push(searchNames.slice(i, i + 75));

    // Chunks parallel statt nacheinander abfragen - bei größeren Decks/Kartenlisten (mehr als ein
    // Chunk) spart das spürbar Zeit, da jeder Chunk ein eigener, unabhängiger Request ist.
    await Promise.all(
      chunks.map(async (chunk) => {
        const res = await this.fetchWithRetry(`${API}/cards/collection`, 2, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ identifiers: chunk.map((name) => ({ name })) }),
        });
        if (!res?.ok) {
          // Chunk übersprungen (auch nach Wiederholungen fehlgeschlagen) - betroffene Karten bleiben einfach ohne Bild.
          for (const name of chunk) failed?.add(searchNameToOriginal.get(normalizeCardName(name)) ?? name);
          return;
        }
        const data = await res.json();
        for (const card of (data.data as any[]) ?? []) {
          const original = searchNameToOriginal.get(normalizeCardName(frontFaceName(card.name as string)));
          const key = original?.toLowerCase() ?? (card.name as string).toLowerCase();
          result.set(key, this.toCard(card));
        }
      })
    );

    // Der Endpoint liefert englisch; bei anderer Artwork-Sprache werden die Bilder gebündelt
    // getauscht (auf Englisch ohne Zusatzanfrage).
    return this.karteMapInKartensprache(result);
  }

  /** inKartensprache() für eine fertige Name->Karte-Map (Reihenfolge und Schlüssel bleiben). */
  async karteMapInKartensprache(
    karten: Map<string, ScryfallCard>
  ): Promise<Map<string, ScryfallCard>> {
    if (this.artLang.lang() === 'en' || karten.size === 0) return karten;
    const schluessel = [...karten.keys()];
    const uebersetzt = await this.inKartensprache(schluessel.map((k) => karten.get(k)!));
    const ergebnis = new Map<string, ScryfallCard>();
    schluessel.forEach((k, i) => ergebnis.set(k, uebersetzt[i]));
    return ergebnis;
  }

  /**
   * Lädt genau die per Set + Sammelnummer benannten Drucke ("Sol Ring (SOC) 128") fürs gewählte
   * Artwork. Zugeordnet über den zurückgegebenen Kartennamen, nicht das Set-Kürzel (Scryfall
   * antwortet mit dem kanonischen Set). Falsche Nummern fehlen einfach. Schlüssel: übergebener Name
   * klein.
   */
  async findPrintingsBySetAndNumber(
    requests: { name: string; setCode: string; collectorNumber: string }[]
  ): Promise<Map<string, ScryfallCard>> {
    const result = new Map<string, ScryfallCard>();
    const frontFaceName = (name: string) => name.split(' // ')[0].trim();

    const searchNameToOriginal = new Map<string, string>();
    const identifiers = new Map<string, { set: string; collector_number: string }>();
    for (const { name, setCode, collectorNumber } of requests) {
      const set = setCode.trim().toLowerCase();
      const collector_number = collectorNumber.trim().toLowerCase();
      if (!name.trim() || !set || !collector_number) continue;
      searchNameToOriginal.set(normalizeCardName(frontFaceName(name)), name);
      identifiers.set(`${set}|${collector_number}`, { set, collector_number });
    }

    const alle = [...identifiers.values()];
    const chunks: { set: string; collector_number: string }[][] = [];
    for (let i = 0; i < alle.length; i += 75) chunks.push(alle.slice(i, i + 75));

    await Promise.all(
      chunks.map(async (chunk) => {
        const res = await this.fetchWithRetry(`${API}/cards/collection`, 2, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ identifiers: chunk }),
        });
        // Fehlgeschlagen oder unbekannter Druck: kein Fehler, der Aufrufer nimmt dann das Bild
        // aus der Namenssuche.
        if (!res?.ok) return;
        const data = await res.json();
        for (const card of (data.data as any[]) ?? []) {
          const original = searchNameToOriginal.get(normalizeCardName(frontFaceName(card.name as string)));
          if (!original) continue;
          result.set(original.toLowerCase(), this.toCard(card));
        }
      })
    );

    return result;
  }

  /** Kartendaten für viele Scryfall-IDs (z. B. Marken aus all_parts), eindeutig statt per Name. */
  async findCardsByIds(ids: string[]): Promise<Map<string, ScryfallCard>> {
    const unique = [...new Set(ids.filter(Boolean))];
    const result = new Map<string, ScryfallCard>();

    const chunks: string[][] = [];
    for (let i = 0; i < unique.length; i += 75) chunks.push(unique.slice(i, i + 75));

    await Promise.all(
      chunks.map(async (chunk) => {
        const res = await this.fetchWithRetry(`${API}/cards/collection`, 2, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ identifiers: chunk.map((id) => ({ id })) }),
        });
        if (!res?.ok) return;
        const data = await res.json();
        for (const card of (data.data as any[]) ?? []) {
          result.set(card.id as string, this.toCard(card));
        }
      })
    );

    return result;
  }

  /**
   * Kartensuche zum Hinzufügen: nur im Deck-Format legale Karten (legal:<format>), optional in der
   * Farbidentität (id<=, leer = nur farblos).
   */
  async searchCards(
    query: string,
    filters: {
      type?: string;
      creatureType?: string;
      cmc?: number | null;
      /** Auswahl des Farbfilters samt Lesart (siehe color-filter-match.ts). */
      colors?: ColorSelection;
      colorIdentitySubset?: string[] | null;
      /** Fertiges Scryfall-Query-Fragment für eine Effekt-Kategorie, z.B. "otag:removal" - siehe effectFilters in deck-effects.service.ts. */
      effectQuery?: string;
      /** Fähigkeits-Keyword wie "lifelink" oder "first strike" (native Scryfall-Abfrage, kein Tagger-Tag). */
      keyword?: string;
      /** Sortierung der Ergebnisliste - Default 'name' (alphabetisch), 'cmc' sortiert nach Manawert aufsteigend. */
      order?: 'name' | 'cmc';
      /** Default true (bestehendes Verhalten fürs Deck-Hinzufügen). false = auch Nicht-Commander-legale Karten (öffentliche Suche ohne Format-Bezug). */
      commanderOnly?: boolean;
      /**
       * Deck-Format: nur dort erlaubte Karten. null = ohne Einschränkung; fehlt der Schlüssel,
       * entscheidet commanderOnly.
       */
      format?: DeckFormat | null;
    }
  ): Promise<ScryfallCard[]> {
    const trimmed = query.trim();
    const creatureType = filters.creatureType?.trim();
    if (
      !trimmed &&
      !filters.type &&
      !creatureType &&
      filters.cmc == null &&
      !filters.colors?.colors.length &&
      !filters.effectQuery &&
      !filters.keyword
    ) {
      return [];
    }

    const parts: string[] = [];
    if (filters.format !== undefined) {
      if (filters.format) parts.push(`legal:${SCRYFALL_FORMAT[filters.format]}`);
    } else if (filters.commanderOnly !== false) {
      parts.push('legal:commander');
    }
    // Name gegen englischen UND gedruckten deutschen Namen in einer Anfrage. Das lang:en ist nötig:
    // sobald ein lang: im Query steht, sucht Scryfall mehrsprachig und fände sonst auch
    // italienische/französische Drucke.
    if (trimmed) {
      const safeName = trimmed.replace(/"/g, '');
      parts.push(`(lang:en name:"${safeName}" or lang:de name:"${safeName}")`);
    }
    if (filters.type) parts.push(`type:"${filters.type}"`);
    if (creatureType) parts.push(`type:"${creatureType.replace(/"/g, '')}"`);
    if (filters.cmc != null) parts.push(filters.cmc >= 7 ? 'cmc>=7' : `cmc:${filters.cmc}`);
    if (filters.colors?.colors.length) {
      // id= bzw. id>= statt des mehrdeutigen id: (Teilmenge).
      const { colors, mode } = filters.colors;
      const operator = mode === 'atLeast' ? '>=' : '=';
      parts.push(colors.includes('C') ? 'id:c' : `id${operator}${colors.join('')}`);
    }
    if (filters.effectQuery) parts.push(filters.effectQuery);
    if (filters.keyword) parts.push(`keyword:"${filters.keyword.replace(/"/g, '')}"`);
    if (filters.colorIdentitySubset) {
      parts.push(filters.colorIdentitySubset.length > 0 ? `id<=${filters.colorIdentitySubset.join('')}` : 'id:c');
    }

    const q = encodeURIComponent(parts.join(' '));
    const res = await this.fetchWithRetry(`${API}/cards/search?q=${q}&unique=cards&order=${filters.order ?? 'name'}`);
    if (!res?.ok) return [];
    const data = await res.json();
    // Scryfall liefert pro Seite ohnehin maximal 175 Treffer - keine zusätzliche Begrenzung nötig,
    // die Aufteilung in Seiten für die Anzeige übernimmt deck-edit.service.ts (pagedAddCardResults).
    const rohdaten = (data.data as any[]) ?? [];
    return this.inKartensprache(
      rohdaten.map((c) => this.toCard(c)),
      rohdaten.map((c) => c.lang as string | undefined)
    );
  }

  /**
   * Welche Partner-Mechanik eine Karte trägt (nur Text/Typzeile): Partner (bare, pairt mit jedem
   * bare-Partner), Partner with X (nur mit X), Partner—Designator (gleicher Designator), Friends
   * forever, Choose a Background + Background, Doctor's companion + Time Lord Doctor.
   */
  private partnerProfile(card: ScryfallCard): PartnerProfile {
    const text = card.oracleText ?? '';
    const lines = text.split('\n').map((l) => l.trim());

    const partnerWithMatch = text.match(/Partner with ([^(\n]+)/);
    const designatorMatch = text.match(/Partner—([^(\n]+)/);
    // Reminder-Text in Klammern ist erlaubt, "Partner with X"/"Partner—X" nicht.
    const barePartnerLine = /^Partner(\s*\(.*\))?$/;

    return {
      plainPartner: lines.some((l) => barePartnerLine.test(l)),
      partnerWithName: partnerWithMatch ? partnerWithMatch[1].trim().replace(/[.,]$/, '').toLowerCase() : null,
      partnerDesignator: designatorMatch ? designatorMatch[1].trim().replace(/[.,]$/, '').toLowerCase() : null,
      friendsForever: text.includes('Friends forever'),
      chooseBackground: /Choose a Background/i.test(text),
      isBackground: (card.typeLine ?? '').includes('Background'),
      doctorsCompanion: /Doctor.s companion/i.test(text),
      isTimeLordDoctor: (card.typeLine ?? '').includes('Time Lord Doctor'),
    };
  }

  /** Prüft, ob zwei Karten laut ihrer Partner-Profile ein regelkonformes Commander-Paar bilden können. */
  private partnersCompatible(a: ScryfallCard, pa: PartnerProfile, b: ScryfallCard, pb: PartnerProfile): boolean {
    if (pa.plainPartner && pb.plainPartner) return true;
    if (pa.partnerWithName === b.name.toLowerCase() || pb.partnerWithName === a.name.toLowerCase()) return true;
    if (pa.partnerDesignator && pa.partnerDesignator === pb.partnerDesignator) return true;
    if (pa.friendsForever && pb.friendsForever) return true;
    if ((pa.chooseBackground && pb.isBackground) || (pb.chooseBackground && pa.isBackground)) return true;
    if ((pa.doctorsCompanion && pb.isTimeLordDoctor) || (pb.doctorsCompanion && pa.isTimeLordDoctor)) return true;
    return false;
  }

  /**
   * Erlaubt die Karte einen zweiten Commander? Auch die passive Hälfte zählt (Background, Time Lord
   * Doctor).
   */
  allowsSecondCommander(card: ScryfallCard): boolean {
    const p = this.partnerProfile(card);
    return (
      p.plainPartner ||
      p.partnerWithName !== null ||
      p.partnerDesignator !== null ||
      p.friendsForever ||
      p.chooseBackground ||
      p.isBackground ||
      p.doctorsCompanion ||
      p.isTimeLordDoctor
    );
  }

  /** Prüft, ob zwei Karten zusammen ein regelkonformes Commander-Paar bilden (siehe partnersCompatible()). */
  canBeCommanderPair(a: ScryfallCard, b: ScryfallCard): boolean {
    return this.partnersCompatible(a, this.partnerProfile(a), b, this.partnerProfile(b));
  }

  /**
   * Welche Namen passen zu einer otag:/keyword:-Abfrage - plus welche erfolgreich geprüft wurden
   * ("checked"), damit classifyCards() ein Nein nur nach echter Antwort cacht (ein
   * Rate-Limit-Fehler als "nicht getaggt" korrigierte sich nie).
   */
  private async filterNamesByQueryChecked(
    tagQuery: string,
    cardNames: string[]
  ): Promise<{ matched: Set<string>; checked: Set<string> }> {
    const matched = new Set<string>();
    const checked = new Set<string>();
    const unique = [...new Set(cardNames.map((n) => n.trim()).filter(Boolean))];

    // Chunks nach Länge statt fester Anzahl - Scryfalls undokumentiertes Längenlimit lässt zu lange
    // Anfragen mit 400 scheitern. Mindestens ein Name je Chunk (sonst Endlosschleife).
    const MAX_QUERY_LEN = 800;
    let i = 0;
    while (i < unique.length) {
      if (i > 0) await sleep(300); // Pause zwischen Chunks - vermeidet Bursts gegen Scryfalls Rate-Limit
      const chunk: string[] = [];
      let len = tagQuery.length + 3; // Puffer für umschließende Klammer/Leerzeichen der Namens-Klausel
      while (i < unique.length) {
        const clauseLen = `!"${unique[i].replace(/"/g, '')}"`.length + 4; // + " or "
        if (chunk.length > 0 && len + clauseLen > MAX_QUERY_LEN) break;
        chunk.push(unique[i]);
        len += clauseLen;
        i++;
      }
      const nameClause = '(' + chunk.map((n) => `!"${n.replace(/"/g, '')}"`).join(' or ') + ')';
      const q = encodeURIComponent(`${tagQuery} ${nameClause}`);
      const res = await this.fetchWithRetry(`${API}/cards/search?q=${q}&unique=cards`);
      if (!res) continue; // gescheitert: bleibt ungeprüft, nächster Aufruf versucht es erneut
      for (const name of chunk) checked.add(normalizeCardName(name));
      // 404 = keine Treffer: gültiges Ergebnis, bleibt als geprüft gecacht.
      if (res.status === 404) continue;
      const data = await res.json();
      for (const card of (data.data as any[]) ?? []) {
        // Scryfall liefert bei Doppelkarten "A // B", geprüft wurde mit der Vorderseite.
        matched.add(normalizeCardName((card.name as string).split(' // ')[0].trim()));
      }
    }
    return { matched, checked };
  }

  // Versionsnummer hochzählen, sobald sich eine Abfrage in EFFECT_TAG_CATEGORIES ändert - sonst
  // gelten alte Ergebnisse weiter.
  private static readonly TAG_CACHE_KEY = 'statsfinity-tag-cache-v5';
  private tagCache: Record<string, Record<string, boolean>> | null = null;

  private getTagCache(): Record<string, Record<string, boolean>> {
    if (!this.tagCache) {
      try {
        this.tagCache = JSON.parse(localStorage.getItem(ScryfallService.TAG_CACHE_KEY) ?? '{}');
      } catch {
        this.tagCache = {};
      }
    }
    return this.tagCache!;
  }

  private saveTagCache(): void {
    try {
      localStorage.setItem(ScryfallService.TAG_CACHE_KEY, JSON.stringify(this.tagCache ?? {}));
    } catch {
      // z.B. Speicher voll oder privater Modus - Cache bleibt dann nur für diese Sitzung im Speicher, kein Beinbruch.
    }
  }

  /**
   * Wie filterNamesByQueryChecked(), mit dauerhaftem localStorage-Cache je (Kategorie, Karte) -
   * Tags ändern sich praktisch nie; nur neue Karten fragen Scryfall.
   */
  async classifyCards(categoryKey: string, tagQuery: string, cardNames: string[]): Promise<Set<string>> {
    const cache = this.getTagCache();
    // Nur die Vorderseite: !"A // B" lässt Scryfall mit 400 scheitern (den ganzen Chunk).
    const frontFaceName = (name: string) => name.split(' // ')[0].trim();
    const unique = [...new Set(cardNames.map((n) => normalizeCardName(frontFaceName(n))).filter(Boolean))];
    const matched = new Set<string>();
    const uncached: string[] = [];

    for (const name of unique) {
      const cached = cache[name]?.[categoryKey];
      if (cached === true) matched.add(name);
      else if (cached === undefined) uncached.push(name);
      // cached === false: bewusst weder zu matched hinzufügen noch erneut abfragen.
    }

    if (uncached.length > 0) {
      const { matched: freshlyMatched, checked } = await this.filterNamesByQueryChecked(tagQuery, uncached);
      for (const name of checked) {
        const isMatch = freshlyMatched.has(name);
        cache[name] ??= {};
        cache[name][categoryKey] = isMatch;
        if (isMatch) matched.add(name);
      }
      this.saveTagCache();
    }

    return matched;
  }

  /**
   * Alle Drucke einer Karte, neueste zuerst (Artwork-Auswahl). include:extras, sonst findet die
   * Suche keine Marken. Marken bevorzugt über oracleId (viele heißen gleich), sonst Name + t:token.
   */
  async getPrintings(cardName: string, options?: { isToken?: boolean; oracleId?: string | null }): Promise<ScryfallPrinting[]> {
    const query = options?.oracleId
      ? `oracleid:${options.oracleId} lang:en -is:digital include:extras`
      : (() => {
          const safeName = cardName.replace(/"/g, '');
          const typeClause = options?.isToken ? ' t:token' : '';
          return `!"${safeName}" lang:en -is:digital include:extras${typeClause}`;
        })();
    const q = encodeURIComponent(query);
    const res = await this.fetchWithRetry(`${API}/cards/search?q=${q}&unique=prints&order=released&dir=desc`);
    if (!res?.ok) return [];
    const data = await res.json();
    return ((data.data as any[]) ?? [])
      .map((c) => ({
        id: c.id as string,
        setName: c.set_name as string,
        setCode: c.set as string,
        releasedAt: (c.released_at as string | undefined) ?? null,
        imageUrl: c.image_uris?.normal ?? c.card_faces?.[0]?.image_uris?.normal ?? null,
      }))
      .filter((p): p is ScryfallPrinting => !!p.imageUrl);
  }

  /**
   * EUR-Preis (Cardmarket über Scryfall) des GÜNSTIGSTEN Drucks je Karte: eur>0, unique:cards,
   * order:eur asc. In Chunks wie filterNamesByQueryChecked(). Schlüssel ist die normalisierte
   * Vorderseite.
   */
  async cheapestPrices(cardNames: string[]): Promise<{ prices: Map<string, number>; incomplete: boolean }> {
    const prices = new Map<string, number>();
    const frontFaceName = (name: string) => name.split(' // ')[0].trim();
    const unique = [...new Set(cardNames.map((n) => frontFaceName(n.trim())).filter(Boolean))];
    let incomplete = false;

    for (let i = 0; i < unique.length; i += 30) {
      if (i > 0) await sleep(300); // Pause zwischen Chunks - vermeidet Bursts gegen Scryfalls Rate-Limit
      const chunk = unique.slice(i, i + 30);
      const nameClause = '(' + chunk.map((n) => `!"${n.replace(/"/g, '')}"`).join(' or ') + ')';
      const q = encodeURIComponent(`${nameClause} eur>0 -is:digital unique:cards order:eur dir:asc`);
      // Geduldiger (4 Versuche) - die einzige Scryfall-Anfrage beim Deck-Öffnen. Scheitert ein
      // Chunk trotzdem, wird das gemeldet statt still eine zu niedrige Summe zu zeigen (so
      // geschehen: 277 statt 388 €). Retry-After ist wegen CORS nicht lesbar.
      const res = await this.fetchWithRetry(`${API}/cards/search?q=${q}`, 4);
      if (!res?.ok) {
        incomplete = true;
        continue;
      }
      const data = await res.json();
      for (const card of (data.data as any[]) ?? []) {
        // Schlüssel ist die Vorderseite, wie bei allen Aufrufern (sonst fielen Doppel-, Split- und
        // Abenteuerkarten still aus der Summe).
        const name = normalizeCardName(frontFaceName(card.name as string));
        const price = parseFloat(card.prices?.eur);
        if (!prices.has(name) && !Number.isNaN(price)) prices.set(name, price);
      }
    }

    // incomplete heißt nur "eine Anfrage scheiterte", nicht "eine Karte hat keinen Preis"
    // (Normalfall).
    return { prices, incomplete };
  }

  /**
   * Setzt Bild und gedruckten Namen auf den Druck in der Artwork-Sprache. Alles andere bleibt
   * englisch (Name, Typzeile, Regeltext, Farbidentität) - die App wertet diese Felder aus.
   * `sprachen[i]` = Sprache, in der Treffer i schon vorliegt; auf Englisch macht derselbe Weg
   * deutsche Treffer wieder englisch.
   */
  async inKartensprache(
    karten: ScryfallCard[],
    sprachen?: (string | undefined)[]
  ): Promise<ScryfallCard[]> {
    const ziel = this.artLang.lang();
    const passtSchon = (index: number) => (sprachen?.[index] ?? 'en') === ziel;
    const offen = karten.filter((karte, index) => karte.name && !passtSchon(index));
    if (offen.length === 0) return karten;

    const drucke = await this.druckeInSprache(
      offen.map((karte) => karte.name),
      ziel
    );
    return karten.map((karte, index) => {
      if (!karte.name || passtSchon(index)) return karte;
      const druck = drucke.get(ScryfallService.druckSchluessel(ziel, karte.name));
      return druck ? ScryfallService.mitDruckbild(karte, druck) : karte;
    });
  }

  /**
   * Druck in einer Sprache zu englischen Namen, gebündelt als lang:xx (!"A" or !"B" ...) - der
   * Collection-Endpoint kennt keine Sprache. Ohne Druck: null gemerkt, der Aufrufer behält
   * Englisch.
   */
  private async druckeInSprache(namen: string[], lang: ArtLang): Promise<Map<string, any>> {
    const ergebnis = new Map<string, any>();
    const offen: string[] = [];
    const gesehen = new Set<string>();

    for (const name of namen) {
      const schluessel = ScryfallService.druckSchluessel(lang, name);
      if (gesehen.has(schluessel)) continue;
      gesehen.add(schluessel);
      if (this.druckCache.has(schluessel)) {
        const treffer = this.druckCache.get(schluessel);
        if (treffer) ergebnis.set(schluessel, treffer);
      } else {
        offen.push(name);
      }
    }
    if (offen.length === 0) return ergebnis;

    // 25 Namen je Anfrage: ab 40 Gliedern meldet Scryfall fälschlich "unclosed parentheses" (400).
    const bloecke: string[][] = [];
    for (let i = 0; i < offen.length; i += 25) bloecke.push(offen.slice(i, i + 25));

    // Nacheinander mit Pause: parallel beantwortet Scryfall die meisten Blöcke mit 429.
    for (const block of bloecke) {
      const namensteil = block
        .map((name) => `!"${ScryfallService.vorderseite(name).replace(/"/g, '')}"`)
        .join(' or ');
      const q = encodeURIComponent(`lang:${lang} (${namensteil})`);
      const res = await this.fetchWithRetry(`${API}/cards/search?q=${q}&unique=cards`);

      // Aufgegeben (null) heißt NICHT "gibt es in dieser Sprache nicht" - würde dieser Block
      // trotzdem als Fehlanzeige im Cache landen, bliebe er für den Rest der Sitzung englisch.
      if (!res) continue;
      if (res.ok) {
        const data = await res.json();
        for (const karte of (data.data as any[]) ?? []) {
          // Schlüssel aus dem Namen des Treffers: !"Lightning Bolt" matcht auch Doppelkarten mit
          // dieser Rückseite.
          if (!ScryfallService.hatEchtesBild(karte)) continue;
          const schluessel = ScryfallService.druckSchluessel(lang, karte.name as string);
          if (!ergebnis.has(schluessel)) ergebnis.set(schluessel, karte);
        }
      } else if (res.status !== 404) {
        continue; // 404 = wirklich kein Treffer im ganzen Block, alles andere ist ein Fehler
      }

      for (const name of block) {
        const schluessel = ScryfallService.druckSchluessel(lang, name);
        this.druckCache.set(schluessel, ergebnis.get(schluessel) ?? null);
      }
      if (block !== bloecke[bloecke.length - 1]) await sleep(100);
    }
    return ergebnis;
  }

  /**
   * Scryfall kennt zu vielen fremdsprachigen Drucken kein Bild (Platzhalter, allein deutsch
   * >30.000) - die zählen als "nicht in dieser Sprache". Nur hier filterbar (is:placeholder meint
   * etwas anderes).
   */
  private static hatEchtesBild(druck: any): boolean {
    const status = druck.image_status as string | undefined;
    return status !== 'placeholder' && status !== 'missing';
  }

  /** Nur die Vorderseite - Scryfall matcht "A // B" bei !"..." über die einzelnen Seiten. */
  private static vorderseite(name: string): string {
    return name.split(' // ')[0].trim();
  }

  private static druckSchluessel(lang: ArtLang, name: string): string {
    return `${lang}|${normalizeCardName(ScryfallService.vorderseite(name))}`;
  }

  /** Tauscht Bild (und gedruckten Namen) aus, lässt alle Spieldaten unberührt - siehe inKartensprache(). */
  private static mitDruckbild(karte: ScryfallCard, druck: any): ScryfallCard {
    const vorne =
      druck.image_uris?.normal ??
      druck.card_faces?.[0]?.image_uris?.normal ??
      druck.image_uris?.art_crop ??
      druck.card_faces?.[0]?.image_uris?.art_crop;
    const hinten = druck.card_faces?.[1]?.image_uris?.normal as string | undefined;
    return {
      ...karte,
      imageUrl: (vorne as string | undefined) ?? karte.imageUrl,
      // Die Rückseite nur ersetzen, wenn die Karte überhaupt eine hat (siehe toCard) - sonst
      // bekäme eine Adventure-/Split-Karte plötzlich ein zweites Bild, das es nicht gibt.
      backImageUrl: karte.backImageUrl ? (hinten ?? karte.backImageUrl) : karte.backImageUrl,
      printedName: (druck.printed_name as string | undefined) ?? undefined,
    };
  }

  private toCard(data: any): ScryfallCard {
    const backFace = data.card_faces?.[1];
    // image_uris auf Face 2 fehlt bei Adventure/Split (die teilen sich ein Bild) - nur wenn es
    // eins hat, ist es eine "echte" umdrehbare Rückseite (Transform/Modal-DFC).
    const hasFlippableBack = !!backFace?.image_uris?.normal;
    return {
      name: data.name as string,
      printedName: data.printed_name as string | undefined,
      imageUrl:
        data.image_uris?.normal ??
        data.card_faces?.[0]?.image_uris?.normal ??
        data.image_uris?.art_crop ??
        data.card_faces?.[0]?.image_uris?.art_crop,
      typeLine: data.type_line as string | undefined,
      cmc: data.cmc as number | undefined,
      manaCost: (data.mana_cost || data.card_faces?.[0]?.mana_cost) as string | undefined,
      colorIdentity: data.color_identity as string[] | undefined,
      // Bei doppelseitigen Karten (z.B. MDFC-Ländern) steht produced_mana je nach Karte oben oder
      // nur auf den Faces - beide Quellen zusammenführen, sonst fehlt die halbe Manabasis.
      producedMana: (data.produced_mana as string[] | undefined) ??
        (data.card_faces as any[] | undefined)?.reduce<string[] | undefined>((acc, face) => {
          const produced = face?.produced_mana as string[] | undefined;
          if (!produced) return acc;
          return [...new Set([...(acc ?? []), ...produced])];
        }, undefined),
      gameChanger: data.game_changer as boolean | undefined,
      oracleText: (data.oracle_text || data.card_faces?.[0]?.oracle_text) as string | undefined,
      keywords: data.keywords as string[] | undefined,
      backImageUrl: hasFlippableBack ? (backFace.image_uris?.normal as string) : undefined,
      backTypeLine: hasFlippableBack ? (backFace.type_line as string | undefined) : undefined,
      allParts: (data.all_parts as any[] | undefined)?.map((p) => ({
        id: p.id as string,
        component: p.component as string,
        name: p.name as string,
        typeLine: p.type_line as string | undefined,
      })),
      oracleId: data.oracle_id as string | undefined,
    };
  }
}
