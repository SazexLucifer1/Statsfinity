# sql/spellbook-combo-card-arrays-2026-09-20.sql in fünf Teilen

Derselbe Umbau wie in `../spellbook-combo-card-arrays-2026-09-20.sql`, nur ohne Kommentare und
in kurze Stücke zerlegt, damit er sich auch vom Handy aus in den Supabase-SQL-Editor
kopieren lässt. Die Begründungen stehen in der Originaldatei.

Nacheinander ausführen, **in dieser Reihenfolge**, jeweils erst weiter, wenn der vorige Teil
ohne Fehler durchgelaufen ist:

1. `teil-1-tabellen.sql`
2. `teil-2-bestand.sql` (dauert etwas)
3. `teil-3-combo-finder.sql`
4. `teil-3b-sieg-muster.sql` (nur nötig, wenn `sql/sieg-definition-breit-2026-09-17.sql` nie lief)
5. `teil-4-gewinn-combos.sql`
6. `teil-4b-urteil-f.sql` (ebenso)
7. `teil-5-aufraeumen.sql`

Jeder Teil ist einzeln wiederholbar. Teil 5 löscht die alte Tabelle nur, wenn die neue
tatsächlich gefüllt ist; sonst bricht er mit einer Meldung ab und es geht nichts verloren.
