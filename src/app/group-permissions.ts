/**
 * Katalog aller einzeln vergebbaren Gruppen-Rechte (siehe group_member_permissions in
 * sql/group-member-permissions-2026-08-31.sql). Der Owner einer Gruppe hat implizit IMMER alle
 * Rechte (siehe GroupService.hasPermission) - dieser Katalog deckt nur die Aktionen ab, die bisher
 * exklusiv dem Owner vorbehalten waren und jetzt gezielt an einzelne Mitglieder freigeschaltet
 * werden können. Neue Owner-exklusive Aktionen bekommen hier einen neuen Eintrag.
 */
export type GroupPermission =
  | 'match.editResult'
  | 'match.editCommander'
  | 'match.editCube'
  | 'match.delete'
  | 'player.renameOthers'
  | 'player.delete'
  | 'player.merge'
  | 'player.link'
  | 'player.repairNamesGroupwide'
  | 'deck.editOthers'
  | 'stats.qualificationThreshold'
  | 'stats.visibility'
  | 'npc.favoriteCommanders'
  | 'group.rename'
  | 'group.delete'
  | 'tournament.manage'
  | 'group.resetAllData';

export interface GroupPermissionCategory {
  labelKey: string;
  permissions: GroupPermission[];
}

/** Gruppierung für die Rechte-Verwaltung im Gruppen-Tab (Mitglieder-Dialog) - rein UI-Anordnung. */
export const GROUP_PERMISSION_CATEGORIES: GroupPermissionCategory[] = [
  {
    labelKey: 'permission.category.match',
    permissions: ['match.editResult', 'match.editCommander', 'match.editCube', 'match.delete'],
  },
  {
    labelKey: 'permission.category.player',
    permissions: ['player.renameOthers', 'player.delete', 'player.merge', 'player.link', 'player.repairNamesGroupwide'],
  },
  {
    labelKey: 'permission.category.deckStats',
    permissions: ['deck.editOthers', 'stats.qualificationThreshold', 'stats.visibility', 'npc.favoriteCommanders'],
  },
  {
    labelKey: 'permission.category.group',
    permissions: ['group.rename', 'group.delete', 'tournament.manage'],
  },
  {
    labelKey: 'permission.category.danger',
    permissions: ['group.resetAllData'],
  },
];

/**
 * Vom Owner selbst definiertes, benanntes Bündel aus GroupPermission-Werten (group_roles) - wird
 * einzelnen Mitgliedern zugewiesen (group_members.custom_role_id) und ersetzt die frühere
 * Einzel-Rechte-Vergabe pro Mitglied (siehe GroupService.loadGroupRoles/createRole/assignRole).
 */
export interface GroupRole {
  id: string;
  groupId: string;
  name: string;
  permissions: GroupPermission[];
}
