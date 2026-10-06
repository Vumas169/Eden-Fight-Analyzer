-- Fights-Tab aus der Datenbank: Liste, Spieler-Karte, Klassen fuer Namen.
-- Nur lesende Funktionen plus drei Indizes. Nichts wird geloescht.

create index if not exists fights_w_gin on public.fights using gin (w);
create index if not exists fights_l_gin on public.fights using gin (l);
create index if not exists characters_lower_name on public.characters (lower(name));

-- Fights fuer den Fights-Tab.
-- Mit Name: alle Fights des Spielers (neueste zuerst, hoechstens p_limit).
-- Ohne Name: Fights im Zeitraum, optional nur eine Gruppengroesse (eine
-- der beiden Seiten hat diese Groesse, 8 steht fuer 8 und mehr).
-- Zeilen: [id, ts (Unix-Sekunden), ws, ls, wr, lr, dauer, w, l]
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
             f.ws, f.ls, f.wr, f.lr, f.dur, f.w, f.l) order by f.ts desc), '[]'::jsonb)
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
             f.ws, f.ls, f.wr, f.lr, f.dur, f.w, f.l) order by f.ts desc), '[]'::jsonb)
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

-- Kleine Karte beim Ueberfahren eines Namens: Klasse, Realm, Bilanz gesamt
-- und letzte 7 Tage, dazu die Bilanz der Namen in p_vs gegen diesen Spieler.
create or replace function public.player_card(p_name text, p_vs text[] default null)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  c characters;
  v_name text;
  v_w int; v_l int; v_w7 int; v_l7 int; v_last timestamptz; v_realm int;
  v_vw int := 0; v_vl int := 0;
begin
  if p_name is null or btrim(p_name) = '' or length(p_name) > 30 then raise exception 'bad name'; end if;
  if p_vs is not null and cardinality(p_vs) > 20 then raise exception 'too many names'; end if;

  select * into c from characters ch where lower(ch.name) = lower(btrim(p_name)) limit 1;
  v_name := coalesce(c.name, btrim(p_name));

  select count(*) filter (where f.w @> array[v_name])::int,
         count(*) filter (where f.l @> array[v_name])::int,
         count(*) filter (where f.w @> array[v_name] and f.ts >= now() - interval '7 days')::int,
         count(*) filter (where f.l @> array[v_name] and f.ts >= now() - interval '7 days')::int,
         max(f.ts),
         max(case when f.w @> array[v_name] then f.wr else f.lr end)
  into v_w, v_l, v_w7, v_l7, v_last, v_realm
  from fights f where f.w @> array[v_name] or f.l @> array[v_name];

  if p_vs is not null and cardinality(p_vs) > 0 then
    select count(*) filter (where f.l @> array[v_name] and f.w && p_vs)::int,
           count(*) filter (where f.w @> array[v_name] and f.l && p_vs)::int
    into v_vw, v_vl
    from fights f
    where (f.l @> array[v_name] and f.w && p_vs) or (f.w @> array[v_name] and f.l && p_vs);
  end if;

  return jsonb_build_object(
    'name', v_name, 'class', c.class, 'realm', coalesce(c.realm, v_realm),
    'wins', v_w, 'losses', v_l, 'wins7', v_w7, 'losses7', v_l7, 'last', v_last,
    'vs_wins', v_vw, 'vs_losses', v_vl
  );
end $$;

-- Klasse und Realm fuer eine Liste von Namen (Fight-Zeile ueberfahren)
create or replace function public.chars_info(p_names text[])
returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_array(c.name, c.class, c.realm)), '[]'::jsonb)
  from characters c
  where c.name = any((p_names)[1:400])
$$;

revoke all on function public.fights_feed(text, int, int, int),
  public.player_card(text, text[]),
  public.chars_info(text[]) from public;
grant execute on function public.fights_feed(text, int, int, int),
  public.player_card(text, text[]),
  public.chars_info(text[]) to anon, authenticated;
