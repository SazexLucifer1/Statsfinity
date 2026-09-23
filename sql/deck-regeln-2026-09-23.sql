-- Fakten für die Bauregeln eines Decks (Kartenzahl, Kopien) - Gegenstück zu deck_banned_cards()
-- aus sql/format-bannliste-2026-09-23.sql. Im Supabase-SQL-Editor ausfuehren. Idempotent.
--
-- Die Funktion URTEILT NICHT: Wie viele Karten ein Format verlangt und wie viele Kopien es
-- erlaubt, steht ausschliesslich in FORMAT_REGELN (src/app/deck-regeln.ts). Hier kommt nur heraus,
-- was der Client dafuer braucht - sonst stuenden die Grenzen zweimal und liefen auseinander.
--
-- Je Deck eine Zeile:
--   card_count  Karten im Hauptdeck (ohne Maybeboard und Marken, Commander zaehlt mit)
--   copies      jsonb-Liste der Karten, die MEHR ALS EINMAL im Deck liegen:
--               [{"name": "...", "qty": 3, "limit": null|7|9|-1}]
--               limit -1 = beliebig viele erlaubt (Standardland, "any number of cards named"),
--               7/9 = "up to seven/nine", null = es gilt die Grenze des Formats.
--               Dieselbe Erkennung steht in eigeneKopienGrenze() (deck-regeln.ts).
--
-- Wie deck_banned_cards() OHNE security definer: es gelten die RLS-Regeln von decks/deck_cards.
-- Kartennamen werden wie ueberall ueber den Namen vor " // " zusammengefasst (normalizeCardName()),
-- damit zwei Drucke derselben Karte als eine zaehlen.

create or replace function public.deck_rule_facts(p_deck_ids uuid[])
returns table (
  deck_id uuid,
  card_count integer,
  copies jsonb
)
language sql
stable
set search_path = public
as $$
  with karten as (
    select
      c.deck_id,
      lower(translate(btrim(split_part(c.card_name, ' // ', 1)), '’‘´`', '''''''''')) as schluessel,
      min(c.card_name) as name,
      sum(c.quantity)::integer as qty,
      bool_or(coalesce(c.type_line, '') like 'Basic%') as basic
    from public.deck_cards c
    where c.deck_id = any(p_deck_ids)
      and not coalesce(c.is_maybeboard, false)
      and not coalesce(c.is_token, false)
    group by c.deck_id, 2
  ),
  mehrfach as (
    select
      k.deck_id,
      k.name,
      k.qty,
      case
        when k.basic or bool_or(sc.type_line like 'Basic%')
          or bool_or(sc.oracle_text ilike '%a deck can have any number of cards named%') then -1
        when bool_or(sc.oracle_text ilike '%a deck can have up to seven cards named%') then 7
        when bool_or(sc.oracle_text ilike '%a deck can have up to nine cards named%') then 9
      end as grenze
    from karten k
    left join public.scryfall_cards sc on sc.front_name_normalized = k.schluessel
    where k.qty > 1
    group by k.deck_id, k.name, k.qty, k.basic
  )
  select
    d.id,
    coalesce((select sum(k.qty) from karten k where k.deck_id = d.id), 0)::integer,
    coalesce(
      (select jsonb_agg(jsonb_build_object('name', m.name, 'qty', m.qty, 'limit', m.grenze) order by m.name)
         from mehrfach m where m.deck_id = d.id),
      '[]'::jsonb
    )
  from public.decks d
  where d.id = any(p_deck_ids);
$$;

grant execute on function public.deck_rule_facts(uuid[]) to anon, authenticated;

notify pgrst, 'reload schema';
