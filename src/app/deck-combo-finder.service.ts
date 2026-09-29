import { Injectable, computed, inject, signal } from '@angular/core';
import { Deck } from './deck.service';
import { ScryfallCard } from './scryfall.service';
import { CardDataService } from './card-data.service';
import { comboSteps, fitsColorIdentity, groupSuggestions, parseManaCost } from './combo-finder';
import type { ComboFinderSuggestion, ComboFinderCombo } from './deck-viewer.service';
import { DeckViewerState } from './deck-viewer-state.service';
import { DeckAnalysisService } from './deck-analysis.service';

/** Combo-Finder: Karten, die dem Deck neue Combos bringen würden. */
@Injectable({ providedIn: 'root' })
export class DeckComboFinderService {
  private readonly cardData = inject(CardDataService);
  private readonly state = inject(DeckViewerState);
  private readonly analysis = inject(DeckAnalysisService);

  /**
   * Höchstens so viele Vorschläge: Ein Deck berührt so viele der ~108.500 Combos, dass der Rest
   * Rauschen ist. Die Gesamtzahl steht unter der Liste.
   */
  private static readonly COMBO_FINDER_MAX = 40;

  readonly comboFinderOpen = signal(false);
  readonly comboFinderBusy = signal(false);
  readonly comboFinderSuggestions = signal<ComboFinderSuggestion[]>([]);
  /** Wie viele passende Vorschläge es insgesamt gab - kann größer sein als die angezeigte Liste. */
  readonly comboFinderTotal = signal(0);
  /**
   * false = Combo-Daten fehlen noch (Migration/Nachtlauf) - getrennt von "nichts gefunden", damit
   * die Oberfläche den Grund nennt.
   */
  readonly comboFinderAvailable = signal(true);

  /**
   * Scryfall-Daten der Vorschläge. Eigenes Signal, weil viewingCardDetails nur echte Deckkarten
   * enthalten darf (Kurve, Pips, Bracket).
   */
  readonly comboFinderCardDetails = signal<Map<string, ScryfallCard>>(new Map());

  /** Die Combo, deren Ablauf gerade als Fenster offen ist - null heißt zu. */
  readonly comboFinderDetail = signal<ComboFinderCombo | null>(null);

  openComboFinderDetail(combo: ComboFinderCombo): void {
    this.comboFinderDetail.set(combo);
  }

  closeComboFinderDetail(): void {
    this.comboFinderDetail.set(null);
  }

  /** Einmal geladen, reicht für dieses Deck - zurückgesetzt in loadCardDetails(). */
  private comboFinderLoaded = false;

  /**
   * Erlaubte Farben der Vorschläge: Farbidentität des Commanders, sonst die Vereinigung aller
   * Deckkarten. null = unbekannt, Filter aus.
   */
  private readonly comboFinderColorIdentity = computed<string[] | null>(() => {
    const vomCommander = this.state.deckColorIdentitySubset();
    if (vomCommander) return vomCommander;

    const details = this.state.viewingCardDetails();
    if (details.size === 0) return null;

    const union = new Set<string>();
    for (const card of this.analysis.analysisDeckCards()) {
      for (const farbe of details.get(card.cardName.toLowerCase())?.colorIdentity ?? [])
        union.add(farbe);
    }
    return [...union];
  });

  /**
   * Öffnet den Combo-Finder und lädt beim ersten Mal nach - erst auf Klick, weil die Suche teuer
   * ist.
   */
  async openComboFinder(): Promise<void> {
    this.comboFinderOpen.set(true);
    if (this.comboFinderLoaded || this.comboFinderBusy()) return;

    const deck = this.state.viewingDeck();
    if (!deck) return;

    this.comboFinderBusy.set(true);
    // Ohne die Kartendetails fehlen Schlüssel und Farbidentität - der Klick kann kommen, bevor
    // loadCardDetails() im Hintergrund fertig ist.
    await this.state.ensureCardDetailsLoaded();

    const cards = this.analysis.bracketCards();
    if (cards.length === 0) {
      this.comboFinderBusy.set(false);
      return;
    }

    const { rows, available } = await this.cardData.combosMissingOneCard(
      cards.map((c) => c.name),
      cards.filter((c) => c.isCommander).map((c) => c.name),
    );
    const vorschlaege = groupSuggestions(rows);
    const details = await this.cardData.cardsByNormalizedNames(vorschlaege.map((v) => v.key));

    // Zwischenzeitlich ein anderes Deck geöffnet? Dann gehören diese Vorschläge nicht mehr hierher.
    if (this.state.viewingDeck()?.id !== deck.id) {
      this.comboFinderBusy.set(false);
      return;
    }

    const identity = this.comboFinderColorIdentity();
    // Karten ohne Eintrag im Kartenbestand fallen raus: ohne ihre Farbidentität lässt sich nicht
    // sagen, ob sie überhaupt ins Deck dürfen, und ohne Bild wäre der Vorschlag ein nackter Name.
    const passend = vorschlaege.filter((v) => {
      const card = details.get(v.key);
      return !!card && fitsColorIdentity(card.colorIdentity, identity);
    });

    this.comboFinderAvailable.set(available);
    this.comboFinderTotal.set(passend.length);

    const gezeigt = passend.slice(0, DeckComboFinderService.COMBO_FINDER_MAX);
    this.comboFinderCardDetails.set(
      new Map(
        gezeigt.map((v) => {
          const card = details.get(v.key) as ScryfallCard;
          return [card.name.toLowerCase(), card];
        }),
      ),
    );

    // Die Suche kennt nur normalisierte Namen; angezeigt werden sollen die Namen, die auch in der
    // Deckliste stehen.
    const anzeigename = new Map(cards.map((c) => [c.key, c.name]));
    this.comboFinderSuggestions.set(
      gezeigt.map((v) => ({
        key: v.key,
        cardName: (details.get(v.key) as ScryfallCard).name,
        comboCount: v.comboCount,
        combos: v.combos.map((c) => ({
          id: c.comboId,
          presentCardNames: c.present.map((key) => anzeigename.get(key) ?? key),
          produces: c.produces,
          steps: comboSteps(c.description),
          // Kein Rückfall auf manaValueNeeded: "3" als {3} hieße drei generische Mana, auch wenn
          // die Combo {1}{B}{B} braucht. Geprüft an 382 Combos: die Quelle liefert immer auch die
          // Schreibweise.
          extraMana: parseManaCost(c.manaNeeded ?? ''),
        })),
      })),
    );
    this.comboFinderLoaded = true;
    this.comboFinderBusy.set(false);
  }

  closeComboFinder(): void {
    this.comboFinderOpen.set(false);
    this.comboFinderDetail.set(null);
  }

  // --- Commander-Bracket (siehe src/app/bracket.ts) ---

  reset(): void {
    this.comboFinderLoaded = false;
    this.comboFinderOpen.set(false);
    this.comboFinderDetail.set(null);
    this.comboFinderSuggestions.set([]);
    this.comboFinderTotal.set(0);
    this.comboFinderAvailable.set(true);
    this.comboFinderCardDetails.set(new Map());
  }
}
