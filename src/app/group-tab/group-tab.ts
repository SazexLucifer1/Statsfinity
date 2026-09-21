import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { GroupService } from '../group.service';
import { MtgService } from '../mtg.service';
import { ProfileService } from '../profile.service';
import { DeckService } from '../deck.service';
import { NavigationService } from '../navigation.service';
import { PlayerAvatar } from '../player-avatar/player-avatar';
import { I18nService } from '../i18n.service';
import { DialogService } from '../dialog.service';
import { GAME_MODES, GameMode } from '../models';
import { GROUP_PERMISSION_CATEGORIES, GroupPermission, GroupRole } from '../group-permissions';
import { OverflowMenu } from '../ui/overflow-menu/overflow-menu';
import { Icon } from '../ui/icon/icon';

@Component({
  selector: 'app-group-tab',
  imports: [FormsModule, PlayerAvatar, OverflowMenu, Icon],
  templateUrl: './group-tab.html',
  styleUrl: './group-tab.scss',
})
export class GroupTab {
  readonly groupService = inject(GroupService);
  readonly mtg = inject(MtgService);
  private readonly profileService = inject(ProfileService);
  private readonly deckService = inject(DeckService);
  private readonly navigation = inject(NavigationService);
  readonly i18n = inject(I18nService);
  private readonly dialog = inject(DialogService);

  // --- Gruppen erstellen/wechseln ---

  readonly newGroupName = signal('');
  readonly creating = signal(false);
  readonly message = signal('');

  readonly showCreateGroupDialog = signal(false);

  openCreateGroupDialog(): void {
    this.newGroupName.set('');
    this.message.set('');
    this.showCreateGroupDialog.set(true);
  }

  closeCreateGroupDialog(): void {
    this.showCreateGroupDialog.set(false);
  }

  async createGroup(): Promise<void> {
    const name = this.newGroupName().trim();
    if (!name) return;

    this.creating.set(true);
    this.message.set('');

    const success = await this.groupService.createGroup(name);

    this.creating.set(false);
    if (success) {
      this.newGroupName.set('');
      this.showCreateGroupDialog.set(false);
    } else {
      this.message.set(this.i18n.t('group.msg.createFailed'));
    }
  }

  selectGroup(groupId: string): void {
    this.groupService.switchGroup(groupId);
  }

  // --- Gruppe verlassen (nur Mitglieder, Hosts nutzen "Gruppe löschen") ---

  readonly leavingGroupId = signal<string | null>(null);
  readonly leavingGroupName = signal('');
  readonly leaveGroupBusy = signal(false);
  readonly leaveGroupError = signal('');

  openLeaveGroupConfirm(groupId: string, groupName: string): void {
    this.leavingGroupId.set(groupId);
    this.leavingGroupName.set(groupName);
    this.leaveGroupError.set('');
  }

  closeLeaveGroupConfirm(): void {
    this.leavingGroupId.set(null);
    this.leaveGroupError.set('');
  }

  async confirmLeaveGroup(): Promise<void> {
    const groupId = this.leavingGroupId();
    if (!groupId) return;

    this.leaveGroupBusy.set(true);
    this.leaveGroupError.set('');

    const ok = await this.groupService.leaveGroup(groupId);

    this.leaveGroupBusy.set(false);

    if (ok) {
      this.closeLeaveGroupConfirm();
    } else {
      this.leaveGroupError.set(this.i18n.t('group.msg.leaveFailed'));
    }
  }

  // --- Gruppe umbenennen ---

  readonly renamingGroupId = signal<string | null>(null);
  readonly renameValue = signal('');

  startRenameGroup(groupId: string, currentName: string): void {
    this.renamingGroupId.set(groupId);
    this.renameValue.set(currentName);
  }

  cancelRenameGroup(): void {
    this.renamingGroupId.set(null);
  }

  async confirmRenameGroup(): Promise<void> {
    const groupId = this.renamingGroupId();
    if (!groupId) return;
    if (await this.groupService.renameGroup(groupId, this.renameValue())) {
      this.renamingGroupId.set(null);
    }
  }

  // --- Gruppe löschen ---

  readonly deletingGroupId = signal<string | null>(null);
  readonly deletingGroupName = signal('');
  readonly deleteConfirmText = signal('');

  openDeleteGroupConfirm(groupId: string, groupName: string): void {
    this.deletingGroupId.set(groupId);
    this.deletingGroupName.set(groupName);
    this.deleteConfirmText.set('');
  }

