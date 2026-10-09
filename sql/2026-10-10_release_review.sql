-- Release review 10.10.2026, Teil A (von Claude angewendet, nichts wird geloescht).
-- Teil B mit Loeschungen steht in 2026-10-10_release_cleanup_USER.sql und wird vom Nutzer
-- im SQL Editor ausgefuehrt.

-- A1. Tabellenrechte: Die App greift nur ueber security-definer-Funktionen zu. Direkte Rechte
-- fuer anon/authenticated (Supabase-Standard) werden entzogen. RLS war bereits aktiv ohne
-- Policies, die Rechte sind also nur eine zweite Absicherung.
do $$ declare t text;
begin
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('revoke all on public.%I from anon, authenticated', t);
  end loop;
end $$;
alter default privileges in schema public revoke all on tables from anon, authenticated;
revoke execute on function public._agg_from(int) from public, anon, authenticated;
revoke execute on function public._elo_bucket(int, int) from public, anon, authenticated;

-- A2. fight_detail holt nur Fights, die es in der Datenbank gibt (vorher konnte jede beliebige
-- ID bei Eden abgefragt und gespeichert werden).
do $$ declare d text := pg_get_functiondef('public.fight_detail(text)'::regprocedure);
 a text := '  v_id := _b36(p_id);
';
begin
  if position(a in d) = 0 then raise exception 'pattern missing'; end if;
  execute replace(d, a, a || '  if not exists (select 1 from fights where id = v_id) then
    return jsonb_build_object(''status'', ''error'', ''error'', ''Fight not in the database'');
  end if;
');
end $$;

-- A3. Zeitfenster bis 7 Tage exakt aus den Rohdaten (vorher Wochen-Aggregate:
-- "24 h" bedeutete "seit Montag", "7 Tage" bis zu 13 Tage).
create or replace function public.leaderboard(p_kind text, p_hours integer default 168, p_size integer default null,
                                              p_realm integer default null, p_limit integer default 20)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_start timestamptz := case when p_hours is null then '2025-03-29 13:01 Europe/Berlin'::timestamptz
                              else now() - make_interval(hours => p_hours) end;
  lim int := least(greatest(coalesce(p_limit, 20), 1), 100);
  res jsonb;
begin
  if p_size is not null and (p_size < 1 or p_size > 8) then raise exception 'bad size'; end if;
  if p_realm is not null and p_realm not in (1, 2, 3) then raise exception 'bad realm'; end if;

  if p_kind in ('wins', 'active', 'winrate') then
    execute format($q$
      with lb as (%s),
      t as (select greatest(10, coalesce(min(n) filter (where cum >= tot * 0.25), 0)) thr
            from (select w + l n, sum(w + l) over (order by w + l rows unbounded preceding) cum, sum(w + l) over () tot from lb) q)
      select jsonb_build_object('min', t.thr, 'rows', coalesce((
        select jsonb_agg(jsonb_build_object('n', name, 'c', class, 'r', realm, 'w', w, 'l', l))
        from (select * from lb
              where $4 <> 'winrate' or w + l >= t.thr
              order by case when $4 = 'wins' then w when $4 = 'active' then w + l end desc nulls last,
                       case when $4 = 'winrate' then w::float / greatest(w + l, 1) end desc nulls last,
                       w + l desc, name
              limit $5) x), '[]'))
      from t
    $q$, case when p_hours is not null and p_hours <= 168 then $s$
        select x.n name, max(c.class) class, max(c.realm) realm,
               (count(*) filter (where x.win))::int w, (count(*) filter (where not x.win))::int l
        from (select n, true win, least(f.ws, 8) sz from fights f, unnest(f.w) n where f.ts >= $1
              union all
              select n, false, least(f.ls, 8) from fights f, unnest(f.l) n where f.ts >= $1) x
        join characters c on c.name = x.n
        where c.class is not null and ($2::int is null or x.sz = $2) and ($3::int is null or c.realm = $3)
        group by x.n
      $s$ else $s$
        select name, max(class) class, max(realm) realm, sum(wins)::int w, sum(losses)::int l
        from agg_player
        where wk >= $6 and ($2::int is null or sz = $2) and ($3::int is null or realm = $3)
        group by name
      $s$ end)
    into res using v_start, p_size, p_realm, p_kind, lim, _agg_from(p_hours);
    return res;

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
  end if;
  raise exception 'bad kind';
end $$;
revoke all on function public.leaderboard(text, int, int, int, int) from public;
grant execute on function public.leaderboard(text, int, int, int, int) to anon, authenticated;

create or replace function public.matchup_matrix(p_hours integer default null, p_size integer default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_wk date := _agg_from(p_hours);
  res jsonb;
begin
  if p_hours is not null and p_hours <= 168 then
    execute $q$
      with s as (
        select distinct f.id, x.sz, x.win, c.class cl, c.realm rl
        from fights f
        cross join lateral (
          select n, true win, least(f.ws, 8)::smallint sz from unnest(f.w) n
          union all
          select n, false, least(f.ls, 8)::smallint from unnest(f.l) n
        ) x
        join characters c on c.name = x.n
        where f.ts >= $1 and c.class is not null
      )
      select coalesce(jsonb_agg(jsonb_build_array(q.cl, q.rl, q.ocl, q.orl, q.w, q.l)), '[]')
      from (select a.cl, a.rl, b.cl ocl, b.rl orl,
                   (count(*) filter (where a.win))::int w, (count(*) filter (where not a.win))::int l
            from s a join s b on a.id = b.id and a.win <> b.win
            where $2::int is null or a.sz = $2
            group by 1, 2, 3, 4) q
    $q$ into res using now() - make_interval(hours => p_hours), p_size;
  else
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
  end if;
  return res;
end $$;
revoke all on function public.matchup_matrix(int, int) from public;
grant execute on function public.matchup_matrix(int, int) to anon, authenticated;

create or replace function public.class_quality(p_hours integer default null, p_size integer default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_wk date := _agg_from(p_hours);
  v_src text;
  res jsonb;
begin
  if p_hours is not null and p_hours <= 168 then
    v_src := $s$
      select x.n name, c.class, c.realm, (count(*) filter (where x.win))::float w, count(*)::float n
      from (select n, true win, least(f.ws, 8) sz from fights f, unnest(f.w) n where f.ts >= $3
            union all
            select n, false, least(f.ls, 8) from fights f, unnest(f.l) n where f.ts >= $3) x
      join characters c on c.name = x.n
      join quality_players q on q.name = x.n
      where c.class is not null and ($2::int is null or x.sz = $2)
      group by 1, 2, 3
    $s$;
  else
    v_src := $s$
      select m.name, m.class, m.realm, sum(m.wins)::float w, sum(m.wins + m.losses)::float n
      from agg_player m join quality_players q on q.name = m.name
      where m.wk >= $1 and ($2::int is null or m.sz = $2)
      group by 1, 2, 3
    $s$;
  end if;
  execute format($q$
    with p as (%s), r as (
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
  $q$, v_src) into res using v_wk, p_size, now() - make_interval(hours => coalesce(p_hours, 0));
  return res;
end $$;
revoke all on function public.class_quality(int, int) from public;
grant execute on function public.class_quality(int, int) to anon, authenticated;

-- A4. Alte Solo-Wertung (Tabelle ratings) abloesen: Suche, Klassen-Elo und Userscript nutzen
-- die neue Elo (Solo, aktuelle Version). Der Job ewa-ratings-update wird abgeschaltet.
create or replace function public.name_search(p_q text, p_limit integer default 8)
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_array(s.name, s.class, s.realm, s.rating, s.games)), '[]'::jsonb)
  from (
    select c.name, c.class, c.realm, round(e.rating)::int rating, e.games
    from characters c
    left join elo e on e.bucket = 1 and e.name = c.name
                   and e.ver = (select value::smallint from meta where key = 'elo_ver')
    where length(btrim(coalesce(p_q, ''))) between 2 and 30
      and lower(c.name) like replace(replace(replace(lower(btrim(p_q)), '\', ''), '%', ''), '_', '\_') || '%'
    order by coalesce(e.games, 0) desc, length(c.name), c.name
    limit least(greatest(coalesce(p_limit, 8), 1), 20)
  ) s
$$;
revoke all on function public.name_search(text, int) from public;
grant execute on function public.name_search(text, int) to anon, authenticated;

create or replace function public._quality_refresh()
returns void language plpgsql security definer set search_path = public as $$
begin
  insert into quality_players(name)
  select name from agg_player group by name having sum(wins + losses) >= 20 and sum(wins) >= 5
  on conflict do nothing;
  insert into class_elo(class, realm, rating)
  select ch.class, ch.realm, round(avg(e.rating))::int
  from elo e join characters ch on ch.name = e.name
  where e.bucket = 1 and e.ver = (select value::smallint from meta where key = 'elo_ver')
    and e.games >= 20 and ch.class is not null and ch.realm is not null
  group by ch.class, ch.realm
  on conflict (class, realm) do update set rating = excluded.rating;
end $$;
revoke all on function public._quality_refresh() from public, anon, authenticated;

do $$ declare d text := pg_get_functiondef('public.tool_player(text)'::regprocedure);
begin
  d := replace(d, 'from elo e where e.name = v_name)', 'from elo e where e.name = v_name and e.ver = (select value::smallint from meta where key = ''elo_ver''))');
  d := replace(d, 'where e2.bucket = e.bucket and e2.games >= 20 and e2.rating > e.rating', 'where e2.bucket = e.bucket and e2.ver = e.ver and e2.games >= 20 and e2.rd <= 200 and e2.rating > e.rating');
  execute d;
end $$;

select cron.alter_job((select jobid from cron.job where jobname = 'ewa-ratings-update'), active := false);
select public._quality_refresh();

-- A5. Fehlerprotokoll der App: Ringpuffer mit 1000 Plaetzen (waechst nie), hoechstens
-- 300 Eintraege pro Stunde insgesamt, gleiche Meldung pro Stunde nur einmal.
create table if not exists public.client_errors (
  slot smallint primary key,
  at timestamptz not null default now(),
  ver text, msg text, src text, page text, ua text, n int not null default 1
);
alter table public.client_errors enable row level security;
revoke all on public.client_errors from anon, authenticated;

create or replace function public.log_client_error(p_ver text, p_msg text, p_src text, p_page text, p_ua text)
returns void language plpgsql security definer set search_path = public as $$
declare v_slot int; v_cnt int;
begin
  if p_msg is null or btrim(p_msg) = '' then return; end if;
  -- same message within the last hour: count it, do not store again
  update client_errors set n = n + 1
   where msg = left(p_msg, 300) and at > now() - interval '1 hour';
  if found then return; end if;
  select count(*) into v_cnt from client_errors where at > now() - interval '1 hour';
  if v_cnt >= 300 then return; end if;
  v_slot := (coalesce((select value::int from meta where key = 'err_slot'), -1) + 1) % 1000;
  insert into meta values ('err_slot', v_slot::text) on conflict (key) do update set value = excluded.value;
  insert into client_errors(slot, at, ver, msg, src, page, ua, n)
  values (v_slot, now(), left(p_ver, 20), left(p_msg, 300), left(p_src, 200), left(p_page, 200), left(p_ua, 120), 1)
  on conflict (slot) do update set at = excluded.at, ver = excluded.ver, msg = excluded.msg, src = excluded.src,
                                   page = excluded.page, ua = excluded.ua, n = 1;
end $$;
revoke all on function public.log_client_error(text, text, text, text, text) from public;
grant execute on function public.log_client_error(text, text, text, text, text) to anon, authenticated;

-- A6. Weitere Anpassungen (per pg_get_functiondef + replace angewendet):
--   leaderboard: p_kind 'rating' liefert fuer alte Userscript-Versionen elo_board(1, 'rating', ...).
--   player_profile: 'rating' kommt aus elo (Solo, aktuelle Version) statt aus der alten Tabelle ratings.
--   tool_player: Elo nur aktuelle Version, Rang nur unter verlaesslichen Werten.
-- Danach nutzt keine Funktion mehr die Tabelle ratings ausser _update_ratings/_rebuild_ratings
-- (Job ewa-ratings-update ist abgeschaltet, Entfernen siehe Teil B).
