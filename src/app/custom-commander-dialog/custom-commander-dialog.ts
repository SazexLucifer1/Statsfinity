import { Component, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { CUSTOM_COMMANDER_COLORS, CustomCommanderService } from '../custom-commander.service';
import { I18nService } from '../i18n.service';
import { ManaSymbol } from '../ui/mana-symbol/mana-symbol';

/**
 * Dialog "Eigenen Commander anlegen": Name, Farbidentität und optional ein Bild der Karte. Zustand
 * und Speichern in CustomCommanderService; geöffnet aus der Commander-Suche im Match-Tab und im
 * Dialog "Leeres Deck anlegen".
 */
@Component({
  selector: 'app-custom-commander-dialog',
  imports: [FormsModule, ManaSymbol],
  templateUrl: './custom-commander-dialog.html',
  styleUrl: './custom-commander-dialog.scss',
})
export class CustomCommanderDialog {
  readonly service = inject(CustomCommanderService);
  readonly i18n = inject(I18nService);
  readonly colors = CUSTOM_COMMANDER_COLORS;

  onFile(event: Event): void {
    const input = event.target as HTMLInputElement;
    this.service.setFile(input.files?.[0] ?? null);
    input.value = '';
  }
}
