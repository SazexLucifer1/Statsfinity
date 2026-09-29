import { Component, inject, input } from '@angular/core';
import { I18nService } from '../i18n.service';
import { LoginOverlayService } from '../login-overlay.service';

/**
 * Ersetzt seit dem App-Umbau (App-Hülle immer sichtbar, auch abgemeldet) den Inhalt von Tabs, die
 * zwingend einen Account brauchen (Stats/Gruppe/Profil) - statt einer leeren/irreführenden Ansicht
 * ein klarer Hinweis mit direktem Weg zum Login-Overlay.
 */
@Component({
  selector: 'app-login-required',
  templateUrl: './login-required.html',
  styleUrl: './login-required.scss',
})
export class LoginRequired {
  readonly i18n = inject(I18nService);
  readonly overlay = inject(LoginOverlayService);

  /** Optionaler, kontextspezifischer Hinweistext - sonst ein generischer Fallback. */
  readonly message = input<string | undefined>(undefined);
}
