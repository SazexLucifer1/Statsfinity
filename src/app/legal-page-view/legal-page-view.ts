import { Component, inject } from '@angular/core';
import { I18nService } from '../i18n.service';
import { LegalPageService } from '../legal-page.service';

@Component({
  selector: 'app-legal-page-view',
  imports: [],
  templateUrl: './legal-page-view.html',
  styleUrl: './legal-page-view.scss',
})
export class LegalPageView {
  readonly i18n = inject(I18nService);
  readonly legal = inject(LegalPageService);
}
