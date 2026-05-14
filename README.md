# SN110 Tracker

Local dashboard for tracking Taostats subnet `110` with SQLite history storage.

## Features

- Node.js app in plain JavaScript
- Fetches subnet data from Taostats
- Uses the official API when an API key is configured
- Falls back to scraping the public subnet page when the API is unavailable
- Stores snapshots in a local SQLite database
- Serves a browser dashboard with a beginner-friendly signal summary, supporting evidence cards, and historical charts
- Adds a "What matters most today" panel that explains the main correlation points in plain language
- Lets you switch the live poller between 1h / 2h / 4h from the admin drawer, with the choice saved in SQLite
- Lets you click the TAO price badge to open a historical TAO/USD chart
- Shows the next scheduled poll time in the top bar as a local timestamp
- Lets you switch historical metric charts between 24H / 7D / 14D / 30D / 60D in the modal, with 7D selected by default
- Lets you slide the modal chart window by 24 hours with left/right buttons or keyboard arrows
- Lets you click any latest snapshot card to open a historical modal with metric help text
- Tracks configured wallet balances from Taostats account latest/history endpoints, using wallet coldkeys, optional hotkeys, and human-friendly names from `.env`
- Shows wallet balances above the financial perspective panel, with the wallet modal presenting the breakdown in a single row and the current subnet stake in a compact horizontal strip
- Includes a collapsible hotkey history section in the wallet modal with positive/negative deltas so you can see whether each hotkey is moving up or down over time
- Caches wallet activity in SQLite and opens the wallet transaction modal from local data first, with a loading state while the local cache or fallback sync is in progress
- Surfaces wallet activity cache health as a colored badge in the top bar and admin panel, showing cached rows, last sync time, and the next scheduled sync
- Includes a standalone Pool growth estimator beneath the wallet section so you can simulate TAO injection against the current subnet pool snapshot
- Keeps operational JSON/debug views inside a collapsible admin panel that only appears when `TAOSTATS_ADMIN_API_KEY` is set, so the main dashboard stays clean
- Includes a subnet sentiment card that prefers Taostats SSI when available and falls back to the legacy Fear & Greed value on older rows
- Money In/Out charts use Taostats Tao Flow history so the historical view stays available even when the subnet snapshot history is sparse
- Subnet stats are arranged as a 4-column grid so the ten cards flow into three neat rows
- Includes an Alpha Holders card in Subnet stats that mirrors the Taostats SN110 chart holders tab count, derives the live count from the locally stored stake-balance holder snapshots, stores the latest holder addresses in SQLite, and opens a historical trend view from the locally stored snapshot history
- Adds a local alpha-holder ranking panel that compares every stored subnet by the latest DB-backed holder count, highlights SN110 in that table, and opens a historical SN110 rank chart built from the same local snapshot history
- Runs a dedicated daily alpha-holder snapshot job at UTC midnight so the holder chart keeps growing from local snapshots even when Taostats historical coverage is unavailable
- Keeps the Alpha holder addresses section collapsed by default so the table stays out of the way until you expand it
- Collapsible panels use a visible chevron affordance so expand/collapse behavior is easier to spot

## Requirements

- Node.js 22+

## Setup

```bash
npm start
```

The app will create `./data/sn110-tracker.sqlite` automatically.
The first run also creates the SQLite app-settings table used for the poll interval selector.

## Configuration

Environment variables:

