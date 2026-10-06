import { Injectable, signal, computed, effect, inject } from '@angular/core';
import { supabase } from './supabase.client';
import { AuthService } from './auth.service';
import { chunk } from './array-utils';
import { GroupPermission, GroupRole } from './group-permissions';

export interface MyGroup {
  id: string;
  name: string;
  role: string;
}

@Injectable({ providedIn: 'root' })
export class GroupService {
  private readonly auth = inject(AuthService);

  readonly groupId = signal<string | null>(null);
  readonly loading = signal<boolean>(true);

  readonly myGroups = signal<MyGroup[]>([]);

  /** Ob der eingeloggte User in der aktuell aktiven Gruppe die Host-Rolle ("owner") hat. */
  readonly isOwner = computed(
    () => this.myGroups().find((g) => g.id === this.groupId())?.role === 'owner'
  );

  /**
   * Spielt die Gruppe mit Elo-Rangsystem (groups.ranked_enabled, sql/ranked-gruppe-2026-09-30.sql)?
   * Eigene Abfrage statt Teil von loadMyGroups(): fehlt die Spalte noch, soll nur der Schalter
   * verschwinden, nicht die ganze Gruppenliste. Ohne Eintrag gilt "an" (der Standard).
   */
  private readonly rankedEnabledByGroup = signal<Map<string, boolean>>(new Map());
  /** false, solange die Migration fehlt - dann gibt es keinen Schalter, Ranked bleibt an. */
  readonly rankedSettingAvailable = signal(true);

  isRankedGroup(groupId: string | null): boolean {
    if (!groupId) return false;
    return this.rankedEnabledByGroup().get(groupId) ?? true;
  }

  /** Ranked in der aktuell aktiven Gruppe? */
  readonly rankedEnabled = computed(() => this.isRankedGroup(this.groupId()));

  /**
   * Wer die Wertung sehen darf: alle, solange das Rangsystem an ist - ist es aus, nur der
   * Gruppenleiter (Wunsch des Users, 06.10.2026: im Hintergrund weiterrechnen, nur nicht
   * zeigen). Gerechnet wird ohnehin immer, Partien werden weiter als Ranked gespeichert.
   */
  canSeeRanked(groupId: string | null): boolean {
    return !!groupId && (this.isRankedGroup(groupId) || this.isOwnerOf(groupId));
  }
  readonly canSeeRankedHere = computed(() => this.canSeeRanked(this.groupId()));

  /**
   * Start der laufenden Saison je Gruppe (groups.ranked_since, sql/ranked-saison-2026-10-06.sql):
   * nur Partien ab diesem Zeitpunkt zählen für die Elo. Fehlt die Spalte, zählt alles.
   */
  private readonly rankedSinceByGroup = signal<Map<string, string | null>>(new Map());
  readonly rankedSeasonAvailable = signal(true);

  rankedSince(groupId: string | null): string | null {
    return groupId ? (this.rankedSinceByGroup().get(groupId) ?? null) : null;
  }

  /** Partien der laufenden Saison dieser Gruppe - vor jeder Elo-Rechnung anwenden. */
  seasonMatches<T extends { date: string }>(matches: readonly T[], groupId: string | null): T[] {
    const since = this.rankedSince(groupId);
    if (!since) return [...matches];
    const start = new Date(since).getTime();
    return matches.filter((m) => new Date(m.date).getTime() >= start);
  }

  /** Name der aktuell aktiven Gruppe, oder null solange keine Gruppe aktiv ist (z.B. beim ersten
   * Laden) - fürs Gruppen-Tab, damit z.B. der "Spieler"-Abschnitt erkennbar zeigt, für welche
   * Gruppe er gerade gilt (relevant sobald jemand Mitglied in mehreren Gruppen ist). */
  readonly activeGroupName = computed(
    () => this.myGroups().find((g) => g.id === this.groupId())?.name ?? null
  );

  /**
   * Host-Check für eine beliebige (nicht zwangsläufig aktuell aktive) Gruppe - zusätzliche
   * Absicherung direkt in den Host-only-Methoden unten, nicht nur im Template. Ersetzt keine
   * serverseitige RLS-Prüfung, verhindert aber Fehlbedienung/Missbrauch über die Service-Methode
   * direkt (z.B. per Browser-Konsole).
   */
  private isOwnerOf(groupId: string): boolean {
    return this.myGroups().find((g) => g.id === groupId)?.role === 'owner';
  }

