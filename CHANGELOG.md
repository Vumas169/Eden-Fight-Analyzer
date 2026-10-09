# Changelog

## Web app 1.1.0 (v24), 10.10.2026

Release review before sharing the app.

Fixes
- Leaderboard (wins, active, win rate), class quality and class-vs-class: "24 h" and "7 days" now count exactly that period. Before, they used weekly totals ("24 h" meant "since Monday", "7 days" up to 13 days).
- Background refresh no longer reloads big lists every minute: overview every minute, fights every 2 minutes, player page every 5 minutes, and never while you type. Saves data volume for you and for the database.
- The head-to-head box no longer loses what you type; a click listener no longer piles up on every refresh.
- Links with a broken % sign no longer leave the page blank.
- Safari/iPhone: the "Elo is being calculated" note no longer shows forever.
- Fight reports: all values are escaped and checked before they are shown or stored.
- Notifications: no more notifications for old fights when the app starts; notifications now work on Android.
- Class icons appear reliably when two lists load at the same time.
- Durations like 1:60 are shown as 2:00; invalid filters in links fall back to defaults; broken favorites in the browser storage no longer break the app.
- Offline: the cached app files match the current version; the version check no longer fills the browser cache.
- Favorites: up to 30, with a message when the limit is reached.

New
- Short welcome panel on the first visit.
- Errors in the app are logged (anonymous, at most 1000 entries in a ring buffer) so problems can be found.
- Weekly encrypted database backup through GitHub Actions (needs two secrets, see .github/workflows/backup.yml).

Database
- Direct table rights for the public key removed (access only through the app's functions).
- Fight reports are only fetched from Eden for fights that exist in the database.
- The old Solo rating table is no longer used; search, class Elo and the userscript read the new Elo.
- Cleanup of logs and caches prepared (sql/2026-10-10_release_cleanup_USER.sql).

## Web app 1.0.x (v1 to v23), 09.10.2026

Elo with three brackets, Skill rating, leaderboard, classes, player pages, fight reports.
