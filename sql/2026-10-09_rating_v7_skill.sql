-- Version 7 (09.10. 17:15): zweite Wertung "Skill" neben der normalen Elo.
-- Gleiche Regeln wie die Elo (Glicko-2, Gewichtung, Teamschnitt, Wiederholungen),
-- aber: ein Sieg gegen einen klar schwaecheren Gegner bringt weniger, ab 90 %
-- Siegchance nichts mehr (voll bis 60 %, dazwischen gleitend). Niederlagen zaehlen voll.
-- Farmen schwacher Gegner hebt die Skill-Wertung damit kaum.

alter table public.elo add column if not exists s_rating real not null default 1500;
alter table public.elo add column if not exists s_rd real not null default 350;
alter table public.elo add column if not exists s_peak real not null default 1500;

create or replace function public._elo_step(p_batch int default 20000)
returns int language plpgsql security definer set search_path = public as $$
declare
  cur text := coalesce((select value from meta where key = 'elo_cur'), '-infinity|0');
  cur_ts timestamptz := split_part(cur, '|', 1)::timestamptz;
  cur_id bigint := split_part(cur, '|', 2)::bigint;
  v_ver smallint := coalesce((select value::smallint from meta where key = 'elo_ver'), 1);
  f record; bw smallint; bl smallint; v_n int := 0; v_day date; v_rep real; v_prev int;
  v_ts timestamptz; v_id bigint;
