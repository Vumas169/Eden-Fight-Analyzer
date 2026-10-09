-- Drei Elo-Wertungen nach der EIGENEN Seite: 1 = Solo (allein, auch 1v3),
-- 2 = Small (eigene Seite 2 bis 5), 3 = Gruppe (eigene Seite 6 und mehr).
-- Ein Duo, das gegen 6 gewinnt, spielt in Small, die 6 in Gruppe.
-- (Stand im Repo: siehe Datenbank; _elo_step wurde am 09.10. auf die eigene
-- Seite umgestellt.) Gruppen: Teamdurchschnitt gegen
-- Teamdurchschnitt, jeder Spieler bekommt die Aenderung mit seinem K
-- (32 in den ersten 30 Fights der Wertung, danach 16).
-- elo_day haelt Start- und End-Elo je Spieler und Tag (Berlin) fuer den
-- Elo-Gewinn ueber einen Zeitraum.

create table if not exists public.elo (
  bucket smallint not null, name text not null,
  rating real not null default 1500, games int not null default 0, wins int not null default 0, losses int not null default 0,
  peak real not null default 1500, last_ts timestamptz,
  primary key (bucket, name)
);
create index if not exists elo_rank on public.elo (bucket, rating desc) where games >= 20;

create table if not exists public.elo_day (
  bucket smallint not null, name text not null, day date not null,
  r_start real not null, r_end real not null, n smallint not null default 0, w smallint not null default 0,
  primary key (bucket, day, name)
);
alter table public.elo enable row level security;
alter table public.elo_day enable row level security;

create or replace function public._elo_bucket(ws int, ls int)
returns smallint language sql immutable as $$
  select case when ws = 1 and ls = 1 then 1 when greatest(ws, ls) <= 5 then 2 else 3 end::smallint
$$;

create or replace function public._elo_step(p_batch int default 20000)
returns int language plpgsql security definer set search_path = public as $$
declare
  cur text := coalesce((select value from meta where key = 'elo_cur'), '-infinity|0');
  cur_ts timestamptz := split_part(cur, '|', 1)::timestamptz;
  cur_id bigint := split_part(cur, '|', 2)::bigint;
  f record; b smallint; v_n int := 0; v_day date;
  v_ts timestamptz; v_id bigint;
begin
  for f in
    select id, ts, ws, ls, w, l from fights
    where (ts, id) > (cur_ts, cur_id) and ts < now() - interval '15 minutes'
      and cardinality(w) > 0 and cardinality(l) > 0
    order by ts, id limit p_batch
  loop
    b := _elo_bucket(f.ws, f.ls);
    v_day := (f.ts at time zone 'Europe/Berlin')::date;

    -- one statement per fight: current ratings, team averages, both upserts
    with p as (
      select x.n name, x.win, coalesce(e.rating, 1500)::real r, coalesce(e.games, 0) g
      from (select distinct on (y.n) y.n, y.win
            from (select unnest(f.w) n, true win union all select unnest(f.l), false) y
            order by y.n, y.win desc) x
      left join elo e on e.bucket = b and e.name = x.n
    ), t as (
      select avg(r) filter (where win) ra, avg(r) filter (where not win) rb from p
    ), q as (
      select p.*, p.r + (case when p.g < 30 then 32 else 16 end)
                        * (1 - 1 / (1 + power(10, (t.rb - t.ra) / 400)))
                        * (case when p.win then 1 else -1 end) r_new
      from p, t where t.ra is not null and t.rb is not null
    ), dd as (
      insert into elo_day as d (bucket, name, day, r_start, r_end, n, w)
      select b, q.name, v_day, q.r, q.r_new, 1, case when q.win then 1 else 0 end from q where f.ts >= now() - interval '35 days'
      on conflict (bucket, day, name) do update
        set r_end = excluded.r_end, n = d.n + 1, w = d.w + excluded.w
      returning 1
    )
    insert into elo as e (bucket, name, rating, games, wins, losses, peak, last_ts)
    select b, q.name, q.r_new, 1, case when q.win then 1 else 0 end, case when q.win then 0 else 1 end,
           greatest(1500, q.r_new), f.ts
    from q
    on conflict (bucket, name) do update
      set rating = excluded.rating, games = e.games + 1, wins = e.wins + excluded.wins, losses = e.losses + excluded.losses,
          peak = greatest(e.peak, excluded.rating), last_ts = greatest(e.last_ts, excluded.last_ts);

    v_n := v_n + 1;
    v_ts := f.ts; v_id := f.id;
  end loop;
  if v_n > 0 then
    insert into meta values ('elo_cur', v_ts::text || '|' || v_id) on conflict (key) do update set value = excluded.value;
    insert into meta values ('elo_built', now()::text) on conflict (key) do update set value = excluded.value;
  end if;
  return v_n;
end $$;
revoke all on function public._elo_step(int) from public, anon, authenticated;

