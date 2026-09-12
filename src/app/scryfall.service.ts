import { Injectable } from '@angular/core';
import { sleep, normalizeCardName } from './array-utils';
import { ColorSelection } from './color-filter-match';

export interface ScryfallCard {
  name: string;
  imageUrl?: string;
  typeLine?: string;
  cmc?: number;
  manaCost?: string;
  colorIdentity?: string[];
  /**
   * Farben, die diese Karte an Mana erzeugen kann ('W'|'U'|'B'|'R'|'G'|'C') - von Scryfall selbst
   * gepflegt, fehlt bei Karten, die gar kein Mana erzeugen. Grundlage der Manaquellen-Verteilung.
   */
  producedMana?: string[];
  /** Teil der offiziellen Commander-Bracket-"Game Changers"-Liste (von Scryfall selbst gepflegt). */
  gameChanger?: boolean;
  oracleText?: string;
  /** Native Scryfall-Fähigkeiten-Liste ("Flying", "Lifelink", ...) - kein Tagger-Tag, kommt direkt mit jeder Karte. */
  keywords?: string[];
  /**
   * Nur gesetzt bei echten zweiseitigen Karten (Transform/Modal-DFC), deren Rückseite ein eigenes
   * Kartenbild hat - NICHT bei Adventure/Split, die trotz mehrerer "Faces" nur ein einziges,
   * gemeinsames Bild besitzen (dort fehlt image_uris auf der zweiten Face, siehe toCard()).
   */
  backImageUrl?: string;
  backTypeLine?: string;
  /** Von Scryfall mitgelieferte verwandte Karten (u.a. Marken, die diese Karte erzeugt) - component "token" ist der für den Marken-Scan relevante Fall. */
  allParts?: { id: string; component: string; name: string; typeLine?: string }[];
  /**
   * Scryfalls "gleiche Karte über alle Drucke hinweg"-ID - bei Marken essenziell, da viele
   * VERSCHIEDENE Marken denselben schlichten Namen teilen (z.B. "Wizard" oder "Zombie" in
   * unterschiedlichen Farben/Werten/Fähigkeiten je nach erzeugender Karte). Nur über diese ID
   * lässt sich zuverlässig zwischen "andere Edition derselben Marke" und "andere Marke mit
   * zufällig gleichem Namen" unterscheiden.
   */
  oracleId?: string;
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

export interface CommanderFilters {
  /** Freitext, UND-verknüpft als Teilstring-Suche auf den Kartennamen (name:"..."). */
  name?: string | null;
  /** Fertiges Scryfall-Query-Fragment für einen Archetyp, z.B. "otag:landfall" - siehe commander-archetype-filters.ts. */
  archetypeQuery?: string | null;
  /**
   * Kreaturtyp aus dem Scryfall-Katalog (z.B. "Elf") - bewusst BREIT: matcht Commander, die
   * SELBST diesen Typ tragen (t:) ODER ihn im Oracle-Text referenzieren/unterstützen (o:), z.B.
   * ein Nicht-Elf-Commander mit "Elfen, die du kontrollierst erhalten +1/+1".
   */
  creatureType?: string | null;
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
  private cachedSets: ScryfallSet[] | null = null;

  private buildHeaders(): HeadersInit {
    return {
      Accept: 'application/json',
      'User-Agent': 'MTG-App/1.0',
    };
  }

  /**
   * Fetch mit Wiederholung bei Fehlern - wichtig, weil Scryfalls Rate-Limit (429) im Browser als
   * generischer CORS-Fehler ankommt (die 429-Antwort hat selbst keine CORS-Header, der Browser
   * blockt sie also komplett und die fetch-Promise wird abgelehnt, ohne dass der Statuscode für
   * JS lesbar wäre). Ein einzelner Fehlschlag lässt sich also nicht sicher von einem "429, kurz
   * warten reicht" unterscheiden - deshalb bei JEDEM Fehler einfach abwarten und erneut versuchen,
   * mit wachsender Pause, statt sofort aufzugeben.
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
   * Liefert den vollständigen, offiziellen Katalog aller je gedruckten Kreaturtypen (Scryfalls
   * /catalog/creature-types) - Grundlage für das Kreaturtyp-Dropdown der Commander-Suche.
   * Alphabetisch sortiert, da Scryfalls Katalog-Reihenfolge nicht dokumentiert/stabil ist.
   * Caching wie allSets() - ändert sich praktisch nur bei neuen Editionen.
   */
  async creatureTypes(): Promise<string[]> {
    if (this.cachedCreatureTypes) return this.cachedCreatureTypes;
    const res = await this.fetchWithRetry(`${API}/catalog/creature-types`);
    if (!res?.ok) return [];
    const data = await res.json();
    this.cachedCreatureTypes = ((data.data as string[]) ?? []).slice().sort((a, b) => a.localeCompare(b));
    return this.cachedCreatureTypes;
  }