  /**
   * Einzeln vom Owner freigeschaltete Rechte je Gruppe (group_member_permissions) - keyed by
   * group_id, für ALLE Gruppen im Voraus geladen (gleiches Muster wie myGroups), damit ein
   * Gruppenwechsel (switchGroup) keinen zusätzlichen Netzwerk-Roundtrip braucht.
   */
  readonly myPermissions = signal<Map<string, Set<GroupPermission>>>(new Map());

  /**
   * Ob der eingeloggte User in der aktuell aktiven Gruppe die gegebene Aktion ausführen darf - der
   * Owner hat implizit IMMER alle Rechte, unabhängig davon, ob explizit eine Zeile in
   * group_member_permissions für ihn existiert. Rein clientseitige UI-Steuerung/Defense-in-Depth -
   * die eigentliche Durchsetzung passiert serverseitig über die has_group_permission()-Funktion in
   * den RLS-Policies (siehe sql/group-member-permissions-2026-08-31.sql).
   */
  hasPermission(permission: GroupPermission): boolean {
    const groupId = this.groupId();
    return !!groupId && this.hasPermissionFor(groupId, permission);
  }

  /**
   * Wie hasPermission(), aber für eine beliebige (nicht zwangsläufig aktuell aktive) Gruppe -
   * für renameGroup/deleteGroup UND für die Gruppenliste im Gruppen-Tab, die pro Zeile eine
   * potenziell andere (nicht aktive) Gruppe zeigt.
   */
  hasPermissionFor(groupId: string, permission: GroupPermission): boolean {
    if (this.isOwnerOf(groupId)) return true;
    return this.myPermissions().get(groupId)?.has(permission) ?? false;
  }

  constructor() {
    effect(() => {
      const user = this.auth.currentUser();
      if (user) {
        this.loadMyGroups(user.id);
      } else {
        this.groupId.set(null);
        this.myGroups.set([]);
        this.myPermissions.set(new Map());
        this.loading.set(false);
      }
    });
  }

  private async loadMyGroups(userId: string): Promise<void> {
    this.loading.set(true);

    const { data, error } = await supabase
      .from('group_members')
      .select('role, groups ( id, name ), custom_role_id, group_roles ( permissions )')
      .eq('user_id', userId);

    if (error) {
      console.error('Konnte Gruppen nicht laden:', error);
      this.myGroups.set([]);
      this.loading.set(false);
      return;
    }

    const groups: MyGroup[] = (data as any[])
      .filter((row) => row.groups)
      .map((row) => ({
        id: row.groups.id,
        name: row.groups.name,
        role: row.role,
      }));

    this.myGroups.set(groups);
    void this.loadRankedEnabled(groups.map((g) => g.id));

    // Die eigenen Rechte ergeben sich jetzt aus der zugewiesenen Rolle (group_roles.permissions)
    // statt aus einzeln vergebenen Rechten (siehe loadGroupRoles/createRole/assignRole) - der
    // Owner-Bypass in hasPermission()/hasPermissionFor() bleibt davon unberührt.
    const permissionMap = new Map<string, Set<GroupPermission>>();
    for (const row of data as any[]) {
      if (!row.groups) continue;
      const permissions: GroupPermission[] = row.group_roles?.permissions ?? [];
      if (permissions.length === 0) continue;
      permissionMap.set(row.groups.id, new Set(permissions));
    }
    this.myPermissions.set(permissionMap);

    const current = this.groupId();
    if (!current || !groups.some((g) => g.id === current)) {
      this.groupId.set(groups[0]?.id ?? null);
    }

    this.loading.set(false);
  }

  /** Alle in dieser Gruppe definierten Rollen - für die Rollen-Verwaltung im Gruppen-Tab (nur Owner). */
  async loadGroupRoles(groupId: string): Promise<GroupRole[]> {
    const { data, error } = await supabase
      .from('group_roles')
      .select('id, group_id, name, permissions')
      .eq('group_id', groupId)
      .order('name');

    if (error) {
      console.error('Konnte Rollen nicht laden:', error);
      return [];
    }

    return (data as any[]).map((row) => ({
      id: row.id,
      groupId: row.group_id,
      name: row.name,
      permissions: row.permissions ?? [],
    }));
  }

