-- Gruppengroesse aus Sicht jedes Spielers: die Groesse der eigenen Seite.
-- 1v3: fuer den Einzelnen Solo, fuer die drei 3v3. Bis 8, groesser zaehlt als 8.

drop materialized view if exists public.mv_class_day;
drop materialized view if exists public.mv_player_day;
drop materialized view if exists public.mv_fights_day;
drop materialized view if exists public.mv_matchup_week;

create materialized view public.mv_class_day as
with s as (
  select distinct f.id, (f.ts at time zone 'Europe/Berlin')::date as d, x.sz, x.win, c.class, c.realm
  from fights f
  cross join lateral (
    select n, true as win, least(f.ws, 8)::smallint as sz from unnest(f.w) n
    union all
    select n, false, least(f.ls, 8)::smallint from unnest(f.l) n
  ) x
  join characters c on c.name = x.n
  where c.class is not null
)
select d, sz, class, realm,
       (count(*) filter (where win))::int as wins,
       (count(*) filter (where not win))::int as losses
from s group by d, sz, class, realm;
create unique index mv_class_day_pk on public.mv_class_day(d, sz, class, realm);

create materialized view public.mv_player_day as
select (f.ts at time zone 'Europe/Berlin')::date as d, x.sz, c.class, c.realm, c.name,
       (count(*) filter (where x.win))::int as wins,
       (count(*) filter (where not x.win))::int as losses
from fights f
cross join lateral (
  select n, true as win, least(f.ws, 8)::smallint as sz from unnest(f.w) n
  union all
  select n, false, least(f.ls, 8)::smallint from unnest(f.l) n
) x
join characters c on c.name = x.n
where c.class is not null
group by 1, 2, 3, 4, 5;
create unique index mv_player_day_pk on public.mv_player_day(d, sz, name, class, realm);
create index mv_player_day_class on public.mv_player_day(class, realm, d);

-- Fights je Gruppengroesse: ein 1v3 zaehlt einmal als Solo und einmal als 3er
create materialized view public.mv_fights_day as
select (f.ts at time zone 'Europe/Berlin')::date as d, v.sz, count(distinct f.id)::int as n
from fights f
cross join lateral (values (least(f.ws, 8)::smallint), (least(f.ls, 8)::smallint)) v(sz)
group by 1, 2;
create unique index mv_fights_day_pk on public.mv_fights_day(d, sz);

create materialized view public.mv_matchup_week as
with s as (
  select distinct f.id, date_trunc('week', f.ts at time zone 'Europe/Berlin')::date as wk, x.sz, x.win, c.class, c.realm
  from fights f
  cross join lateral (
    select n, true as win, least(f.ws, 8)::smallint as sz from unnest(f.w) n
    union all
    select n, false, least(f.ls, 8)::smallint from unnest(f.l) n
  ) x
  join characters c on c.name = x.n
  where c.class is not null
)
select a.wk, a.sz, a.class, a.realm, b.class as oclass, b.realm as orealm,
       (count(*) filter (where a.win))::int as wins,
       (count(*) filter (where not a.win))::int as losses
from s a join s b on a.id = b.id and a.win <> b.win
group by 1, 2, 3, 4, 5, 6;
create unique index mv_matchup_week_pk on public.mv_matchup_week(wk, sz, class, realm, oclass, orealm);
create index mv_matchup_week_cls on public.mv_matchup_week(class, realm, wk);

revoke all on public.mv_class_day, public.mv_player_day, public.mv_fights_day, public.mv_matchup_week from anon, authenticated;

create or replace function public._class_rows(p_from timestamptz, p_after timestamptz)
returns table(sz smallint, class smallint, realm smallint, wins int, losses int)
language sql stable set search_path = public as $$
  with s as (
    select distinct f.id, x.sz as fsz, x.win, c.class as cl, c.realm as rl
    from fights f
    cross join lateral (
      select n, true as win, least(f.ws, 8)::smallint as sz from unnest(f.w) n
      union all
      select n, false, least(f.ls, 8)::smallint from unnest(f.l) n
    ) x
    join characters c on c.name = x.n
    where f.ts >= p_from and f.created_at > p_after and c.class is not null
  )
  select fsz, cl, rl, (count(*) filter (where win))::int, (count(*) filter (where not win))::int
  from s group by fsz, cl, rl
$$;

create or replace function public._player_rows(p_from timestamptz, p_after timestamptz, p_size int, p_class int, p_realm int)
returns table(name text, wins int, losses int)
language sql stable set search_path = public as $$
  with x as (
    select n, true as win, least(f.ws, 8) as sz from fights f, unnest(f.w) n
    where f.ts >= p_from and f.created_at > p_after
    union all
    select n, false, least(f.ls, 8) from fights f, unnest(f.l) n
    where f.ts >= p_from and f.created_at > p_after
  )
  select c.name, (count(*) filter (where x.win))::int, (count(*) filter (where not x.win))::int
  from x join characters c on c.name = x.n
  where c.class = p_class and c.realm = p_realm and (p_size is null or x.sz = p_size)
  group by c.name
$$;

create or replace function public._matchup_rows(p_from timestamptz, p_after timestamptz, p_size int, p_class int, p_realm int)
returns table(oclass smallint, orealm smallint, wins int, losses int)
language sql stable set search_path = public as $$
  with s as (
    select distinct f.id, x.sz, x.win, c.class as cl, c.realm as rl
    from fights f
    cross join lateral (
      select n, true as win, least(f.ws, 8)::smallint as sz from unnest(f.w) n
      union all
      select n, false, least(f.ls, 8)::smallint from unnest(f.l) n
    ) x
    join characters c on c.name = x.n
    where f.ts >= p_from and f.created_at > p_after and c.class is not null
  )
  select b.cl, b.rl, (count(*) filter (where a.win))::int, (count(*) filter (where not a.win))::int
  from s a join s b on a.id = b.id and a.win <> b.win
  where a.cl = p_class and a.rl = p_realm and (p_size is null or a.sz = p_size)
  group by b.cl, b.rl
$$;

create or replace function public.fight_counts(p_hours int default null)
returns table(sz smallint, n int)
language plpgsql stable security definer set search_path = public as $$
begin
  if p_hours is not null and p_hours <= 168 then
    return query
    select v.sz, count(distinct f.id)::int from fights f
    cross join lateral (values (least(f.ws, 8)::smallint), (least(f.ls, 8)::smallint)) v(sz)
    where f.ts >= now() - make_interval(hours => p_hours) group by 1;
  else
    return query
    select t.sz, sum(t.n)::int from (
      select m.sz, m.n from mv_fights_day m where m.d >= _from_day(p_hours)
      union all
      select v.sz, count(distinct f.id)::int from fights f
      cross join lateral (values (least(f.ws, 8)::smallint), (least(f.ls, 8)::smallint)) v(sz)
      where f.ts >= _day_start(p_hours) and f.created_at > _snap() group by 1
    ) t group by t.sz;
  end if;
end $$;

revoke execute on function public._class_rows(timestamptz, timestamptz),
  public._player_rows(timestamptz, timestamptz, int, int, int),
  public._matchup_rows(timestamptz, timestamptz, int, int, int) from public, anon, authenticated;

select public.refresh_stats();
