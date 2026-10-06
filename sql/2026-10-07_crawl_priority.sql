-- Aktive Spieler zuerst: Prioritaet fuer Spielerlisten und Klassenabrufe.
-- Prioritaet = Fights der letzten 30 Tage x 4 + alle Fights in der Datenbank.

alter table public.crawl add column if not exists prio int not null default 0;
alter table public.characters add column if not exists prio int not null default 0;

create index if not exists crawl_open_prio on public.crawl (prio desc, size desc) where done_at is null;
create index if not exists characters_unknown_prio on public.characters (prio desc, tries) where class is null;

create or replace function public._refresh_prio()
returns void
language plpgsql security definer set search_path = public as $$
begin
  create temporary table if not exists _prio (n text primary key, p int) on commit drop;
  truncate _prio;
  insert into _prio
  select n, (count(*) filter (where f.ts >= now() - interval '30 days') * 4 + count(*))::int
  from fights f, unnest(f.w || f.l) n
  group by n;

  update crawl cr set prio = x.p from _prio x
  where cr.name = x.n and cr.done_at is null and cr.prio <> x.p;

  update characters ch set prio = x.p from _prio x
  where ch.name = x.n and ch.class is null and ch.prio <> x.p;
end $$;
revoke all on function public._refresh_prio() from public, anon, authenticated;

-- alle 15 Minuten mit den Statistiken neu berechnen
create or replace function public.refresh_stats()
returns void
language plpgsql security definer set search_path = public as $$
begin
  refresh materialized view concurrently mv_class_day;
  refresh materialized view concurrently mv_player_day;
  refresh materialized view concurrently mv_fights_day;
  refresh materialized view concurrently mv_matchup_week;
  update meta set value = now()::text where key = 'mv_refreshed';
  perform _refresh_prio();
end $$;

create or replace function public.claim_jobs(p_token text, p_fights integer default 5, p_crawl integer default 5)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  sid int := _sub(p_token);
  v_fights jsonb; v_crawl jsonb;
begin
  with pick as (
    select name from characters
    where class is null and seen_fight is not null and tries < 5
      and (claimed_at is null or claimed_at < now() - interval '30 minutes')
    order by prio desc, tries, updated_at
    limit least(greatest(p_fights, 0), 20) * 4
    for update skip locked
  ), upd as (
    update characters c set claimed_at = now(), tries = tries + 1
    from pick where c.name = pick.name
    returning c.seen_fight
  )
  select coalesce(jsonb_agg(distinct _to_b36(seen_fight)), '[]') into v_fights from upd;

  with pick as (
    select name, size from crawl
    where (done_at is null and (claimed_at is null or claimed_at < now() - interval '30 minutes'))
       or (size = 0 and done_at < now() - interval '14 days' and coalesce(result_count, 0) > 0
           and (claimed_at is null or claimed_at < now() - interval '30 minutes'))
    order by (done_at is null) desc, prio desc, size desc
    limit least(greatest(p_crawl, 0), 20)
    for update skip locked
  ), upd as (
    update crawl c set claimed_at = now()
    from pick where c.name = pick.name and c.size = pick.size
    returning c.name, c.size
  )
  select coalesce(jsonb_agg(jsonb_build_object('name', name, 'size', size)), '[]') into v_crawl from upd;

  return jsonb_build_object('fights', v_fights, 'crawl', v_crawl);
end $$;

select public._refresh_prio();
