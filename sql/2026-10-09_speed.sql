-- Schnellere Abfragen fuer die Web-App (gemessen als anon mit 10 s Limit):
-- class_quality (bis 10,5 s), matchup_matrix (bis 11 s), fights_feed mit
-- seltener Gruppengroesse ueber die Season (bis 16 s), db_info (bis 3,8 s).
-- Nichts wird geloescht.

-- Spieler, die fuer die Klassen-Qualitaet zaehlen (Season: 20 Fights, 5 Siege).
-- Einmal qualifiziert bleibt ein Spieler drin, daher reicht Einfuegen.
create table if not exists public.quality_players (name text primary key);
-- Durchschnittliche 1v1-Elo je Klasse
create table if not exists public.class_elo (class smallint, realm smallint, rating int, primary key (class, realm));
alter table public.quality_players enable row level security;
alter table public.class_elo enable row level security;

create or replace function public._quality_refresh()
returns void language plpgsql security definer set search_path = public as $$
begin
  insert into quality_players(name)
  select name from agg_player group by name having sum(wins + losses) >= 20 and sum(wins) >= 5
  on conflict do nothing;
  insert into class_elo(class, realm, rating)
  select ch.class, ch.realm, round(avg(ra.rating))::int
  from ratings ra join characters ch on ch.name = ra.name
  where ra.games >= 20 and ch.class is not null and ch.realm is not null
  group by ch.class, ch.realm
  on conflict (class, realm) do update set rating = excluded.rating;
end $$;
revoke all on function public._quality_refresh() from public, anon, authenticated;
select public._quality_refresh();
select cron.schedule('ewa-quality-refresh', '23 * * * *', 'select public._quality_refresh()');

