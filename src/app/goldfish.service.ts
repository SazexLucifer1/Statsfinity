import { Injectable, computed, inject, signal } from '@angular/core';
import { DeckService, Deck, DeckCard } from './deck.service';
import { ScryfallService } from './scryfall.service';
import { shuffle } from './array-utils';

export type GoldfishZone = 'library' | 'hand' | 'battlefield' | 'graveyard' | 'exile' | 'command';
export type BattlefieldRow = 'creature' | 'other' | 'land';

export interface GoldfishCardInstance {
  instanceId: string;
  cardName: string;
  imageUrl: string | null;
  typeLine: string | null;
  /** Rückseite bei echten Transform-/Modal-DFC-Karten (z.B. Sorcery // Land) - sonst beides null. */
  backImageUrl: string | null;
  backTypeLine: string | null;
  /** Welche Seite gerade gezeigt wird - bestimmt, welche Type-Line für Einsortierung/Wirken zählt. */
  showingBack: boolean;
  isCommander: boolean;
  zone: GoldfishZone;
  /** Nur in 'battlefield' relevant - wird bei jedem Zonenwechsel zurückgesetzt. */
  tapped: boolean;
  /** instanceId der Kreatur, an der diese Ausrüstung/Verzauberung "angelegt" ist - nur informell/visuell, keine Regel-Durchsetzung. */
  attachedTo: string | null;
}

const OPENING_HAND_SIZE = 7;

/** Sortier-Reihenfolge der mittleren "Rest"-Zeile - alles, was nicht Kreatur oder Land ist. */
const REST_TYPE_PRIORITY = ['Artifact', 'Enchantment', 'Planeswalker', 'Battle'];

/** Die aktuell gültige Type-Line - bei umgedrehten DFCs die der Rückseite, sonst die der Vorderseite. */
export function activeTypeLine(card: GoldfishCardInstance): string | null {
  return card.showingBack ? (card.backTypeLine ?? card.typeLine) : card.typeLine;
}

/** Ordnet eine Karte anhand ihrer Type-Line automatisch einer der 3 Spielfeld-Zeilen zu - unabhängig davon, wo sie hingezogen wurde. */
function classifyRow(typeLine: string | null): BattlefieldRow {
  const t = typeLine ?? '';
  if (t.includes('Land')) return 'land';
  if (t.includes('Creature')) return 'creature';
  return 'other';
}

function restTypePriority(typeLine: string | null): number {
  const t = typeLine ?? '';
  const idx = REST_TYPE_PRIORITY.findIndex((p) => t.includes(p));
  return idx === -1 ? REST_TYPE_PRIORITY.length : idx;
}

/** Instants/Sorceries sind keine Permanents - "ins Spiel legen" bedeutet für sie: wirken und direkt in den Friedhof. */
export function isEphemeralSpell(typeLine: string | null): boolean {
  const t = typeLine ?? '';
  return t.includes('Instant') || t.includes('Sorcery');
}

/** Ausrüstung/Verzauberung, die an eine Kreatur "angelegt" werden kann. */
export function isAttachable(typeLine: string | null): boolean {
  const t = typeLine ?? '';
  return t.includes('Equipment') || t.includes('Aura');
}

/**
 * Rein clientseitiger Solo-Deck-Simulator ("Goldfishing") - kein Bezug zu GameSessionService,
 * keine Supabase-Schreibaktionen, kein Einfluss auf Match-Historie/Statistiken. Zustand lebt nur
 * so lange wie das Overlay offen ist (siehe open()/close(), Muster wie DeckViewerService).
 */
@Injectable({ providedIn: 'root' })
export class GoldfishService {
  private readonly deckService = inject(DeckService);
  private readonly scryfall = inject(ScryfallService);

  readonly activeDeck = signal<Deck | null>(null);
  readonly busy = signal(false);
  readonly mulliganCount = signal(0);

  /** Einzige Quelle der Wahrheit - Zonen sind computed-Filter darüber (siehe unten). */
  readonly cards = signal<GoldfishCardInstance[]>([]);

  /** Instanz-ID, für die gerade das Verschiebe-Menü offen ist. */
  readonly moveMenuFor = signal<string | null>(null);
  /** Instanz-ID einer Ausrüstung/Verzauberung, für die gerade die Kreatur-Auswahl zum Anlegen offen ist. */
  readonly attachMenuFor = signal<string | null>(null);
  /** Welcher Stapel (Bibliothek/Friedhof/Exil) gerade als durchsuchbare Liste aufgeklappt ist. */
  readonly zoneListView = signal<GoldfishZone | null>(null);
  readonly zoneListSearch = signal('');
  /** Karte, die gerade groß in der Vorschau angezeigt wird (Lupe-Symbol auf jeder Kachel). */
  readonly previewCard = signal<GoldfishCardInstance | null>(null);

