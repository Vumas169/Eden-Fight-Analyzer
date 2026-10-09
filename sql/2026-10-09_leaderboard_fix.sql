-- Leaderboard: Underdog schneller (Teilindex nur auf Underdog-Fights),
-- Realm-Filter vor dem Limit (vorher kamen mit Realm-Filter zu wenige Zeilen),
-- temporaere Tabelle wird vorher entfernt (zwei Aufrufe in einer Transaktion).

create index if not exists fights_underdog_cover on public.fights (ts) include (id, ws, ls, w) where ws < ls;
drop index if exists public.fights_underdog_ts; -- erster Versuch, ersetzt durch den Index darueber

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
    drop table if exists _lb;
    create temporary table _lb on commit drop as
      select name, max(class) class, max(realm) realm, sum(wins)::int w, sum(losses)::int l
      from agg_player
      where wk >= date_trunc('week', v_from)::date and (p_size is null or sz = p_size) and (p_realm is null or realm = p_realm)
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
    with u as materialized (
      select f.id, f.ts, f.ls - f.ws gap, n
      from fights f, unnest(f.w) n
      where f.ws < f.ls and f.ts >= v_start and (p_size is null or least(f.ws, 8) = p_size)
    ), a as (
      select n, count(*) c, max(gap) best from u group by n
    ), top as (
      select a.*, ch.class, ch.realm from a left join characters ch on ch.name = a.n
      where p_realm is null or ch.realm = p_realm
      order by a.c desc, a.best desc limit lim
    )
    select coalesce(jsonb_agg(jsonb_build_object('n', t.n, 'c', t.class, 'r', t.realm, 'w', t.c, 'best', t.best,
             'fid', (select _to_b36(u.id) from u where u.n = t.n order by u.gap desc, u.ts desc limit 1))
           order by t.c desc, t.best desc), '[]') into res
    from top t;
    return jsonb_build_object('rows', res);

  elsif p_kind = 'streak' then
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
          group by name order by 2 desc limit lim * 20) s
    left join characters ch on ch.name = s.name
    where p_realm is null or ch.realm = p_realm;
    return jsonb_build_object('rows', coalesce((select jsonb_agg(e) from (select e from jsonb_array_elements(res) e limit lim) t), '[]'), 'days', 30);

  elsif p_kind = 'rating' then
    select coalesce(jsonb_agg(jsonb_build_object('n', r.name, 'c', r.class, 'r', r.realm, 'w', r.wins, 'l', r.losses,
                                                  'rating', round(r.rating), 'peak', round(r.peak)) order by r.rating desc), '[]') into res
    from (select r.*, ch.class, ch.realm from ratings r
          left join characters ch on ch.name = r.name
          where r.games >= 20 and r.last_ts >= v_start and (p_realm is null or ch.realm = p_realm)
          order by r.rating desc limit lim) r;
    return jsonb_build_object('rows', res, 'built', (select value from meta where key = 'ratings_built'));
  end if;
  raise exception 'bad kind';
end $$;