create or replace function public.class_quality(p_hours int default null, p_size int default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_wk date := date_trunc('week', _from_day(p_hours))::date;
  res jsonb;
begin
  execute $q$
    with p as (
      select m.name, m.class, m.realm, sum(m.wins)::float w, sum(m.wins + m.losses)::float n
      from agg_player m join quality_players q on q.name = m.name
      where m.wk >= $1 and ($2 is null or m.sz = $2)
      group by 1, 2, 3
    ), r as (
      select *, w / n rate,
             percent_rank() over (partition by class, realm order by w / n) pr,
             count(*) over (partition by class, realm) cnt
      from p where n > 0
    )
    select coalesce(jsonb_agg(jsonb_build_array(x.class, x.realm, x.players, x.fights, x.fight_wr, x.player_avg, x.mid80, e.rating)), '[]')
    from (
      select r.class, r.realm, count(*) players, sum(n)::int fights,
             round((sum(w) / sum(n) * 100)::numeric, 1) fight_wr,
             round((avg(rate) * 100)::numeric, 1) player_avg,
             case when max(cnt) >= 10 then round((sum(w) filter (where pr between 0.1 and 0.9) /
                  nullif(sum(n) filter (where pr between 0.1 and 0.9), 0) * 100)::numeric, 1) end mid80
      from r group by r.class, r.realm
    ) x left join class_elo e on e.class = x.class and e.realm = x.realm
  $q$ into res using v_wk, p_size;
  return res;
end $$;

-- Matrix: je Klasse ein Bereich des Primaerschluessels statt der ganzen Tabelle
create or replace function public.matchup_matrix(p_hours int default null, p_size int default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_wk date := date_trunc('week', _from_day(p_hours))::date;
  res jsonb;
begin
  execute $q$
    select coalesce(jsonb_agg(jsonb_build_array(cr.class, cr.realm, x.oclass, x.orealm, x.w, x.l)), '[]')
    from (select distinct class, realm from class_elo) cr
    cross join lateral (
      select a.oclass, a.orealm, sum(a.wins)::int w, sum(a.losses)::int l
      from agg_matchup a
      where a.class = cr.class and a.realm = cr.realm and a.wk >= $1 and ($2 is null or a.sz = $2)
      group by a.oclass, a.orealm
    ) x
  $q$ into res using v_wk, p_size;
  return res;
end $$;

-- Gruppen-Fights (eine Seite ab 2) mit Groessen im Index: seltene Groessen
-- ueber lange Zeitraeume ohne Lesen der ganzen Tabelle
create index if not exists fights_group_ts on public.fights (ts) include (ws, ls)
  where ws > 1 or ls > 1;

create or replace function public.fights_feed(p_name text default null, p_hours int default null,
                                              p_size int default null, p_limit int default 3000)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_name text;
  v_from timestamptz;
  v_limit int := least(greatest(coalesce(p_limit, 3000), 1), 5000);
  v_rows jsonb;
  v_total int;
  v_crawled boolean;
begin
  if p_hours is not null and (p_hours < 1 or p_hours > 100000) then raise exception 'bad hours'; end if;
  if p_size is not null and (p_size < 1 or p_size > 8) then raise exception 'bad size'; end if;

  if p_name is not null and btrim(p_name) <> '' then
    if length(p_name) > 30 then raise exception 'bad name'; end if;
    select c.name into v_name from characters c where lower(c.name) = lower(btrim(p_name)) limit 1;
    v_name := coalesce(v_name, btrim(p_name));

    select count(*)::int into v_total from fights f
    where f.w @> array[v_name] or f.l @> array[v_name];

    select coalesce(jsonb_agg(jsonb_build_array(_to_b36(f.id), extract(epoch from f.ts)::bigint,
             f.ws, f.ls, f.wr, f.lr, f.dur, f.w, f.l, f.zone) order by f.ts desc), '[]'::jsonb)
    into v_rows
    from (select * from fights f
          where f.w @> array[v_name] or f.l @> array[v_name]
          order by f.ts desc limit v_limit) f;

    select cr.done_at is not null into v_crawled from crawl cr where cr.name = v_name and cr.size = 0;
  else
    v_from := case when p_hours is null
                then coalesce((select value::timestamptz from meta where key = 'season_start'), '2025-03-29 12:01+00')
                else now() - make_interval(hours => p_hours) end;

    if p_size is not null and (p_hours is null or p_hours > 168) then
      -- days from the summary table: one side has this size
      select coalesce(sum(n), 0)::int into v_total from agg_fights
      where d >= (v_from at time zone 'Europe/Berlin')::date and sz = p_size;
    else
      execute 'select count(*)::int from fights f where f.ts >= $1 and ($2 is null or least(f.ws, 8) = $2 or least(f.ls, 8) = $2)'
        into v_total using v_from, p_size;
    end if;

    if p_size is not null and p_size > 1 then
      execute $q$
        select coalesce(jsonb_agg(jsonb_build_array(_to_b36(f.id), extract(epoch from f.ts)::bigint,
                 f.ws, f.ls, f.wr, f.lr, f.dur, f.w, f.l, f.zone) order by f.ts desc), '[]'::jsonb)
        from fights f
        where f.id in (select g.id from fights g
                       where (g.ws > 1 or g.ls > 1) and g.ts >= $1 and (least(g.ws, 8) = $2 or least(g.ls, 8) = $2)
                       order by g.ts desc limit $3)
      $q$ into v_rows using v_from, p_size, v_limit;
    else
      execute $q$
        select coalesce(jsonb_agg(jsonb_build_array(_to_b36(f.id), extract(epoch from f.ts)::bigint,
                 f.ws, f.ls, f.wr, f.lr, f.dur, f.w, f.l, f.zone) order by f.ts desc), '[]'::jsonb)
        from (select * from fights f
              where f.ts >= $1 and ($2 is null or least(f.ws, 8) = $2 or least(f.ls, 8) = $2)
              order by f.ts desc limit $3) f
      $q$ into v_rows using v_from, p_size, v_limit;
    end if;
  end if;

  return jsonb_build_object(
    'name', v_name,
    'total', v_total,
    'crawled', coalesce(v_crawled, false),
    'last_poll', (select value from meta where key = 'last_list_poll'),
    'rows', v_rows
  );
end $$;

-- db_info: Zahl der Fights aus der Statistik statt Zaehlen (fast genau)
create or replace function public.db_info()
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'fights', (select greatest(reltuples, 0)::bigint from pg_class where oid = 'public.fights'::regclass),
    'first', (select min(ts) from fights),
    'last', (select max(ts) from fights),
    'chars', (select greatest(reltuples, 0)::bigint from pg_class where oid = 'public.characters'::regclass),
    'chars_unknown', (select count(*) from characters where class is null),
    'crawl_open', (select count(*) from crawl where done_at is null),
    'crawl_total', (select count(*) from crawl),
    'complete_since', (select value from meta where key = 'complete_since'),
    'last_list_poll', (select value from meta where key = 'last_list_poll'),
    'refreshed', (select value from meta where key = 'mv_refreshed')
  )
$$;
