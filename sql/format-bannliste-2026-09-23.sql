-- Bannliste aller Spielformate der App (DECK_FORMATS in src/app/models.ts). Im Supabase-SQL-Editor
-- ausfuehren. Idempotent.
--
-- Gefuellt vom naechtlichen Scryfall-Abgleich (scripts/sync-scryfall-bulk.js, Teil 3): Er fragt je
-- Format "banned:<format>" und fuer Vintage zusaetzlich "restricted:vintage" bei Scryfall ab und
-- ersetzt die Zeilen des Formats. Das sind 14 kleine Anfragen, unabhaengig von der Bulk-Datei - nach
-- dieser Migration reicht also ein gewoehnlicher Lauf, kein --force.
--
-- Eine eigene Tabelle statt einer Spalte je Format an scryfall_cards: Gebannt sind ueber alle
-- Formate zusammen ein paar hundert Karten, eine Spalte je Format waere bei 33.000 Zeilen fast
-- ueberall null. Und der Client laedt die ganze Liste eines Formats mit einer Anfrage.
--
-- Wie bei den anderen Scryfall-Tabellen: nur oeffentliche Kartendaten, fuer jeden lesbar, fuer
-- niemanden schreibbar (der Nachtlauf schreibt mit dem Service-Role-Key).

create table if not exists public.format_banlist (
  -- Der Formatname, wie ihn die App in decks.format speichert ('Commander', 'Historic Brawl', ...),
  -- NICHT Scryfalls Schluessel - sonst muesste jede Abfrage die Zuordnung ein zweites Mal kennen.
  format text not null,
  -- Kartenname vor " // ", durch normalizeCardName() (array-utils.ts) geschickt - derselbe
  -- Schluessel wie scryfall_cards.front_name_normalized.
  name_normalized text not null,
  -- 'banned' = gar nicht erlaubt, 'restricted' = hoechstens ein Exemplar (nur Vintage).
  status text not null check (status in ('banned', 'restricted')),
  synced_at timestamptz not null default now(),
  primary key (format, name_normalized)
);

comment on table public.format_banlist is
  'Gebannte (und in Vintage beschraenkte) Karten je Spielformat, taeglich von scripts/sync-scryfall-bulk.js aus Scryfall abgeglichen.';

alter table public.format_banlist enable row level security;

drop policy if exists "Banlist is readable by anyone" on public.format_banlist;
create policy "Banlist is readable by anyone"
  on public.format_banlist for select
  to anon, authenticated
  using (true);

-- =====================================================================================
-- Verstoesse einer ganzen Seite von Decks in EINER Anfrage (die Deckliste im Profil zeigt je
-- Deck ein rotes Ausrufezeichen). Liefert nur Decks, die tatsaechlich etwas Verbotenes enthalten.
--
-- Bewusst OHNE security definer: Die Funktion laeuft mit den Rechten des Aufrufers, es gelten die
-- bestehenden RLS-Regeln auf decks und deck_cards. Wer ein Deck nicht sehen darf, bekommt dazu
-- auch keinen Verstoss - eine zweite Fassung der Sichtbarkeitsregel gibt es hier nicht.
--
-- Nicht mitgezaehlt: Maybeboard und Marken, die gehoeren nicht zum gespielten Deck. Eine
-- beschraenkte Karte ist erst ab dem zweiten Exemplar ein Verstoss.
--
-- Die Normalisierung muss normalizeCardName() entsprechen: Kleinschreibung, typografische
-- Apostrophe zu ', und nur der Name vor " // ".
-- =====================================================================================
create or replace function public.deck_banned_cards(p_deck_ids uuid[])
returns table (
  deck_id uuid,
  card_name text,
  status text
)
language sql
stable
set search_path = public
as $$
  select c.deck_id, min(c.card_name), b.status
  from public.deck_cards c
  join public.decks d on d.id = c.deck_id
  join public.format_banlist b
    on b.format = d.format
   and b.name_normalized = lower(translate(btrim(split_part(c.card_name, ' // ', 1)), '’‘´`', ''''''''''))
  where c.deck_id = any(p_deck_ids)
    and not coalesce(c.is_maybeboard, false)
    and not coalesce(c.is_token, false)
  group by c.deck_id, b.name_normalized, b.status
  having b.status = 'banned' or sum(c.quantity) > 1;
$$;

grant execute on function public.deck_banned_cards(uuid[]) to anon, authenticated;

notify pgrst, 'reload schema';