  // NEU
  /** Entfernt Apostrophe/Akzente, damit z.B. "Baldurs" auch "Baldur's" findet. */
  private normalizeForSearch(text: string): string {
    return text
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '') // Akzente entfernen (é -> e)
      .replace(/['’‘´`]/g, '');        // alle Apostroph-Varianten entfernen
  }

  // NEU
  /**
   * Set-Typen, die als echtes Draft-/Play-Booster-Display verkauft werden.
   * Schließt Token-, Promo-, Commander-Precon-, Duel-Deck- und Alchemy-Sets
   * (nur digital in Arena) automatisch aus.
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

  /** Liefert Sets nach Erscheinungsjahr */
  async setsByYear(year: number): Promise<ScryfallSet[]> {
    return this.searchSets('', year);
  }
  // NEU
  /**
   * Autovervollständigung für Kartennamen – liefert nur Karten, die laut Regel 903.3
   * als Commander erlaubt sind (legendäre Kreatur, Vehicle, Spacecraft mit P/T-Werten,
   * oder Karten mit "kann dein Commander sein"-Text). Scryfalls "is:commander"
   * bildet genau diese Regel ab, deshalb reicht ein einziger Suchoperator.
   * Findet englische Namen direkt; bei deutschen Eingaben wird zusätzlich
   * über die gedruckten deutschen Namen gesucht und der englische Name geliefert.
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
   * Autovervollständigung für den ZWEITEN Commander eines Partner-Decks - wie autocomplete(),
   * schließt aber zusätzlich Backgrounds mit ein: die sind selbst nicht is:commander-legal (keine
   * "kann dein Commander sein"-Karte) und würden hier sonst fehlen, wandern bei "Choose a
   * Background" aber genauso mit in die Kommandozone.
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
   * Autovervollständigung ohne Commander-Einschränkung - für die öffentliche Kartensuche (jede
   * Karte, nicht nur Commander-legale), nutzt Scryfalls eigenen dafür vorgesehenen Endpoint statt
   * einer eigenen name:"..."-Suche.
   * Dieser Endpoint kennt allerdings NUR englische Namen ("Blitzschlag" liefert dort nichts),
   * deshalb wird bei wenigen Treffern zusätzlich über die gedruckten deutschen Namen gesucht -
   * genau wie in autocomplete() für Commander. Geliefert wird in beiden Fällen der englische Name,
   * mit dem der Rest der App weiterarbeitet.
   */
  async autocompleteAnyCard(query: string): Promise<string[]> {
    if (query.trim().length < 2) return [];
    const res = await this.fetchWithRetry(`${API}/cards/autocomplete?q=${encodeURIComponent(query.trim())}`);
    const english = res?.ok ? (((await res.json()).data as string[]) ?? []) : [];
    if (english.length >= 5) return english;

    const german = await this.searchGermanPrintedNames(query, 'any');
    return [...new Set([...english, ...german])].slice(0, 12);
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
   * Prüft, ob eine Karte existiert, und liefert Details (englischer Name).
   * Akzeptiert auch deutsche Kartennamen.
   */
  async findCard(name: string): Promise<ScryfallCard | null> {
    if (!name.trim()) return null;

    // Fuzzy-Suche matcht auch viele gedruckte fremdsprachige Namen
    const res = await this.fetchWithRetry(`${API}/cards/named?fuzzy=${encodeURIComponent(name)}`);
    if (res?.ok) {
      return this.toCard(await res.json());
    }

    // Fallback: exakte Suche über gedruckte Namen in beliebiger Sprache
    const q = encodeURIComponent(`lang:any !"${name}"`);
    const searchRes = await this.fetchWithRetry(`${API}/cards/search?q=${q}&unique=cards`);
    if (searchRes?.ok) {
      const data = await searchRes.json();
      if (data.data?.length > 0) {
        return this.toCard(data.data[0]);
      }
    }
    return null;
  }

  /**
   * Löst einen unsauberen Namens-Kandidaten (z.B. aus einem Excel-Kommentar-Bildtitel oder einem
   * Deckname wie "Sovereign Okinec Ahau +1/+1 Markendeck") zu einem eindeutigen, offiziellen
   * Commander-Namen auf. Schneidet dafür schrittweise Wörter vom Ende ab (der störende
   * Zusatztext steht meist hinter dem eigentlichen Namen) und sucht bei jeder Länge gezielt nach
   * Commander-fähigen Karten - auf Englisch, dann Deutsch (nacheinander statt parallel, siehe
   * fetchWithRetry). Sobald eine Länge Treffer liefert, wird abgebrochen (kürzer würde die Trefferzahl nur
   * noch vergrößern, nie eindeutiger machen). Von den englischen Treffern zählt nur einer, dessen
   * Name mit dem gesuchten Ausschnitt beginnt (z.B. akzeptiert "T'Challa, the Black Panther" für die
   * Suche "T'Challa" - aber NICHT "King T'Challa // Black Panther, Hope Enduring", das "T'Challa" nur
   * mittendrin enthält). Ohne diesen Filter griff Scryfalls Namens-Suche als reine Teilstring-Suche
   * und der alphabetisch erste Treffer konnte eine völlig andere Karte sein, die den gesuchten
   * Ausschnitt nur zufällig irgendwo im Namen trägt. Letzter Fallback: die normale Fuzzy-Suche, die
   * auch Tippfehler im Kernnamen selbst abdeckt.
   */
  async resolveCommanderCandidate(candidate: string): Promise<string | null> {
    const words = candidate.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) return null;

    // Bewusst NACHEINANDER statt parallel, mit Pause zwischen jeder einzelnen Anfrage -
    // Scryfalls Rate-Limit (429) greift sonst schnell, wenn ein Name mehrere Kürzungs- und
    // Sprachversuche braucht (mehrere Anfragen in kurzer Zeit).
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

  // NEU
  /**
   * Sucht deutsche gedruckte Namen und liefert die englischen Kartennamen zurück. `scope` steuert,
   * welche Karten überhaupt in Frage kommen: nur Commander, Commander+Backgrounds (zweiter
   * Commander eines Partner-Decks) oder - für die öffentliche Kartensuche - jede Karte.
   * Der Name wird als name:"..."-Klausel gestellt: unter lang:de vergleicht Scryfall damit den
   * gedruckten deutschen Namen (verifiziert: lang:de name:"Sonnenring" findet Sol Ring).
   */
  private async searchGermanPrintedNames(
    query: string,
    scope: 'commander' | 'commanderOrBackground' | 'any' = 'commander'
  ): Promise<string[]> {
    const safeQuery = query.trim().replace(/"/g, '');
    if (!safeQuery) return [];
    const legality =
      scope === 'any' ? '' : scope === 'commanderOrBackground' ? '(is:commander or type:background) ' : 'is:commander ';
    const q = encodeURIComponent(`${legality}lang:de name:"${safeQuery}"`);
    const res = await this.fetchWithRetry(`${API}/cards/search?q=${q}&unique=cards&order=name`);
    if (!res?.ok) return [];
    const data = await res.json();
    return ((data.data as { name: string }[]) ?? []).map((c) => c.name).slice(0, 12);
  }
  /**
   * Lädt Kartendaten (u.a. Bilder) für viele Kartennamen auf einmal, statt pro Karte eine
   * Anfrage zu schicken. Nutzt Scryfalls Collection-Endpoint (max. 75 Identifier pro Request).
   * Karten, die nicht exakt gefunden werden, fehlen einfach in der Ergebnis-Map (kein Fehler).
   */
  async findCardsBulk(names: string[]): Promise<Map<string, ScryfallCard>> {
    const unique = [...new Set(names.map((n) => n.trim()).filter(Boolean))];
    const result = new Map<string, ScryfallCard>();

    // Scryfalls Collection-Endpoint matcht Doppelkarten (Transform/MDFC, z.B. "Westvale Abbey //
    // Ormendahl, Profane Prince") nur über den Namen der Vorderseite, nicht über den vollen
    // "A // B"-Namen, den Decklist-Exporte oft verwenden. Deshalb wird nur vor "//" gesucht,
    // das Ergebnis aber unter dem ursprünglichen (vollen) Namen abgelegt.
    const frontFaceName = (name: string) => name.split(' // ')[0].trim();
    // normalizeCardName() statt nur .toLowerCase() - Scryfall liefert Kartennamen mit Apostroph (z.B.
    // "Dovin's Veto") teils mit einer anderen Unicode-Apostroph-Variante zurück als sie in
    // Decklisten-Importen gespeichert sind. Ohne Normalisierung würde original hier undefined bleiben
    // und die Karte landete unter Scryfalls statt dem ursprünglichen Namen im Ergebnis - der Lookup
    // per viewingCardDetails.get(cardName.toLowerCase()) an anderer Stelle würde sie dann nie finden.
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
        if (!res?.ok) return; // Chunk übersprungen (auch nach Wiederholungen fehlgeschlagen) - betroffene Karten bleiben einfach ohne Bild.
        const data = await res.json();
        for (const card of (data.data as any[]) ?? []) {
          const original = searchNameToOriginal.get(normalizeCardName(frontFaceName(card.name as string)));
          const key = original?.toLowerCase() ?? (card.name as string).toLowerCase();
          result.set(key, this.toCard(card));
        }
      })
    );

    return result;
  }

