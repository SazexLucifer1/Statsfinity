import { Component, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DeckImportService } from '../deck-import.service';
import { CardThumb } from '../ui/card-thumb/card-thumb';
import { CustomCommanderService } from '../custom-commander.service';
import { AuthService } from '../auth.service';

@Component({
  selector: 'app-deck-import-dialogs',
  imports: [FormsModule, CardThumb],
  templateUrl: './deck-import-dialogs.html',
  styleUrl: './deck-import-dialogs.scss',
})
export class DeckImportDialogs {
  readonly importService = inject(DeckImportService);
  readonly customCommanders = inject(CustomCommanderService);
  private readonly auth = inject(AuthService);

  /** Selbst erstellter Commander, den Scryfall nicht kennt - angeboten, solange keiner gewählt ist. */
  canCreateCustom(): boolean {
    const q = this.importService.newDeckCommanderQuery().trim();
    if (q.length < 2 || this.importService.newDeckCommanderSelected()) return false;
    if (!this.customCommanders.available() || !this.auth.currentUser()) return false;
    return !this.importService.newDeckCommanderSuggestions().some((s) => s.toLowerCase() === q.toLowerCase());
  }

  createCustom(): void {
    this.customCommanders.openCreate(this.importService.newDeckCommanderQuery(), (name) =>
      void this.importService.selectNewDeckCommander(name),
    );
  }
}
