-- Nachgetragene Bilanz je Deck: Siege/Niederlagen/Unentschieden aus der Zeit vor Statsfinity.
-- Im Supabase-Dashboard unter "SQL Editor" ausführen. Idempotent.
--
-- Mythic Tools erlaubt, einem Deck eine alte Bilanz mitzugeben ("manual stats"). Bei uns steht
-- sie als eine jsonb-Spalte an decks: {"wins": 12, "losses": 8, "draws": 1}.
--
-- Bewusst KEINE erfundenen Partien: Eine Bilanz kennt weder Gegner noch Datum noch Modus. Als
-- Partien gespeichert, würde sie Elo, Head-to-Head, Gegner-Auswertungen und jede Gruppenstatistik
-- mit ausgedachten Gegnern verfälschen. Sie erscheint deshalb nur in der Deck-Ansicht, getrennt
-- ausgewiesen und zusammen mit den erfassten Partien als Gesamtbilanz.
--
-- Keine neue RLS-Policy: Lesen folgt der Sichtbarkeit des Decks, Schreiben dem bestehenden
-- Update-Recht (wie beim Primer). Fehlt die Migration, verschwindet der Abschnitt still
-- (42703/PGRST204, siehe deck-manual-record.service.ts).

alter table public.decks
  add column if not exists manual_record jsonb;

comment on column public.decks.manual_record is
  'Nachgetragene Bilanz aus der Zeit vor der App: {"wins":n,"losses":n,"draws":n}. null = keine.';
