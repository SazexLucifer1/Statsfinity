-- Kartenlisten der Spellbook-Combos platzsparend ablegen: ein Zahlen-Array je Combo statt einer
-- Zeile je Karte. Im Supabase-SQL-Editor ausführen. Idempotent - ein zweiter Lauf tut nichts.
--
-- WARUM: Die Messung vom 20.09.2026 (sql/datenbankgroesse-pruefen-2026-09-20.sql) hat
-- spellbook_combo_cards als zweitgrößten Posten der Datenbank ausgewiesen - 82 MB bei 398 MB
-- Gesamtbestand. Der Grund ist NICHT Aufblähung, sondern der Schlüssel:
--
--   spellbook_combo_cards           383.229 Zeilen    82 MB
--     davon Primärschlüssel (combo_id text, name_normalized text)   33 MB
--     davon Index auf name_normalized                                6 MB
--     davon Index auf synced_at                                    8,3 MB
--     davon die Zeilen selbst                                       35 MB
--
-- 33 MB für den Primärschlüssel sind rechnerisch korrekt: zwei Textspalten mal 383.229 Zeilen.
-- Der Index ist gesund, er ist teuer ENTWORFEN. Bei 105.025 Combos sind das 3,6 Zeilen je Combo,
-- und jede davon wiederholt die Combo-ID als Text.
--
-- DAS IST DERSELBE FEHLER WIE BEI archidekt_deck_pool_cards, wo der Primärschlüssel allein 72 MB
-- gekostet hat (sql/archidekt-pool-card-arrays-2026-09-15.sql). Dort war die Lösung ein Zahlen-
-- Array je Deck; hier ist es ein Zahlen-Array je Combo. Erwartet:
--
--   spellbook_combo_cardlists (105.025 Zeilen) + spellbook_card_names   ~26 MB
--   -> rund 56 MB frei, ohne dass eine einzige Combo verloren geht.
--
-- WAS DAS KOSTET: Die Frage "welche Combos betreffen diese Karte?" lief bisher über einen
-- gewöhnlichen Index auf name_normalized. Jetzt beantwortet sie ein GIN-Index über das Array
-- (Operator &&). Das ist der Grund, warum die Kartenliste überhaupt als Array funktioniert -
-- ohne GIN wäre der Combo-Finder unbrauchbar langsam.
--
-- WAS SICH NICHT ÄNDERT: Beide Funktionen, die die App aufruft, behalten Signatur UND
-- Rückgabespalten - spellbook_combos_missing_one() und winning_combos_in_deck(). Am Angular-Code
-- ändert sich deshalb nichts. Ebenso unberührt: spellbook_two_card_combos, die schmale Tabelle
-- hinter dem offiziellen Bracket-Kriterium.
--
-- EIGENE NAMENSTABELLE, nicht archidekt_pool_card_names mitbenutzt: Die beiden werden von
-- verschiedenen Läufen gefüllt (Spellbook-Abgleich nächtlich, Archidekt-Import von Hand). Eine
-- gemeinsame Tabelle würde die beiden aneinanderketten, und der Gewinn wären rund 3 MB an
-- doppelten Namen - gemessen an 56 MB kein Grund, zwei unabhängige Läufe zu verheiraten.
--
-- REIHENFOLGE: Die Abschnitte bauen aufeinander auf und müssen in EINEM Durchgang laufen.
-- Abschnitt 1 gibt zuerst Platz frei, weil die neuen Tabellen neben den alten entstehen.
-- Bis Abschnitt 7 ist der Umbau folgenlos abbrechbar, danach nicht mehr.

-- =====================================================================================
-- 1. Platz schaffen: der Index auf name_normalized (rund 6 MB) gehört zur ALTEN Suchfunktion
--    und wird gleich durch den GIN-Index ersetzt. Anders als ein delete gibt ein drop index
--    den Platz sofort zurück.
-- =====================================================================================
drop index if exists public.spellbook_combo_cards_name_idx;

-- =====================================================================================
-- 2. Die Kartennamen, einmal statt 383.229-mal.
--
--    Nur name_normalized, KEIN Anzeigename: Anders als beim Deckvorrat zeigt hier nichts einen
--    Kartennamen aus dieser Tabelle an. Der Combo-Finder gibt normalisierte Namen zurück (so war
--    es vorher auch), und die App schlägt Anzeigenamen ohnehin über scryfall_cards nach.
-- =====================================================================================
create table if not exists public.spellbook_card_names (
  id integer primary key generated always as identity,
  name_normalized text not null unique
);

