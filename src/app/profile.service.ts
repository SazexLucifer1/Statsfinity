import { Injectable, effect, inject, signal } from '@angular/core';
import { supabase } from './supabase.client';
import { AuthService } from './auth.service';
import { ArtLang, istArtLang } from './art-languages';

export interface Profile {
  id: string;
  displayName: string;
  avatarUrl: string | null;
  favoriteCommanders: string[];
  language: 'de' | 'en';
  /**
   * Sprache der KARTENBILDER (Scryfall-Sprachcode, Standard 'en') - nicht die Oberflächensprache.
   * Undefined, solange sql/artwork-sprache-2026-09-22.sql noch nicht gelaufen ist; dann gilt nur
   * der Gerätewert aus dem localStorage (siehe art-language.service.ts).
   */
  artLanguage?: ArtLang;
  /** IDs der schon gesehenen/übersprungenen Einführungs-Touren (z.B. "intro", "match", "deckDetail", ...) - siehe tutorial.service.ts. */
  tutorialsSeen: string[];
  /** Developer-Flag (manuell in Supabase gesetzt, kein Selbstbedienungs-Feature) - nur für den/die
   * App-Betreiber:in gedacht. Schaltet neben der Feedback-Inbox (siehe feedback.service.ts) auch
   * per RLS einen Schreibzugriff auf FREMDE profiles-Zeilen frei (siehe sql/roles-permissions-*.sql)
   * - für Support/Debugging, nicht für normale Gruppen-Admins. */
  isDeveloper: boolean;
}

@Injectable({ providedIn: 'root' })
export class ProfileService {
  private readonly auth = inject(AuthService);

  readonly profile = signal<Profile | null>(null);
  readonly loading = signal<boolean>(true);

  /** Ist gesetzt, während im Profil-Tab statt des eigenen Profils das eines anderen Users
   * (nur lesend) angezeigt wird - z.B. nach "Profil ansehen" aus dem Gruppen-Tab. */
  readonly viewingUserId = signal<string | null>(null);
  readonly viewingProfile = signal<{
    displayName: string;
    avatarUrl: string | null;
    favoriteCommanders: string[];
  } | null>(null);
  readonly viewingBusy = signal(false);

  /** Ist gesetzt, während im Profil-Tab statt eines echten Accounts das "Profil" eines NPCs
   * (accountloser Spieler) angezeigt wird - siehe group-tab.ts openNpcProfileView(). Anders als
   * viewingUserId gibt es dafür keinen eigenen Ladevorgang: Name/Lieblingscommander kommen direkt
   * aus MtgService, das für die aktive Gruppe schon reaktiv geladen ist (siehe profile-tab.ts). */
  readonly viewingPlayerId = signal<string | null>(null);
  readonly viewingPlayerName = signal<string | null>(null);

  async viewProfile(userId: string): Promise<void> {
    this.viewingPlayerId.set(null);
    this.viewingPlayerName.set(null);
    this.viewingUserId.set(userId);
    this.viewingBusy.set(true);
    this.viewingProfile.set(await this.loadPublicProfile(userId));
    this.viewingBusy.set(false);
  }

  viewNpcProfile(playerId: string, playerName: string): void {
    this.viewingUserId.set(null);
    this.viewingProfile.set(null);
    this.viewingPlayerId.set(playerId);
    this.viewingPlayerName.set(playerName);
  }

  stopViewingProfile(): void {
    this.viewingUserId.set(null);
    this.viewingProfile.set(null);
    this.viewingPlayerId.set(null);
    this.viewingPlayerName.set(null);
  }

  /** Account-ID des zuletzt ERFOLGREICH geladenen Profils - verhindert unnötige Neuladungen. */
  private loadedUserId: string | null = null;
  /** Zähler gegen Race Conditions, siehe loadProfile(). */
  private loadSeq = 0;

  constructor() {
    effect(() => {
      const user = this.auth.currentUser();
      if (!user) {
        this.loadedUserId = null;
        this.profile.set(null);
        this.loading.set(false);
        return;
      }
      // Supabase feuert currentUser() während Session-Wiederherstellung/Token-Refresh mehrfach mit
      // einem NEUEN User-Objekt für denselben eingeloggten Account (INITIAL_SESSION,
      // TOKEN_REFRESHED, SIGNED_IN, ...) - ohne diese Prüfung würde jedes Mal unnötig neu geladen,
      // was das Race-Fenster in loadProfile() unnötig vergrößert.
      if (this.loadedUserId === user.id && this.profile() !== null) return;
      this.loadProfile(user.id);
    });
  }

