-- Bracket-Benchmark aus Statsfinity-Decks - lernt aus Decks, deren Besitzer das Bracket selbst
-- gewaehlt haben. Im Supabase-SQL-Editor ausfuehren. Idempotent.
--
-- WOZU: Zwei Teile der automatischen Einstufung (src/app/bracket.ts) sind keine offiziellen
-- Regeln, sondern gemessene Werte - die Spannen des Tuning-Grads (Urteil C) und die
-- Tutorenschwelle von Urteil F ("spielbeendende Combo + mindestens N Tutoren = mindestens
-- Bracket 4"). Bisher standen sie fest im Code. Ab hier stehen sie in bracket_benchmark und werden
-- jede Nacht an den Decks nachgemessen, deren Bracket ein Mensch gewaehlt hat.
--
-- DIE 100ER-REGEL: Die Werte eines Brackets werden erst ueberschrieben, wenn mindestens 100 Decks
-- DIESES Brackets in der Stichprobe liegen. Darunter bleibt stehen, was vorher dort stand - zu
-- Beginn die Startwerte unten, die genau den bisherigen festen Werten im Code entsprechen. An der
-- Einstufung aendert diese Migration fuer sich genommen also nichts.
--
-- WAS NICHT GELERNT WIRD: die offiziellen Kriterien (Game Changer, Mass Land Denial,
-- Extra-Turn-Schleifen, Combos). Die kommen aus dem Regelwerk und bleiben fest in bracket.ts.
--
-- DATENSCHUTZ: Die Stichprobe umfasst auch private Decks (Entscheidung des Users, 29.09.2026).
-- Gespeichert werden je Deck nur fuenf Zahlen, keine Karten und keine Namen, und die Tabelle
-- bracket_benchmark_decks ist fuer niemanden lesbar (RLS an, keine Policy). Lesbar ist nur das
-- Ergebnis je Bracket (Mediane und Deckzahl).
--
-- AUSGELOEST: am Ende des naechtlichen Spellbook-Abgleichs (scripts/sync-spellbook-bracket.js),
-- nach dem Auffrischen von spellbook_winning_combos - die Combo-Zahl je Deck rechnet also gegen
-- den frischen Stand. Von Hand: select public.bracket_benchmark_aktualisieren();
--
-- SETZT VORAUS: scryfall_cards, spellbook_card_flags, winning_combos_in_deck() samt
-- spellbook_winning_combos, decks.bracket und decks.deleted_at.

-- =====================================================================================
-- 1. Die Stichprobe: je Deck mit selbst gewaehltem Bracket eine Zeile Kennzahlen.
--
--    Jede Nacht komplett neu gemessen statt fortgeschrieben: Ein Deck, dessen Karten oder Bracket
--    sich geaendert haben oder das geloescht wurde, soll am naechsten Morgen richtig drinstehen
--    bzw. verschwunden sein.
-- =====================================================================================
create table if not exists public.bracket_benchmark_decks (
  deck_id uuid primary key references public.decks (id) on delete cascade,
  bracket smallint not null check (bracket between 1 and 5),
  total_cards integer not null,
  -- Tutoren je 100 Karten - dieselbe Groesse wie der Teil 'tutors' in tuningParts() (bracket.ts).
  tutor_density real not null,
  tutors integer not null,
  game_changers integer not null,
  winning_combos integer not null,
  -- null, wenn das Deck keine Nichtland- bzw. keine Landkarten hat.
  avg_cmc real,
  untapped_land_percent real,
  measured_at timestamptz not null default now()
);

comment on table public.bracket_benchmark_decks is
  'Kennzahlen der Decks mit selbst gewaehltem Bracket (Commander, nicht geloescht), jede Nacht neu gemessen von bracket_benchmark_aktualisieren(). Nur Zahlen, keine Karten. Fuer Clients nicht lesbar.';

-- RLS an und KEINE Policy: Die Zeilen stammen auch aus privaten Decks. Geschrieben wird nur von
-- der security-definer-Funktion unten.
alter table public.bracket_benchmark_decks enable row level security;

-- =====================================================================================
-- 2. Das Ergebnis: je Bracket eine Zeile mit den Medianen der Stichprobe.
--
--    bracket.ts nutzt davon:
--      Tuning-Spannen  von = Median Bracket 2, bis = Median Bracket 5 (je Merkmal).
--                      Bis Bracket 5 und nicht bis 4: Voll getunt heisst "wie ein typisches
--                      cEDH-Deck". Laege das Ende beim Median von Bracket 4, kaeme die Haelfte
--                      aller Bracket-4-Decks auf den cEDH-Hinweis (ab 0,85).
--      Urteil F        combo_tutor_min aus der Zeile von Bracket 4.
--    Die Zeilen 1 und 3 werden mitgemessen, von der App aber (noch) nicht gelesen.
-- =====================================================================================
create table if not exists public.bracket_benchmark (
  bracket smallint primary key check (bracket between 1 and 5),
  -- Decks dieses Brackets in der Stichprobe beim LETZTEN Lauf - auch wenn es zu wenige waren,
  -- damit sichtbar ist, wie weit es noch bis 100 ist.
  deck_count integer not null default 0,
  tutor_density real,
  avg_cmc real,
  untapped_land_percent real,
  game_changers real,
  -- Nur in der Zeile von Bracket 4 belegt: Urteil F verlangt mindestens so viele Tutoren.
  combo_tutor_min smallint,
  -- Wann die Werte zuletzt aus der Stichprobe kamen. null = es gelten noch die Startwerte.
  values_updated_at timestamptz,
  checked_at timestamptz
);

comment on table public.bracket_benchmark is
  'Mediane der Decks mit selbst gewaehltem Bracket, je Bracket. Werte werden erst ab 100 Decks des Brackets ueberschrieben, vorher gelten die Startwerte. Gelesen von CardDataService.bracketBenchmark() fuer src/app/bracket.ts.';

-- Startwerte = die bisher fest in bracket.ts stehenden Werte. "on conflict do nothing": ein
-- zweiter Lauf dieses Skripts setzt bereits gelernte Werte nicht zurueck.
insert into public.bracket_benchmark (bracket, tutor_density, avg_cmc, untapped_land_percent, game_changers, combo_tutor_min)
values
  (1, null, null, null, null, null),
  (2, 0, 3.4, 70, 0, null),
  (3, null, null, null, null, null),
  (4, null, null, null, null, 2),
  (5, 8, 2.2, 95, 6, null)
on conflict (bracket) do nothing;

alter table public.bracket_benchmark enable row level security;

drop policy if exists "Bracket benchmark is readable by anyone" on public.bracket_benchmark;
create policy "Bracket benchmark is readable by anyone"
  on public.bracket_benchmark for select
  using (true);

grant select on public.bracket_benchmark to anon, authenticated;

-- =====================================================================================
-- 3. Der naechtliche Lauf.
--
--    Merkmale exakt wie im Client (deck-viewer.service.ts), damit gemessene und gerechnete Werte
--    dieselbe Groesse sind:
--      - Hauptdeck ohne Maybeboard und Marken, Commander zaehlt mit.
--      - Tutoren aus spellbook_card_flags (kuratierte Liste), Game Changer aus scryfall_cards.
--      - Oe Manawert ohne Laender.
--      - Ungetappt: Land ohne "enters (the battlefield) tapped" oder mit "unless"/"you may pay".
--      - Gewinn-Combos ueber winning_combos_in_deck(), also die enge Sieg-Definition.
--
--    Urteil F neu bestimmt: die kleinste Tutorenzahl t (1-8), bei der unter den Decks mit
--    mindestens einer Gewinn-Combo und mindestens t Tutoren mindestens 90 % Bracket 4 oder 5
--    gewaehlt haben - und das bei mindestens 20 solchen Decks, sonst ist der Anteil Zufall. Nur,
--    wenn Bracket 2, 3 UND 4 je mindestens 100 Decks haben: Der Anteil ist ein Vergleich mit den
--    Stufen darunter und hat ohne sie keine Aussage. Findet sich kein t, bleibt der alte Wert.
-- =====================================================================================
create or replace function public.bracket_benchmark_aktualisieren()
-- Rueckgabe bewusst NICHT bracket/deck_count genannt: In plpgsql wuerden gleichnamige
-- Ausgabespalten mit den Tabellenspalten kollidieren ("column reference is ambiguous").
returns table (stufe smallint, decks integer, werte_aktualisiert boolean)
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  mindest_decks constant integer := 100;
  neues_t smallint;
begin
  delete from public.bracket_benchmark_decks where true;

  insert into public.bracket_benchmark_decks (
    deck_id, bracket, total_cards, tutor_density, tutors, game_changers, winning_combos,
    avg_cmc, untapped_land_percent
  )
  with stichprobe as (
    select d.id, d.bracket
    from public.decks d
    where d.bracket is not null
      and d.format = 'Commander'
      and d.deleted_at is null
  ),
  karten as (
    select
      c.deck_id,
      lower(translate(btrim(split_part(c.card_name, ' // ', 1)), '’‘´`', '''''''''')) as schluessel,
      c.quantity as qty,
      coalesce(c.is_commander, false) as ist_commander,
      c.type_line,
      c.cmc
    from public.deck_cards c
    join stichprobe s on s.id = c.deck_id
    where not coalesce(c.is_maybeboard, false)
      and not coalesce(c.is_token, false)
  ),
  -- Eine Zeile je Kartenname: scryfall_cards hat eine Zeile je Oracle-ID, und in seltenen Faellen
  -- teilen sich zwei Oracle-IDs denselben Vorderseiten-Namen.
  kartendaten as (
    select
      sc.front_name_normalized as schluessel,
      bool_or(sc.game_changer) as game_changer,
      min(sc.cmc) as cmc,
      min(sc.type_line) as type_line,
      min(sc.oracle_text) as oracle_text
    from public.scryfall_cards sc
    where sc.front_name_normalized in (select distinct k.schluessel from karten k)
    group by sc.front_name_normalized
  ),
  angereichert as (
    select
      k.deck_id,
      k.schluessel,
      k.qty,
      k.ist_commander,
      coalesce(kd.type_line, k.type_line, '') as type_line,
      coalesce(kd.cmc, k.cmc, 0) as cmc,
      coalesce(kd.game_changer, false) as game_changer,
      coalesce(f.tutor, false) as tutor,
      coalesce(kd.oracle_text, '') as oracle_text
    from karten k
    left join kartendaten kd on kd.schluessel = k.schluessel
    left join public.spellbook_card_flags f on f.name_normalized = k.schluessel
  ),
  je_deck as (
    select
      a.deck_id,
      sum(a.qty)::integer as total_cards,
      coalesce(sum(a.qty) filter (where a.tutor), 0)::integer as tutors,
      coalesce(sum(a.qty) filter (where a.game_changer), 0)::integer as game_changers,
      (sum(a.cmc * a.qty) filter (where a.type_line not like '%Land%'))
        / nullif(sum(a.qty) filter (where a.type_line not like '%Land%'), 0) as avg_cmc,
      100.0 * coalesce(sum(a.qty) filter (
          where a.type_line like '%Land%'
            and not (a.oracle_text ~* 'enters (the battlefield )?tapped'
                     and a.oracle_text !~* 'unless|you may pay')
        ), 0)
        / nullif(sum(a.qty) filter (where a.type_line like '%Land%'), 0) as untapped_land_percent,
      array_agg(distinct a.schluessel) as namen,
      coalesce(array_agg(distinct a.schluessel) filter (where a.ist_commander), '{}'::text[]) as commander
    from angereichert a
    group by a.deck_id
  )
  select
    s.id,
    s.bracket,
    j.total_cards,
    100.0 * j.tutors / nullif(j.total_cards, 0),
    j.tutors,
    j.game_changers,
    public.winning_combos_in_deck(j.namen, j.commander),
    j.avg_cmc,
    j.untapped_land_percent
  from stichprobe s
  join je_deck j on j.deck_id = s.id
  -- Leere oder halbe Decks sagen ueber eine Stufe nichts.
  where j.total_cards >= 60;

  -- Deckzahl je Bracket immer nachtragen, die Werte nur ab 100 Decks.
  update public.bracket_benchmark b
  set deck_count = coalesce(z.anzahl, 0),
      checked_at = now()
  from (
    select b2.bracket, count(x.deck_id)::integer as anzahl
    from public.bracket_benchmark b2
    left join public.bracket_benchmark_decks x on x.bracket = b2.bracket
    group by b2.bracket
  ) z
  where z.bracket = b.bracket;

  update public.bracket_benchmark b
  set tutor_density = m.tutor_density,
      avg_cmc = m.avg_cmc,
      untapped_land_percent = m.untapped_land_percent,
      game_changers = m.game_changers,
      values_updated_at = now()
  from (
    select
      x.bracket,
      percentile_cont(0.5) within group (order by x.tutor_density) as tutor_density,
      percentile_cont(0.5) within group (order by x.avg_cmc) as avg_cmc,
      percentile_cont(0.5) within group (order by x.untapped_land_percent) as untapped_land_percent,
      percentile_cont(0.5) within group (order by x.game_changers) as game_changers
    from public.bracket_benchmark_decks x
    group by x.bracket
    having count(*) >= mindest_decks
  ) m
  where m.bracket = b.bracket;

  if (select count(*) from public.bracket_benchmark
      where bracket_benchmark.bracket in (2, 3, 4)
        and bracket_benchmark.deck_count >= mindest_decks) = 3 then
    select t.t into neues_t
    from generate_series(1, 8) as t(t)
    cross join lateral (
      select count(*) as treffer, count(*) filter (where x.bracket >= 4) as hoch
      from public.bracket_benchmark_decks x
      where x.winning_combos >= 1 and x.tutors >= t.t
    ) a
    where a.treffer >= 20 and a.hoch >= 0.9 * a.treffer
    order by t.t
    limit 1;

    if neues_t is not null then
      update public.bracket_benchmark
      set combo_tutor_min = neues_t, values_updated_at = now()
      where bracket_benchmark.bracket = 4;
    end if;
  end if;

  return query
    -- now() ist in plpgsql der Beginn der Transaktion, also genau der Stempel von oben.
    select b.bracket, b.deck_count, coalesce(b.values_updated_at = now(), false)
    from public.bracket_benchmark b
    order by b.bracket;
end;
$$;

comment on function public.bracket_benchmark_aktualisieren() is
  'Misst die Decks mit selbst gewaehltem Bracket neu und aktualisiert bracket_benchmark - je Bracket erst ab 100 Decks. Aufgerufen am Ende von scripts/sync-spellbook-bracket.js.';

-- Nur der Nachtlauf (Service-Role-Key) darf das ausloesen: Die Funktion liest als
-- security definer auch private Decks.
revoke all on function public.bracket_benchmark_aktualisieren() from public, anon, authenticated;
grant execute on function public.bracket_benchmark_aktualisieren() to service_role;

notify pgrst, 'reload schema';