comment on table public.spellbook_card_names is
  'Jeder in einer Combo vorkommende Kartenname genau einmal. Ersetzt die 383.229-fache Textwiederholung der frueheren Kartentabelle.';
comment on column public.spellbook_card_names.name_normalized is
  'Schluessel fuer den Join auf scryfall_cards.front_name_normalized - muss exakt normalizeCardName() aus src/app/array-utils.ts entsprechen.';

-- =====================================================================================
-- 3. Die Kartenliste als Arrays, eine Zeile je Combo.
--
--    commander_ids ist eine eigene, kurze Liste statt eines zweiten Parallel-Arrays: Es sind fast
--    immer null Einträge, und der check unten hält fest, dass es eine Teilmenge von card_ids ist.
--    Liefe das auseinander, würde der Combo-Finder Combos als spielbar melden, die es nicht sind.
-- =====================================================================================
create table if not exists public.spellbook_combo_cardlists (
  combo_id text primary key references public.spellbook_combos (id) on delete cascade,
  card_ids integer[] not null,
  commander_ids integer[] not null default '{}',
  synced_at timestamptz not null default now(),
  constraint spellbook_combo_cardlists_karten_check
    check (cardinality(card_ids) between 2 and 5),
  constraint spellbook_combo_cardlists_commander_check
    check (commander_ids <@ card_ids)
);

comment on table public.spellbook_combo_cardlists is
  'Beteiligte Karten je Combo als Zahlen-Array. Eine Zeile je Combo, nicht je Karte - siehe Kopf von sql/spellbook-combo-card-arrays-2026-09-20.sql.';
comment on column public.spellbook_combo_cardlists.card_ids is
  'Verweise auf spellbook_card_names.id. Aufsteigend sortiert und ohne Dubletten, damit zwei gleiche Combos dieselbe Darstellung haben.';
comment on column public.spellbook_combo_cardlists.commander_ids is
  'Teilmenge von card_ids: die Karten, die der Commander sein MUESSEN (Spellbook: mustBeCommander). Meist leer.';

-- Der Index, ohne den der ganze Umbau nicht funktioniert: "welche Combos enthalten eine dieser
-- Karten?" ist die erste Frage des Combo-Finders und läuft über den Array-Ueberschneidungs-
-- Operator &&. Ein btree-Index kann das nicht, ein GIN-Index schon.
create index if not exists spellbook_combo_cardlists_karten_idx
  on public.spellbook_combo_cardlists using gin (card_ids);

-- Fuer das naechtliche Aufraeumen - dieselbe Begruendung wie in
-- sql/spellbook-sync-cleanup-2026-09-16.sql: ohne diesen Index liest Postgres die ganze Tabelle
-- und der Lauf stirbt an einer Zeitueberschreitung.
create index if not exists spellbook_combo_cardlists_synced_at_idx
  on public.spellbook_combo_cardlists (synced_at);

-- =====================================================================================
-- 4. Den vorhandenen Bestand umstellen.
--
--    Laeuft nur, solange die alte Tabelle noch existiert - nach einem vollstaendigen Durchlauf
--    dieser Datei ist sie weg, und ein zweiter Lauf ueberspringt diesen Abschnitt stillschweigend.
--    Ohne diesen Schritt waere der Combo-Finder bis zum naechsten Nachtlauf leer.
-- =====================================================================================
do $$
begin
  if to_regclass('public.spellbook_combo_cards') is null then
    raise notice 'spellbook_combo_cards gibt es nicht mehr - Bestand wurde bereits umgestellt.';
    return;
  end if;

  insert into public.spellbook_card_names (name_normalized)
  select distinct cc.name_normalized
  from public.spellbook_combo_cards cc
  on conflict (name_normalized) do nothing;

  insert into public.spellbook_combo_cardlists (combo_id, card_ids, commander_ids, synced_at)
  select
    cc.combo_id,
    array_agg(distinct n.id),
    coalesce(
      (array_agg(n.id order by n.id) filter (where cc.must_be_commander)),
      '{}'::integer[]
    ),
    max(cc.synced_at)
  from public.spellbook_combo_cards cc
  join public.spellbook_card_names n on n.name_normalized = cc.name_normalized
  group by cc.combo_id
  -- Combos, deren Kartenzahl ausserhalb von 2 bis 5 liegt, kann es nach dem check oben nicht
  -- geben; solche Zeilen waeren ohnehin kaputt und bleiben bewusst draussen.
  having count(*) between 2 and 5
  on conflict (combo_id) do nothing;

  raise notice 'Umgestellt: % Combos, % Kartennamen.',
    (select count(*) from public.spellbook_combo_cardlists),
    (select count(*) from public.spellbook_card_names);
