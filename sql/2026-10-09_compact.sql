-- Datenbank verkleinern (bitte komplett im SQL Editor ausfuehren).
-- Die alten Statistik-Ansichten werden durch kleinere Summentabellen ersetzt
-- (agg_class, agg_fights, agg_player, agg_matchup). Die bauen sich danach
-- automatisch in etwa 15 Minuten auf. Fights und Spieler bleiben unberuehrt.

drop materialized view if exists public.mv_class_day;
drop materialized view if exists public.mv_player_day;
drop materialized view if exists public.mv_fights_day;
drop materialized view if exists public.mv_matchup_week;

-- nicht mehr gebrauchter Index
drop index if exists public.fights_sub;

-- aufgeblaehte Indizes neu und kompakt aufbauen (dauert etwa eine Minute)
reindex index public.fights_pkey;
reindex index public.fights_ts;
reindex index public.fights_created;

select pg_size_pretty(pg_database_size(current_database())) as groesse_jetzt;
