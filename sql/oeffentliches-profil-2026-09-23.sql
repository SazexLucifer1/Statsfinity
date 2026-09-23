-- Öffentliches Profil: Name, Avatar und Lieblingscommander eines Accounts, auch für Besucher ohne
-- Login. Im Supabase-Dashboard unter "SQL Editor" ausführen. Idempotent.
--
-- Anlass: In der Deck-Suche steht unter jedem Deck "von <Profilname>", und ein Tipp darauf öffnet
-- das Profil (ProfileService.viewProfile()). Gelesen wurde das Profil bisher direkt aus
-- public.profiles - für "anon" ist die Tabelle aber gesperrt, ein nicht eingeloggter Besucher sah
-- nach dem Tipp nur "Profil konnte nicht geladen werden". public.profiles soll dafür nicht
-- geöffnet werden (dort stehen auch Sprache, Developer-Flag usw.), deshalb eine SECURITY-DEFINER-
-- Funktion, die genau die drei Felder herausgibt, die die Profil-Fremdansicht ohnehin zeigt -
-- gleiche Konvention wie deck_comments_for_deck() und deck_social_stats().
--
-- Die App liest weiterhin zuerst direkt aus profiles und fragt diese Funktion nur, wenn das
-- nichts liefert. Fehlt sie, bleibt es beim bisherigen Verhalten.

create or replace function public.public_profile(p_user_id uuid)
returns table (
  display_name text,
  avatar_url text,
  favorite_commanders text[]
)
language sql
stable
security definer
set search_path = public
as $$
  -- ::text/::text[]-Casts: public.profiles wird nicht von diesem Repo angelegt, die Spaltentypen
  -- stehen also nirgends hier (siehe deck_comments_for_deck()).
  select
    p.display_name::text,
    p.avatar_url::text,
    coalesce(p.favorite_commanders::text[], '{}')
  from public.profiles p
  where p.id = p_user_id;
$$;

grant execute on function public.public_profile(uuid) to anon, authenticated;

notify pgrst, 'reload schema';
