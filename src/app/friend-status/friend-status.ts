import { Component, computed, effect, inject, input, signal } from '@angular/core';
import { I18nService } from '../i18n.service';
import { AuthService } from '../auth.service';
import { DialogService } from '../dialog.service';
import { FriendsService } from '../friends.service';
import { SplitBar, SplitSegment } from '../ui/split-bar/split-bar';

/**
 * Im fremden Profil: Freundschaft anfragen/annehmen/beenden und die Bilanz "Du gegen X" über
 * alle gemeinsamen Partien (alle Gruppen und Freundesspiele, sql/freunde-2026-10-04.sql).
 */
@Component({
  selector: 'app-friend-status',
  imports: [SplitBar],
  templateUrl: './friend-status.html',
  styleUrl: './friend-status.scss',
})
export class FriendStatus {
  readonly i18n = inject(I18nService);
  readonly auth = inject(AuthService);
  readonly friends = inject(FriendsService);
  private readonly dialog = inject(DialogService);

  readonly userId = input.required<string>();
  readonly name = input('');

  readonly status = computed(() => this.friends.statusWith(this.userId()));
  readonly isSelf = computed(() => this.auth.currentUser()?.id === this.userId());
  readonly busy = signal(false);
  readonly h2h = signal<{ games: number; myWins: number; theirWins: number } | null>(null);

  readonly segments = computed<SplitSegment[]>(() => {
    const h = this.h2h();
    if (!h) return [];
    return [
      { label: this.i18n.t('profile.friends.you'), value: h.myWins, color: 'var(--series-1)' },
      {
        label: this.i18n.t('profile.friends.others'),
        value: h.games - h.myWins - h.theirWins,
        color: 'var(--series-neutral)',
      },
      { label: this.name() || '?', value: h.theirWins, color: 'var(--series-2)' },
    ];
  });

  constructor() {
    effect(() => {
      const id = this.userId();
      this.h2h.set(null);
      if (!this.auth.currentUser() || this.isSelf()) return;
      this.friends.headToHead(id).then((h) => {
        if (this.userId() === id) this.h2h.set(h);
      });
    });
  }

  async act(): Promise<void> {
    this.busy.set(true);
    const id = this.userId();
    switch (this.status()) {
      case 'none':
        await this.friends.request(id);
        break;
      case 'incoming':
        await this.friends.accept(id);
        break;
      case 'outgoing':
        await this.friends.remove(id);
        break;
      case 'friends':
        if (
          await this.dialog.confirm(
            this.i18n.t('profile.friends.confirmRemove', { name: this.name() }),
          )
        ) {
          await this.friends.remove(id);
        }
        break;
    }
    this.busy.set(false);
  }

  actionLabel(): string {
    const keys = {
      none: 'profile.friends.add',
      incoming: 'profile.friends.accept',
      outgoing: 'profile.friends.withdraw',
      friends: 'profile.friends.unfriend',
    } as const;
    return this.i18n.t(keys[this.status()]);
  }
}