- `PORT` - dashboard port, defaults to `3000`
- `TAOSTATS_NETUID` - subnet id, defaults to `110`
- `TAOSTATS_API_KEY` - optional API token for Taostats
- `TAOSTATS_AUTH_HEADER` - optional full `Authorization` header value
- `TAOSTATS_ADMIN_API_KEY` - optional feature flag that enables the admin drawer and its controls
- `TAOSTATS_API_MAX_REQUESTS_PER_MINUTE` - API budget cap, defaults to `5`
- `TAOSTATS_BACKFILL_DAYS` - number of days to backfill when using backfill mode, defaults to `0`
- `TAOSTATS_BACKFILL_FREQUENCY` - backfill resolution, defaults to `by_hour`
- `TAOSTATS_BACKFILL_ON_STARTUP` - set to `true` to run historical backfill on startup
- `TAOSTATS_BACKFILL_OVERWRITE` - replace overlapping rows in the backfill window, defaults to `true`
- `TAOSTATS_WALLET_ACTIVITY_BACKFILL_DAYS` - wallet activity backfill window, defaults to `60`
- `TAOSTATS_WALLET_ACTIVITY_SYNC_DAYS` - rolling wallet activity sync window, defaults to `7`
- `TAOSTATS_WALLET_ACTIVITY_SYNC_INTERVAL_MINUTES` - scheduled wallet activity sync cadence, defaults to `60`
- `TAOSTATS_WALLET_1_NAME`, `TAOSTATS_WALLET_1_COLDKEY` (or the backward-compatible `TAOSTATS_WALLET_1_SS58`), `TAOSTATS_WALLET_1_NETWORK` - first tracked wallet entry
- `TAOSTATS_WALLET_1_HOTKEY_1_NAME`, `TAOSTATS_WALLET_1_HOTKEY_1_SS58`, `TAOSTATS_WALLET_1_HOTKEY_1_NETUID`, `TAOSTATS_WALLET_1_HOTKEY_1_ROLE` - optional first hotkey for wallet 1
- `TAOSTATS_WALLET_2_NAME`, `TAOSTATS_WALLET_2_COLDKEY`, `TAOSTATS_WALLET_2_NETWORK` - second tracked wallet entry
- `TAOSTATS_WALLET_2_HOTKEY_1_NAME`, `TAOSTATS_WALLET_2_HOTKEY_1_SS58`, `TAOSTATS_WALLET_2_HOTKEY_1_NETUID`, `TAOSTATS_WALLET_2_HOTKEY_1_ROLE` - optional first hotkey for wallet 2
- Continue incrementing the wallet index and hotkey index for additional tracked wallets and hotkeys
- `TAOSTATS_BASE_URL` - defaults to `https://api.taostats.io`
- `TAOSTATS_PUBLIC_BASE_URL` - defaults to `https://taostats.io`
- `DB_PATH` - SQLite file path, defaults to `./data/sn110-tracker.sqlite`
- `POLL_INTERVAL_MINUTES` - polling interval, defaults to `60` and is normalised to the supported dashboard choices

The app automatically loads a local `.env` file from the project root if present.
You can keep your Taostats key there for local development.
You can also keep one or more wallet coldkeys there as indexed entries with matching names, and attach optional hotkeys per wallet for clearer miner/validator context. If you want the wallet modal to split the income sources, add `ROLE=validator` or `ROLE=owner` to the relevant hotkeys; anything you have not tagged yet stays in the residual/unclassified bucket instead of being forced into validator.
The checked-in `.env.example` is intentionally redacted, so copy it locally and replace the placeholder ss58 values with your own wallet and hotkey addresses.

If the Taostats API requires a prefix like `Bearer`, put the full header value in `TAOSTATS_AUTH_HEADER`.
When an API key is configured, the app rate-limits Taostats API requests to 5 per minute by default so the free tier is respected.
If `TAOSTATS_ADMIN_API_KEY` is set, the admin drawer appears with the manual refresh button, poll interval controls, JSON links, backfill form, wallet activity status badge, and ingest history views; without it, those controls stay hidden. The POST admin routes (`/api/subnets/:netuid/ingest`, `/api/subnets/:netuid/backfill`, `/api/subnets/:netuid/wallet-backfill`, and `/api/settings/poll-interval`) also require the matching `X-Admin-API-Key` header when the admin key is configured.
The dashboard also shows the current TAO price used for USD conversion and uses the stored TAO price history when you open the TAO price badge modal.
Wallet activity uses a separate backfill flow and admin-panel trigger, so the transaction timeline can stay on a local cache even when the live Taostats request path is slow.

## Historical backfill

You can seed SQLite with historical API data before the live poller starts.
The backfill command pulls Taostats history, replaces overlapping local rows by default, and then runs one live ingest so the latest snapshot still ends on the current API row.
The dashboard also exposes a matching admin-panel backfill form that posts to the same backfill flow, so you can trigger the import from the browser during testing.

```bash
npm run backfill -- --days 30 --frequency by_hour
```

Add `--no-overwrite` if you want the historical importer to keep existing local rows instead of replacing the overlapping window.
Use `npm run wallet-backfill -- --days 60` to prefill wallet activity rows for every configured coldkey.
That command uses the same wallet activity sync flow as the admin-panel trigger and the scheduled refresh, so overlapping windows dedupe safely in SQLite.
Use `npm run subnet-name-backfill` to refresh the local subnet metadata cache for every discovered subnet. It fills friendly names from the Taostats subnet catalog, falls back to the latest subnet snapshot when the catalog row is unnamed, and uses a small concurrent worker queue so the fallback lookups do not run strictly one at a time.
Use `npm run alpha-holder-backfill` or `npm run alpha-holder-history-backfill` to snapshot the current holder rows for every discovered subnet. Those commands seed the local alpha-holder ranking/history views with a baseline, and the daily UTC snapshot job keeps those charts growing after the initial collection starts.
The `alpha-holder-history-backfill` alias now reuses the supported snapshot path instead of calling an unsupported Taostats subnet-history endpoint; both CLI commands stream per-subnet progress to stderr and include a live ETA so long fills are easier to monitor from the terminal.
The manual alpha-holder snapshot path uses a small 3-worker subnet queue for faster fills, while the scheduled UTC sync stays sequential.
While each subnet is loading, the CLI also prints page-level heartbeat lines and worker ids so you can tell whether the fetch is still active before the subnet finishes.
If Taostats returns a 429 during the alpha-holder fetch, the CLI now pauses for about a minute, prints a retry message, and tries that page again once before moving on.
The alpha-holder ranking view now collapses by default into a current-subnet rank card. Opening it reveals the table-first leaderboard with rank, subnet, alpha-holder count, change from the prior daily sample, and a tiny trend sparkline. It still uses the latest stored subnet name when available, so labels read like `Chutes (SN64)` instead of plain `SN64`.
Those labels are backed by a small local subnet metadata cache, so the app can keep using the friendly name even when the current subnet snapshot is missing.

