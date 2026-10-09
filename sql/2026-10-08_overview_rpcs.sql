-- Overview, leaderboards, class quality, matchup matrix, activity, player
-- profile and a solo rating (Elo). Read-only functions plus one ratings table.

create table if not exists public.ratings (
  name text primary key,
  rating real not null,
  games int not null,
  wins int not null,
  losses int not null,
  peak real not null,
  last_ts timestamptz
);
alter table public.ratings enable row level security;
create index if not exists ratings_rating on public.ratings (rating desc) where games >= 20;
create index if not exists fights_zone_ts on public.fights (ts) where zone is not null;

-- Solo rating (Elo) from every 1v1 fight in order. K 32 for the first 30
-- fights, then 16. Start 1500. Rebuilt at night; new fights in between
-- are added by _update_ratings().
create or replace function public._rebuild_ratings()
returns int
language plpgsql security definer set search_path = public set statement_timeout = '20min' as $$
declare
  f record; ra real; rb real; ga int; gb int; ea real; ka real; kb real; n int := 0;
begin
  create temporary table _r (name text primary key, rating real, games int, wins int, losses int, peak real, last_ts timestamptz) on commit drop;
  for f in select ts, w[1] a, l[1] b from fights where ws = 1 and ls = 1 order by ts, id loop
    insert into _r values (f.a, 1500, 0, 0, 0, 1500, null) on conflict do nothing;
    insert into _r values (f.b, 1500, 0, 0, 0, 1500, null) on conflict do nothing;
    select rating, games into ra, ga from _r where name = f.a;
    select rating, games into rb, gb from _r where name = f.b;
    ea := 1 / (1 + power(10, (rb - ra) / 400));
    ka := case when ga < 30 then 32 else 16 end;
    kb := case when gb < 30 then 32 else 16 end;
    update _r set rating = ra + ka * (1 - ea), games = games + 1, wins = wins + 1,
                  peak = greatest(peak, ra + ka * (1 - ea)), last_ts = f.ts where name = f.a;
    update _r set rating = rb - kb * (1 - ea), games = games + 1, losses = losses + 1, last_ts = f.ts where name = f.b;
    n := n + 1;
  end loop;
  insert into ratings select * from _r
  on conflict (name) do update set rating = excluded.rating, games = excluded.games, wins = excluded.wins,
    losses = excluded.losses, peak = excluded.peak, last_ts = excluded.last_ts;
  insert into meta values ('ratings_cursor', (select coalesce(max(created_at), now())::text from fights))
  on conflict (key) do update set value = excluded.value;
  insert into meta values ('ratings_built', now()::text) on conflict (key) do update set value = excluded.value;
  return n;
end $$;

create or replace function public._update_ratings()
returns int
language plpgsql security definer set search_path = public set statement_timeout = '5min' as $$
declare
  f record; ra real; rb real; ga int; gb int; ea real; ka real; kb real; n int := 0;
  v_from timestamptz := coalesce((select value::timestamptz from meta where key = 'ratings_cursor'), now());
  v_to timestamptz := (select max(created_at) from fights);
begin
  if v_to is null or v_to <= v_from then return 0; end if;
  for f in select ts, w[1] a, l[1] b from fights
           where ws = 1 and ls = 1 and created_at > v_from and created_at <= v_to order by ts, id loop
    insert into ratings values (f.a, 1500, 0, 0, 0, 1500, null) on conflict do nothing;
    insert into ratings values (f.b, 1500, 0, 0, 0, 1500, null) on conflict do nothing;
    select rating, games into ra, ga from ratings where name = f.a;
    select rating, games into rb, gb from ratings where name = f.b;
    ea := 1 / (1 + power(10, (rb - ra) / 400));
    ka := case when ga < 30 then 32 else 16 end;
    kb := case when gb < 30 then 32 else 16 end;
    update ratings set rating = ra + ka * (1 - ea), games = games + 1, wins = wins + 1,
                       peak = greatest(peak, ra + ka * (1 - ea)), last_ts = greatest(last_ts, f.ts) where name = f.a;
    update ratings set rating = rb - kb * (1 - ea), games = games + 1, losses = losses + 1,
                       last_ts = greatest(last_ts, f.ts) where name = f.b;
    n := n + 1;
  end loop;
  insert into meta values ('ratings_cursor', v_to::text) on conflict (key) do update set value = excluded.value;
  return n;
end $$;

