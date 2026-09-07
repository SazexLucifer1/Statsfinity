-- Alle Combos von Commander Spellbook (bis fünf Karten) samt Ergebnis und Ablauf - Grundlage des
-- Combo-Finders in der Deck-Analyse. Im Supabase-Dashboard unter "SQL Editor" ausführen.
-- Komplett idempotent (alle "create table if not exists"/"create index if not exists"/
-- "create or replace function"/"drop policy if exists"+"create policy"-Paare sind gefahrlos
-- mehrfach ausführbar).
--
-- NACH dem Ausführen einmal den Abgleich anstoßen: GitHub -> Actions -> "spellbook-sync" ->
-- "Run workflow". Vorher bleiben die Tabellen leer und der Combo-Finder sagt das auch so.
-- Der Lauf dauert rund 20 Minuten (1.085 Seiten à 100 Combos).
--
-- =====================================================================================
-- Warum eine ZWEITE Combo-Tabelle neben spellbook_two_card_combos?
--
-- Die beiden beantworten verschiedene Fragen, und genau das ist der Grund:
--
--   spellbook_two_card_combos  ->  "Verletzt dieses Deck ein Bracket-Kriterium?"
--       Das offizielle Kriterium redet ausdrücklich von ZWEI-Karten-Combos. Die Tabelle ist
--       schmal (keine Beschreibungen), wird bei JEDEM Deck-Öffnen gelesen und muss deshalb
--       schnell bleiben. Sie bleibt unverändert - die Bracket-Einstufung fasst diese Migration
--       nicht an und funktioniert weiter, auch wenn der neue Abgleich noch nicht gelaufen ist.
--
--   spellbook_combos + _cards  ->  "Welche EINE Karte fehlt mir noch für eine Combo?"
--       Dafür ist die Kartenzahl egal (zwei im Deck, die dritte fehlt, zählt genauso), und es
--       braucht zwei Felder, die die schmale Tabelle bewusst NICHT hat: was die Combo erzeugt
--       und wie sie Schritt für Schritt abläuft. Wird nur auf Klick gelesen.
--
-- Beide füllt derselbe Nachtlauf aus DEMSELBEN Durchgang (scripts/sync-spellbook-bracket.js) -
-- die Zweier-Combos fallen als Teilmenge mit ab, es wird nichts zweimal heruntergeladen.
--
-- Nachgemessen an Spellbooks API (Stand 07.09.2026):
--   cards=2      3.985      cards<=3    51.295
--   cards=3     47.310      cards<=4    98.274
--   cards=4     46.979      cards<=5   108.487   <- was hier landet
--   cards=5     10.213
-- Beschreibung im Median 388 Bytes, "produces" 120 Bytes -> grob 135 MB inklusive Index.
--
-- Diese Tabellen enthalten AUSSCHLIESSLICH öffentliche Kartendaten von Commander Spellbook,
-- keinerlei Nutzerdaten. Sie sind deshalb für jeden lesbar (auch ohne Login) und für niemanden
-- schreibbar. Der Nachtlauf schreibt mit dem Service-Role-Key, der RLS ohnehin umgeht.
-- =====================================================================================

-- =====================================================================================
-- 1. Die Combos selbst (~108.500 Zeilen)
-- =====================================================================================
create table if not exists public.spellbook_combos (
  id text primary key,
  card_count smallint not null,
  produces text[] not null default '{}',
  description text not null default '',
  mana_value_needed smallint,
  bracket_tag text,
  popularity integer,
  synced_at timestamptz not null default now()
);

comment on table public.spellbook_combos is
  'Alle Combos bis fuenf Karten von Commander Spellbook (/variants/?q=cards<=5), taeglich abgeglichen von scripts/sync-spellbook-bracket.js. Grundlage des Combo-Finders. Nur oeffentliche Kartendaten, keine Nutzerdaten.';
comment on column public.spellbook_combos.produces is
  'Was die Combo am Ende erzeugt, in Spellbooks eigener Benennung ("Infinite mana", "Infinite lifegain", ...). Das ist die Kurzantwort auf "was bringt mir das?" und steht deshalb im Combo-Finder direkt unter der Combo.';
comment on column public.spellbook_combos.description is
  'Der Ablauf als Fliesstext mit einem Zeilenumbruch je Schritt - genau so, wie ihn die Live-Auswertung liefert; die App teilt ihn an den Umbruechen in eine nummerierte Liste.';
comment on column public.spellbook_combos.card_count is
  'Anzahl beteiligter Karten (2 bis 5). Redundant zu spellbook_combo_cards, aber so laesst sich ohne Join sortieren und anzeigen.';

-- =====================================================================================
-- 2. Welche Karten gehoeren zu welcher Combo (~350.000 Zeilen)
--
--    Eigene Zeile je Karte statt eines Arrays in spellbook_combos: nur so laesst sich mit einem
--    Index beantworten "welche Combos betreffen diese Karte?" - und genau das ist die Frage, mit
--    der der Combo-Finder anfaengt.
-- =====================================================================================
create table if not exists public.spellbook_combo_cards (
  combo_id text not null references public.spellbook_combos (id) on delete cascade,
  name_normalized text not null,
  must_be_commander boolean not null default false,
  synced_at timestamptz not null default now(),
  primary key (combo_id, name_normalized)
);