  closeDeleteGroupConfirm(): void {
    this.deletingGroupId.set(null);
    this.deleteConfirmText.set('');
  }

  updateDeleteConfirmText(value: string): void {
    this.deleteConfirmText.set(value);
  }

  readonly canConfirmDeleteGroup = computed(() => this.i18n.isDeleteConfirmed(this.deleteConfirmText()));

  async confirmDeleteGroup(): Promise<void> {
    if (!this.canConfirmDeleteGroup()) return;
    const groupId = this.deletingGroupId();
    if (!groupId) return;
    await this.groupService.deleteGroup(groupId);
    this.closeDeleteGroupConfirm();
  }

  // --- Einladungscode erstellen ---

  readonly invitingForGroupId = signal<string | null>(null);
  readonly generatedCode = signal<string | null>(null);
  readonly inviteBusy = signal(false);

  async openInvite(groupId: string): Promise<void> {
    this.invitingForGroupId.set(groupId);
    this.generatedCode.set(null);
    this.inviteBusy.set(true);

    const code = await this.groupService.createInvite(groupId);

    this.inviteBusy.set(false);
    this.generatedCode.set(code);
  }

  closeInvite(): void {
    this.invitingForGroupId.set(null);
    this.generatedCode.set(null);
  }

  // --- Mitgliederliste ---

  readonly viewingMembersForGroupId = signal<string | null>(null);
  readonly members = signal<
    { userId: string; displayName: string; role: string; avatarUrl: string | null; customRoleId: string | null }[]
  >([]);
  readonly membersBusy = signal(false);

  async openMembers(groupId: string): Promise<void> {
    this.viewingMembersForGroupId.set(groupId);
    this.membersBusy.set(true);
    // Rollen mitladen, damit roleName() (siehe Rollen-Verwaltung weiter unten) hier den
    // zugewiesenen Rollennamen statt nur "Member" anzeigen kann.
    const [members, roles] = await Promise.all([
      this.groupService.loadGroupMembers(groupId),
      this.groupService.loadGroupRoles(groupId),
    ]);
    this.members.set(members);
    this.groupRoles.set(roles);
    this.membersBusy.set(false);
  }

  closeMembers(): void {
    this.viewingMembersForGroupId.set(null);
    this.members.set([]);
  }

  // --- Einladungscode einlösen ---

  readonly joinCode = signal('');
  readonly joinBusy = signal(false);
  readonly joinMessage = signal('');
  readonly showJoinGroupDialog = signal(false);

  openJoinGroupDialog(): void {
    this.joinCode.set('');
    this.joinMessage.set('');
    this.showJoinGroupDialog.set(true);
  }

  closeJoinGroupDialog(): void {
    this.showJoinGroupDialog.set(false);
  }

  async submitJoinCode(): Promise<void> {
    this.joinBusy.set(true);
    this.joinMessage.set('');

    const result = await this.groupService.joinGroupByCode(this.joinCode());

    this.joinBusy.set(false);
    this.joinMessage.set(result.message);

    if (result.success) {
      this.joinCode.set('');
      this.showJoinGroupDialog.set(false);

      if (result.needsPlayerChoice && result.groupId) {
        this.playerChoiceGroupId.set(result.groupId);
        this.playerChoiceCandidates.set(result.candidates ?? []);
        this.playerChoiceSuggestedId.set(result.suggestedPlayerId ?? null);
        this.playerChoiceNewName.set(this.profileService.profile()?.displayName ?? '');
        this.showPlayerChoiceDialog.set(true);
      }
    }
  }

  // --- Nach dem Beitritt: mit bestehendem Spieler verknüpfen oder neuen anlegen ---

  readonly showPlayerChoiceDialog = signal(false);
  readonly playerChoiceGroupId = signal<string | null>(null);
  readonly playerChoiceCandidates = signal<{ id: string; displayName: string }[]>([]);
  readonly playerChoiceSuggestedId = signal<string | null>(null);
  readonly playerChoiceNewName = signal('');
  readonly playerChoiceBusy = signal(false);

  private finishPlayerChoiceDialog(): void {
    this.showPlayerChoiceDialog.set(false);
    this.playerChoiceGroupId.set(null);
    this.playerChoiceCandidates.set([]);
    this.playerChoiceSuggestedId.set(null);
    setTimeout(() => this.joinMessage.set(''), 2500);
  }

