-- Eigene Commander nachträglich ändern (Bild und Farben), baut auf
-- sql/eigene-commander-2026-11-22.sql auf. Im Supabase-SQL-Editor ausführen; idempotent.
--
-- Anlass: Eine selbst gebaute Karte wurde nach ein paar Runden überarbeitet (neuer Text, neues
-- Bild). Das Bild in einem einzelnen Deck zu tauschen half nicht - für alle anderen blieb die
-- Karte die alte.
--
-- Ändern dürfen der Ersteller und Developer (Entscheidung des Users, 22.11.2026).
-- Der NAME bleibt fest: Partien und Statistiken hängen nur am Namen, ein umbenannter Commander
-- verlöre seine ganze Bilanz. Auch der Ersteller bleibt fest.
--
-- Ein neues Bild zieht in alle Decks nach, deren Commander-Zeile noch das ALTE Standardbild zeigt.
-- Ein in einem Deck von Hand gewähltes anderes Bild bleibt unangetastet.

drop policy if exists "Creators update their custom commanders" on public.custom_commanders;
create policy "Creators update their custom commanders"
on public.custom_commanders for update to authenticated
using (created_by = auth.uid() or public.is_developer(auth.uid()))
with check (created_by = auth.uid() or public.is_developer(auth.uid()));

create or replace function public.custom_commander_before_update()
returns trigger
language plpgsql
as $$
begin
  if new.name is distinct from old.name then
    raise exception 'Der Name eines eigenen Commanders kann nicht geändert werden';
  end if;
  if new.created_by is distinct from old.created_by then
    raise exception 'Der Ersteller eines eigenen Commanders kann nicht geändert werden';
  end if;
  return new;
end;
$$;

drop trigger if exists custom_commander_before_update on public.custom_commanders;
create trigger custom_commander_before_update
before update on public.custom_commanders
for each row execute function public.custom_commander_before_update();

-- SECURITY DEFINER: Die Decks gehören anderen Spielern, ihre RLS-Regeln ließen das Update sonst
-- nicht zu. Geändert wird ausschließlich das Bild dieses einen Kartennamens.
create or replace function public.custom_commander_after_update()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.image_url is distinct from old.image_url then
    update public.deck_cards
       set image_url = new.image_url
     where lower(btrim(card_name)) = lower(btrim(new.name))
       and image_url is not distinct from old.image_url;

    update public.decks
       set deleted_commander_image_url = new.image_url
     where lower(btrim(deleted_commander_name)) = lower(btrim(new.name))
       and deleted_commander_image_url is not distinct from old.image_url;
  end if;
  return new;
end;
$$;

drop trigger if exists custom_commander_after_update on public.custom_commanders;
create trigger custom_commander_after_update
after update on public.custom_commanders
for each row execute function public.custom_commander_after_update();
