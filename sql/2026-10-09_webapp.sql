-- Web-App: Zone in fights_feed (Index 9, aeltere Skript-Versionen ignorieren
-- sie) und Namenssuche mit Vorschlaegen. Nichts wird geloescht.

create index if not exists characters_lower_name_pat on public.characters (lower(name) text_pattern_ops);

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

    select count(*)::int into v_total from fights f
    where f.ts >= v_from and (p_size is null or least(f.ws, 8) = p_size or least(f.ls, 8) = p_size);

    select coalesce(jsonb_agg(jsonb_build_array(_to_b36(f.id), extract(epoch from f.ts)::bigint,
             f.ws, f.ls, f.wr, f.lr, f.dur, f.w, f.l, f.zone) order by f.ts desc), '[]'::jsonb)
    into v_rows
    from (select * from fights f
          where f.ts >= v_from and (p_size is null or least(f.ws, 8) = p_size or least(f.ls, 8) = p_size)
          order by f.ts desc limit v_limit) f;
  end if;

  return jsonb_build_object(
    'name', v_name,
    'total', v_total,
    'crawled', coalesce(v_crawled, false),
    'last_poll', (select value from meta where key = 'last_list_poll'),
    'rows', v_rows
  );
end $$;

-- Namensvorschlaege fuer die Suche: Namen, die mit p_q beginnen.
-- Zeilen: [name, class, realm, elo, 1v1-fights]
create or replace function public.name_search(p_q text, p_limit int default 8)
returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_array(s.name, s.class, s.realm, s.rating, s.games)), '[]'::jsonb)
  from (
    select c.name, c.class, c.realm, round(r.rating)::int rating, r.games
    from characters c
    left join ratings r on r.name = c.name
    where length(btrim(coalesce(p_q, ''))) between 2 and 30
      and lower(c.name) like replace(replace(lower(btrim(p_q)), '%', ''), '_', '\_') || '%'
    order by coalesce(r.games, 0) desc, length(c.name), c.name
    limit least(greatest(coalesce(p_limit, 8), 1), 20)
  ) s
$$;

revoke all on function public.name_search(text, int) from public;
grant execute on function public.name_search(text, int) to anon, authenticated;
