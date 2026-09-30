import { Component, input } from '@angular/core';
import { Icon } from '../ui/icon/icon';

@Component({
  imports: [Icon],
  selector: 'app-player-avatar',
  templateUrl: './player-avatar.html',
  styleUrl: './player-avatar.scss',
})
export class PlayerAvatar {
  readonly url = input<string | null>(null);
  readonly large = input(false);
}
