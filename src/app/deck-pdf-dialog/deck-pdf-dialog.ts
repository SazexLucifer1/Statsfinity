import { Component, computed, inject } from '@angular/core';
import { CardThumb } from '../ui/card-thumb/card-thumb';
import { FormsModule } from '@angular/forms';
import { DeckPdfService, PdfCardEntry, hatExemplarArtworks } from '../deck-pdf.service';
import { Icon } from '../ui/icon/icon';

@Component({
  selector: 'app-deck-pdf-dialog',
  imports: [FormsModule, Icon, CardThumb],
  templateUrl: './deck-pdf-dialog.html',
  styleUrl: './deck-pdf-dialog.scss',
})
export class DeckPdfDialog {
  readonly pdfService = inject(DeckPdfService);
  readonly hatExemplarArtworks = hatExemplarArtworks;
  /** Karte, deren Artworks je Exemplar gerade bearbeitet werden - ersetzt solange die Kartenliste. */
  readonly expandedEntry = computed(() => {
    const name = this.pdfService.expandedCard();
    return name ? (this.pdfService.entries().find((e) => e.cardName === name) ?? null) : null;
  });

  copyIndices(entry: PdfCardEntry): number[] {
    return entry.copyArtworks.map((_, i) => i);
  }

  hasCustom(entry: PdfCardEntry): boolean {
    return entry.copyArtworks.some((u) => !!u);
  }
}