### Backfill command options

- `--days N` - look back N days when requesting API history
- `--frequency by_hour|by_day|by_block` - history resolution passed to Taostats
- `--netuid N` - override the subnet id for the backfill run
- `--overwrite` - replace overlapping local rows in the requested window
- `--no-overwrite` - keep existing rows and only insert missing history

Defaults come from the corresponding environment variables when set:

- `TAOSTATS_BACKFILL_DAYS`
- `TAOSTATS_BACKFILL_FREQUENCY`
- `TAOSTATS_BACKFILL_OVERWRITE`

Optional startup mode:

```bash
TAOSTATS_BACKFILL_DAYS=30 TAOSTATS_BACKFILL_FREQUENCY=by_hour TAOSTATS_BACKFILL_ON_STARTUP=true npm start
```

Backfill mode pulls Taostats historical subnet, pool, registration-cost, and alpha-holder address data, merges it into the same snapshot schema, and skips rows already stored for a block number when overwrite is disabled.
By default it deletes overlapping local rows in the requested time window before inserting the historical API snapshots, so the local chart stays continuous during testing.
It also backfills TAO price history so USD toggles keep working for historical values.
It also backfills Tao Flow history so the Money In/Out charts can render historical values from dedicated flow data.
If wallets are configured, backfill also pulls Taostats account history for each configured coldkey and stores the daily wallet balance history locally.
Alpha holder history is stored as snapshot rows in SQLite too, so the Alpha Holders card can chart previous days from the local `alpha_holder_snapshots` table. The new ranking panel also uses that table, so both the all-subnet ranking view and the SN110 rank chart only begin once local collection has stored its first alpha-holder samples.
The ranking panel compares every stored subnet by latest local holder count, highlights SN110 in the table, and collapses by default into a current-subnet card that expands into the leaderboard.
Backfill also pulls historical hotkey stake snapshots for each configured coldkey, so the wallet modal can show a hotkey history section alongside the live current stake positions.
Sentiment history will use SSI when Taostats provides it, with legacy Fear & Greed as a fallback for older live rows.

Wallet activity backfill covers extrinsics, transfers, and derived stake-delta events for configured wallets, and the rolling sync keeps a recent overlap window fresh after the initial 60-day load.

## Historical chart controls

Every historical metric modal includes:

- range buttons for `24H`, `7D`, `14D`, `30D`, and `60D` with `7D` selected by default
- a 24-hour sliding window control with left/right buttons
- matching keyboard shortcuts: left arrow for an earlier window, right arrow for a later window

The 24-hour sliding window keeps the chosen range but shifts the visible time span by one day at a time, which makes it easier to inspect how a metric changed across adjacent periods.

## Live polling interval

The dashboard top bar includes a small live poller selector for `1h`, `2h`, and `4h`.
Picking one updates the background polling timer immediately and saves the choice in SQLite under the app settings table, so the interval survives a restart.
The same setting is used on startup if it has already been stored locally.
The top bar also shows the next scheduled poll time and the wallet activity cache badge.
The dashboard now starts with a wallet section, followed by a collapsible financial perspective panel, then a beginner-friendly quick read and watchlist that highlight the main price, flow, sentiment, and supply relationships before the underlying charts.
Configured wallet balances appear in their own section, and clicking a wallet card opens the historical balance modal with wallet profile details such as rank, created-on date, configured hotkeys, current subnet stake positions, and coldkey swap status when available.
The wallet modal also includes an estimated income-sources section that can split recent wallet growth between validator and owner roles when you tag hotkeys with `ROLE`; anything you have not tagged yet stays in the residual bucket instead of being guessed as validator.
The wallet modal also includes a hotkey history panel with delta color-coding so you can quickly spot which subnet positions are growing or shrinking.
Ctrl/Cmd-clicking a wallet card opens a wallet transaction timeline modal that combines extrinsics, transfers, and hotkey stake deltas so you can inspect the underlying activity behind a wallet change.
The transaction modal now reads from SQLite first and only falls back to Taostats for cache misses or a manual refresh, and it shows a clear “Fetching wallet activity…” loading state while the local read or fallback sync is in progress.

