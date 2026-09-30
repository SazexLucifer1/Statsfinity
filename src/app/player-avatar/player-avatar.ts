import { Component, computed, input } from '@angular/core';
import { Icon } from '../ui/icon/icon';
import { RankTier } from '../elo';
import { rankStyle } from '../ui/rank-badge/rank-badge';

@Component({
  imports: [Icon],
  selector: 'app-player-avatar',
  templateUrl: './player-avatar.html',
  styleUrl: './player-avatar.scss',
  host: { '[style]': 'rankVars()' },
})
export class PlayerAvatar {
  readonly url = input<string | null>(null);
  readonly large = input(false);
  /**
   * Elo-Rang des Spielers in der angezeigten Gruppe - färbt den Ring ums Profilbild wie im Profil
   * (Farben aus RANK_COLORS). null = kein Ring (Gruppe ohne Rangsystem oder noch ungewertet).
   */
  readonly tier = input<RankTier | null>(null);

  readonly rankVars = computed(() => rankStyle(this.tier()));
}