  private async loadProfile(userId: string): Promise<void> {
    // Überlappende Aufrufe (siehe Kommentar im Effect oben) sind trotzdem möglich - ohne diese
    // Sequenznummer könnte eine spät ankommende Antwort einer ÄLTEREN Anfrage ein bereits
    // erfolgreich geladenes Profil mit einem Fehler überschreiben, obwohl inzwischen eine neuere
    // Anfrage läuft/schon fertig ist. Nur das Ergebnis der zuletzt gestarteten Anfrage zählt.
    const seq = ++this.loadSeq;
    this.loading.set(true);
    let { data, error } = await supabase
      .from('profiles')
      .select(ProfileService.profilSpalten())
      .eq('id', userId)
      .single();

    // Die Artwork-Spalte kommt aus sql/artwork-sprache-2026-09-22.sql, und dieses Skript läuft
    // NICHT automatisch mit dem Deployment. Stünde sie fest in der Select-Liste, würde PostgREST
    // bis dahin JEDES Profil-Laden mit "column does not exist" (42703) ablehnen - die App wäre für
    // alle unbenutzbar. Beim ersten 42703 wird sie deshalb für die Sitzung abgeschaltet und die
    // Abfrage ohne sie wiederholt (gleiche Mechanik wie bei den Bracket-Spalten in deck.service.ts).
    if (ProfileService.istFehlendeArtSpalte(error)) {
      ({ data, error } = await supabase
        .from('profiles')
        .select(ProfileService.profilSpalten())
        .eq('id', userId)
        .single());
    }

    if (seq !== this.loadSeq) return;

    if (error) {
      console.error('Konnte Profil nicht laden:', error);
      this.profile.set(null);
    } else {
      // Die Spaltenliste steht erst zur Laufzeit fest (siehe profilSpalten()), damit verliert
      // supabase-js die Typisierung der Zeile - deshalb der Cast auf einen schlichten Record.
      const zeile = data as unknown as Record<string, unknown>;
      this.profile.set({
        id: zeile['id'] as string,
        displayName: zeile['display_name'] as string,
        avatarUrl: (zeile['avatar_url'] as string | null) ?? null,
        favoriteCommanders: (zeile['favorite_commanders'] as string[] | null) ?? [],
        language: zeile['language'] === 'en' ? 'en' : 'de',
        artLanguage: istArtLang(zeile['art_language']) ? zeile['art_language'] : undefined,
        tutorialsSeen: (zeile['tutorials_seen'] as string[] | null) ?? [],
        isDeveloper: (zeile['is_developer'] as boolean | null) ?? false,
      });
      this.loadedUserId = userId;
    }
    this.loading.set(false);
  }

  /** In-App-Fallback für den Fehlerzustand im Profil-Tab, falls das Laden doch mal fehlschlägt (z.B. echter Netzwerkfehler) - erspart einen kompletten Seiten-Reload. */
  retryLoadProfile(): void {
    const user = this.auth.currentUser();
    if (user) this.loadProfile(user.id);
  }

  /** Siehe istFehlendeArtSpalte() - einmal je Sitzung umgelegt, nicht je Abfrage. */
  private static artSpalteVerfuegbar = true;

  private static readonly BASIS_SPALTEN =
    'id, display_name, avatar_url, favorite_commanders, language, tutorials_seen, is_developer';

  private static profilSpalten(): string {
    return ProfileService.artSpalteVerfuegbar
      ? `${ProfileService.BASIS_SPALTEN}, art_language`
      : ProfileService.BASIS_SPALTEN;
  }

  /**
   * true = der Fehler kam von der noch fehlenden Spalte art_language und der Aufrufer soll es
   * ohne sie erneut versuchen. Prüft die Meldung mit, damit nicht irgendein anderer 42703 die
   * Artwork-Sprache stillschweigend abschaltet.
   */
  private static istFehlendeArtSpalte(error: { code?: string; message?: string } | null): boolean {
    if (!error || !ProfileService.artSpalteVerfuegbar) return false;
    if (error.code !== '42703') return false;
    if (!(error.message ?? '').includes('art_language')) return false;
    console.warn(
      'Spalte art_language fehlt noch - sql/artwork-sprache-2026-09-22.sql im Supabase-SQL-Editor ausführen. Die Artwork-Sprache gilt solange nur auf diesem Gerät.'
    );
    ProfileService.artSpalteVerfuegbar = false;
    return true;
  }