-- Server pulse for the overview: last 24 hours
create or replace function public.server_pulse()
returns jsonb
language sql stable security definer set search_path = public as $$
  with d as (select * from fights where ts >= now() - interval '24 hours'),
  parts as (
    select n, true win, d.ts from d, unnest(d.w) n
    union all
    select n, false, d.ts from d, unnest(d.l) n
  )
  select jsonb_build_object(
    'now', now(),
    'today', (select count(*) from fights where ts >= (date_trunc('day', now() at time zone 'Europe/Berlin') at time zone 'Europe/Berlin')),
    'day', (select count(*) from d),
    'active', (select count(distinct n) from parts),
    'last', (select max(ts) from d),
    'hours', (select coalesce(jsonb_agg(jsonb_build_array(extract(epoch from h)::bigint, c) order by h), '[]')
              from (select date_trunc('hour', ts) h, count(*) c from d group by 1) x),
    'sizes', (select coalesce(jsonb_agg(jsonb_build_array(s, c) order by s), '[]')
              from (select least(greatest(ws, ls), 8) s, count(*) c from d group by 1) x),
    'zones', (select coalesce(jsonb_agg(jsonb_build_array(zone, c) order by c desc), '[]')
              from (select zone, count(*) c from d where zone is not null group by 1 order by 2 desc limit 8) x),
    'kills_hour', (select coalesce(jsonb_agg(jsonb_build_array(p.n, ch.class, ch.realm, p.c) order by p.c desc), '[]')
              from (select n, count(*) c from parts where win and ts >= now() - interval '1 hour' group by n order by 2 desc limit 5) p
              left join characters ch on ch.name = p.n),
    'classes', (select coalesce(jsonb_agg(jsonb_build_array(x.class, x.realm, x.c, x.p) order by x.c desc), '[]')
              from (select ch.class, ch.realm, count(*) c, count(distinct p.n) p
                    from parts p join characters ch on ch.name = p.n where ch.class is not null
                    group by 1, 2 order by 3 desc limit 10) x),
    'underdogs', (select coalesce(jsonb_agg(jsonb_build_array(_to_b36(id), extract(epoch from ts)::bigint, ws, ls, wr, lr, w, l, zone) order by ls - ws desc, ts desc), '[]')
              from (select * from d where ws < ls order by ls - ws desc, ts desc limit 6) x),
    'streaks', (select coalesce(jsonb_agg(jsonb_build_array(s.name, ch.class, ch.realm, s.len) order by s.len desc), '[]')
              from (select name, max(len) len from (
                      select name, count(*) len from (
                        select n name, win, row_number() over (partition by n order by ts) - row_number() over (partition by n, win order by ts) grp
                        from parts) g
                      where win group by name, grp) s0
                    group by name order by 2 desc limit 5) s
              left join characters ch on ch.name = s.name)
  )
$$;

-- Leaderboards. p_kind: wins, active, winrate, underdog, streak, rating.
-- Win rate only counts players with enough fights: at least 10, more where
-- many active players are in the list (fight-weighted lower quartile).
create or replace function public.leaderboard(p_kind text, p_hours int default 168, p_size int default null,
                                              p_realm int default null, p_limit int default 20)
returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare
  v_from date := _from_day(p_hours);
  v_start timestamptz := case when p_hours is null then '2025-03-29 13:01 Europe/Berlin'::timestamptz
                              else now() - make_interval(hours => p_hours) end;
  lim int := least(greatest(coalesce(p_limit, 20), 1), 100);
  res jsonb;
  thr int;