begin
  for f in
    select id, ts, ws, ls, w, l from fights
    where (ts, id) > (cur_ts, cur_id) and ts < now() - interval '15 minutes'
      and cardinality(w) > 0 and cardinality(l) > 0
    order by ts, id limit p_batch
  loop
    bw := _elo_bucket(f.ws, f.ls);
    bl := _elo_bucket(f.ls, f.ws);
    v_day := (f.ts at time zone 'Europe/Berlin')::date;
    v_rep := 1;
    if f.ws = 1 and f.ls = 1 then
      select count(*) into v_prev from fights g
      where g.ts > f.ts - interval '24 hours' and (g.ts, g.id) < (f.ts, f.id) and g.ws = 1 and g.ls = 1
        and ((g.w @> f.w and g.l @> f.l) or (g.w @> f.l and g.l @> f.w));
      v_rep := 1.0 / (1 + v_prev);
    end if;
    with p as (
      select x.n name, x.win, case when x.win then bw else bl end b,
             case when x.win then f.ws else f.ls end side,
             coalesce(e.rating, 1500)::float8 r, coalesce(e.rd, 350)::float8 rd,
             coalesce(e.s_rating, 1500)::float8 sr, coalesce(e.s_rd, 350)::float8 srd,
             greatest(coalesce(e.games, 0), coalesce(xp.n, 0)) g, e.last_ts lt
      from (select distinct on (y.n) y.n, y.win
            from (select unnest(f.w) n, true win union all select unnest(f.l), false) y
            order by y.n, y.win desc) x
      left join elo e on e.bucket = case when x.win then bw else bl end and e.name = x.n and e.ver = v_ver
      left join elo_exp xp on xp.bucket = case when x.win then bw else bl end and xp.name = x.n
    ), p2 as (
      select p.*, (p.r - 1500) / 173.7178 mu, (p.sr - 1500) / 173.7178 smu_i,
             least(350, sqrt(p.rd * p.rd + 110 * greatest(0, extract(epoch from (f.ts - coalesce(p.lt, f.ts))) / 86400))) / 173.7178 phi,
             least(350, sqrt(p.srd * p.srd + 110 * greatest(0, extract(epoch from (f.ts - coalesce(p.lt, f.ts))) / 86400))) / 173.7178 sphi
      from p
    ), t as (
      select win, avg(mu) mu_t, sqrt(avg(phi * phi)) phi_t, avg(smu_i) smu_t, sqrt(avg(sphi * sphi)) sphi_t,
             avg(g) g_t, avg(r) r_t from p2 group by win
    ), q as (
      select p2.*, o.mu_t omu, o.g_t og, o.r_t orat, 0.5 * p2.mu + 0.5 * s.mu_t smu, least(o.g_t, s.g_t) mg,
             1 / sqrt(1 + 3 * o.phi_t * o.phi_t / (pi() * pi())) gg,
             o.smu_t somu, 0.5 * p2.smu_i + 0.5 * s.smu_t ssmu,
             1 / sqrt(1 + 3 * o.sphi_t * o.sphi_t / (pi() * pi())) sgg
      from p2 join t o on o.win <> p2.win join t s on s.win = p2.win
    ), q2 as (
      select q.*, least(0.999999, greatest(0.000001, 1 / (1 + exp(-q.gg * (q.smu - q.omu))))) ee,
             least(0.999999, greatest(0.000001, 1 / (1 + exp(-q.sgg * (q.ssmu - q.somu))))) see,
             (case when q.b = 1 then least(1, (power(q.mg, 4) / (power(q.mg, 4) + power(41.5, 4))) / 0.9712)
                   else 0.1 + 0.9 * least(1, q.mg / 20.0) end)
             * v_rep / sqrt(least(8, greatest(1, q.side))) wgt
      from q
    ), q3 as (
      select q2.*,
             1 / sqrt(1 / (q2.phi * q2.phi + 0.0036) + q2.gg * q2.gg * q2.ee * (1 - q2.ee)) phi_new,
             1 / sqrt(1 / (q2.sphi * q2.sphi + 0.0036) + q2.sgg * q2.sgg * q2.see * (1 - q2.see)) sphi_new,
             -- skill: a win counts in full up to 60 % win chance, nothing from 90 %
             case when q2.win then least(1, greatest(0, (0.9 - q2.see) / 0.3)) else 1 end sf
      from q2
    ), q4 as (
      select q3.*,
             1500 + 173.7178 * (q3.mu + q3.wgt * q3.phi_new * q3.phi_new * q3.gg * ((case when q3.win then 1 else 0 end) - q3.ee)) r_new,
             173.7178 * (q3.phi + q3.wgt * (q3.phi_new - q3.phi)) rd_new,
             1500 + 173.7178 * (q3.smu_i + q3.sf * q3.wgt * q3.sphi_new * q3.sphi_new * q3.sgg * ((case when q3.win then 1 else 0 end) - q3.see)) sr_new,
             173.7178 * (q3.sphi + q3.wgt * (q3.sphi_new - q3.sphi)) srd_new
      from q3
    ), dd as (
      insert into elo_day as d (bucket, name, day, r_start, r_end, n, w, ver)
      select q4.b, q4.name, v_day, q4.r, q4.r_new, 1, case when q4.win then 1 else 0 end, v_ver from q4 where f.ts >= now() - interval '35 days'
      on conflict (bucket, day, name) do update
        set r_start = case when d.ver = excluded.ver then d.r_start else excluded.r_start end,
            r_end = excluded.r_end,
            n = case when d.ver = excluded.ver then d.n + 1 else 1 end,
            w = case when d.ver = excluded.ver then d.w + excluded.w else excluded.w end,
            ver = excluded.ver
      returning 1
    )
    insert into elo as e (bucket, name, rating, rd, games, wins, losses, peak, last_ts, opp_sum, est_w, ver, s_rating, s_rd, s_peak)
    select q4.b, q4.name, q4.r_new, q4.rd_new, 1, case when q4.win then 1 else 0 end, case when q4.win then 0 else 1 end,
           greatest(1500, q4.r_new), f.ts, q4.orat,
           case when q4.win and q4.orat >= (case q4.b when 1 then 1600 when 2 then 1650 else 1700 end) then 1 else 0 end, v_ver,
           q4.sr_new, q4.srd_new, greatest(1500, q4.sr_new)
    from q4
    on conflict (bucket, name) do update
      set rating = excluded.rating, rd = excluded.rd,
          s_rating = excluded.s_rating, s_rd = excluded.s_rd,
          games = case when e.ver = excluded.ver then e.games + 1 else 1 end,
          wins = case when e.ver = excluded.ver then e.wins else 0 end + excluded.wins,
          losses = case when e.ver = excluded.ver then e.losses else 0 end + excluded.losses,
          peak = case when e.ver = excluded.ver then greatest(e.peak, excluded.rating) else excluded.peak end,
          s_peak = case when e.ver = excluded.ver then greatest(e.s_peak, excluded.s_rating) else excluded.s_peak end,
          last_ts = excluded.last_ts,
          opp_sum = case when e.ver = excluded.ver then e.opp_sum else 0 end + excluded.opp_sum,
          est_w = case when e.ver = excluded.ver then e.est_w else 0 end + excluded.est_w,
          ver = excluded.ver;
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

-- elo_board kennt p_kind 'skill' (sortiert nach s_rating, gelistet ab s_rd <= 200, Feld 'elo' = normale Elo);
-- player_elo liefert zusaetzlich [11] s_rating, [12] s_rd, [13] Skill-Rang.