  async chooseExistingPlayer(playerId: string): Promise<void> {
    const groupId = this.playerChoiceGroupId();
    if (!groupId || this.playerChoiceBusy()) return;

    this.playerChoiceBusy.set(true);
    const ok = await this.groupService.finalizePlayerChoice(groupId, { linkToPlayerId: playerId });
    this.playerChoiceBusy.set(false);
    if (ok) this.finishPlayerChoiceDialog();
  }

  async chooseNewPlayer(): Promise<void> {
    const groupId = this.playerChoiceGroupId();
    if (!groupId || this.playerChoiceBusy()) return;

    this.playerChoiceBusy.set(true);
    const name =
      this.playerChoiceNewName().trim() ||
      this.profileService.profile()?.displayName ||
      this.i18n.t('group.defaultPlayerName');
    const ok = await this.groupService.finalizePlayerChoice(groupId, { createNewWithName: name });
    this.playerChoiceBusy.set(false);
    if (ok) this.finishPlayerChoiceDialog();
  }

  /** Overlay weggeklickt, ohne explizit zu wählen -> Fallback: wie bisher neuen Spieler mit Profilnamen anlegen. */
  dismissPlayerChoiceDialog(): void {
    this.chooseNewPlayer();
  }

  // --- Spielerverwaltung (Statistik-Identitäten der aktiven Gruppe) ---

  readonly newPlayerName = signal('');
  readonly editingPlayer = signal<string | null>(null);
  readonly editName = signal('');
  readonly playerErrorMessage = signal('');

  readonly gamesPerPlayer = computed(() => {
    const counts = new Map<string, number>();
    for (const match of this.mtg.history()) {
      if (match.countsInGeneralStats === false) continue;
      for (const p of match.players) {
        counts.set(p.name, (counts.get(p.name) ?? 0) + 1);
      }
    }
    return counts;
  });

  async addPlayer(): Promise<void> {
    this.playerErrorMessage.set('');
    const name = this.newPlayerName().trim();
    if (!name) return;
    if (!(await this.mtg.addPlayer(name))) {
      this.playerErrorMessage.set(this.i18n.t('group.msg.nameExists', { name }));
      return;
    }
    this.newPlayerName.set('');
  }

  startEditPlayer(name: string): void {
    this.playerErrorMessage.set('');
    this.editingPlayer.set(name);
    this.editName.set(name);
  }

  async confirmEditPlayer(): Promise<void> {
    const oldName = this.editingPlayer();
    if (!oldName) return;
    const newName = this.editName().trim();
    if (newName && newName !== oldName && !(await this.mtg.renamePlayer(oldName, newName))) {
      this.playerErrorMessage.set(this.i18n.t('group.msg.nameExists', { name: newName }));
      return;
    }
    this.editingPlayer.set(null);
  }

  cancelEditPlayer(): void {
    this.editingPlayer.set(null);
  }

  async deletePlayer(name: string): Promise<void> {
    const games = this.gamesPerPlayer().get(name) ?? 0;
    // Wegen der ON DELETE CASCADE auf decks.player_id löscht das Entfernen des Spielers automatisch
    // auch alle Decks, die ihm direkt gehören (siehe openNpcProfileView) - der Admin muss das vorher wissen.
    const playerId = this.mtg.playerIdFor(name);
    const deckCount = playerId
      ? (await this.deckService.loadDecksForOwner({ kind: 'player', playerId })).length
      : 0;

    let warning: string;
    if (games > 0 && deckCount > 0) {
      warning = this.i18n.t('group.msg.confirmDeletePlayerWithGamesAndDecks', { name, games, decks: deckCount });
    } else if (deckCount > 0) {
      warning = this.i18n.t('group.msg.confirmDeletePlayerWithDecks', { name, decks: deckCount });
    } else if (games > 0) {
      warning = this.i18n.t('group.msg.confirmDeletePlayerWithGames', { name, games });
    } else {
      warning = this.i18n.t('group.msg.confirmDeletePlayer', { name });
    }
    if (await this.dialog.confirm(warning)) {
      await this.mtg.deletePlayer(name);
    }
  }

  isPlayerLinked(name: string): boolean {
    return !!this.mtg.playerUserIds()[name];
  }

  // --- Spieler zusammenführen (Duplikate wie "Theo"/"Theos"/"Theodor" zu einem machen) ---

  readonly showMergeDialog = signal(false);
  readonly mergeSelected = signal<Set<string>>(new Set());
  readonly mergeTargetName = signal<string | null>(null);
  readonly mergeBusy = signal(false);
  readonly mergeMessage = signal('');