  /** Nur für den Owner: legt eine neue benannte Rolle mit den gegebenen Rechten an. */
  async createRole(groupId: string, name: string, permissions: GroupPermission[]): Promise<GroupRole | null> {
    if (!this.isOwnerOf(groupId)) return null;

    const { data, error } = await supabase
      .from('group_roles')
      .insert({ group_id: groupId, name, permissions, created_by: this.auth.currentUser()?.id ?? null })
      .select('id, group_id, name, permissions')
      .single();

    if (error || !data) {
      console.error('Konnte Rolle nicht anlegen:', error);
      return null;
    }

    return { id: data.id, groupId: data.group_id, name: data.name, permissions: data.permissions ?? [] };
  }

  /** Nur für den Owner: ändert Name und/oder Rechte einer bestehenden Rolle. */
  async updateRole(roleId: string, changes: { name?: string; permissions?: GroupPermission[] }): Promise<boolean> {
    const { error } = await supabase.from('group_roles').update(changes).eq('id', roleId);

    if (error) {
      console.error('Konnte Rolle nicht ändern:', error);
      return false;
    }
    return true;
  }

  /** Nur für den Owner: löscht eine Rolle - Mitglieder mit dieser Rolle fallen automatisch auf "keine Rolle" zurück. */
  async deleteRole(roleId: string): Promise<boolean> {
    const { error } = await supabase.from('group_roles').delete().eq('id', roleId);

    if (error) {
      console.error('Konnte Rolle nicht löschen:', error);
      return false;
    }
    return true;
  }

  /** Nur für den Owner: weist einem Mitglied eine Rolle zu (oder entzieht sie mit roleId = null). */
  async assignRole(groupId: string, userId: string, roleId: string | null, permissions: GroupPermission[]): Promise<boolean> {
    if (!this.isOwnerOf(groupId)) return false;

    const { error } = await supabase
      .from('group_members')
      .update({ custom_role_id: roleId })
      .eq('group_id', groupId)
      .eq('user_id', userId);

    if (error) {
      console.error('Konnte Rolle nicht zuweisen:', error);
      return false;
    }

    if (userId === this.auth.currentUser()?.id) {
      this.myPermissions.update((map) => {
        const next = new Map(map);
        if (permissions.length === 0) next.delete(groupId);
        else next.set(groupId, new Set(permissions));
        return next;
      });
    }
    return true;
  }

  switchGroup(groupId: string): void {
    if (this.myGroups().some((g) => g.id === groupId)) {
      this.groupId.set(groupId);
    }
  }

  async refresh(): Promise<void> {
    const user = this.auth.currentUser();
    if (user) {
      await this.loadMyGroups(user.id);
    }
  }

  /**
   * Lässt den eingeloggten User eine Gruppe verlassen, in der er NICHT Host ist (Hosts nutzen
   * stattdessen "Gruppe löschen" - sonst bliebe die Gruppe ohne Host zurück). Der eigene
   * players-Eintrag wird dabei nur entkoppelt (user_id = null), nicht gelöscht - so bleiben
   * Match-Historie/Statistik für die verbleibende Gruppe erhalten, genau wie beim Löschen eines
   * Spielers durch den Host. Tritt der User später erneut bei, kann er sich über die
   * Beitritts-Auswahl wieder mit demselben Spieler verknüpfen.
   */
  async leaveGroup(groupId: string): Promise<boolean> {
    const user = this.auth.currentUser();
    if (!user) return false;

    const { error: unlinkError } = await supabase
      .from('players')
      .update({ user_id: null })
      .eq('group_id', groupId)
      .eq('user_id', user.id);

    if (unlinkError) {
      console.error('Konnte eigenen Spieler nicht entkoppeln:', unlinkError);
      return false;
    }

    const { error: leaveError } = await supabase
      .from('group_members')
      .delete()
      .eq('group_id', groupId)
      .eq('user_id', user.id);

    if (leaveError) {
      console.error('Konnte Gruppe nicht verlassen:', leaveError);
      return false;
    }

    await this.refresh();
    return true;
  }