begin
  if p_size is not null and (p_size < 1 or p_size > 8) then raise exception 'bad size'; end if;

  if p_kind in ('wins', 'active', 'winrate') then
    create temporary table _lb on commit drop as
      select name, max(class) class, max(realm) realm, sum(wins)::int w, sum(losses)::int l
      from mv_player_day
      where d >= v_from and (p_size is null or sz = p_size) and (p_realm is null or realm = p_realm)
      group by name;
    select greatest(10, coalesce(min(n) filter (where cum >= tot * 0.25), 0)) into thr
    from (select w + l n, sum(w + l) over (order by w + l rows unbounded preceding) cum, sum(w + l) over () tot from _lb) q;

    select coalesce(jsonb_agg(jsonb_build_object('n', name, 'c', class, 'r', realm, 'w', w, 'l', l)), '[]') into res
    from (select * from _lb
          where p_kind <> 'winrate' or w + l >= thr
          order by case when p_kind = 'wins' then w when p_kind = 'active' then w + l end desc nulls last,
                   case when p_kind = 'winrate' then w::float / greatest(w + l, 1) end desc nulls last,
                   w + l desc
          limit lim) x;
    return jsonb_build_object('min', thr, 'rows', res);

  elsif p_kind = 'underdog' then
    select coalesce(jsonb_agg(jsonb_build_object('n', x.n, 'c', ch.class, 'r', ch.realm, 'w', x.c, 'best', x.best, 'fid', x.fid) order by x.c desc, x.best desc), '[]') into res
    from (select n, count(*) c, max(f.ls - f.ws) best,
                 _to_b36((array_agg(f.id order by f.ls - f.ws desc, f.ts desc))[1]) fid
          from fights f, unnest(f.w) n
          where f.ts >= v_start and f.ws < f.ls and (p_size is null or least(f.ws, 8) = p_size)
          group by n order by 2 desc, 3 desc limit lim) x
    left join characters ch on ch.name = x.n
    where p_realm is null or ch.realm = p_realm;
    return jsonb_build_object('rows', res);

  elsif p_kind = 'streak' then
    -- longest win streak, at most the last 30 days (otherwise too much work)
    v_start := greatest(v_start, now() - interval '30 days');
    select coalesce(jsonb_agg(jsonb_build_object('n', s.name, 'c', ch.class, 'r', ch.realm, 'w', s.len) order by s.len desc), '[]') into res
    from (select name, max(len) len from (
            select name, count(*) len from (
              select name, win, row_number() over (partition by name order by ts) - row_number() over (partition by name, win order by ts) grp
              from (select n name, true win, f.ts from fights f, unnest(f.w) n
                    where f.ts >= v_start and (p_size is null or least(f.ws, 8) = p_size)
                    union all
                    select n, false, f.ts from fights f, unnest(f.l) n
                    where f.ts >= v_start and (p_size is null or least(f.ls, 8) = p_size)) p) g
            where win group by name, grp) s0
          group by name order by 2 desc limit lim * 3) s
    left join characters ch on ch.name = s.name
    where p_realm is null or ch.realm = p_realm;
    return jsonb_build_object('rows', coalesce((select jsonb_agg(e) from (select e from jsonb_array_elements(res) e limit lim) t), '[]'), 'days', 30);

  elsif p_kind = 'rating' then
    select coalesce(jsonb_agg(jsonb_build_object('n', r.name, 'c', ch.class, 'r', ch.realm, 'w', r.wins, 'l', r.losses,
                                                  'rating', round(r.rating), 'peak', round(r.peak)) order by r.rating desc), '[]') into res
    from (select * from ratings r
          where r.games >= 20 and r.last_ts >= v_start
          order by r.rating desc limit lim * 3) r
    left join characters ch on ch.name = r.name
    where p_realm is null or ch.realm = p_realm;
    return jsonb_build_object('rows', coalesce((select jsonb_agg(e) from (select e from jsonb_array_elements(res) e limit lim) t), '[]'),
                              'built', (select value from meta where key = 'ratings_built'));
  end if;
  raise exception 'bad kind';
end $$;

-- Class quality: like the class table, plus how the class does with
-- experienced players. Qualified = at least 20 fights and 5 wins this
-- season (all group sizes). Mid 80 = fight-weighted win rate after leaving
-- out the best and the worst 10 % of qualified players of that class.
create or replace function public.class_quality(p_hours int default null, p_size int default null)
returns jsonb
language sql stable security definer set search_path = public as $$
  with season as (
    select name, sum(wins) w, sum(wins + losses) n from mv_player_day group by name
  ), p as (
    select m.name, m.class, m.realm, sum(m.wins)::float w, sum(m.wins + m.losses)::float n
    from mv_player_day m join season s on s.name = m.name and s.n >= 20 and s.w >= 5
    where m.d >= _from_day(p_hours) and (p_size is null or m.sz = p_size)
    group by 1, 2, 3
  ), r as (
    select *, w / n rate,
           percent_rank() over (partition by class, realm order by w / n) pr,
           count(*) over (partition by class, realm) cnt
    from p where n > 0
  )
  select coalesce(jsonb_agg(jsonb_build_array(class, realm, players, fights, fight_wr, player_avg, mid80, rating)), '[]')
  from (
    select r.class, r.realm, count(*) players, sum(n)::int fights,
           round((sum(w) / sum(n) * 100)::numeric, 1) fight_wr,
           round((avg(rate) * 100)::numeric, 1) player_avg,
           case when max(cnt) >= 10 then round((sum(w) filter (where pr between 0.1 and 0.9) /
                nullif(sum(n) filter (where pr between 0.1 and 0.9), 0) * 100)::numeric, 1) end mid80,
           (select round(avg(ra.rating)) from ratings ra join characters ch on ch.name = ra.name
             where ch.class = r.class and ch.realm = r.realm and ra.games >= 20) rating
    from r group by r.class, r.realm
  ) x