  // NEU
  /**
   * Lädt Kartendaten für viele Scryfall-IDs auf einmal (z.B. Marken aus all_parts) - Namenssuche
   * wäre hier mehrdeutig (mehrere Karten teilen sich oft denselben Markennamen wie "Zombie"),
   * die ID identifiziert dagegen eindeutig genau diesen einen Marken-Druck. Gleiches
   * Chunking-/Parallelitätsmuster wie findCardsBulk().
   */
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

  // NEU
  /**
   * Kartensuche zum Hinzufügen einzelner Karten zu einem Deck. Beschränkt sich bewusst auf
   * Commander-legale Karten (legal:commander) und optional auf eine Farbidentität
   * (id<=<Farben> - Teilmenge, damit das Ergebnis wirklich in ein Deck mit dieser
   * Commander-Farbidentität passt; leeres Array = nur farblose Karten über id:c).
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
      /** Fertiges Scryfall-Query-Fragment für eine Effekt-Kategorie, z.B. "otag:removal" - siehe effectFilters in deck-viewer.service.ts. */
      effectQuery?: string;
      /** Fähigkeits-Keyword wie "lifelink" oder "first strike" (native Scryfall-Abfrage, kein Tagger-Tag). */
      keyword?: string;
      /** Sortierung der Ergebnisliste - Default 'name' (alphabetisch), 'cmc' sortiert nach Manawert aufsteigend. */
      order?: 'name' | 'cmc';
      /** Default true (bestehendes Verhalten fürs Deck-Hinzufügen). false = auch Nicht-Commander-legale Karten (öffentliche Suche ohne Format-Bezug). */
      commanderOnly?: boolean;
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

