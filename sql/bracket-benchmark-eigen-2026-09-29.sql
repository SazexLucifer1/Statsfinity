-- Bracket-Benchmark an den eigenen Decks: Merkmale je Deck für die Developer-Liste im Profil.
-- Im Supabase-SQL-Editor ausführen. Idempotent.
--
-- WOZU: Vergleich mit docs/bracket-benchmark-archidekt-2026-09.md. Dort ist gemessen, wie gut
-- einzelne Merkmale (Game Changer, Tutoren, Combos, …) die Bracket-Stufen trennen - an fremden
-- Decks. Hier dieselben Merkmale an Statsfinity-Decks, deren Besitzer das Bracket SELBST gesetzt
-- hat (decks.bracket). bracket_auto zählt nicht: Die Automatik rechnet aus genau diesen Merkmalen,
-- eine Messung daran würde nur die eigene Regel bestätigen.
--
-- Die Funktion liefert nur Zahlen je Deck - keine Deck-IDs, Namen oder Besitzer. Die AUC rechnet
-- die App (src/app/bracket-benchmark.ts), mit derselben Methode wie im Benchmark-Dokument.
--
-- SECURITY DEFINER, weil auch private Decks mitzählen sollen - deshalb prüft sie selbst, dass nur
-- Developer sie aufrufen. Der Schlüssel der Kartennamen ist derselbe wie in normalizeCardName()
-- (array-utils.ts): Vorderseite, klein, typografische Apostrophe gerade.

create or replace function public.bracket_benchmark_merkmale()
returns table (
  bracket smallint,
  game_changer integer,
  tutoren integer,
  combos integer,
  laender integer,
  rampe integer,
  interaktion integer,
  mld integer,
  extrazuege integer,
  avg_cmc numeric
)
language plpgsql
stable
security definer
set search_path = public
as $$
#variable_conflict use_column
begin
  if not public.is_developer(auth.uid()) then
    raise exception 'nur für Developer' using errcode = '42501';
  end if;

  return query
  with deck as (
    select d.id, d.bracket
    from public.decks d
    where d.bracket between 1 and 5
      and d.deleted_at is null
      and coalesce(d.format, 'Commander') = 'Commander'
  ),
  karte as (
    select c.deck_id,
           c.quantity,
           c.is_commander,
           coalesce(c.type_line, '') as type_line,
           coalesce(c.cmc, 0) as cmc,
           translate(lower(split_part(c.card_name, ' // ', 1)), '’‘´`', '''''''''') as schluessel
    from public.deck_cards c
    join deck on deck.id = c.deck_id
    where not coalesce(c.is_maybeboard, false)
      and not coalesce(c.is_token, false)
  ),
  -- front_name_normalized ist nicht eindeutig (Playtest-Karten u. ä.) - je Name zusammenfassen,
  -- sonst zählt eine Karte doppelt.
  gc as (
    select s.front_name_normalized as schluessel, bool_or(s.game_changer) as ist_gc
    from public.scryfall_cards s
    where s.front_name_normalized in (select schluessel from karte)
    group by s.front_name_normalized
  ),
  effekt as (
    select e.front_name_normalized as schluessel,
           bool_or(e.category = 'ramp') as ist_rampe,
           bool_or(e.category in ('removal', 'counterspell', 'boardwipe')) as ist_interaktion
    from public.scryfall_card_effects e
    where e.front_name_normalized in (select schluessel from karte)
    group by e.front_name_normalized
  ),
  je_deck as (
    select k.deck_id,
      sum(k.quantity) filter (where gc.ist_gc)::integer as game_changer,
      sum(k.quantity) filter (where f.tutor)::integer as tutoren,
      sum(k.quantity) filter (where k.type_line ilike '%land%')::integer as laender,
      sum(k.quantity) filter (where ef.ist_rampe and k.type_line not ilike '%land%')::integer as rampe,
      sum(k.quantity) filter (where ef.ist_interaktion)::integer as interaktion,
      sum(k.quantity) filter (where f.mass_land_denial)::integer as mld,
      sum(k.quantity) filter (where f.extra_turn)::integer as extrazuege,
      round(sum(k.cmc * k.quantity) filter (where k.type_line not ilike '%land%')
            / nullif(sum(k.quantity) filter (where k.type_line not ilike '%land%'), 0), 2) as avg_cmc,
      array_agg(distinct k.schluessel) as namen,
      array_agg(distinct k.schluessel) filter (where k.is_commander) as commander
    from karte k
    left join gc on gc.schluessel = k.schluessel
    left join effekt ef on ef.schluessel = k.schluessel
    left join public.spellbook_card_flags f on f.name_normalized = k.schluessel
    group by k.deck_id
  )
  select deck.bracket,
         coalesce(j.game_changer, 0),
         coalesce(j.tutoren, 0),
         public.winning_combos_in_deck(j.namen, coalesce(j.commander, '{}'::text[])),
         coalesce(j.laender, 0),
         coalesce(j.rampe, 0),
         coalesce(j.interaktion, 0),
         coalesce(j.mld, 0),
         coalesce(j.extrazuege, 0),
         j.avg_cmc
  from deck
  join je_deck j on j.deck_id = deck.id;
end $$;

revoke execute on function public.bracket_benchmark_merkmale() from public, anon;
grant execute on function public.bracket_benchmark_merkmale() to authenticated;

-- ---------------------------------------------------------------------------------------------
-- Gespeicherte Stände: ein Knopf in der Developer-Liste legt den aktuellen Stand ab, damit sich
-- zeigen lässt, wie sich die Zahlen mit wachsender Deckzahl verändern. Eine Zeile je Stand, das
-- Ergebnis als jsonb (Anzahl je Stufe, AUC je Merkmal) - keine Zeile je Deck.
-- ---------------------------------------------------------------------------------------------
create table if not exists public.bracket_benchmark_staende (
  id uuid primary key default gen_random_uuid(),
  erstellt_at timestamptz not null default now(),
  erstellt_von uuid not null default auth.uid() references auth.users (id) on delete cascade,
  ergebnis jsonb not null
);

alter table public.bracket_benchmark_staende enable row level security;

drop policy if exists "Developer lesen Benchmark-Stände" on public.bracket_benchmark_staende;
create policy "Developer lesen Benchmark-Stände"
on public.bracket_benchmark_staende for select to authenticated
using (is_developer(auth.uid()));

drop policy if exists "Developer speichern Benchmark-Stände" on public.bracket_benchmark_staende;
create policy "Developer speichern Benchmark-Stände"
on public.bracket_benchmark_staende for insert to authenticated
with check (erstellt_von = auth.uid() and is_developer(auth.uid()));

drop policy if exists "Developer löschen Benchmark-Stände" on public.bracket_benchmark_staende;
create policy "Developer löschen Benchmark-Stände"
on public.bracket_benchmark_staende for delete to authenticated
using (is_developer(auth.uid()));

grant select, insert, delete on public.bracket_benchmark_staende to authenticated;