$$;

-- Every class against every class, for the heat map
create or replace function public.matchup_matrix(p_hours int default null, p_size int default null)
returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_array(class, realm, oclass, orealm, w, l)), '[]')
  from (
    select class, realm, oclass, orealm, sum(wins)::int w, sum(losses)::int l
    from mv_matchup_week
    where wk >= date_trunc('week', _from_day(p_hours))::date and (p_size is null or sz = p_size)
    group by 1, 2, 3, 4
  ) x
$$;

-- Fights per weekday and hour (Berlin time), at most 90 days back
create or replace function public.activity_heat(p_days int default 30, p_size int default null)
returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_array(dow, h, c)), '[]')
  from (
    select extract(isodow from ts at time zone 'Europe/Berlin')::int dow,
           extract(hour from ts at time zone 'Europe/Berlin')::int h, count(*)::int c
    from fights
    where ts >= now() - make_interval(days => least(greatest(coalesce(p_days, 30), 1), 90))
      and (p_size is null or least(ws, 8) = p_size or least(ls, 8) = p_size)
    group by 1, 2
  ) x
$$;

-- One player: solo rating and record against each enemy class
create or replace function public.player_profile(p_name text, p_hours int default null, p_size int default null)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_name text;
  v_start timestamptz := case when p_hours is null then '2025-03-29 13:01 Europe/Berlin'::timestamptz
                              else now() - make_interval(hours => p_hours) end;
begin
  if p_name is null or length(p_name) > 30 then raise exception 'bad name'; end if;
  select c.name into v_name from characters c where lower(c.name) = lower(btrim(p_name)) limit 1;
  v_name := coalesce(v_name, btrim(p_name));
  return jsonb_build_object(
    'name', v_name,
    'class', (select class from characters where name = v_name),
    'rating', (select jsonb_build_object('rating', round(rating), 'peak', round(peak), 'games', games, 'wins', wins, 'losses', losses,
                      'rank', (select count(*) + 1 from ratings r2 where r2.games >= 20 and r2.rating > r.rating))
               from ratings r where r.name = v_name),
    'vs', (select coalesce(jsonb_agg(jsonb_build_array(class, realm, w, l) order by w + l desc), '[]')
           from (select ch.class, ch.realm, count(*) filter (where x.win)::int w, count(*) filter (where not x.win)::int l
                 from (select o, true win from fights f, unnest(f.l) o
                       where f.w @> array[v_name] and f.ts >= v_start and (p_size is null or least(f.ws, 8) = p_size)
                       union all
                       select o, false from fights f, unnest(f.w) o
                       where f.l @> array[v_name] and f.ts >= v_start and (p_size is null or least(f.ls, 8) = p_size)) x
                 join characters ch on ch.name = x.o
                 where ch.class is not null
                 group by 1, 2) v),
    'zones', (select coalesce(jsonb_agg(jsonb_build_array(zone, w, l) order by w + l desc), '[]')
              from (select zone, count(*) filter (where f.w @> array[v_name])::int w, count(*) filter (where f.l @> array[v_name])::int l
                    from fights f where (f.w @> array[v_name] or f.l @> array[v_name]) and f.ts >= v_start and zone is not null
                    group by zone order by count(*) desc limit 6) z)
  );
end $$;

revoke all on function public._rebuild_ratings(), public._update_ratings() from public, anon, authenticated;
revoke all on function public.server_pulse(), public.leaderboard(text, int, int, int, int), public.class_quality(int, int),
  public.matchup_matrix(int, int), public.activity_heat(int, int), public.player_profile(text, int, int) from public;
grant execute on function public.server_pulse(), public.leaderboard(text, int, int, int, int), public.class_quality(int, int),
  public.matchup_matrix(int, int), public.activity_heat(int, int), public.player_profile(text, int, int) to anon, authenticated;

-- ratings: new fights every 15 minutes, full rebuild every night at 5:30 Berlin (3:30 UTC)
select cron.schedule('ewa-ratings-update', '7,22,37,52 * * * *', 'select public._update_ratings()');
select cron.schedule('ewa-ratings-rebuild', '30 3 * * *', 'select public._rebuild_ratings()');