-- Rangliste: p_kind 'rating' (aktuelle Elo, aktiv im Zeitraum, ab 20 Fights)
-- oder 'gain' (Elo-Gewinn im Zeitraum, ab 3 Fights im Zeitraum)
create or replace function public.elo_board(p_bucket int default 1, p_kind text default 'rating', p_hours int default 168,
                                            p_realm int default null, p_limit int default 25)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  lim int := least(greatest(coalesce(p_limit, 25), 1), 100);
  v_start timestamptz := case when p_hours is null then '2025-03-29 13:01 Europe/Berlin'::timestamptz
                              else now() - make_interval(hours => p_hours) end;
  v_day date := (v_start at time zone 'Europe/Berlin')::date;
  res jsonb;
begin
  if p_bucket not in (1, 2, 3) then raise exception 'bad bucket'; end if;
  if p_kind = 'rating' then
    execute $q$
      select coalesce(jsonb_agg(jsonb_build_object('n', x.name, 'c', x.class, 'r', x.realm, 'rating', round(x.rating),
               'peak', round(x.peak), 'w', x.wins, 'l', x.losses) order by x.rating desc), '[]')
      from (select e.*, ch.class, ch.realm from elo e left join characters ch on ch.name = e.name
            where e.bucket = $1 and e.games >= 20 and e.last_ts >= $2 and ($3 is null or ch.realm = $3)
            order by e.rating desc limit $4) x
    $q$ into res using p_bucket::smallint, v_start, p_realm, lim;
  elsif p_kind = 'gain' then
    execute $q$
      with g as (
        select d.name, sum(d.n)::int n, sum(d.w)::int w,
               (array_agg(d.r_end order by d.day desc))[1] - (array_agg(d.r_start order by d.day))[1] gain,
               (array_agg(d.r_end order by d.day desc))[1] r_now
        from elo_day d where d.bucket = $1 and d.day >= $2
        group by d.name having sum(d.n) >= 3
      )
      select coalesce(jsonb_agg(jsonb_build_object('n', x.name, 'c', x.class, 'r', x.realm, 'gain', round(x.gain),
               'rating', round(x.r_now), 'w', x.w, 'l', x.n - x.w) order by x.gain desc), '[]')
      from (select g.*, ch.class, ch.realm from g left join characters ch on ch.name = g.name
            where $3 is null or ch.realm = $3 order by g.gain desc limit $4) x
    $q$ into res using p_bucket::smallint, v_day, p_realm, lim;
  else
    raise exception 'bad kind';
  end if;
  return jsonb_build_object('rows', res, 'built', (select value from meta where key = 'elo_built'),
                            'cur', (select value from meta where key = 'elo_cur'));
end $$;
revoke all on function public.elo_board(int, text, int, int, int) from public;
grant execute on function public.elo_board(int, text, int, int, int) to anon, authenticated;

-- Elo eines Spielers in allen drei Wertungen: [bucket, rating, rank, peak, games, wins, losses, gain 7 Tage]
create or replace function public.player_elo(p_name text)
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_array(e.bucket, round(e.rating),
           case when e.games >= 20 then (select count(*) + 1 from elo e2 where e2.bucket = e.bucket and e2.games >= 20 and e2.rating > e.rating) end,
           round(e.peak), e.games, e.wins, e.losses,
           (select round((array_agg(d.r_end order by d.day desc))[1] - (array_agg(d.r_start order by d.day))[1])
              from elo_day d where d.bucket = e.bucket and d.name = e.name
                and d.day >= ((now() - interval '7 days') at time zone 'Europe/Berlin')::date))
         order by e.bucket), '[]')
  from elo e where e.name = (select coalesce((select c.name from characters c where lower(c.name) = lower(btrim(p_name)) limit 1), btrim(p_name)))
$$;
revoke all on function public.player_elo(text) from public;
grant execute on function public.player_elo(text) to anon, authenticated;

select cron.schedule('ewa-elo', '30 seconds', 'select public._elo_step(20000)');

-- Vom Nutzer im SQL Editor auszufuehren (enthaelt Loeschbefehle):
-- Block 1: Tagesverlauf leeren (bisher nur alte Tage) und taeglich auf 35 Tage kuerzen
-- truncate public.elo_day;
-- create or replace function public._elo_day_trim() returns void language sql security definer set search_path = public as
--   $f$ delete from elo_day where day < current_date - 35 $f$;
-- revoke all on function public._elo_day_trim() from public, anon, authenticated;
-- select cron.schedule('ewa-elo-day-trim', '41 3 * * *', 'select public._elo_day_trim()');

-- Neustart nach der Umstellung auf die eigene Seite (vom Nutzer ausgefuehrt):
-- truncate public.elo, public.elo_day;
-- delete from public.meta where key in ('elo_cur', 'elo_built');
-- select cron.alter_job((select jobid from cron.job where jobname = 'ewa-elo'), active := true);

-- 09.10.: elo_board kennt zusaetzlich p_kind 'loss' (Elo-Verlust, aufsteigend sortiert).