  /**
   * Speichert die Artwork-Sprache am Account. Fehlt die Spalte noch, ist das KEIN Fehlerfall:
   * die Einstellung bleibt dann einfach im localStorage und gilt nur auf diesem Gerät.
   */
  async updateArtLanguage(artLanguage: ArtLang): Promise<boolean> {
    const current = this.profile();
    if (!current || !ProfileService.artSpalteVerfuegbar) return false;

    const { error } = await supabase
      .from('profiles')
      .update({ art_language: artLanguage })
      .eq('id', current.id);

    if (error) {
      if (!ProfileService.istFehlendeArtSpalte(error)) {
        console.error('Konnte Artwork-Sprache nicht speichern:', error);
      }
      return false;
    }

    this.profile.update((p) => (p ? { ...p, artLanguage } : p));
    return true;
  }

  /** Speichert die bevorzugte Sprache am Account, damit sie geräteübergreifend gilt. */
  async updateLanguage(language: 'de' | 'en'): Promise<boolean> {
    const current = this.profile();
    if (!current) return false;

    const { error } = await supabase
      .from('profiles')
      .update({ language })
      .eq('id', current.id);

    if (error) {
      console.error('Konnte Sprache nicht speichern:', error);
      return false;
    }

    this.profile.update((p) => (p ? { ...p, language } : p));
    return true;
  }

  /** Merkt sich, dass der Nutzer eine bestimmte Einführungs-Tour gesehen (oder übersprungen) hat - danach startet genau diese Tour nicht mehr automatisch, ist aber jederzeit über den Hilfe-Knopf im Profil erneut wählbar. */
  async markTutorialSeen(tutorialId: string): Promise<boolean> {
    const current = this.profile();
    if (!current) return false;
    if (current.tutorialsSeen.includes(tutorialId)) return true;

    const next = [...current.tutorialsSeen, tutorialId];
    const { error } = await supabase
      .from('profiles')
      .update({ tutorials_seen: next })
      .eq('id', current.id);

    if (error) {
      console.error('Konnte Tutorial-Status nicht speichern:', error);
      return false;
    }

    this.profile.update((p) => (p ? { ...p, tutorialsSeen: next } : p));
    return true;
  }

  /** Maximal 3 Lieblings-Commander. */
  async updateFavoriteCommanders(commanders: string[]): Promise<boolean> {
    const current = this.profile();
    if (!current) return false;

    const trimmed = commanders.slice(0, 3);

    const { error } = await supabase
      .from('profiles')
      .update({ favorite_commanders: trimmed })
      .eq('id', current.id);

    if (error) {
      console.error('Konnte Lieblings-Commander nicht speichern:', error);
      return false;
    }

    this.profile.update((p) => (p ? { ...p, favoriteCommanders: trimmed } : p));
    return true;
  }

  async updateDisplayName(newName: string): Promise<boolean> {
    const trimmed = newName.trim();
    if (!trimmed) return false;

    const current = this.profile();
    if (!current) return false;

    const { error } = await supabase
      .from('profiles')
      .update({ display_name: trimmed })
      .eq('id', current.id);

    if (error) {
      console.error('Konnte Namen nicht ändern:', error);
      return false;
    }

    this.profile.update((p) => (p ? { ...p, displayName: trimmed } : p));
    return true;
  }

  /** Lädt ein neues Profilbild in den "avatars"-Storage-Bucket hoch und verknüpft es mit dem Profil. */
  async uploadAvatar(file: File): Promise<boolean> {
    const current = this.profile();
    if (!current) return false;
    // Gleiches Limit wie bei uploadCustomCardArt()/uploadBackground() - hier zusätzlich zur
    // clientseitigen Prüfung in profile-tab.ts (onAvatarSelected), falls diese Methode künftig
    // von woanders aufgerufen wird.
    if (!file.type.startsWith('image/') || file.size > 10 * 1024 * 1024) return false;

    const ext = file.name.split('.').pop() ?? 'jpg';
    const path = `${current.id}/avatar.${ext}`;

    const { error: uploadError } = await supabase.storage
      .from('avatars')
      .upload(path, file, { upsert: true, contentType: file.type });

    if (uploadError) {
      console.error('Konnte Profilbild nicht hochladen:', uploadError);
      return false;
    }

    const { data } = supabase.storage.from('avatars').getPublicUrl(path);
    // Cache-Busting, sonst zeigt der Browser nach einem erneuten Upload das alte Bild aus dem Cache.
    const avatarUrl = `${data.publicUrl}?t=${Date.now()}`;

    const { error: updateError } = await supabase
      .from('profiles')
      .update({ avatar_url: avatarUrl })
      .eq('id', current.id);

    if (updateError) {
      console.error('Konnte Profilbild-URL nicht speichern:', updateError);
      return false;
    }

    this.profile.update((p) => (p ? { ...p, avatarUrl } : p));
    return true;
  }