comment on table public.spellbook_combo_cards is
  'Beteiligte Karten je Combo. name_normalized ist derselbe Schluessel wie scryfall_cards.front_name_normalized und spellbook_card_flags.name_normalized.';
comment on column public.spellbook_combo_cards.must_be_commander is
  'true = die Combo zaehlt nur, wenn diese Karte der Commander ist (Spellbook: mustBeCommander).';

create index if not exists spellbook_combo_cards_name_idx
  on public.spellbook_combo_cards (name_normalized);

-- =====================================================================================
-- 3. Zustand des Nachtlaufs - dieselbe Tabelle wie bisher, nur zwei weitere Zeilen
--    (id "combos" und "combo_cards").
-- =====================================================================================

-- =====================================================================================
-- 4. Die Suchfunktion: welche EINE Karte fehlt noch?
--
--    Bewusst als Datenbankfunktion und nicht als Abfrage aus der App. Die Frage lautet "gib mir
--    alle Combos, bei denen genau eine Karte fehlt" - die laesst sich mit PostgREST-Filtern gar
--    nicht stellen, sie braucht eine Gruppierung ueber die Karten je Combo. Der Browser muesste
--    sonst ALLE Combos herunterladen, die irgendeine Deckkarte enthalten; bei 108.500 Combos und
--    einer verbreiteten Karte wie Sol Ring waeren das zehntausende Zeilen fuer am Ende vierzig
--    Vorschlaege.
--
--    security invoker + stable: die Funktion liest nur die beiden Tabellen oben, die ohnehin fuer
--    jeden lesbar sind. Sie verschafft also keinen Zugriff, den der Aufrufer nicht sowieso haette.
-- =====================================================================================
create or replace function public.spellbook_combos_missing_one(
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
  with kandidaten as (
    -- Erst grob eingrenzen: nur Combos, die ueberhaupt eine Deckkarte enthalten. Ohne diesen
    -- Schritt liefe die Gruppierung darunter ueber die ganze Tabelle.
    select distinct cc.combo_id
    from public.spellbook_combo_cards cc
    where cc.name_normalized = any(deck_names)
  ),
  bewertet as (
    select
      cc.combo_id,
      count(*) filter (where not (cc.name_normalized = any(deck_names))) as fehlend,
      -- Deckt beide mustBeCommander-Faelle auf einmal ab: eine FEHLENDE Karte, die Commander sein
      -- muesste (sie ins Deck zu legen braechte nichts), und eine VORHANDENE, die Commander sein
      -- muesste, es aber nicht ist. Beide Male ist die Combo nicht ausfuehrbar.
      count(*) filter (
        where cc.must_be_commander and not (cc.name_normalized = any(commander_names))
      ) as commander_verletzt,
      array_agg(cc.name_normalized order by cc.name_normalized)
        filter (where cc.name_normalized = any(deck_names)) as vorhanden,
      min(cc.name_normalized) filter (where not (cc.name_normalized = any(deck_names))) as fehlt
    from public.spellbook_combo_cards cc
    join kandidaten k on k.combo_id = cc.combo_id
    group by cc.combo_id
  ),
  treffer as (
    select
      b.combo_id,
      b.fehlt,
      b.vorhanden,
      c.card_count,
      c.produces,
      c.description,
      c.mana_value_needed,
      c.popularity
    from bewertet b
    join public.spellbook_combos c on c.id = b.combo_id
    where b.fehlend = 1
      and b.commander_verletzt = 0
  ),
  -- Nuetzlichkeit je fehlender Karte: erst die, die auf einen Schlag die meisten Combos
  -- freischaltet, bei Gleichstand die mit der beliebtesten Combo.
  rang_alle as (
    select
      t.fehlt,
      count(*)::integer as combo_anzahl,
      max(coalesce(t.popularity, 0)) as beste_beliebtheit
    from treffer t
    group by t.fehlt
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
      t.*,
      r.combo_anzahl,
      r.beste_beliebtheit,
      row_number() over (
        partition by t.fehlt
        order by t.popularity desc nulls last, t.card_count, t.combo_id
      ) as platz
    from treffer t
    join rang r on r.fehlt = t.fehlt
  )
  select
    g.combo_id,
    g.fehlt,
    g.vorhanden,
    g.card_count,
    g.produces,
    g.description,
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
-- 5. RLS: fuer jeden lesbar, fuer niemanden schreibbar
--
--    Ohne "enable row level security" waeren die Tabellen ueber den oeffentlichen Anon-Key auch
--    BESCHREIBBAR - deshalb ist RLS hier zwingend, obwohl die Daten selbst oeffentlich sind. Es
--    gibt bewusst nur eine select-Policy: fehlt fuer insert/update/delete jede Policy, verweigert
--    RLS sie grundsaetzlich.
-- =====================================================================================
alter table public.spellbook_combos enable row level security;
alter table public.spellbook_combo_cards enable row level security;

drop policy if exists "Spellbook combos are readable by anyone" on public.spellbook_combos;
create policy "Spellbook combos are readable by anyone"
on public.spellbook_combos
for select
to public
using (true);

drop policy if exists "Spellbook combo cards are readable by anyone" on public.spellbook_combo_cards;
create policy "Spellbook combo cards are readable by anyone"
on public.spellbook_combo_cards
for select
to public
using (true);

grant execute on function public.spellbook_combos_missing_one(text[], text[], integer, integer)
  to anon, authenticated;
