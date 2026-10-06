import { Component, inject, signal } from '@angular/core';
import { I18nService } from '../i18n.service';
import { ProfileService } from '../profile.service';

/**
 * Fragt nach dem Benutzernamen, solange das Profil noch den automatisch vergebenen Namen trägt
 * (Teil der E-Mail vor dem @, siehe ProfileService.needsUsername). Vorher musste man selbst darauf
 * kommen, den Namen im Profil zu ändern - und stand bis dahin als "max.mustermann87" in jeder
 * Rangliste.
 */
@Component({
  selector: 'app-username-prompt',
  templateUrl: './username-prompt.html',
  styleUrl: './username-prompt.scss',
})
export class UsernamePrompt {
  readonly i18n = inject(I18nService);
  readonly profiles = inject(ProfileService);

  readonly name = signal('');
  readonly busy = signal(false);
  readonly failed = signal(false);

  async save(): Promise<void> {
    const trimmed = this.name().trim();
    if (!trimmed) return;
    this.busy.set(true);
    this.failed.set(false);
    const ok = await this.profiles.updateDisplayName(trimmed);
    this.busy.set(false);
    if (!ok) {
      this.failed.set(true);
      return;
    }
    // Auch wer bewusst denselben Namen eintippt, wird nicht noch einmal gefragt.
    this.profiles.dismissUsernamePrompt();
  }
}
