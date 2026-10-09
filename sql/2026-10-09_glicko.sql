-- Wertung nach Glicko-2 (Elo-Nachfolger) mit vier Ergaenzungen:
-- 1. Gegner mit wenigen Fights zaehlen anteilig: 10 % bei 0 Fights, voll ab 20.
-- 2. Unsicherheit (RD): neue Spieler starten mit 350, sie sinkt mit jedem
--    Fight und waechst bei Inaktivitaet wieder (von 50 auf 350 in ~180 Tagen).
-- 3. Solo: jedes weitere Treffen mit demselben Gegner innerhalb von 24 h zaehlt
--    weniger (1/2, 1/3, ...).
-- 4. Je Spieler: Summe der Gegner-Wertungen und Siege gegen etablierte Gegner.
-- Jede Seite zaehlt in der Wertung ihrer eigenen Groesse (Solo / Small 2-5 /
-- Group 6+), Gegner ist der Durchschnitt des anderen Teams.
-- Rangliste nach dem vorsichtigen Wert: Wertung minus 2 x RD.

alter table public.elo add column if not exists rd real not null default 350;
alter table public.elo add column if not exists opp_sum real not null default 0;
alter table public.elo add column if not exists est_w int not null default 0;

create or replace function public._elo_step(p_batch int default 10000)
returns int language plpgsql security definer set search_path = public as $$
declare
  cur text := coalesce((select value from meta where key = 'elo_cur'), '-infinity|0');
  cur_ts timestamptz := split_part(cur, '|', 1)::timestamptz;
  cur_id bigint := split_part(cur, '|', 2)::bigint;
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

    -- repeated solo fights between the same two players within 24 h count less
    v_rep := 1;
    if f.ws = 1 and f.ls = 1 then
      select count(*) into v_prev from fights g
      where g.ts > f.ts - interval '24 hours' and (g.ts, g.id) < (f.ts, f.id) and g.ws = 1 and g.ls = 1
        and ((g.w @> f.w and g.l @> f.l) or (g.w @> f.l and g.l @> f.w));
      v_rep := 1.0 / (1 + v_prev);
    end if;

    with p as (
      select x.n name, x.win, case when x.win then bw else bl end b,
             coalesce(e.rating, 1500)::float8 r, coalesce(e.rd, 350)::float8 rd, coalesce(e.games, 0) g, e.last_ts lt
      from (select distinct on (y.n) y.n, y.win
            from (select unnest(f.w) n, true win union all select unnest(f.l), false) y
            order by y.n, y.win desc) x
      left join elo e on e.bucket = case when x.win then bw else bl end and e.name = x.n
    ), p2 as (
      select p.*, (p.r - 1500) / 173.7178 mu,
             least(350, sqrt(p.rd * p.rd + 666.7 * greatest(0, extract(epoch from (f.ts - coalesce(p.lt, f.ts))) / 86400))) / 173.7178 phi
      from p
    ), t as (
      select win, avg(mu) mu_t, sqrt(avg(phi * phi)) phi_t, avg(g) g_t, avg(r) r_t from p2 group by win
    ), q as (
      select p2.*, o.mu_t omu, o.g_t og, o.r_t orat, s.mu_t smu,
             1 / sqrt(1 + 3 * o.phi_t * o.phi_t / (pi() * pi())) gg
      from p2 join t o on o.win <> p2.win join t s on s.win = p2.win
    ), q2 as (
      select q.*, least(0.999999, greatest(0.000001, 1 / (1 + exp(-q.gg * (q.smu - q.omu))))) ee,
             (0.1 + 0.9 * least(1, q.og / 20.0)) * v_rep wgt
      from q
    ), q3 as (
      select q2.*, sqrt(q2.phi * q2.phi + 0.0036) phi_s,
             1 / sqrt(1 / (q2.phi * q2.phi + 0.0036) + q2.gg * q2.gg * q2.ee * (1 - q2.ee)) phi_new
      from q2
    ), q4 as (
      select q3.*,
             1500 + 173.7178 * (q3.mu + q3.wgt * q3.phi_new * q3.phi_new * q3.gg * ((case when q3.win then 1 else 0 end) - q3.ee)) r_new,
             173.7178 * (q3.phi_s - q3.wgt * (q3.phi_s - q3.phi_new)) rd_new
      from q3
    ), dd as (
      insert into elo_day as d (bucket, name, day, r_start, r_end, n, w)
      select q4.b, q4.name, v_day, q4.r, q4.r_new, 1, case when q4.win then 1 else 0 end from q4 where f.ts >= now() - interval '35 days'
      on conflict (bucket, day, name) do update
        set r_end = excluded.r_end, n = d.n + 1, w = d.w + excluded.w
      returning 1
    )
    insert into elo as e (bucket, name, rating, rd, games, wins, losses, peak, last_ts, opp_sum, est_w)
    select q4.b, q4.name, q4.r_new, q4.rd_new, 1, case when q4.win then 1 else 0 end, case when q4.win then 0 else 1 end,
           greatest(1500, q4.r_new), f.ts, q4.orat, case when q4.win and q4.og >= 20 then 1 else 0 end
    from q4
    on conflict (bucket, name) do update
      set rating = excluded.rating, rd = excluded.rd, games = e.games + 1, wins = e.wins + excluded.wins, losses = e.losses + excluded.losses,
          peak = greatest(e.peak, excluded.rating), last_ts = greatest(e.last_ts, excluded.last_ts),
          opp_sum = e.opp_sum + excluded.opp_sum, est_w = e.est_w + excluded.est_w;

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

-- Rangliste und Profil: elo_board sortiert nach rating - 2 * rd und liefert
-- rd, score, opp (Durchschnitt der Gegner-Wertung) und est (Siege gegen
-- Spieler mit 20+ Fights). player_elo liefert zusaetzlich rd, opp, est.
-- (Eingespielt am 09.10. direkt in der Datenbank.)

-- Neustart (vom Nutzer im SQL Editor):
-- truncate public.elo, public.elo_day;
-- delete from public.meta where key in ('elo_cur', 'elo_built');
-- select cron.alter_job((select jobid from cron.job where jobname = 'ewa-elo'), active := true,
--                       command := 'select public._elo_step(10000)');

-- 09.10. 11:25: Gewichtung Solo als S-Kurve bis 100 Fights:
--   0.05 + 0.95 * smoothstep(min(1, fights / 100))  -> 20: 15 %, 50: 53 %, 80: 90 %
-- Small und Group bleiben linear 10 % bis 100 % bei 20 Fights.
-- "vs established": Solo ab 100 Fights, Small und Group ab 20.

-- 09.10. 11:35: Solo-Gewichtung steiler: min(1, (n^4 / (n^4 + 41.5^4)) / 0.9712)
--   7: 0,1 %, 10: 0,3 %, 20: 5 %, 30: 22 %, 40: 48 %, 50: 70 %, 65: 88 %, 80: 96 %, 100: 100 %