  openMergeDialog(): void {
    this.showMergeDialog.set(true);
    this.mergeSelected.set(new Set());
    this.mergeTargetName.set(null);
    this.mergeMessage.set('');
  }

  closeMergeDialog(): void {
    this.showMergeDialog.set(false);
  }

  toggleMergeSelected(name: string): void {
    this.mergeSelected.update((set) => {
      const next = new Set(set);
      if (next.has(name)) {
        next.delete(name);
        if (this.mergeTargetName() === name) this.mergeTargetName.set(null);
      } else {
        next.add(name);
      }
      return next;
    });
  }

  setMergeTarget(name: string): void {
    this.mergeTargetName.set(name);
  }

  readonly canConfirmMerge = computed(
    () => this.mergeSelected().size >= 2 && !!this.mergeTargetName()
  );

  async confirmMerge(): Promise<void> {
    const target = this.mergeTargetName();
    if (!target) return;
    const sources = [...this.mergeSelected()].filter((n) => n !== target);
    if (sources.length === 0) return;

    this.mergeBusy.set(true);
    this.mergeMessage.set('');

    const ok = await this.mtg.mergePlayers(target, sources);

    this.mergeBusy.set(false);

    if (ok) {
      this.closeMergeDialog();
    } else {
      this.mergeMessage.set(this.i18n.t('group.msg.mergeFailed'));
    }
  }

  // --- Commander-Namen für die ganze Gruppe reparieren (z.B. deutsch/englisch-Dopplungen) ---

  readonly showRepairInfoDialog = signal(false);
  readonly repairGroupBusy = signal(false);
  readonly repairGroupProgress = signal<{ done: number; total: number } | null>(null);
  readonly repairGroupMessage = signal('');

  openRepairInfoDialog(): void {
    this.repairGroupMessage.set('');
    this.showRepairInfoDialog.set(true);
  }

  closeRepairInfoDialog(): void {
    this.showRepairInfoDialog.set(false);
  }

  async repairGroupCommanderNames(): Promise<void> {
    const groupId = this.groupService.groupId();
    if (!groupId) return;

    this.repairGroupBusy.set(true);
    this.repairGroupMessage.set('');
    this.repairGroupProgress.set({ done: 0, total: 0 });

    const result = await this.deckService.repairCommanderNamesForGroup(groupId, (done, total) =>
      this.repairGroupProgress.set({ done, total })
    );

    await this.mtg.refreshHistory();

    this.repairGroupBusy.set(false);
    this.repairGroupProgress.set(null);
    this.repairGroupMessage.set(
      result.checked === 0
        ? this.i18n.t('group.msg.repairNothingToCheck')
        : this.i18n.t('group.msg.repairDone', { checked: result.checked, fixed: result.fixed })
    );
  }

  // --- Profil ansehen (nur lesend, springt in den Profil-Tab statt Popup) ---

  async openProfileView(userId: string): Promise<void> {
    this.navigation.goToTab('profile');
    await this.profileService.viewProfile(userId);
  }

  /** Wie openProfileView, aber für ein NPC-Profil (accountloser Spieler) - zeigt dort dieselbe
   * Profil-Tab-Struktur (Lieblingscommander, Decks, Statistiken), nur mit Bearbeiten-Möglichkeiten
   * für den Host statt einem separaten Verwaltungs-Dialog hier im Gruppen-Tab. */
  openNpcProfileView(playerName: string): void {
    const playerId = this.mtg.playerIdFor(playerName);
    if (!playerId) return;
    this.navigation.goToTab('profile');
    this.profileService.viewNpcProfile(playerId, playerName);
  }

  // --- Spieler nachträglich mit einem Mitglied-Account verknüpfen (nur Host) ---

  readonly linkingPlayerName = signal<string | null>(null);
  readonly linkCandidates = signal<{ userId: string; displayName: string }[]>([]);
  readonly linkBusy = signal(false);

  async openLinkDialog(playerName: string): Promise<void> {
    const groupId = this.groupService.groupId();
    if (!groupId) return;

    this.linkingPlayerName.set(playerName);
    this.linkBusy.set(true);

    const allMembers = await this.groupService.loadGroupMembers(groupId);
    const linkedUserIds = new Set(
      Object.values(this.mtg.playerUserIds()).filter((id): id is string => !!id)
    );
    this.linkCandidates.set(allMembers.filter((m) => !linkedUserIds.has(m.userId)));
    this.linkBusy.set(false);
  }

