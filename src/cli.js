'use strict';

const { loadConfig } = require('./config');
const { openDatabase } = require('./db');
const { createIngestService } = require('./ingest');
const { createRateLimiter } = require('./taostats');

function readArg(name, fallback = null) {
  const prefix = `--${name}=`;
  const exact = process.argv.find((arg) => arg.startsWith(prefix));
  if (exact) {
    return exact.slice(prefix.length);
  }

  const index = process.argv.indexOf(`--${name}`);
  if (index !== -1 && process.argv[index + 1] && !process.argv[index + 1].startsWith('--')) {
    return process.argv[index + 1];
  }

  return fallback;
}

function intArg(value, fallback) {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function boolArg(name, fallback) {
  if (process.argv.includes(`--no-${name}`)) return false;
  if (process.argv.includes(`--${name}`)) return true;
  return fallback;
}

async function run() {
  const config = loadConfig();
  config.taostatsRateLimiter = config.taostatsAuthHeader
    ? createRateLimiter({ maxRequests: config.taostatsApiMaxRequestsPerMinute })
    : null;
  const db = openDatabase(config.dbPath);
  const ingestService = createIngestService({ db, config });
  const backfill = process.argv.includes('--backfill');
  const walletBackfill = process.argv.includes('--wallet-backfill') || process.argv.includes('--wallet-activity-backfill');
  const alphaHolderBackfill = process.argv.includes('--alpha-holder-backfill') || process.argv.includes('--alpha-holder-history-backfill');
  const alphaHolderSync = process.argv.includes('--alpha-holder-sync');
  const once = process.argv.includes('--once');

  let result;
  if (walletBackfill) {
    result = await ingestService.backfillWalletActivity({
      days: intArg(readArg('days', config.taostatsWalletActivityBackfillDays || 60), config.taostatsWalletActivityBackfillDays || 60),
      limit: intArg(readArg('limit', 200), 200),
    });
  } else if (alphaHolderBackfill) {
    result = await ingestService.backfillAlphaHolderHistory({
      netuid: intArg(readArg('netuid', null), null),
      days: intArg(readArg('days', config.taostatsBackfillDays || 30), config.taostatsBackfillDays || 30),
      overwrite: boolArg('overwrite', config.taostatsBackfillOverwrite ?? true),
      limit: intArg(readArg('limit', 1024), 1024),
    });
  } else if (alphaHolderSync) {
    result = await ingestService.backfillAlphaHolderSnapshots({
      capturedAt: new Date().toISOString(),
      skipIfAlreadyCapturedToday: boolArg('skip-if-captured-today', true),
      limit: intArg(readArg('limit', 1024), 1024),
    });
  } else if (backfill) {
    const backfillResult = await ingestService.backfillHistoricalSnapshots({
      netuid: intArg(readArg('netuid', config.netuid), config.netuid),
      days: intArg(readArg('days', config.taostatsBackfillDays || 30), config.taostatsBackfillDays || 30),
      frequency: String(readArg('frequency', config.taostatsBackfillFrequency || 'by_hour')),
      overwrite: boolArg('overwrite', config.taostatsBackfillOverwrite ?? true),
    });
    const liveResult = await ingestService.ingestOnce({ netuid: config.netuid });
    result = {
      backfill: backfillResult,
      live: liveResult,
    };
  } else {
    result = await ingestService.ingestOnce({ netuid: config.netuid });
  }
  console.log(JSON.stringify(result, null, 2));

  if (!once && !backfill) {
    console.log('Use --once to run the ingest command and exit.');
  }

  db.close();
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
