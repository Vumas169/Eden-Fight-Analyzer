-- Release-Bereinigung, Teil B. Bitte im Supabase SQL Editor ausfuehren, Block fuer Block.
-- (Das Werkzeug von Claude darf keine Loesch-Befehle ausfuehren.)
-- Bestehende Auswertungen bleiben erhalten: es werden nur Protokolle, ein ungenutzter Cache,
-- die abgeloeste alte Solo-Wertung und doppelte Indizes entfernt.

-- Block 1: taegliche Bereinigung (Protokolle 30 Tage, Fight-Cache max. 5000, Elo-Tagesverlauf 35 Tage)
create or replace function public._maint_cleanup() returns jsonb language plpgsql security definer set search_path = public as $f$
declare a int; b int; c int; d int; e int;
begin
  delete from conflicts where created_at < now() - interval '30 days'; get diagnostics a = row_count;
  delete from rate_log where ts < now() - interval '30 days'; get diagnostics b = row_count;
  delete from fight_detail_req where at < now() - interval '2 days'; get diagnostics c = row_count;
  delete from fight_detail where id in (select id from fight_detail order by at desc offset 5000); get diagnostics d = row_count;
  delete from elo_day where day < current_date - 35 or ver <> (select value::smallint from meta where key = 'elo_ver'); get diagnostics e = row_count;
  return jsonb_build_object('conflicts', a, 'rate_log', b, 'detail_req', c, 'detail', d, 'elo_day', e);
end $f$;
revoke all on function public._maint_cleanup() from public, anon, authenticated;
select cron.schedule('ewa-maint', '52 3 * * *', 'select public._maint_cleanup()');
select public._maint_cleanup();

-- Block 2: alte Solo-Wertung und ungenutzte Indizes entfernen
select cron.unschedule('ewa-ratings-update');
drop function if exists public._update_ratings(int);
drop function if exists public._update_ratings();
drop function if exists public._rebuild_ratings();
drop table if exists public.ratings;
drop index if exists public.elo_score;       -- Sortierung nach "Score" gibt es nicht mehr
drop index if exists public.elo_rank_rel;    -- alte Grenze 150
drop index if exists public.characters_lower_name;  -- characters_lower_name_pat deckt das ab
delete from public.client_errors where ver = 'test';

-- Block 3: Speicher zurueckgeben (jede Zeile einzeln ausfuehren, sperrt die Tabelle kurz)
vacuum full public.elo;
vacuum full public.elo_day;
vacuum full public.characters;
vacuum full public.conflicts;

-- Block 4 (NUR nach Entscheidung, siehe Bericht): Rohdaten aelter als 12 Monate loeschen.
-- Klassen- und Ranglisten-Aggregate und die Elo bleiben. Spielerseiten, Vergleich und eine
-- spaetere Neuberechnung der Elo kennen danach nur noch die letzten 12 Monate.
-- delete from public.fights where ts < now() - interval '12 months';
-- vacuum full public.fights;
