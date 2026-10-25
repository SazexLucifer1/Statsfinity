import { Component, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DeckImportService } from '../deck-import.service';
import { CardThumb } from '../ui/card-thumb/card-thumb';

@Component({
  selector: 'app-deck-import-dialogs',
  imports: [FormsModule, CardThumb],
  templateUrl: './deck-import-dialogs.html',
  styleUrl: './deck-import-dialogs.scss',
})
export class DeckImportDialogs {
  readonly importService = inject(DeckImportService);
}