  async createGroup(name: string): Promise<boolean> {
    const trimmed = name.trim();
    if (!trimmed) return false;

    const user = this.auth.currentUser();
    if (!user) return false;

    // Vorher merken, welche Gruppen bekannt sind - daran wird die neue unten erkannt. Ein
    // .select() am insert waere naheliegender, laesst PostgREST die Zeile aber zurueckgeben,
    // und dafuer greift die SELECT-Policy auf groups, die in diesem Moment noch nicht erfuellt
    // ist: der Insert scheitert dann komplett mit 42501.
    const bekannt = new Set(this.myGroups().map((g) => g.id));

    const { error } = await supabase
      .from('groups')
      .insert({ name: trimmed, created_by: user.id });

    if (error) {
      console.error('Konnte Gruppe nicht erstellen:', error);
      return false;
    }

    await this.refresh();

    // Die Admin-Mitgliedschaft legt handle_new_group() serverseitig an, einen players-Eintrag
    // aber nicht. Ohne den taucht der Ersteller nicht unter "Wer spielt mit?" auf und kann in
    // seiner eigenen Gruppe kein Match eintragen - genauso wenig ein eigenes Deck waehlen, weil
    // die Deckauswahl am verknuepften Spieler haengt. Beim Beitritt ueber einen Einladungscode
    // passiert das laengst; hier hat es schlicht gefehlt.
    const neu = this.myGroups().find((g) => !bekannt.has(g.id));
    if (neu) {
      const { data: profile } = await supabase
        .from('profiles')
        .select('display_name')
        .eq('id', user.id)
        .single();

      if (profile?.display_name) {
        const { error: playerError } = await supabase
          .from('players')
          .insert({ group_id: neu.id, display_name: profile.display_name, user_id: user.id });

        if (playerError) {
          // Kein "return" - die Gruppe steht, das ist nur ein Zusatzschritt. Denselben Umgang
          // hat der Beitritts-Weg.
          console.error('Konnte Spieler-Eintrag nicht anlegen:', playerError);
        } else {
          await this.refresh();
        }
      }
    }

    return true;
  }

  /**
   * Liefert den (einen, dauerhaften) Einladungscode einer Gruppe - legt beim ersten Aufruf einen
   * an, bei jedem weiteren wird einfach derselbe zurückgegeben. Codes sind über alle Gruppen
   * hinweg eindeutig (DB-Constraint), bei einer sehr seltenen Kollision wird neu gewürfelt.
   */
  async createInvite(groupId: string): Promise<string | null> {
    const { data: existing, error: fetchError } = await supabase
      .from('group_invites')
      .select('code')
      .eq('group_id', groupId)
      .maybeSingle();

    if (fetchError) {
      console.error('Konnte bestehende Einladung nicht laden:', fetchError);
      return null;
    }
    if (existing) return existing.code;

    const user = this.auth.currentUser();
    if (!user) return null;

    for (let attempt = 0; attempt < 5; attempt++) {
      const code = this.generateCode();
      const { error } = await supabase
        .from('group_invites')
        .insert({ group_id: groupId, code, created_by: user.id });

      if (!error) return code;
      if (error.code !== '23505') {
        console.error('Konnte Einladung nicht erstellen:', error);
        return null;
      }
      // 23505 = unique_violation -> Code kollidiert mit einer anderen Gruppe, nochmal versuchen.
    }

    console.error('Konnte keinen eindeutigen Einladungscode finden.');
    return null;
  }

