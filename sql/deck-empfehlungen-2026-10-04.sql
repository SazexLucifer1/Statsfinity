-- Kartenempfehlungen aus den eigenen Decks: Was spielen andere Statsfinity-Decks mit demselben
-- Commander, das in diesem Deck fehlt?
-- Im Supabase-Dashboard unter "SQL Editor" ausführen. Idempotent.
--
-- Die rechtlich saubere Antwort auf EDHRECs Empfehlungen (siehe CLAUDE.md, EDHREC nur für
-- Alpha-Tester): Die Daten stammen ausschließlich aus Decks, die Statsfinity-Nutzer selbst
-- öffentlich gestellt haben.
--
-- SECURITY DEFINER, damit die Funktion über alle öffentlichen Decks zählen kann - herausgegeben
-- werden aber nur Kartennamen und Zahlen, nie Deck, Besitzer oder Name. Private Decks und
-- gelöschte Decks (Grabsteine) zählen nicht mit, das Vergleichsdeck selbst auch nicht.
-- Erst ab 3 Vergleichsdecks gibt es überhaupt Ergebnisse: bei einem einzigen anderen Deck wäre
-- "Empfehlung" nur dessen Kartenliste.
--
-- Fehlt die Migration, verschwindet der Abschnitt still (PGRST202/42883, siehe
-- deck-suggestions.service.ts).

create or replace function public.deck_card_suggestions(p_deck_id uuid, p_limit integer default 20)
returns table (card_name text, deck_count integer, total_decks integer)
language sql
stable
security definer
set search_path = public
as $$
  with ziel as (
    select d.id, d.format
      from public.decks d
     where d.id = p_deck_id
  ),
  commander as (
    -- Commander des Zieldecks, normalisiert und sortiert (Partner zählen als Paar)
    select string_agg(lower(btrim(c.card_name)), '|' order by lower(btrim(c.card_name))) as schluessel
      from public.deck_cards c
     where c.deck_id = p_deck_id
       and c.is_commander
  ),
  vergleich as (
    select d.id
      from public.decks d
      join ziel z on z.format is not distinct from d.format
      join public.deck_cards c on c.deck_id = d.id and c.is_commander
     where d.id <> p_deck_id
       and not coalesce(d.is_private, false)
       and d.deleted_at is null
     group by d.id
    having string_agg(lower(btrim(c.card_name)), '|' order by lower(btrim(c.card_name)))
           = (select schluessel from commander)
  ),
  anzahl as (
    select count(*)::integer as n from vergleich
  ),
  vorhanden as (
    select distinct lower(btrim(c.card_name)) as name
      from public.deck_cards c
     where c.deck_id = p_deck_id
  )
  select min(c.card_name) as card_name,
         count(distinct c.deck_id)::integer as deck_count,
         (select n from anzahl) as total_decks
    from public.deck_cards c
    join vergleich v on v.id = c.deck_id
   where not coalesce(c.is_maybeboard, false)
     and not coalesce(c.is_token, false)
     and not c.is_commander
     and coalesce(c.type_line, '') not like 'Basic%'
     and lower(btrim(c.card_name)) not in (select name from vorhanden)
     and (select n from anzahl) >= 3
   group by lower(btrim(c.card_name))
   order by count(distinct c.deck_id) desc, min(c.card_name)
   limit greatest(1, least(coalesce(p_limit, 20), 50));
$$;

-- Nur über deck_card_suggestions_checked() aufrufbar (Funktionen sind in Postgres sonst für
-- PUBLIC ausführbar).
revoke execute on function public.deck_card_suggestions(uuid, integer) from public, anon, authenticated;

-- Wer das Zieldeck selbst nicht sehen darf, soll auch nichts darüber erfahren: Die Funktion
-- verrät zwar nur Karten ANDERER Decks, aber ob ein privates Deck einen bestimmten Commander hat,
-- ließe sich sonst erraten. Deshalb prüft die App-Seite das Deck ohnehin nur in Ansichten, in
-- denen es schon geladen ist; zusätzlich hier: privates Zieldeck nur für den Besitzer.
create or replace function public.deck_card_suggestions_checked(p_deck_id uuid, p_limit integer default 20)
returns table (card_name text, deck_count integer, total_decks integer)
language sql
stable
security definer
set search_path = public
as $$
  select s.*
    from public.deck_card_suggestions(p_deck_id, p_limit) s
   where exists (
     select 1 from public.decks d
      where d.id = p_deck_id
        and (not coalesce(d.is_private, false) or d.user_id = auth.uid())
   );
$$;

grant execute on function public.deck_card_suggestions_checked(uuid, integer) to anon, authenticated;