end
$$;

-- =====================================================================================
-- 5. Die Suchfunktion des Combo-Finders auf Arrays umstellen.
--
--    SIGNATUR UND RÜCKGABESPALTEN BLEIBEN EXAKT GLEICH - die App ruft sie über
--    CardDataService.combosMissingOne() auf (src/app/card-data.service.ts), und an dieser Stelle
--    ändert sich kein einziges Zeichen Angular-Code.
--
--    Der einzige inhaltliche Unterschied steckt in "kandidaten": Statt eines btree-Index auf
--    name_normalized fragt jetzt der GIN-Index, welche Combos eine der Deckkarten enthalten
--    (Operator &&). Alles danach - genau eine fehlende Karte, mustBeCommander geprüft, nach
--    Nützlichkeit sortiert - rechnet dieselbe Rechnung wie vorher, nur auf Zahlen statt Text.
-- =====================================================================================
drop function if exists public.spellbook_combos_missing_one(text[], text[], integer, integer);

create function public.spellbook_combos_missing_one(
  deck_names text[],
  commander_names text[] default '{}'::text[],
  max_cards integer default 150,
  max_combos_per_card integer default 6
)
returns table (
  combo_id text,
  missing_name text,
  present_names text[],
  card_count smallint,
  produces text[],
  description text,
  mana_needed text,
  mana_value_needed smallint,
  popularity integer,
  combo_count integer,
  total_cards integer
)
language sql
stable
security invoker
set search_path = public
as $$
  with deck_auswahl as (
    select coalesce(array_agg(n.id), '{}'::integer[]) as ids
    from public.spellbook_card_names n
    where n.name_normalized = any(deck_names)
  ),
  commander_auswahl as (
    select coalesce(array_agg(n.id), '{}'::integer[]) as ids
    from public.spellbook_card_names n
    where n.name_normalized = any(commander_names)
  ),
  kandidaten as (
    -- Erst grob eingrenzen: nur Combos, die ueberhaupt eine Deckkarte enthalten. Genau hier
    -- greift der GIN-Index; ohne ihn liefe das ueber die ganze Tabelle.
    select cl.combo_id, cl.card_ids, cl.commander_ids, d.ids as deck, c.ids as cmd
    from public.spellbook_combo_cardlists cl
    cross join deck_auswahl d
    cross join commander_auswahl c
    where cl.card_ids && d.ids
  ),
  bewertet as (
    select
      k.combo_id,
      array(select x from unnest(k.card_ids) as x where not (x = any(k.deck)))  as fehlende,
      array(select x from unnest(k.card_ids) as x where x = any(k.deck))        as vorhandene,
      -- Deckt beide mustBeCommander-Faelle auf einmal ab: eine FEHLENDE Karte, die Commander
      -- sein muesste (sie ins Deck zu legen braechte nichts), und eine VORHANDENE, die
      -- Commander sein muesste, es aber nicht ist. Beide Male ist die Combo nicht ausfuehrbar.
      not exists (
        select 1 from unnest(k.commander_ids) as c where not (c = any(k.cmd))
      ) as commander_ok
    from kandidaten k
  ),
  treffer as (
    select
      b.combo_id,
      b.fehlende[1] as fehlt_id,
      b.vorhandene,
      c.card_count,
      c.produces,
      c.description,
      c.mana_needed,
      c.mana_value_needed,
      c.popularity
    from bewertet b
    join public.spellbook_combos c on c.id = b.combo_id
    where cardinality(b.fehlende) = 1
      and b.commander_ok
  ),
  -- Zahlen zurueck in Namen: erst hier, fuer die paar hundert Zeilen, die uebrig geblieben sind.
  benannt as (
    select
      t.combo_id,
      fn.name_normalized as fehlt,
      array(
        select vn.name_normalized
        from unnest(t.vorhandene) as v(id)
        join public.spellbook_card_names vn on vn.id = v.id
        order by vn.name_normalized
      ) as vorhanden,
      t.card_count,
      t.produces,
      t.description,
      t.mana_needed,
      t.mana_value_needed,
      t.popularity
    from treffer t
    join public.spellbook_card_names fn on fn.id = t.fehlt_id
  ),
  -- Nuetzlichkeit je fehlender Karte: erst die, die auf einen Schlag die meisten Combos
  -- freischaltet, bei Gleichstand die mit der beliebtesten Combo.
  rang_alle as (
    select
      b.fehlt,
      count(*)::integer as combo_anzahl,
      max(coalesce(b.popularity, 0)) as beste_beliebtheit
    from benannt b
    group by b.fehlt
  ),
  rang as (
    select *
    from rang_alle
    order by combo_anzahl desc, beste_beliebtheit desc, fehlt
    limit greatest(max_cards, 1)
  ),
  -- Je Karte nur die beliebtesten Combos: eine Karte kann in dreistellig vielen Combos stecken,
  -- angezeigt wird davon ohnehin nur eine Handvoll. Deckelt zugleich die Antwortgroesse, damit
  -- PostgREST nichts stillschweigend abschneidet.
  gekuerzt as (
    select
      b.*,
      r.combo_anzahl,
      r.beste_beliebtheit,
      row_number() over (
        partition by b.fehlt
        order by b.popularity desc nulls last, b.card_count, b.combo_id
      ) as platz
    from benannt b
    join rang r on r.fehlt = b.fehlt
  )
  select
    g.combo_id,
    g.fehlt,
    g.vorhanden,
    g.card_count,
    g.produces,
    g.description,
    g.mana_needed,
    g.mana_value_needed,
    g.popularity,
    g.combo_anzahl,
    (select count(*)::integer from rang_alle)
  from gekuerzt g
  where g.platz <= greatest(max_combos_per_card, 1)
  order by g.combo_anzahl desc, g.beste_beliebtheit desc, g.fehlt, g.platz;
