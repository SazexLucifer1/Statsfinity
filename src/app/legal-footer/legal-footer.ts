import { Component, inject } from '@angular/core';
import { I18nService } from '../i18n.service';
import { LegalPageService } from '../legal-page.service';

@Component({
  selector: 'app-legal-footer',
  imports: [],
  templateUrl: './legal-footer.html',
  styleUrl: './legal-footer.scss',
})
export class LegalFooter {
  readonly i18n = inject(I18nService);
  readonly legal = inject(LegalPageService);
}
