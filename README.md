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
- Lets you switch the live poller between 1h / 2h / 4h from the dashboard, with the choice saved in SQLite
- Lets you click the TAO price badge to open a historical TAO/USD chart
- Shows the next scheduled poll time in the top bar
- Lets you switch historical metric charts between 24H / 7D / 30D / 60D in the modal
- Lets you click any latest snapshot card to open a historical modal with metric help text
- Keeps operational JSON/debug views inside a collapsible admin panel so the main dashboard stays clean
- Includes a subnet sentiment card that prefers Taostats SSI when available and falls back to the legacy Fear & Greed value on older rows
- Money In/Out charts use Taostats Tao Flow history so the historical view stays available even when the subnet snapshot history is sparse

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
- `TAOSTATS_API_MAX_REQUESTS_PER_MINUTE` - API budget cap, defaults to `5`
- `TAOSTATS_BACKFILL_DAYS` - number of days to backfill when using backfill mode, defaults to `0`
- `TAOSTATS_BACKFILL_FREQUENCY` - backfill resolution, defaults to `by_hour`
- `TAOSTATS_BACKFILL_ON_STARTUP` - set to `true` to run historical backfill on startup
- `TAOSTATS_BACKFILL_OVERWRITE` - replace overlapping rows in the backfill window, defaults to `true`
- `TAOSTATS_BASE_URL` - defaults to `https://api.taostats.io`
- `TAOSTATS_PUBLIC_BASE_URL` - defaults to `https://taostats.io`
- `DB_PATH` - SQLite file path, defaults to `./data/sn110-tracker.sqlite`
- `POLL_INTERVAL_MINUTES` - polling interval, defaults to `60` and is normalised to the supported dashboard choices

The app automatically loads a local `.env` file from the project root if present.
You can keep your Taostats key there for local development.

If the Taostats API requires a prefix like `Bearer`, put the full header value in `TAOSTATS_AUTH_HEADER`.
When an API key is configured, the app rate-limits Taostats API requests to 5 per minute by default so the free tier is respected.
The dashboard also shows the current TAO price used for USD conversion and uses the stored TAO price history when you open the TAO price badge modal.

## Historical backfill

You can seed SQLite with historical API data before the live poller starts.
The backfill command pulls Taostats history, replaces overlapping local rows by default, and then runs one live ingest so the latest snapshot still ends on the current API row.
The dashboard also exposes a matching admin-panel backfill form that posts to the same backfill flow, so you can trigger the import from the browser during testing.

```bash
npm run backfill -- --days 30 --frequency by_hour
```

Add `--no-overwrite` if you want the historical importer to keep existing local rows instead of replacing the overlapping window.

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

Backfill mode pulls Taostats historical subnet, pool, and registration-cost data, merges it into the same snapshot schema, and skips rows already stored for a block number when overwrite is disabled.
By default it deletes overlapping local rows in the requested time window before inserting the historical API snapshots, so the local chart stays continuous during testing.
It also backfills TAO price history so USD toggles keep working for historical values.
It also backfills Tao Flow history so the Money In/Out charts can render historical values from dedicated flow data.
Sentiment history will use SSI when Taostats provides it, with legacy Fear & Greed as a fallback for older live rows.

## Live polling interval

The dashboard top bar includes a small live poller selector for `1h`, `2h`, and `4h`.
Picking one updates the background polling timer immediately and saves the choice in SQLite under the app settings table, so the interval survives a restart.
The same setting is used on startup if it has already been stored locally.
The top bar also shows the next scheduled poll time.
The dashboard now starts with a collapsible financial perspective panel, followed by a beginner-friendly quick read and watchlist that highlight the main price, flow, sentiment, and supply relationships before the underlying charts.
The Token Price chart is now also surfaced in the hero area so the latest price trend is visible before the rest of the dashboard sections.

## Commands

- `npm start` - run the dashboard and background poller
- `npm run ingest -- --once` - fetch one snapshot and exit
- `npm run backfill -- --days 30 --frequency by_hour` - backfill historical API data, then refresh the live snapshot
- `npm test` - run tests

## Endpoints

- `/` - redirect to the default subnet dashboard
- `/subnets/110` - dashboard
- `/api/subnets/110/latest` - latest stored snapshot
- `/api/subnets/110/history?days=30` - historical snapshots
- `/api/subnets/110/flow-history?days=30` - historical Tao Flow series used by Money In/Out charts
- `/api/tao-price/history?days=30` - stored TAO/USD price history
- `POST /api/subnets/110/ingest` - manual ingest trigger
- `POST /api/subnets/110/backfill` - browser/admin backfill trigger
- `/health` - current poll interval and next poll timestamp