$$;

comment on function public.spellbook_combos_missing_one is
  'Combo-Finder: liefert alle Combos, denen bei dieser Deckliste genau EINE Karte fehlt, gruppiert nach der fehlenden Karte und nach Nuetzlichkeit sortiert. deck_names und commander_names sind normalisierte Vorderseiten-Namen.';

-- =====================================================================================
-- 6. Die materialisierte Ansicht neu bauen.
--
--    Inhalt, Spalten und Indizes bleiben identisch - nur die Quelle der Kartenliste wechselt.
--    Der Nebeneffekt ist eine Vereinfachung: Weil jetzt EINE Zeile je Combo vorliegt, faellt die
--    Gruppierung weg, mit der die alte Fassung die Kartenzeilen wieder einsammeln musste.
--
--    Die Muster-Funktionen (spellbook_winning_combo_muster, spellbook_sofort_sieg_muster,
--    spellbook_sieg_ausnahme) bleiben unangetastet - sie stehen in
--    sql/sieg-definition-breit-2026-09-17.sql und werden hier nur benutzt.
-- =====================================================================================
-- Die Ansicht weg - EGAL IN WELCHER FORM sie gerade existiert. "drop view if exists" genuegt
-- nicht: Liegt sie als MATERIALISIERTE Ansicht vor, bricht Postgres trotzdem ab.
do $ausraeumen$
declare
  art "char";
begin
  select relkind into art from pg_class where oid = to_regclass('public.spellbook_winning_combos');
  if art = 'm' then
    execute 'drop materialized view public.spellbook_winning_combos';
  elsif art = 'v' then
    execute 'drop view public.spellbook_winning_combos';
  end if;
end
$ausraeumen$;