  private generateCode(): string {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 6; i++) {
      code += chars[Math.floor(Math.random() * chars.length)];
    }
    return code;
  }

  async joinGroupByCode(code: string): Promise<{
    success: boolean;
    message: string;
    needsPlayerChoice?: boolean;
    groupId?: string;
    candidates?: { id: string; displayName: string }[];
    suggestedPlayerId?: string | null;
  }> {
    const user = this.auth.currentUser();
    if (!user) return { success: false, message: 'Nicht angemeldet.' };

    const trimmedCode = code.trim().toUpperCase();
    if (!trimmedCode) return { success: false, message: 'Bitte einen Code eingeben.' };

    // Vorab-Prüfung nur für schnelle, spezifische Fehlermeldungen (UX) - die eigentliche,
    // sicherheitsrelevante Prüfung (gültiger Code, nicht abgelaufen, role fest 'member') passiert
    // unabhängig davon nochmal serverseitig in der join_group_by_code()-Funktion unten, ein reiner
    // Client-Insert in group_members ist seit dem RLS-Fix nicht mehr möglich.
    const { data: invite, error: inviteError } = await supabase
      .from('group_invites')
      .select('id, group_id, expires_at')
      .eq('code', trimmedCode)
      .single();

    if (inviteError || !invite) {
      return { success: false, message: 'Ungültiger Einladungscode.' };
    }

    if (invite.expires_at && new Date(invite.expires_at) < new Date()) {
      return { success: false, message: 'Dieser Einladungscode ist abgelaufen.' };
    }

    const alreadyMember = this.myGroups().some((g) => g.id === invite.group_id);
    if (alreadyMember) {
      return { success: false, message: 'Du bist bereits Mitglied dieser Gruppe.' };
    }

    const { data: joinResult, error: joinError } = await supabase.rpc('join_group_by_code', {
      p_code: trimmedCode,
    });

    if (joinError || !joinResult?.[0]?.group_id) {
      console.error('Konnte Gruppe nicht beitreten:', joinError);
      return { success: false, message: 'Beitritt fehlgeschlagen.' };
    }

    // players-Eintrag für diese Person anlegen bzw. verknüpfen.
    const { data: profile } = await supabase
      .from('profiles')
      .select('display_name')
      .eq('id', user.id)
      .single();

    // Alle noch account-losen Spieler dieser Gruppe (z.B. aus einem Excel-Import vor dem Beitritt) -
    // der Beitretende soll sich bewusst selbst zuordnen können, statt dass Namensabweichungen wie
    // "Theo" vs. "Theodor" stillschweigend zu einem doppelten Spieler-Eintrag führen.
    const { data: unlinkedPlayers } = await supabase
      .from('players')
      .select('id, display_name')
      .eq('group_id', invite.group_id)
      .is('user_id', null);

    await this.refresh();
    this.groupId.set(invite.group_id);

    if (profile?.display_name && unlinkedPlayers && unlinkedPlayers.length > 0) {
      const suggested = unlinkedPlayers.find(
        (p) => p.display_name.toLowerCase() === profile.display_name.toLowerCase()
      );
      return {
        success: true,
        message: 'Erfolgreich beigetreten!',
        needsPlayerChoice: true,
        groupId: invite.group_id,
        candidates: unlinkedPlayers.map((p) => ({ id: p.id, displayName: p.display_name })),
        suggestedPlayerId: suggested?.id ?? null,
      };
    }

    if (profile?.display_name) {
      const { error: playerError } = await supabase
        .from('players')
        .insert({ group_id: invite.group_id, display_name: profile.display_name, user_id: user.id });

      if (playerError) {
        console.error('Konnte Spieler-Eintrag nicht anlegen:', playerError);
        // Kein "return" hier - der Gruppenbeitritt selbst war erfolgreich, das ist nur ein Zusatzschritt.
      }
    }

    return { success: true, message: 'Erfolgreich beigetreten!' };
  }

  /**
   * Schließt die Spieler-Auswahl nach dem Beitritt ab: entweder mit einem bestehenden,
   * account-losen Spieler verknüpfen (dessen alte Stats übernehmen), oder einen neuen anlegen.
   */
  async finalizePlayerChoice(
    groupId: string,
    choice: { linkToPlayerId: string } | { createNewWithName: string }
  ): Promise<boolean> {
    const user = this.auth.currentUser();
    if (!user) return false;

    if ('linkToPlayerId' in choice) {
      const { error } = await supabase
        .from('players')
        .update({ user_id: user.id })
        .eq('id', choice.linkToPlayerId);

      if (error) {
        console.error('Konnte Spieler nicht verknüpfen:', error);
        return false;
      }
      return true;
    }

    const { error } = await supabase
      .from('players')
      .insert({ group_id: groupId, display_name: choice.createNewWithName, user_id: user.id });

    if (error) {
      console.error('Konnte Spieler-Eintrag nicht anlegen:', error);
      return false;
    }
    return true;
  }

  async loadGroupMembers(
    groupId: string
  ): Promise<{ userId: string; displayName: string; role: string; avatarUrl: string | null; customRoleId: string | null }[]> {
    const { data, error } = await supabase
      .from('group_members')
      .select('user_id, role, custom_role_id, profiles ( display_name, avatar_url )')
      .eq('group_id', groupId);

    if (error) {
      console.error('Konnte Mitglieder nicht laden:', error);
      return [];
    }

    return (data as any[]).map((row) => ({
      userId: row.user_id,
      displayName: row.profiles?.display_name ?? 'Unbekannt',
      role: row.role,
      avatarUrl: row.profiles?.avatar_url ?? null,
      customRoleId: row.custom_role_id ?? null,
    }));
  }


  private async loadRankedEnabled(groupIds: string[]): Promise<void> {
    if (groupIds.length === 0 || !this.rankedSettingAvailable()) return;
    const { data, error } = await supabase
      .from('groups')
      .select('id, ranked_enabled')
      .in('id', groupIds);
    if (error) {
      if (error.code === '42703') {
        console.warn('Spalte groups.ranked_enabled fehlt noch - sql/ranked-gruppe-2026-09-30.sql im Supabase-SQL-Editor ausführen.');
        this.rankedSettingAvailable.set(false);
      } else {
        console.error('Konnte Ranked-Einstellung nicht laden:', error);
      }
      return;
    }
    this.rankedEnabledByGroup.set(
      new Map((data ?? []).map((row: { id: string; ranked_enabled: boolean }) => [row.id, row.ranked_enabled !== false]))
    );
    void this.loadRankedSince(groupIds);
  }

  private async loadRankedSince(groupIds: string[]): Promise<void> {
    if (!this.rankedSeasonAvailable()) return;
    const { data, error } = await supabase.from('groups').select('id, ranked_since').in('id', groupIds);
    if (error) {
      if (error.code === '42703') {
        console.warn('Spalte groups.ranked_since fehlt noch - sql/ranked-saison-2026-10-06.sql im Supabase-SQL-Editor ausführen.');
        this.rankedSeasonAvailable.set(false);
      } else {
        console.error('Konnte Saisonstart nicht laden:', error);
      }
      return;
    }
    this.rankedSinceByGroup.set(
      new Map((data ?? []).map((row: { id: string; ranked_since: string | null }) => [row.id, row.ranked_since])),
    );
  }

  /** Neue Saison: ab jetzt zählen nur noch neue Partien - nur der Gruppenleiter. */
  async startNewRankedSeason(groupId: string): Promise<string | null> {
    if (!this.isOwnerOf(groupId)) return null;
    const now = new Date().toISOString();
    const { error } = await supabase.from('groups').update({ ranked_since: now }).eq('id', groupId);
    if (error) {
      console.error('Konnte Saison nicht neu starten:', error);
      return null;
    }
    this.rankedSinceByGroup.update((map) => new Map(map).set(groupId, now));
    return now;
  }

  /** Rangsystem der Gruppe an/aus - nur der Gruppenleiter (Host). */
  async setRankedEnabled(groupId: string, enabled: boolean): Promise<boolean> {
    if (!this.isOwnerOf(groupId)) return false;
    const { error } = await supabase.from('groups').update({ ranked_enabled: enabled }).eq('id', groupId);
    if (error) {
      console.error('Konnte Ranked-Einstellung nicht speichern:', error);
      return false;
    }
    this.rankedEnabledByGroup.update((map) => new Map(map).set(groupId, enabled));
    return true;
  }

  async renameGroup(groupId: string, name: string): Promise<boolean> {
    if (!this.hasPermissionFor(groupId, 'group.rename')) return false;

    const trimmed = name.trim();
    if (!trimmed) return false;

    const { error } = await supabase.from('groups').update({ name: trimmed }).eq('id', groupId);

    if (error) {
      console.error('Konnte Gruppe nicht umbenennen:', error);
      return false;
    }

    await this.refresh();
    return true;
  }

  /**
   * Löscht eine Gruppe unwiderruflich samt aller zugehörigen Daten. Löscht bewusst Tabelle für
   * Tabelle in Abhängigkeitsreihenfolge (statt auf DB-seitige Cascades zu vertrauen), analog zu
   * MtgService.resetAllData.
   */
  async deleteGroup(groupId: string): Promise<boolean> {
    if (!this.hasPermissionFor(groupId, 'group.delete')) return false;

    const { data: matchRows, error: matchesFetchError } = await supabase
      .from('matches')
      .select('id')
      .eq('group_id', groupId);

    if (matchesFetchError) {
      console.error('Löschen fehlgeschlagen (Matches laden):', matchesFetchError);
      return false;
    }

    const matchIds = (matchRows ?? []).map((m) => m.id);

    // In Päckchen löschen, sonst wird die Anfrage-URL bei vielen Matches zu lang ("Bad Request").
    for (const batch of chunk(matchIds, 150)) {
      const { error } = await supabase.from('match_players').delete().in('match_id', batch);
      if (error) {
        console.error('Löschen fehlgeschlagen (match_players):', error);
        return false;
      }
    }

    const tablesToClear = [
      'matches',
      'player_backgrounds',
      'player_stat_visibility',
      'players',
      'cubes',
      'group_invites',
      'group_members',
    ];

    for (const table of tablesToClear) {
      const { error } = await supabase.from(table).delete().eq('group_id', groupId);
      if (error) {
        console.error(`Löschen fehlgeschlagen (${table}):`, error);
        return false;
      }
    }

    const { error: groupError } = await supabase.from('groups').delete().eq('id', groupId);

    if (groupError) {
      console.error('Löschen fehlgeschlagen (groups):', groupError);
      return false;
    }

    await this.refresh();
    return true;
  }
}