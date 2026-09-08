import { Component, effect, inject } from '@angular/core';
import { CurrencyPipe, DatePipe, DecimalPipe, NgTemplateOutlet, PercentPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import {
  AnalysisCombo,
  ComboFinderCombo,
  ComboFinderSuggestion,
  DeckViewerService,
  DeckChangeGroup,
  GameChangerEntry,
} from '../deck-viewer.service';
import { BracketReason } from '../bracket';
import { DeckService, DeckCard, DeckOwner } from '../deck.service';
import { DeckImportService } from '../deck-import.service';
import { DeckPdfService } from '../deck-pdf.service';
import { EdhrecCardlist } from '../edhrec.service';
import { CardImage } from '../card-image/card-image';
import { BarChart } from '../ui/bar-chart/bar-chart';
import { OverflowMenu } from '../ui/overflow-menu/overflow-menu';
import { ColorFilter } from '../ui/color-filter/color-filter';
import { CmcFilter } from '../ui/cmc-filter/cmc-filter';
import { BracketBadge } from '../ui/bracket-badge/bracket-badge';
import { ManaSymbol } from '../ui/mana-symbol/mana-symbol';

@Component({
  selector: 'app-deck-detail-view',
  imports: [CurrencyPipe, DatePipe, DecimalPipe, NgTemplateOutlet, PercentPipe, FormsModule, CardImage, BarChart, OverflowMenu, ColorFilter, CmcFilter, BracketBadge, ManaSymbol],
  templateUrl: './deck-detail-view.html',
  styleUrls: ['./deck-detail-view.scss', './deck-detail-view.bracket.scss'],
})
export class DeckDetailView {
  readonly viewer = inject(DeckViewerService);

  private readonly deckService = inject(DeckService);
  private readonly importService = inject(DeckImportService);
  private readonly pdfService = inject(DeckPdfService);

  /**
   * Die beiden Karten einer Combo in der Form, die das Karten-Raster der Analyse erwartet - so
   * zeigt das Combo-Fenster dieselben anklickbaren Vorschaubilder wie die Abschnitte darüber.
   * Anzahl immer 1: eine Combo nennt jede Karte genau einmal, die Deck-Anzahl spielt hier keine
   * Rolle.
   */
  comboCardEntries(combo: AnalysisCombo): GameChangerEntry[] {
    return combo.cardNames.map((cardName) => ({ cardName, quantity: 1 }));
  }

  /**
   * Eine ganze Combo als eine Kartenreihe: erst die Karten, die schon im Deck liegen, ganz rechts
   * die fehlende. Genau diese letzte umrandet das Raster rot (Kontext "highlightName").
   *
   * Anzahl immer 1: eine Combo nennt jede Karte genau einmal, die Deck-Anzahl spielt hier keine
   * Rolle.
   */
  comboCardRow(suggestion: ComboFinderSuggestion, combo: ComboFinderCombo): GameChangerEntry[] {
    return [...combo.presentCardNames, suggestion.cardName].map((cardName) => ({
      cardName,
      quantity: 1,
    }));
  }

  /**
   * Die Karten eines Bracket-Befunds als Gruppen für den Bild-Streifen in der Begründung.
   *
   * Combo-Befunde nennen ihre Karten als Paar in einem einzigen Eintrag ("A + B", siehe
   * comboNamen() in bracket.ts) - würde man alle Namen flach auflösen, stünden bei mehreren Combos
   * lauter Einzelbilder nebeneinander und niemand sähe mehr, welche zwei zusammen die Combo
   * bilden. Jede Gruppe ist deshalb genau ein Befundeintrag: eine Karte oder ein Combo-Paar.
   */
  bracketReasonCardGroups(reason: BracketReason): string[][] {
    return reason.cards.map((entry) => entry.split(' + '));
  }

  /**
   * Öffnet den bestehenden Import-Dialog wieder (Copy-Paste einer kompletten Liste inkl.
   * Diff-Erkennung) - jetzt als Zusatzaktion direkt aus der Detailansicht statt über einen
   * eigenen Bearbeiten-Button in der Deckliste. Lädt das Deck nach dem Speichern frisch aus der DB
   * nach, da der Dialog dabei auch Name/Tag mitändern kann.
   */
  async reimportDecklist(): Promise<void> {
    const deck = this.viewer.viewingDeck();
    if (!deck || !this.viewer.canEditViewingDeck()) return;
    const owner: DeckOwner = deck.playerId
      ? { kind: 'player', playerId: deck.playerId }
      : { kind: 'user', userId: deck.userId! };
    await this.importService.openEditDeckDialog(owner, deck, async () => {
      const decks = await this.deckService.loadDecksForOwner(owner);
      const fresh = decks.find((d) => d.id === deck.id) ?? deck;
      await this.viewer.open(fresh);
    });
  }

  async openPdfExport(): Promise<void> {
    const deck = this.viewer.viewingDeck();
    if (!deck) return;
    // Ohne dieses Warten könnten die Scryfall-Zusatzdaten (u.a. Rückseiten-Bilder) noch nicht
    // geladen sein, wenn direkt nach dem Öffnen eines Decks exportiert wird - Rückseiten würden
    // dann im PDF fehlen, obwohl die Karte im Deck korrekt doppelseitig ist.
    await this.viewer.ensureCardDetailsLoaded();
    const orderedCards = this.viewer
      .groupedDeckCards()
      .filter((section) => section.label !== 'Maybeboard')
      .flatMap((section) => section.cards);
    this.pdfService.open(
      deck.name,
      orderedCards.map((c) => ({
        cardName: c.cardName,
        quantity: c.quantity,
        imageUrl: this.viewer.resolvedCardPrintImage(c),
        backImageUrl: this.viewer.resolvedCardBackPrintImage(c),
      }))
    );
  }

  /**
   * Druckt genau die Karten, die in EINER Bearbeitung (dem offenen Verlaufs-Reiter) ins Deck
   * gekommen sind - der Dateiname bekommt das Datum der Bearbeitung angehängt, damit sich mehrere
   * gedruckte Bögen desselben Decks auseinanderhalten lassen.
   */
  async printChangeGroup(group: DeckChangeGroup): Promise<void> {
    const deck = this.viewer.viewingDeck();
    if (!deck) return;
    const cards = await this.viewer.addedCardsForPrint(group);
    if (cards.length === 0) return;
    // ISO-Datum (2026-09-05) statt lokalem Format: DeckPdfService.generatePdf() wirft beim Bauen des
    // Dateinamens alles ausser Wortzeichen, Bindestrich, Klammern und Leerzeichen weg - aus "5.9.2026"
    // würde damit "592026".
    this.pdfService.open(`${deck.name} ${group.changedAt.slice(0, 10)}`, cards);
  }

  async onCustomArtworkSelected(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    await this.viewer.uploadCustomArtwork(file);
  }

  /** Summe der Kartenanzahl (nicht Anzahl unterschiedlicher Kartennamen) für den Zähler in der Abschnitts-Überschrift, z.B. "Land (12)" bei 7 Forest + 5 Island statt fälschlich nur 2 (Zeilenanzahl). */
  sectionCardCount(cards: DeckCard[]): number {
    return cards.reduce((sum, c) => sum + c.quantity, 0);
  }




  private readonly expandedEdhrecCategories = new Set<string>();

  constructor() {
    // Sobald sich die EDHREC-Vorschlagsliste ändert (Tag gewechselt, Commander gewechselt, erneutes
    // Bearbeiten nach dem Speichern, ...), für bereits aufgeklappte Kategorien die Bilder direkt neu
    // nachladen - sonst zeigen sie weiterhin nur die (jetzt zu den neuen Karten nicht mehr
    // passenden) alten Bilder oder gar keine, bis man von Hand ein-/wieder ausklappt.
    // loadEdhrecCategoryImages() lädt intern ohnehin nur Karten nach, die noch nicht im Cache sind.
    effect(() => {
      const lists = this.viewer.edhrecLists();
      if (!lists) return;
      for (const list of lists) {
        if (this.expandedEdhrecCategories.has(list.tag)) {
          this.viewer.loadEdhrecCategoryImages(
            list.tag,
            list.cards.map((c) => c.name)
          );
        }
      }
    });
  }

  isEdhrecCategoryExpanded(tag: string): boolean {
    return this.expandedEdhrecCategories.has(tag);
  }

  toggleEdhrecCategory(list: EdhrecCardlist): void {
    if (this.expandedEdhrecCategories.has(list.tag)) {
      this.expandedEdhrecCategories.delete(list.tag);
    } else {
      this.expandedEdhrecCategories.add(list.tag);
      this.viewer.loadEdhrecCategoryImages(
        list.tag,
        list.cards.map((c) => c.name)
      );
    }
  }
}