  closeLinkDialog(): void {
    this.linkingPlayerName.set(null);
    this.linkCandidates.set([]);
  }

  async linkPlayer(userId: string): Promise<void> {
    const name = this.linkingPlayerName();
    if (!name) return;
    await this.mtg.linkPlayerToUser(name, userId);
    this.closeLinkDialog();
  }

  // --- Stats-Zugriff pro Account (nur Host): wer darf im Stats-Tab welchen Modus sehen ---

  readonly visibilityModes = GAME_MODES;
  readonly showVisibilityDialog = signal(false);
  readonly linkedPlayersForVisibility = computed(() =>
    this.mtg.allPlayers().filter((name) => this.isPlayerLinked(name)),
  );

  /** Setzt die Sichtbarkeits-Matrix für ALLE verlinkten Spieler auf einmal (alle Modi gesperrt/frei) -
   * reiner Komfort-Button für den Massen-Fall (z.B. vor einer Jahresend-Enthüllung alles zumachen),
   * schreibt aber in dieselbe Matrix wie die einzelnen Chips darunter. Der Host kann direkt danach
   * einzelne Zellen wieder umschalten, ohne dass irgendein separates Flag das überschreibt.
   */
  async setVisibilityForAllPlayers(visible: boolean): Promise<void> {
    await Promise.all(
      this.linkedPlayersForVisibility().map((name) => this.mtg.setStatVisibilityForAllModes(name, visible))
    );
  }

  openVisibilityDialog(groupId: string): void {
    // Sichtbarkeit hängt an den Daten der AKTIVEN Gruppe (mtg.allPlayers()/statVisibility) -
    // falls der Button in einer anderen als der gerade aktiven Gruppe geklickt wird, erst
    // dorthin wechseln, damit der Dialog die richtigen Spieler zeigt.
    if (this.groupService.groupId() !== groupId) {
      this.selectGroup(groupId);
    }
    this.showVisibilityDialog.set(true);
  }

  closeVisibilityDialog(): void {
    this.showVisibilityDialog.set(false);
  }

  isStatVisible(name: string, mode: GameMode): boolean {
    return this.mtg.statVisibility().get(name)?.get(mode) ?? false;
  }

  async toggleVisibilityChip(name: string, mode: GameMode): Promise<void> {
    await this.mtg.setStatVisibility(name, mode, !this.isStatVisible(name, mode));
  }

  async setAllModesVisible(name: string, visible: boolean): Promise<void> {
    await this.mtg.setStatVisibilityForAllModes(name, visible);
  }

  // --- Qualifikationsschwellen pro Modus (nur Host): ab wann taucht wer in der Rangliste auf ---

  readonly showQualificationDialog = signal(false);
  /** Modus-Liste für den Dialog: die echten Modi plus die Aggregat-Ansicht "Alle Modi". */
  readonly qualificationDialogModes: readonly (GameMode | 'Alle')[] = ['Alle', ...GAME_MODES];

  openQualificationDialog(groupId: string): void {
    if (this.groupService.groupId() !== groupId) {
      this.selectGroup(groupId);
    }
    this.showQualificationDialog.set(true);
  }

  closeQualificationDialog(): void {
    this.showQualificationDialog.set(false);
  }

  /** Aktuell wirksame Mindestspielzahl für einen Modus - Host-Override falls gesetzt, sonst der App-Standard (10 bei "Alle", sonst 3). */
  qualificationValue(mode: GameMode | 'Alle'): number {
    return this.mtg.qualificationSettings().get(mode) ?? (mode === 'Alle' ? 10 : 3);
  }

  async updateQualificationValue(mode: GameMode | 'Alle', value: string): Promise<void> {
    const parsed = Math.max(0, Math.floor(Number(value)));
    if (!Number.isFinite(parsed)) return;
    await this.mtg.setQualificationThreshold(mode, parsed);
  }

  // --- Rollen-Verwaltung (nur Host): eigene benannte Rechte-Bündel definieren und einzelnen
  // Mitgliedern zuweisen - siehe GroupService.loadGroupRoles()/createRole()/updateRole()/
  // deleteRole()/assignRole(). Ersetzt die frühere Einzel-Rechte-Vergabe pro Mitglied. ---

