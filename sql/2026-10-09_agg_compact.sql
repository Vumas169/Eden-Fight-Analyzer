-- SCHRITT 1 von 2: diese ganze Datei auf einmal im SQL Editor ausfuehren.
--
-- Statistik-Tabellen verkleinern: Wochen und Tage, die aelter als rund zwei
-- Monate sind, werden zu Monaten zusammengefasst. Neuere Daten bleiben fein.
-- Abfragen fuer "3 Monate" und "Season" zaehlen dann ab Monatsbeginn.

-- Startdatum fuer agg_player und agg_matchup (Wochen- bzw. Monatszeilen)
create or replace function public._agg_from(p_hours int)
returns date language sql stable set search_path = public as $$
  select case
    when p_hours is not null and p_hours <= 1344 then date_trunc('week', _from_day(p_hours))::date
    else date_trunc('month', _from_day(p_hours))::date end
$$;

create or replace function public._agg_compact()
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  cut_wk date := date_trunc('month', now() - interval '63 days')::date;
  cut_day date := date_trunc('month', now() - interval '100 days')::date;
  n_p int; n_m int; n_c int;
begin
  create temporary table _cp on commit drop as
    select date_trunc('month', wk)::date wk, sz, name, max(class) class, max(realm) realm, sum(wins)::int wins, sum(losses)::int losses
    from agg_player where wk < cut_wk group by 1, 2, 3;
  delete from agg_player where wk < cut_wk;
  get diagnostics n_p = row_count;
  insert into agg_player(wk, sz, name, class, realm, wins, losses) select * from _cp;

  create temporary table _cm on commit drop as
    select class, realm, date_trunc('month', wk)::date wk, sz, oclass, orealm, sum(wins)::int wins, sum(losses)::int losses
    from agg_matchup where wk < cut_wk group by 1, 2, 3, 4, 5, 6;
  delete from agg_matchup where wk < cut_wk;
  get diagnostics n_m = row_count;
  insert into agg_matchup(class, realm, wk, sz, oclass, orealm, wins, losses) select * from _cm;

  create temporary table _cc on commit drop as
    select date_trunc('month', d)::date d, sz, class, realm, sum(wins)::int wins, sum(losses)::int losses
    from agg_class where d < cut_day group by 1, 2, 3, 4;
  delete from agg_class where d < cut_day;
  get diagnostics n_c = row_count;
  insert into agg_class(d, sz, class, realm, wins, losses) select * from _cc;

  return jsonb_build_object('player', n_p, 'player_new', (select count(*) from _cp),
                            'matchup', n_m, 'matchup_new', (select count(*) from _cm),
                            'class', n_c, 'class_new', (select count(*) from _cc));
end $$;

revoke all on function public._agg_compact() from public, anon, authenticated;

-- Abfragen auf das neue Startdatum umstellen
do $$
declare r record; src text;
begin
  for r in select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname in ('class_players', 'class_matchups', 'matchup_matrix', 'class_quality', 'leaderboard')
  loop
    src := pg_get_functiondef(r.oid);
    src := replace(src, 'date_trunc(''week'', _from_day(p_hours))::date', '_agg_from(p_hours)');
    src := replace(src, 'date_trunc(''week'', v_from)::date', '_agg_from(p_hours)');
    execute src;
  end loop;
end $$;

-- einmal jetzt, danach am 2. jedes Monats
select public._agg_compact();
select cron.schedule('ewa-agg-compact', '17 4 2 * *', 'select public._agg_compact()');

-- Index fuer seltene Gruppengroessen mit der Fight-Id, damit die Abfrage die
-- Tabelle nicht mehr lesen muss (ersetzt den ersten Versuch)
drop index if exists public.fights_group_ts;
create index if not exists fights_group_ts2 on public.fights (ts) include (id, ws, ls) where ws > 1 or ls > 1;
drop index if exists public.fights_underdog_ts;

-- SCHRITT 2: danach diese Zeilen EINZELN nacheinander ausfuehren (jeweils
-- nur eine Zeile markieren und Run). Sie schreiben die Tabellen neu und geben
-- den Platz frei. Die Reihenfolge haelt den Speicher unter 500 MB.
--
-- vacuum full public.ratings, public.characters;
-- cluster public.agg_matchup using agg_matchup_pkey;
-- cluster public.agg_player using agg_player_pkey;
-- vacuum full public.agg_class;
-- vacuum analyze public.fights;