    const parts = filters.commanderOnly === false ? [] : ['legal:commander'];
    // Der Name wird bewusst gegen den englischen UND den gedruckten deutschen Namen geprüft
    // (ein Request statt zwei): Scryfall vergleicht name:"..." unter lang:de mit printed_name,
    // liefert im Kartenobjekt aber weiterhin den englischen name - der Rest der App bleibt
    // dadurch unverändert englisch. Ohne die zweite Hälfte findet "Sonnenring" nichts.
    if (trimmed) {
      const safeName = trimmed.replace(/"/g, '');
      parts.push(`(name:"${safeName}" or (lang:de name:"${safeName}"))`);
    }
    if (filters.type) parts.push(`type:"${filters.type}"`);
    if (creatureType) parts.push(`type:"${creatureType.replace(/"/g, '')}"`);
    if (filters.cmc != null) parts.push(filters.cmc >= 7 ? 'cmc>=7' : `cmc:${filters.cmc}`);
    if (filters.colors?.colors.length) {
      // Bewusst id= bzw. id>= statt des mehrdeutigen id: - das ist bei Scryfall die
      // Teilmengen-Suche (id:U findet blaue UND farblose Karten, aber keine simic-farbenen) und
      // trifft damit keine der beiden Lesarten des Filters.
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
    // die Aufteilung in Seiten für die Anzeige übernimmt deck-viewer.service.ts (pagedAddCardResults).
    return ((data.data as any[]) ?? []).map((c) => this.toCard(c));
  }

  /**
   * Sucht Commander-legale Legenden über beliebig kombinierbare Filter (Name, exakte Farbidentität,
   * Archetyp-Kategorie, Kreaturtyp), alle UND-verknüpft, sortiert nach Scryfalls eigenem EDHREC-Rang
   * (order=edhrec - offizieller, dokumentierter Scryfall-Sortierparameter, keine inoffizielle
   * EDHREC-API nötig). Farbidentität nutzt bewusst id= (EXAKTE Übereinstimmung) statt id:
   * (Teilmenge) - "Azorius-Commander" meint wirklich genau Weiß+Blau, nicht auch Mono-Weiß oder
   * einen 3-Farben-Commander, der Weiß+Blau mit einschließt. Ersetzt die EDHREC-Direktanbindung
   * fürs Commander-Entdecken (Farbe/Archetyp-Browsing), die trotz mehrerer Versuche keine
   * zuverlässigen Endpunkte fand - Scryfalls eigene API ist dokumentiert und stabil.
   */
  async searchCommanders(colors: string[], filters?: CommanderFilters): Promise<ScryfallCard[]> {
    const parts = ['is:commander'];
    if (colors.length > 0) parts.push(`id=${colors.join('')}`);
    parts.push(...this.buildCommanderFilterParts(filters));
    return this.fetchCommanderList(parts.join(' '));
  }

  /** Baut die Name-/Archetyp-/Kreaturtyp-Query-Fragmente, die searchCommanders() UND searchCommanderPairs() teilen. */
  private buildCommanderFilterParts(filters?: CommanderFilters): string[] {
    const parts: string[] = [];

    const name = filters?.name?.trim();
    if (name) parts.push(`name:"${name.replace(/"/g, '')}"`);

    if (filters?.archetypeQuery) parts.push(filters.archetypeQuery);

    const creatureType = filters?.creatureType?.trim();
    if (creatureType) {
      const safe = creatureType.replace(/"/g, '');
      parts.push(`(t:"${safe}" or o:"${safe}")`);
    }

    return parts;
  }

  /** Führt eine fertige Scryfall-Query aus und liefert die geparste Kartenliste (order=edhrec, wie searchCommanders()). */
  private async fetchCommanderList(query: string): Promise<ScryfallCard[]> {
    const q = encodeURIComponent(query);
    const res = await this.fetchWithRetry(`${API}/cards/search?q=${q}&unique=cards&order=edhrec`);
    if (!res?.ok) return [];
    const data = await res.json();
    return ((data.data as any[]) ?? []).map((c) => this.toCard(c));
  }

  /**
   * Erkennt, über welche der 5 Partner-Commander-Mechaniken eine Karte verfügt (reines Parsen von
   * oracleText/typeLine, keine zusätzliche Netzwerkanfrage nötig) - Grundlage für searchCommanderPairs().
   * Reihenfolge/Erkennung nach Recherche gegen Scryfalls Suchsyntax:
   * - "Partner" (bare) pairt mit jedem anderen bare-Partner - MUSS von "Partner with X" und
   *   "Partner—Designator" unterschieden werden (beide enthalten ebenfalls das Wort "Partner").
   * - "Partner with X" pairt NUR mit der explizit genannten Karte X.
   * - "Partner—Designator" (z.B. "Partner—Survivors") pairt nur mit Karten mit demselben Designator.
   * - "Friends forever" pairt mit jeder anderen Friends-forever-Karte.
   * - "Choose a Background" pairt mit jeder Karte vom Typ "Background".
   * - "Doctor's companion" pairt mit jeder Karte vom Kreaturtyp "Time Lord Doctor".
   */
  private partnerProfile(card: ScryfallCard): PartnerProfile {
    const text = card.oracleText ?? '';
    const lines = text.split('\n').map((l) => l.trim());

    const partnerWithMatch = text.match(/Partner with ([^(\n]+)/);
    const designatorMatch = text.match(/Partner—([^(\n]+)/);
    // Bewusst NICHT auf exakte Gleichheit mit "Partner" prüfen: Scryfalls oracle_text hängt bei
    // Keyword-Fähigkeiten oft den Reminder-Text in Klammern an dieselbe Zeile an (z.B.
    // "Partner (You can have two commanders if both have partner.)"). Das Pattern lässt genau
    // diesen optionalen Klammerzusatz zu, schließt aber "Partner with X"/"Partner—X" aus, weil dort
    // zwischen "Partner" und der Klammer noch anderer Text steht.
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
   * Ob eine Karte überhaupt einen ZWEITEN Commander neben sich erlaubt - beide Hälften einer
   * Paarung zählen, also auch die passive: ein Background selbst trägt kein Partner-Schlüsselwort,
   * gehört aber genauso zu einer "Choose a Background"-Paarung wie ein Time Lord Doctor zu einer
   * "Doctor's companion"-Paarung.
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
   * Sucht regelkonforme PAARE von Partner-Commandern (Partner, Partner with X, Friends forever,
   * Choose a Background, Doctor's companion), deren KOMBINIERTE Farbidentität exakt den Filtern
   * entspricht - Ergänzung zu searchCommanders() für Decks mit zwei Commandern. Ein Paar zählt als
   * Treffer, sobald MINDESTENS EINE Hälfte Name/Archetyp/Kreaturtyp erfüllt (nicht zwingend beide -
   * genau wie im echten Partner-Deckbau ergänzen sich beide Hälften, statt identisch zu sein).
   *
   * Bewusst nur aktiv, wenn mindestens eine Farbe gewählt ist: ohne Farbziel gäbe es keine sinnvolle
   * Grenze für "welche Farbkombination muss die Paarung exakt ergeben", und ein ungefiltertes
   * Durchpaaren aller ~230 Partner-fähigen Karten wäre kombinatorisch (zehntausende Paare) sinnlos.
   *
   * Backgrounds sind selbst NICHT is:commander-legal (keine "kann dein Commander sein"-Karte),
   * werden also über eine separate type:background-Abfrage geholt, sonst würden sie in der
   * Kandidatenliste fehlen und "Choose a Background"-Paarungen wären nie vollständig.
   */
  async searchCommanderPairs(colors: string[], filters?: CommanderFilters): Promise<[ScryfallCard, ScryfallCard][]> {
    if (colors.length === 0) return [];

    const colorClause = `id<=${colors.join('')}`;
    const matchingQuery = ['is:commander', 'is:partner', colorClause, ...this.buildCommanderFilterParts(filters)].join(' ');
    const fullQuery = ['is:commander', 'is:partner', colorClause].join(' ');
    const backgroundQuery = ['type:background', colorClause].join(' ');

    const [matchingPool, fullCreaturePool, backgroundPool] = await Promise.all([
      this.fetchCommanderList(matchingQuery),
      this.fetchCommanderList(fullQuery),
      this.fetchCommanderList(backgroundQuery),
    ]);

    const fullPool = [...fullCreaturePool, ...backgroundPool];
    const profiles = new Map(fullPool.map((c) => [c.name, this.partnerProfile(c)]));
    const targetColors = new Set(colors);

    const pairs: [ScryfallCard, ScryfallCard][] = [];
    const seen = new Set<string>();

    for (const a of matchingPool) {
      const profileA = profiles.get(a.name);
      if (!profileA) continue;

      for (const b of fullPool) {
        if (b.name === a.name) continue;
        const profileB = profiles.get(b.name)!;
        if (!this.partnersCompatible(a, profileA, b, profileB)) continue;

        const combined = new Set([...(a.colorIdentity ?? []), ...(b.colorIdentity ?? [])]);
        if (combined.size !== targetColors.size || [...combined].some((c) => !targetColors.has(c))) continue;

        const key = [a.name, b.name].sort().join('|');
        if (seen.has(key)) continue;
        seen.add(key);
        pairs.push([a, b]);
      }
    }

    return pairs;
  }

  // NEU
  // NEU
  /**
   * Prüft, welche der übergebenen Kartennamen zu einer otag:/keyword:-Abfrage passen, und meldet
   * zusätzlich, welche der übergebenen Namen überhaupt erfolgreich geprüft wurden ("checked") -
   * nötig für classifyCards(), das ein Nein-Ergebnis nur
   * dann dauerhaft cachen darf, wenn der jeweilige Chunk wirklich erfolgreich beantwortet wurde
   * (sonst würde ein an Scryfalls Rate-Limit gescheiterter Chunk fälschlich als "nicht getaggt"
   * gecacht - schlimmer als das ursprüngliche Problem, weil es sich nie mehr korrigiert).
   */
  private async filterNamesByQueryChecked(
    tagQuery: string,
    cardNames: string[]
  ): Promise<{ matched: Set<string>; checked: Set<string> }> {
    const matched = new Set<string>();
    const checked = new Set<string>();
    const unique = [...new Set(cardNames.map((n) => n.trim()).filter(Boolean))];

    // Chunks längenbasiert statt fester Anzahl bilden - eine feste Zahl (z.B. 30) reißt bei
    // Kategorien mit langer Tag-Abfrage (z.B. Konter mit 12 ODER-verknüpften Unter-Tags, ~450
    // Zeichen) Scryfalls (nicht dokumentiertes) Query-Längenlimit, was die komplette Anfrage mit
    // HTTP 400 scheitern lässt - beobachtet bei 30 Namen + Konter-Tag-Abfrage (1063 Zeichen).
    // MAX_QUERY_LEN liegt bewusst deutlich darunter. Mindestens 1 Name pro Chunk, auch falls schon
    // dieser eine Name allein (mit der Tag-Abfrage) das Limit reißen würde - sonst Endlosschleife.
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
      // NEU - Verifikationsrunde (siehe Plan): macht die exakte Scryfall-Anfrage in der Browser-Konsole
      // sichtbar, damit sie manuell (F12) nachvollzogen werden kann - wieder entfernen, sobald alle
      // 15 Effekt-Kategorien einzeln verifiziert sind.
      console.log(`[Effekt-Kategorie-Check] Anfrage: https://scryfall.com/search?q=${q}`);
      const res = await this.fetchWithRetry(`${API}/cards/search?q=${q}&unique=cards`);
      if (!res) {
        console.log('[Effekt-Kategorie-Check] Anfrage fehlgeschlagen (Rate-Limit?), wird beim nächsten Öffnen erneut versucht.');
        continue; // Chunk gescheitert - bleibt in "checked" ungelistet, wird beim nächsten Aufruf erneut versucht.
      }
      for (const name of chunk) checked.add(normalizeCardName(name));
      // Scryfall antwortet bei null Treffern mit HTTP 404 (kein Fehler, siehe fetchWithRetry()) -
      // gültiges "keine dieser Karten hat den Tag"-Ergebnis, muss trotzdem als geprüft gecacht werden,
      // sonst würden diese Karten bei jedem Öffnen erneut abgefragt, obwohl das Ergebnis feststeht.
      if (res.status === 404) {
        console.log('[Effekt-Kategorie-Check] Keine Treffer in diesem Chunk.');
        continue;
      }
      const data = await res.json();
      const chunkMatches = ((data.data as any[]) ?? []).map((card) => card.name as string);
      console.log(`[Effekt-Kategorie-Check] Treffer in diesem Chunk (${chunkMatches.length}):`, chunkMatches);
      for (const card of (data.data as any[]) ?? []) {
        // Scryfall liefert bei Doppelkarten den vollen "A // B"-Namen zurück, obwohl nur mit dem
        // Vorderseiten-Namen gesucht wurde (siehe classifyCards()) - ohne diesen Split würde
        // z.B. "Ashling, Rekindled // Ashling, Rimebound" hier nie mit dem in "checked" stehenden
        // reinen "ashling, rekindled" übereinstimmen und fälschlich als "nicht getaggt" gelten.
        matched.add(normalizeCardName((card.name as string).split(' // ')[0].trim()));
      }
    }
    return { matched, checked };
  }

  // Versionsnummer im Schlüssel MUSS hochgezählt werden, sobald sich eine der Kategorie-Abfragen in
  // EFFECT_TAG_CATEGORIES (deck-viewer.service.ts) inhaltlich ändert - sonst werden alte, gegen die
  // VORHERIGE Abfrage ermittelte Ergebnisse fälschlich weiterverwendet, obwohl sie zur neuen Abfrage
  // nicht mehr passen (z.B. wenn Ramp um zusätzliche Unter-Tags erweitert wird).
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

  // NEU
  /**
   * Wie filterNamesByQueryChecked(), aber mit dauerhaftem localStorage-Cache pro (Kategorie, Kartenname) -
   * Kartentags ändern sich praktisch nie, ein erneutes Abfragen bei jedem Deck-Öffnen ist daher
   * unnötig und war die Hauptursache für schwankende Ergebnisse beim wiederholten Testen (Scryfalls
   * Rate-Limit riss bei den vielen parallelen/wiederholten Anfragen). Nur wirklich neue, noch nie
   * klassifizierte Karten lösen überhaupt eine Netzanfrage aus.
   */
  async classifyCards(categoryKey: string, tagQuery: string, cardNames: string[]): Promise<Set<string>> {
    const cache = this.getTagCache();
    // Nur der Vorderseiten-Name - Scryfalls exakter Namens-Filter (!"...") lehnt Anfragen mit "//"
    // (voller Doppelkarten-Name, z.B. "Sink into Stupor // Soporific Springs") mit HTTP 400 ab, was
    // den GESAMTEN Chunk (bis zu 30 Karten) zum Scheitern brachte - nicht nur die Doppelkarte selbst.
    // Gleiches Vorgehen wie findCardsBulk()/cheapestPrices().
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

    // NEU - Verifikationsrunde (siehe Plan): zusammenfassender Log pro Kategorie in der Konsole.
    console.log(
      `[Effekt-Kategorie-Check] "${categoryKey}": ${unique.length} Karte(n) im Deck, ${uncached.length} davon noch nicht gecacht.`
    );

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

    console.log(`[Effekt-Kategorie-Check] "${categoryKey}" Endergebnis (${matched.size}):`, [...matched]);
    return matched;
  }

  // NEU
  /**
   * Alle Editionen/Artworks einer Karte, neueste zuerst - für die Artwork-Auswahl im
   * Bearbeiten-Modus. include:extras ist nötig, weil Scryfalls Suche Marken/Tokens standardmäßig
   * NICHT durchsucht (genau wie Pläne, Embleme, Art-Series-Karten, ...) - ohne dieses Flag liefert
   * die Suche für einen Markennamen (z.B. "Spirit") praktisch immer null Treffer.
   *
   * Bei Marken wird bevorzugt über oracleId gesucht statt über den Namen: viele VERSCHIEDENE
   * Marken teilen sich denselben schlichten Namen (z.B. gibt es rote, blaue und schwarze "Wizard"-
   * Marken mit komplett unterschiedlichen Werten/Fähigkeiten je nach erzeugender Karte) - eine
   * reine Namenssuche würde all diese Varianten wild durcheinanderwürfeln. oracleId identifiziert
   * dagegen genau EINE bestimmte Markenvariante über alle ihre Drucke hinweg. Nur wenn keine
   * oracleId bekannt ist (ältere, vor diesem Fix gescannte Marken), fällt die Suche auf
   * Name+t:token zurück - besser als gar nichts, kann aber bei mehrdeutigen Markennamen weiterhin
   * andere Varianten mit anzeigen.
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

  // NEU
  /**
   * Liefert für jeden übergebenen Kartennamen den EUR-Preis (Cardmarket, über Scryfall) der
   * GÜNSTIGSTEN Druckvariante - bewusst NICHT der Preis des aktuell im Deck ausgewählten Artworks
   * und keine grobe USD→EUR-Umrechnung, sondern der echte, von Scryfall separat geführte
   * Cardmarket-Preis. `eur>0` blendet Drucke ohne ermittelbaren EUR-Preis aus, `unique:cards`
   * dedupliziert auf einen Eintrag pro Kartenname; da explizit nach `order:eur dir:asc` sortiert
   * wird, bleibt dabei jeweils die günstigste Druckvariante übrig (Karten ohne ermittelbaren Preis
   * fehlen einfach im Ergebnis). Gleiches Chunking-Muster wie filterNamesByQueryChecked() (Gruppen statt
   * einer Anfrage pro Karte, um bei größeren Decks nicht an Scryfalls Rate-Limit zu geraten).
   *
   * Schlüssel der zurückgegebenen Map ist die normalisierte VORDERSEITE des Kartennamens (also
   * "esika, god of the tree", nicht "esika, god of the tree // the prismatic bridge") - so, wie
   * auch gesucht wird und wie alle Aufrufer nachschlagen.
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
      // Geduldiger als der Standard (2 Versuche): Diese Abfrage ist seit der Umstellung auf den
      // eigenen Kartenbestand die EINZIGE, die beim Öffnen eines Decks noch zu Scryfall geht - sie
      // darf also ruhig warten, es hängt nichts anderes dahinter. Scheitert ein Chunk trotzdem,
      // fehlen dessen Karten im Ergebnis und die Summe wäre STILL zu niedrig; genau das ist
      // passiert (277 € statt 388 € an einem echten Deck). Deshalb wird der Ausfall gemeldet,
      // statt ihn zu verschlucken.
      //
      // Ein Warten nach Scryfalls "Retry-After" ist hier bewusst NICHT möglich: Eine 429-Antwort
      // trägt selbst keine CORS-Header, der Browser blockt sie komplett, und JS sieht nur einen
      // generischen Fehler ohne Status und ohne Header (siehe fetchWithRetry()).
      const res = await this.fetchWithRetry(`${API}/cards/search?q=${q}`, 4);
      if (!res?.ok) {
        incomplete = true;
        continue;
      }
      const data = await res.json();
      for (const card of (data.data as any[]) ?? []) {
        // Schlüssel ist die VORDERSEITE, nicht der volle Scryfall-Name: Bei doppelseitigen,
        // Split-, Aftermath- und Abenteuer-Karten liefert Scryfall "Vorderseite // Rückseite",
        // während alle drei Aufrufer (Deck-Ansicht, Precon-Browser, öffentliche Decks) mit der
        // Vorderseite nachschlagen - genauso, wie oben auch gesucht wird. Vorher passte beides
        // nicht zusammen, jede solche Karte fiel STILL aus der Summe (über die 92 Commander-
        // Precons aus 2023-2026 waren das 234 statt 121 preislose Karten, rund 2 € je Deck).
        const name = normalizeCardName(frontFaceName(card.name as string));
        const price = parseFloat(card.prices?.eur);
        if (!prices.has(name) && !Number.isNaN(price)) prices.set(name, price);
      }
    }

    // incomplete meint AUSDRÜCKLICH nur "eine Anfrage ist gescheitert" - nicht "eine Karte hat
    // keinen Preis". Letzteres ist der Normalfall (eur>0 blendet preislose Drucke aus) und würde
    // die Kennzeichnung sonst praktisch immer auslösen und damit wertlos machen.
    return { prices, incomplete };
  }

  private toCard(data: any): ScryfallCard {
    const backFace = data.card_faces?.[1];
    // image_uris auf Face 2 fehlt bei Adventure/Split (die teilen sich ein Bild) - nur wenn es
    // eins hat, ist es eine "echte" umdrehbare Rückseite (Transform/Modal-DFC).
    const hasFlippableBack = !!backFace?.image_uris?.normal;
    return {
      name: data.name as string,
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
