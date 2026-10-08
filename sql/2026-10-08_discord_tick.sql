-- Discord-Feed: alle 5 Sekunden fertige Antworten von Discord verarbeiten und
-- die naechste Seite anfragen. Erst rueckwaerts bis zum Season-Start
-- (Nachholen), danach etwa einmal pro Minute nur neue Nachrichten.
-- Antworten von Discord werden sofort nach dem Verarbeiten geloescht, sonst
-- waere der Speicher in kurzer Zeit voll.

create or replace function public._dc_tick()
returns void
language plpgsql security definer set search_path = public, net as $$
declare
  c record; r record; msgs jsonb; msg jsonb; e jsonb;
  n_msgs int; n_fights int; min_id text; max_id text; oldest timestamptz;
  token text := (select decrypted_secret from vault.decrypted_secrets where name = 'discord_bot_token');
  url text;
  season0 constant timestamptz := '2025-03-29 13:01 Europe/Berlin';
begin
  if token is null then return; end if;

  for c in select * from dc_channels where request_id is not null loop
    select * into r from net._http_response where id = c.request_id;
    if not found then
      if c.request_at < now() - interval '2 minutes' then
        update dc_channels set request_id = null, last_error = 'no answer' where channel_id = c.channel_id;
      end if;
      continue;
    end if;
    delete from net._http_response where id = c.request_id;

    if r.status_code <> 200 then
      update dc_channels set request_id = null, last_error = coalesce(r.error_msg, 'HTTP ' || r.status_code || ' ' || left(r.content, 120))
      where channel_id = c.channel_id;
      continue;
    end if;

    msgs := r.content::jsonb;
    n_msgs := jsonb_array_length(msgs);
    n_fights := 0;
    for msg in select * from jsonb_array_elements(msgs) loop
      for e in select * from jsonb_array_elements(coalesce(msg->'embeds', '[]')) loop
        n_fights := n_fights + _dc_take_embed(e);
      end loop;
    end loop;

    select min((m->>'id')::numeric)::text, max((m->>'id')::numeric)::text, min((m->>'timestamp')::timestamptz)
    into min_id, max_id, oldest
    from jsonb_array_elements(msgs) m;

    if c.request_mode = 'back' then
      update dc_channels set
        request_id = null, last_error = null,
        messages = messages + n_msgs, fights = fights + n_fights,
        back_before = coalesce(min_id, back_before),
        last_id = coalesce(last_id, max_id),
        oldest_ts = least(coalesce(oldest_ts, oldest), oldest),
        back_done = n_msgs < 100 or oldest < season0
      where channel_id = c.channel_id;
    else
      update dc_channels set
        request_id = null, last_error = null,
        messages = messages + n_msgs, fights = fights + n_fights,
        last_id = coalesce(max_id, last_id)
      where channel_id = c.channel_id;
    end if;
  end loop;

  for c in select * from dc_channels where request_id is null loop
    if not c.back_done then
      url := 'https://discord.com/api/v10/channels/' || c.channel_id || '/messages?limit=100'
             || coalesce('&before=' || c.back_before, '');
      update dc_channels set request_mode = 'back',
        request_id = net.http_get(url, headers => jsonb_build_object('Authorization', 'Bot ' || token, 'User-Agent', 'DiscordBot (eden-fight-analyzer, 1.0)'), timeout_milliseconds => 30000),
        request_at = now()
      where channel_id = c.channel_id;
    elsif c.last_id is not null and (c.request_at is null or c.request_at < now() - interval '50 seconds') then
      url := 'https://discord.com/api/v10/channels/' || c.channel_id || '/messages?limit=100&after=' || c.last_id;
      update dc_channels set request_mode = 'new',
        request_id = net.http_get(url, headers => jsonb_build_object('Authorization', 'Bot ' || token, 'User-Agent', 'DiscordBot (eden-fight-analyzer, 1.0)'), timeout_milliseconds => 30000),
        request_at = now()
      where channel_id = c.channel_id;
    end if;
  end loop;
end $$;

revoke all on function public._dc_tick() from public, anon, authenticated;

-- alte Testantworten wegraeumen und den Takt starten
delete from net._http_response;
select cron.schedule('ewa-discord-feed', '5 seconds', 'select public._dc_tick()');