  readonly library = computed(() => this.cards().filter((c) => c.zone === 'library'));
  readonly hand = computed(() => this.cards().filter((c) => c.zone === 'hand'));
  readonly battlefield = computed(() => this.cards().filter((c) => c.zone === 'battlefield'));
  readonly graveyard = computed(() => this.cards().filter((c) => c.zone === 'graveyard'));
  readonly exile = computed(() => this.cards().filter((c) => c.zone === 'exile'));
  readonly command = computed(() => this.cards().filter((c) => c.zone === 'command'));
  readonly libraryEmpty = computed(() => this.library().length === 0);
  /** Länder auf der Hand - die erste Frage bei jeder Starthand ("behalten oder Mulligan?"). */
  readonly handLands = computed(() => this.hand().filter((c) => classifyRow(activeTypeLine(c)) === 'land').length);

  /** Die 3 automatisch sortierten Spielfeld-Zeilen - Zugehörigkeit ergibt sich immer aus der (aktuell gezeigten) Type-Line, nie aus der Ablageposition. */
  readonly battlefieldCreatures = computed(() => this.battlefield().filter((c) => classifyRow(activeTypeLine(c)) === 'creature'));
  readonly battlefieldLands = computed(() => this.battlefield().filter((c) => classifyRow(activeTypeLine(c)) === 'land'));
  readonly battlefieldOther = computed(() =>
    [...this.battlefield().filter((c) => classifyRow(activeTypeLine(c)) === 'other')].sort(
      (a, b) => restTypePriority(activeTypeLine(a)) - restTypePriority(activeTypeLine(b))
    )
  );

  readonly zoneListCards = computed(() => {
    const zone = this.zoneListView();
    if (!zone) return [];
    const all = this.cards().filter((c) => c.zone === zone);
    const q = this.zoneListSearch().trim().toLowerCase();
    return q ? all.filter((c) => c.cardName.toLowerCase().includes(q)) : all;
  });

  /** Kreaturen auf dem Spielfeld, an die man `excludeId` (Ausrüstung/Verzauberung) anlegen könnte. */
  attachTargets(excludeId: string): GoldfishCardInstance[] {
    return this.battlefieldCreatures().filter((c) => c.instanceId !== excludeId);
  }

  /** Anzahl der Ausrüstungen/Verzauberungen, die aktuell an dieser Kreatur hängen. */
  attachmentCount(creatureInstanceId: string): number {
    return this.cards().filter((c) => c.zone === 'battlefield' && c.attachedTo === creatureInstanceId).length;
  }

  async open(deck: Deck): Promise<void> {
    this.activeDeck.set(deck);
    this.busy.set(true);
    this.cards.set([]);
    this.mulliganCount.set(0);
    this.moveMenuFor.set(null);
    this.attachMenuFor.set(null);
    this.zoneListView.set(null);
    this.zoneListSearch.set('');
    this.previewCard.set(null);

    // Maybeboard-Karten (in engerer Auswahl, nicht wirklich Teil des Decks) und Marken (kein echtes,
    // ziehbares Kartenexemplar) dürfen nicht mitgezogen werden - loadDeckCards() liefert bewusst
    // ungefiltert alles zurück, jeder Aufrufer filtert selbst, was er braucht (siehe z.B.
    // deck-viewer.service.ts, das denselben Filter an mehreren Stellen nutzt).
    const deckCards = (await this.deckService.loadDeckCards(deck.id)).filter(
      (c) => !c.isMaybeboard && !c.isToken
    );
    // Nur für DFC-Rückseiten nötig (deck_cards speichert nur die Vorderseite) - läuft parallel zum
    // Rendern der Vorderseiten, blockt also nicht, bis die Starthand gezogen werden kann.
    const scryfallByName = await this.scryfall.findCardsBulk(deckCards.map((c) => c.cardName));
    const instances = this.buildInstances(deckCards, scryfallByName);
    const commanders = instances.filter((c) => c.isCommander).map((c) => ({ ...c, zone: 'command' as const }));
    const rest = shuffle(instances.filter((c) => !c.isCommander));

    this.cards.set([...commanders, ...rest]);
    this.busy.set(false);
    this.draw(OPENING_HAND_SIZE);
  }

  close(): void {
    this.activeDeck.set(null);
    this.busy.set(false);
    this.cards.set([]);
    this.mulliganCount.set(0);
    this.moveMenuFor.set(null);
    this.attachMenuFor.set(null);
    this.zoneListView.set(null);
    this.zoneListSearch.set('');
    this.previewCard.set(null);
  }

  private buildInstances(
    deckCards: DeckCard[],
    scryfallByName: Map<string, { backImageUrl?: string; backTypeLine?: string }>
  ): GoldfishCardInstance[] {
    const instances: GoldfishCardInstance[] = [];
    for (const card of deckCards) {
      const scryfallCard = scryfallByName.get(card.cardName.toLowerCase());
      for (let i = 0; i < card.quantity; i++) {
        instances.push({
          instanceId: crypto.randomUUID(),
          cardName: card.cardName,
          imageUrl: card.imageUrl,
          typeLine: card.typeLine,
          backImageUrl: scryfallCard?.backImageUrl ?? null,
          backTypeLine: scryfallCard?.backTypeLine ?? null,
          showingBack: false,
          isCommander: card.isCommander,
          zone: 'library',
          tapped: false,
          attachedTo: null,
        });
      }
    }
    return instances;
  }