  readonly permissionCategories = GROUP_PERMISSION_CATEGORIES;
  readonly showPermissionsDialog = signal(false);
  readonly permissionsGroupId = signal<string | null>(null);
  readonly permissionsMembers = signal<{ userId: string; displayName: string; role: string; customRoleId: string | null }[]>([]);
  readonly permissionsBusy = signal(false);
  readonly groupRoles = signal<GroupRole[]>([]);

  /** null = neue Rolle wird angelegt, sonst ID der gerade bearbeiteten Rolle. */
  readonly showRoleEditor = signal(false);
  readonly editingRoleId = signal<string | null>(null);
  readonly roleNameDraft = signal('');
  readonly rolePermissionsDraft = signal<Set<GroupPermission>>(new Set());

  async openPermissionsDialog(groupId: string): Promise<void> {
    this.permissionsGroupId.set(groupId);
    this.permissionsBusy.set(true);
    const [members, roles] = await Promise.all([
      this.groupService.loadGroupMembers(groupId),
      this.groupService.loadGroupRoles(groupId),
    ]);
    // Der Owner selbst hat implizit immer alle Rechte (siehe hasPermission) - eine Zeile für ihn in
    // der Zuweisungsliste wäre irreführend (eine Rolle hätte keine Wirkung), deshalb ausgeblendet.
    this.permissionsMembers.set(members.filter((m) => m.role !== 'owner'));
    this.groupRoles.set(roles);
    this.permissionsBusy.set(false);
    this.showPermissionsDialog.set(true);
  }

  closePermissionsDialog(): void {
    this.showPermissionsDialog.set(false);
    this.permissionsGroupId.set(null);
    this.permissionsMembers.set([]);
    this.groupRoles.set([]);
    this.closeRoleEditor();
  }

  roleName(roleId: string | null): string {
    if (!roleId) return this.i18n.t('group.noRole');
    return this.groupRoles().find((r) => r.id === roleId)?.name ?? this.i18n.t('group.noRole');
  }

  openRoleEditor(role?: GroupRole): void {
    this.editingRoleId.set(role?.id ?? null);
    this.roleNameDraft.set(role?.name ?? '');
    this.rolePermissionsDraft.set(new Set(role?.permissions ?? []));
    this.showRoleEditor.set(true);
  }

  closeRoleEditor(): void {
    this.showRoleEditor.set(false);
    this.editingRoleId.set(null);
    this.roleNameDraft.set('');
    this.rolePermissionsDraft.set(new Set());
  }

  toggleDraftPermission(permission: GroupPermission): void {
    this.rolePermissionsDraft.update((set) => {
      const next = new Set(set);
      if (next.has(permission)) next.delete(permission);
      else next.add(permission);
      return next;
    });
  }

  async saveRole(): Promise<void> {
    const groupId = this.permissionsGroupId();
    const name = this.roleNameDraft().trim();
    if (!groupId || !name) return;

    const permissions = Array.from(this.rolePermissionsDraft());
    const editingId = this.editingRoleId();

    if (editingId) {
      const ok = await this.groupService.updateRole(editingId, { name, permissions });
      if (!ok) return;
      this.groupRoles.update((roles) => roles.map((r) => (r.id === editingId ? { ...r, name, permissions } : r)));
    } else {
      const created = await this.groupService.createRole(groupId, name, permissions);
      if (!created) return;
      this.groupRoles.update((roles) => [...roles, created]);
    }
    this.closeRoleEditor();
  }

  async deleteRole(role: GroupRole): Promise<void> {
    if (!(await this.dialog.confirm(this.i18n.t('group.deleteRoleConfirm', { name: role.name })))) return;

    const ok = await this.groupService.deleteRole(role.id);
    if (!ok) return;

    this.groupRoles.update((roles) => roles.filter((r) => r.id !== role.id));
    this.permissionsMembers.update((members) =>
      members.map((m) => (m.customRoleId === role.id ? { ...m, customRoleId: null } : m))
    );
  }

  async assignRoleToMember(userId: string, roleId: string): Promise<void> {
    const groupId = this.permissionsGroupId();
    if (!groupId) return;

    const resolvedRoleId = roleId || null;
    const permissions = resolvedRoleId ? this.groupRoles().find((r) => r.id === resolvedRoleId)?.permissions ?? [] : [];

    const ok = await this.groupService.assignRole(groupId, userId, resolvedRoleId, permissions);
    if (!ok) return;

    this.permissionsMembers.update((members) =>
      members.map((m) => (m.userId === userId ? { ...m, customRoleId: resolvedRoleId } : m))
    );
  }
}
