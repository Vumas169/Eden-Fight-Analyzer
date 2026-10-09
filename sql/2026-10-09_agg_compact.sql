-- Datenbank verkleinern. Sieben Bloecke, EINZELN und in dieser Reihenfolge
-- ausfuehren: jeweils nur den Block markieren und Run. Die Reihenfolge haelt
-- die Datenbank waehrend des Umbaus unter 500 MB.
-- Erwartet: von rund 488 MB auf rund 385 MB.

-- ===== Block 1: ueberfluessige Indizes (rund 8 MB) =====
drop index if exists public.fights_underdog_ts;
drop index if exists public.fights_group_ts;

-- ===== Block 2: Elo und Spieler neu schreiben (rund 20 MB) =====
vacuum full public.ratings, public.characters;

-- ===== Block 3: Klasse-gegen-Klasse: aeltere Wochen zu Monaten (78 MB -> rund 33 MB) =====
lock table public.agg_matchup in exclusive mode;
create table public.agg_matchup_n (like public.agg_matchup including all);
insert into public.agg_matchup_n (wk, sz, class, realm, oclass, orealm, wins, losses)
select case when wk < date_trunc('month', now() - interval '63 days')::date then date_trunc('month', wk)::date else wk end,
       sz, class, realm, oclass, orealm, sum(wins)::int, sum(losses)::int
from public.agg_matchup group by 1, 2, 3, 4, 5, 6
order by 3, 4, 1;
drop table public.agg_matchup;
alter table public.agg_matchup_n rename to agg_matchup;
alter index public.agg_matchup_n_pkey rename to agg_matchup_pkey;
alter table public.agg_matchup enable row level security;

-- ===== Block 4: Spieler je Woche: aeltere Wochen zu Monaten (83 MB -> rund 60 MB) =====
lock table public.agg_player in exclusive mode;
create table public.agg_player_n (like public.agg_player including all);
insert into public.agg_player_n (wk, sz, name, class, realm, wins, losses)
select case when wk < date_trunc('month', now() - interval '63 days')::date then date_trunc('month', wk)::date else wk end,
       sz, name, max(class), max(realm), sum(wins)::int, sum(losses)::int
from public.agg_player group by 1, 2, 3
order by max(class), max(realm), 1;
drop table public.agg_player;
alter table public.agg_player_n rename to agg_player;
alter index public.agg_player_n_pkey rename to agg_player_pkey;
alter index public.agg_player_n_class_realm_wk_idx rename to agg_player_cls;
alter table public.agg_player enable row level security;

-- ===== Block 5: Klassen je Tag: aelter als 100 Tage zu Monaten (17 MB -> rund 4 MB) =====
lock table public.agg_class in exclusive mode;
create table public.agg_class_n (like public.agg_class including all);
insert into public.agg_class_n (d, sz, class, realm, wins, losses)
select case when d < date_trunc('month', now() - interval '100 days')::date then date_trunc('month', d)::date else d end,
       sz, class, realm, sum(wins)::int, sum(losses)::int
from public.agg_class group by 1, 2, 3, 4;
drop table public.agg_class;
alter table public.agg_class_n rename to agg_class;
alter index public.agg_class_n_pkey rename to agg_class_pkey;
alter table public.agg_class enable row level security;

-- ===== Block 6: monatliches Zusammenfassen ab jetzt automatisch, schneller Index =====
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

  return jsonb_build_object('player', n_p, 'matchup', n_m, 'class', n_c);
end $$;
revoke all on function public._agg_compact() from public, anon, authenticated;
select cron.schedule('ewa-agg-compact', '17 4 2 * *', 'select public._agg_compact()');
create index if not exists fights_group_ts2 on public.fights (ts) include (id, ws, ls) where ws > 1 or ls > 1;

-- ===== Block 7: Statistik der Fights-Tabelle auffrischen =====
vacuum analyze public.fights;