## Pool growth estimator

The dashboard includes a standalone **Pool growth estimator** section directly beneath the wallet cards.

What it uses:
- the latest local subnet pool snapshot already stored in SQLite
- the current TAO reserve
- the current alpha reserve
- the current alpha price

What it does:
- simulates a TAO injection locally using the current pool ratio
- estimates alpha received
- projects the post-injection alpha price
- shows the percent price change and slippage against the no-slippage baseline
- projects the implied subnet market cap from the current market-cap snapshot and price move
- shows the projected TAO in pool after injection
- shows the market-cap and pool impact as change percentages
- includes a collapsible compact scenario curve for projected alpha price change vs TAO injected, spanning 0 to 2,500 TAO, with hover crosshair and tooltip readout; when collapsed, the estimator cards reflow to fill the panel, and when expanded the curve returns beside the stacked estimator cards with a smooth layout transition
- exposes the scenario chart through a mixed-case `Show chart` / `Hide chart` pill so the toggle reads like the rest of the panel text instead of shouting in uppercase

What to know:
- it is a what-if simulator, not a trade executor or transaction tracker
- results are approximate and assume the current snapshot is the baseline
- the estimator does not call a new backend route; it runs from the current dashboard data already in memory
- the market-cap output is implied from the current market-cap snapshot, so it should be read as an estimate rather than a protocol value
- if the local pool snapshot is missing reserve or price fields, the estimator shows an unavailable state instead of guessing

Implementation notes:
- the estimator source lives in `src/pool-estimator.js`
- the UI is rendered in `src/server.js`
- a longer source-and-behavior guide lives in `docs/pool-growth-estimator.md`

## Commands

- `npm start` - run the dashboard and background poller
- `npm run ingest -- --once` - fetch one snapshot and exit
- `npm run backfill -- --days 30 --frequency by_hour` - backfill historical API data, then refresh the live snapshot
- `npm run wallet-backfill -- --days 60` - backfill wallet activity for all configured coldkeys
- `npm run subnet-name-backfill` - refresh the local subnet metadata cache so friendly labels like `Chutes (SN64)` work even when the current subnet snapshot is missing; uses a small concurrent worker queue and prints live progress plus skip reasons
- `npm run alpha-holder-backfill` - snapshot the current alpha-holder row set for every discovered subnet so the ranking/history views start with a local baseline; uses a 3-worker manual queue, prints live progress, worker ids, page heartbeats, retry waits, and ETA to stderr
- `npm run alpha-holder-history-backfill` - alias for the alpha-holder backfill command; reuses the supported snapshot path, uses the same 3-worker manual queue, and prints live progress, worker ids, page heartbeats, retry waits, and ETA to stderr
- `npm run alpha-holder-sync` - refresh the latest alpha-holder snapshot rows for every discovered subnet; uses the same 3-worker manual queue and prints live progress, worker ids, page heartbeats, retry waits, and ETA to stderr
- `npm test` - run tests

## Endpoints

- `/` - redirect to the default subnet dashboard
- `/subnets/110` - dashboard
- `/api/subnets/110/latest` - latest stored snapshot
- `/api/subnets/110/history?days=30` - historical snapshots
- `/api/subnets/110/flow-history?days=30` - historical Tao Flow series used by Money In/Out charts
- `/api/subnets/110/alpha-holder-ranking` - latest local alpha-holder ranking across all stored subnets
- `/api/subnets/110/alpha-holder-rank-history?days=30` - historical SN110 rank series built from local alpha-holder snapshots across subnets
- `/api/wallets/<ss58>/latest` - latest stored wallet snapshot for a configured coldkey ss58 address
- `/api/wallets/<ss58>/history?days=30` - historical wallet balance rows for a configured coldkey ss58 address
- `/api/wallets/<ss58>/stake-history?days=30` - historical hotkey stake rows for a configured coldkey ss58 address
- `/api/wallets/<ss58>/transactions?days=7` - wallet activity timeline from local SQLite, with `?refresh=1` for a live sync fallback
- `/api/tao-price/history?days=30` - stored TAO/USD price history
- `POST /api/subnets/110/ingest` - manual ingest trigger
- `POST /api/subnets/110/backfill` - browser/admin backfill trigger
- `POST /api/subnets/110/wallet-backfill` - browser/admin wallet activity backfill trigger
- `/health` - current poll interval and next poll timestamp