  shuffleLibrary(): void {
    this.cards.update((all) => {
      const rest = all.filter((c) => c.zone !== 'library');
      const shuffled = shuffle(all.filter((c) => c.zone === 'library'));
      return [...rest, ...shuffled];
    });
  }

  /** Zieht so viele Karten wie verfügbar (0..n) - stiller No-Op bei leerer Bibliothek, kein Crash. */
  draw(n: number): void {
    if (n <= 0) return;
    this.cards.update((all) => {
      let remaining = n;
      return all.map((c) => {
        if (c.zone === 'library' && remaining > 0) {
          remaining--;
          return { ...c, zone: 'hand' as const, tapped: false };
        }
        return c;
      });
    });
  }

  /**
   * Generischer Zonenwechsel - keine Regel-Einschränkung, jede Karte darf in jede Zone, mit einer
   * Ausnahme: Instant/Sorcery aufs Spielfeld gelegt heißt "gewirkt" und landet direkt im Friedhof.
   * Verlässt eine Kreatur das Spielfeld, wird alles, was an ihr angelegt war, automatisch lose.
   */
  moveCard(instanceId: string, toZone: GoldfishZone): void {
    this.cards.update((all) => {
      const movingCard = all.find((c) => c.instanceId === instanceId);
      const leavingBattlefield = movingCard?.zone === 'battlefield' && toZone !== 'battlefield';
      return all.map((c) => {
        if (c.instanceId === instanceId) {
          const zone = toZone === 'battlefield' && isEphemeralSpell(activeTypeLine(c)) ? 'graveyard' : toZone;
          return { ...c, zone, tapped: false, attachedTo: null };
        }
        if (leavingBattlefield && c.attachedTo === instanceId) {
          return { ...c, attachedTo: null };
        }
        return c;
      });
    });
    this.closeMoveMenu();
  }

  toggleTapped(instanceId: string): void {
    this.cards.update((all) =>
      all.map((c) => (c.instanceId === instanceId && c.zone === 'battlefield' ? { ...c, tapped: !c.tapped } : c))
    );
  }

  untapAll(): void {
    this.cards.update((all) => all.map((c) => (c.zone === 'battlefield' ? { ...c, tapped: false } : c)));
  }

  /** Dreht eine Doppelkarte (Transform/Modal-DFC) auf ihre andere Seite - nur relevant, wenn sie eine echte Rückseite hat. */
  flip(instanceId: string): void {
    this.cards.update((all) =>
      all.map((c) => (c.instanceId === instanceId && c.backImageUrl ? { ...c, showingBack: !c.showingBack } : c))
    );
  }

  /** Alles außer der Kommandozone (Hand, Spielfeld, Friedhof, Exil) zurück in die Bibliothek, mischen, neue Starthand von 7. */
  private resetBoardAndDrawOpeningHand(): void {
    this.cards.update((all) =>
      all.map((c) => (c.zone === 'command' ? c : { ...c, zone: 'library' as const, tapped: false, attachedTo: null }))
    );
    this.shuffleLibrary();
    this.draw(OPENING_HAND_SIZE);
  }

  /** Entspricht exakt restart() - einziger Unterschied ist der hochgezählte Mulligan-Zähler statt eines Resets auf 0. */
  mulligan(): void {
    this.resetBoardAndDrawOpeningHand();
    this.mulliganCount.update((n) => n + 1);
  }

  /** Bewusst ohne Bestätigungsdialog (Kernloop des Features). */
  restart(): void {
    this.resetBoardAndDrawOpeningHand();
    this.mulliganCount.set(0);
  }

  openMoveMenu(instanceId: string): void {
    this.moveMenuFor.set(instanceId);
  }

  closeMoveMenu(): void {
    this.moveMenuFor.set(null);
  }

  openAttachMenu(instanceId: string): void {
    this.attachMenuFor.set(instanceId);
  }

  closeAttachMenu(): void {
    this.attachMenuFor.set(null);
  }

  attachTo(instanceId: string, targetCreatureId: string): void {
    this.cards.update((all) => all.map((c) => (c.instanceId === instanceId ? { ...c, attachedTo: targetCreatureId } : c)));
    this.closeAttachMenu();
  }

  detachFromCreature(instanceId: string): void {
    this.cards.update((all) => all.map((c) => (c.instanceId === instanceId ? { ...c, attachedTo: null } : c)));
  }

  openZoneList(zone: GoldfishZone): void {
    this.zoneListView.set(zone);
    this.zoneListSearch.set('');
  }

  closeZoneList(): void {
    this.zoneListView.set(null);
    this.zoneListSearch.set('');
  }

  openPreview(card: GoldfishCardInstance): void {
    this.previewCard.set(card);
  }

  closePreview(): void {
    this.previewCard.set(null);
  }
}
