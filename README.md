# Eden Fight Analyzer

Tampermonkey userscript for the fight pages of [Eden DAoC](https://eden-daoc.net/fights).

- **Fights**: overview, player stats, head-to-head and recurring groups from Eden's fight list
- **Analysis**: class win rates by period, group size and realm, win rates against each enemy class, players per class (from a shared database that every installation helps to fill)
- **Fight report** on `/fights?id=...`: comp, totals, crowd control and players of both sides

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/).
2. Open the [script file](https://raw.githubusercontent.com/Vumas169/Eden-Fight-Analyzer/main/eden-winrate-analyzer.user.js) and confirm the installation.
3. Allow the connection to `supabase.co` when Tampermonkey asks.

Updates arrive automatically through Tampermonkey.

## Data collection

While the fights page is open, the script fetches fights from Eden in the background and adds them to the shared database: at most one request every 2 seconds, in one tab only, with a daily limit and automatic pauses on errors. Each browser gets its own key. Duplicate fights are not possible.