create materialized view public.spellbook_winning_combos as
with gewinner as materialized (
  select
    c.id,
    c.card_count,
    coalesce(c.mana_value_needed, 0) as mana_value_needed,
    c.produces,
    exists (
      select 1 from unnest(c.produces) as p
      where p ~* public.spellbook_sofort_sieg_muster()
        and p !~* public.spellbook_sieg_ausnahme()
    ) as beendet_sofort
  from public.spellbook_combos c
  where exists (
    select 1 from unnest(c.produces) as p
    where p ~* public.spellbook_winning_combo_muster()
      and p !~* public.spellbook_sieg_ausnahme()
  )
)
select
  g.id as combo_id,
  g.card_count,
  g.mana_value_needed,
  g.produces,
  g.beendet_sofort,
  array(
    select n.name_normalized
    from unnest(cl.card_ids) as u(id)
    join public.spellbook_card_names n on n.id = u.id
    order by n.name_normalized
  ) as card_names,
  array(
    select n.name_normalized
    from unnest(cl.commander_ids) as u(id)
    join public.spellbook_card_names n on n.id = u.id
    order by n.name_normalized
  ) as commander_required
from gewinner g
join public.spellbook_combo_cardlists cl on cl.combo_id = g.id;

comment on materialized view public.spellbook_winning_combos is
  'Combos, deren Ergebnis der Endpunkt eines Decks ist (weite Definition). beendet_sofort = true heisst zusaetzlich: beendet das Spiel unmittelbar (enge Definition, Grundlage von Urteil F).';

-- Eindeutiger Index: macht das Blaettern schnell und ist zugleich die Voraussetzung dafuer,
-- spaeter "refresh materialized view concurrently" nutzen zu koennen (Auffrischen ohne Lesesperre).
create unique index if not exists spellbook_winning_combos_id_idx
  on public.spellbook_winning_combos (combo_id);

create index if not exists spellbook_winning_combos_cards_idx
  on public.spellbook_winning_combos using gin (card_names);

-- Eigener Index auf die enge Teilmenge: Urteil F fragt bei jedem Deck-Oeffnen genau danach.
create index if not exists spellbook_winning_combos_sofort_idx
  on public.spellbook_winning_combos (beendet_sofort)
  where beendet_sofort;

grant select on public.spellbook_winning_combos to anon, authenticated;

-- =====================================================================================
-- 7. RLS fuer die neuen Tabellen: fuer jeden lesbar, fuer niemanden schreibbar.
--
--    Ohne "enable row level security" waeren die Tabellen ueber den oeffentlichen Anon-Key auch
--    BESCHREIBBAR. Es gibt bewusst nur eine select-Policy: fehlt fuer insert/update/delete jede
--    Policy, verweigert RLS sie grundsaetzlich. Der Nachtlauf schreibt mit dem Service-Role-Key,
--    der RLS ohnehin umgeht.
-- =====================================================================================
alter table public.spellbook_card_names enable row level security;
alter table public.spellbook_combo_cardlists enable row level security;

drop policy if exists "Spellbook card names are readable by anyone" on public.spellbook_card_names;
create policy "Spellbook card names are readable by anyone"
on public.spellbook_card_names
for select
to anon, authenticated
using (true);

drop policy if exists "Spellbook combo cardlists are readable by anyone" on public.spellbook_combo_cardlists;
create policy "Spellbook combo cardlists are readable by anyone"
on public.spellbook_combo_cardlists
for select
to anon, authenticated
using (true);

-- =====================================================================================
-- 8. Die alte Kartentabelle weg. Das ist der Schritt, der die rund 76 MB zurueckgibt.
--
--    Erst hier, nachdem alles Uebrige steht: Bis zu diesem Punkt ist der Umbau folgenlos
--    abbrechbar, danach nicht mehr.
--
--    ACHTUNG: scripts/sync-spellbook-bracket.js muss auf dem Stand dieses PRs sein, BEVOR der
--    naechste Nachtlauf startet. Ein alter Lauf wuerde in eine Tabelle schreiben, die es nicht
--    mehr gibt, und mit einem Fehler abbrechen - die Daten blieben dabei unbeschaedigt.
-- =====================================================================================
drop table if exists public.spellbook_combo_cards;

-- =====================================================================================
-- 9. Und zum Schluss den Platz wirklich zurueckgeben.
--
--    "drop table" gibt seinen Platz sofort frei - anders als ein delete. Fuer die Datenbank als
--    Ganzes lohnt danach ein Blick mit sql/datenbankgroesse-pruefen-2026-09-20.sql: erwartet
--    werden rund 56 MB weniger.
-- =====================================================================================
analyze public.spellbook_card_names;
analyze public.spellbook_combo_cardlists;