  // NEU
  /**
   * Sammelt die eigenen Daten für den Selbstbedienungs-Export (Art. 20 DSGVO) und liefert sie als
   * einfaches JSON-Objekt - der Aufrufer bietet es zum Download an (siehe profile-tab.ts). Deckt
   * die Kern-Tabellen ab, bei denen die Zuordnung zum eigenen Account eindeutig ist: eigenes
   * Profil, eigene Spieler-Zeilen (players.user_id, gruppenübergreifend), selbst besessene Decks
   * (decks.user_id - Decks virtueller Spieler laufen bewusst NICHT mit, die gehören administrativ
   * zur Gruppe statt direkt zum Account), zugehörige Kartenlisten/Änderungshistorie,
   * Match-Teilnahmen inkl. der jeweiligen Match-Daten sowie Turnier-Teilnahmen. RLS sorgt ohnehin
   * dafür, dass jede Abfrage nur Zeilen liefert, auf die der eingeloggte Account Zugriff hat.
   */
  async exportMyData(): Promise<Record<string, unknown>> {
    const userId = this.auth.currentUser()?.id;
    if (!userId) return {};

    const [{ data: profileRow }, { data: playerRows }] = await Promise.all([
      supabase.from('profiles').select('*').eq('id', userId).maybeSingle(),
      supabase.from('players').select('*').eq('user_id', userId),
    ]);
    const playerIds = (playerRows ?? []).map((p: any) => p.id);

    const [{ data: ownedDecks }, { data: matchParticipations }, { data: tournamentParticipations }, { data: tournamentMatchParticipations }] =
      await Promise.all([
        supabase.from('decks').select('*').eq('user_id', userId),
        playerIds.length
          ? supabase.from('match_players').select('*, matches (*)').in('player_id', playerIds)
          : Promise.resolve({ data: [] as any[] }),
        playerIds.length
          ? supabase.from('tournament_participants').select('*').in('player_id', playerIds)
          : Promise.resolve({ data: [] as any[] }),
        playerIds.length
          ? supabase.from('tournament_match_players').select('*').in('player_id', playerIds)
          : Promise.resolve({ data: [] as any[] }),
      ]);
    const deckIds = (ownedDecks ?? []).map((d: any) => d.id);

    const [{ data: deckCards }, { data: deckChangeLog }] = await Promise.all([
      deckIds.length ? supabase.from('deck_cards').select('*').in('deck_id', deckIds) : Promise.resolve({ data: [] as any[] }),
      deckIds.length ? supabase.from('deck_change_log').select('*').in('deck_id', deckIds) : Promise.resolve({ data: [] as any[] }),
    ]);

    return {
      exportedAt: new Date().toISOString(),
      profile: profileRow,
      players: playerRows,
      decks: ownedDecks,
      deckCards,
      deckChangeLog,
      matchParticipations,
      tournamentParticipations,
      tournamentMatchParticipations,
    };
  }

  /** Lädt die öffentlich sichtbaren Profildaten eines beliebigen Users (nur lesend, keine Bearbeitung). */
  async loadPublicProfile(
    userId: string
  ): Promise<{ displayName: string; avatarUrl: string | null; favoriteCommanders: string[] } | null> {
    const { data, error } = await supabase
      .from('profiles')
      .select('display_name, avatar_url, favorite_commanders')
      .eq('id', userId)
      .single();

    if (error || !data) {
      console.error('Konnte Profil nicht laden:', error);
      return null;
    }

    return {
      displayName: data.display_name,
      avatarUrl: data.avatar_url,
      favoriteCommanders: data.favorite_commanders ?? [],
    };
  }
}