# Eden Fight Analyzer

Tampermonkey userscript for the fight pages of [Eden DAoC](https://eden-daoc.net/fights).

- **Overview**: fights today and in the last 24 hours, fights per hour, group sizes, zones, most kills, win streaks, underdog wins, most played classes, busy times over 30 days
- **Fights**: player stats with Elo, head-to-head, classes faced, zones, recurring opponents, read from the shared database (new fights within about a minute)
- Hover a name for a player card, hover a fight for both line-ups with classes, favorites bar, copy a summary for Discord, mouse back button steps back in the panel
- **Classes**: win rates by period, group size and realm, a quality view (how good the players of a class are) and a class-against-class matrix
- **Leaderboard**: Elo, most wins, win rate, most active, underdog wins, streaks
- **Fight report** on `/fights?id=...`: comp, totals, crowd control and players of both sides
- Wide mode, the panel can be moved freely (double-click the header to reset)

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/).
2. Open the [script file](https://raw.githubusercontent.com/Vumas169/Eden-Fight-Analyzer/main/eden-winrate-analyzer.user.js) and confirm the installation.
3. Allow the connection to `supabase.co` when Tampermonkey asks.

Updates arrive automatically through Tampermonkey.

## Data collection

The shared database is filled from Eden's public fight feed and the list of recent fights. Collecting directly from Eden in your browser is off by default and only starts when you switch it on. It then runs slowly, in small batches, with less traffic in the evening hours.
