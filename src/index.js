'use strict';

const { loadConfig, normalizePollIntervalMinutes } = require('./config');
const { openDatabase, getSetting, setSetting } = require('./db');
const { createIngestService } = require('./ingest');
const { createDashboardServer } = require('./server');
const { createRateLimiter } = require('./taostats');

async function main() {
  const config = loadConfig();
  config.taostatsRateLimiter = config.taostatsAuthHeader
    ? createRateLimiter({ maxRequests: config.taostatsApiMaxRequestsPerMinute })
    : null;
  const db = openDatabase(config.dbPath);
  const storedPollIntervalMinutes = normalizePollIntervalMinutes(
    getSetting(db, 'poll_interval_minutes'),
    config.pollIntervalMinutes,
  );
  config.pollIntervalMinutes = storedPollIntervalMinutes;
  config.pollIntervalMs = storedPollIntervalMinutes * 60 * 1000;
  config.nextPollAtIso = new Date(Date.now() + config.pollIntervalMs).toISOString();
  setSetting(db, 'poll_interval_minutes', storedPollIntervalMinutes);
  const ingestService = createIngestService({ db, config });
  let timer = null;

  const schedulePolling = (minutes) => {
    const normalizedMinutes = normalizePollIntervalMinutes(minutes, config.pollIntervalMinutes);
    config.pollIntervalMinutes = normalizedMinutes;
    config.pollIntervalMs = normalizedMinutes * 60 * 1000;
    config.nextPollAtIso = new Date(Date.now() + config.pollIntervalMs).toISOString();
    if (timer) {
      clearInterval(timer);
    }
    timer = setInterval(() => {
      config.nextPollAtIso = new Date(Date.now() + config.pollIntervalMs).toISOString();
      void ingestService.ingestOnce({ netuid: config.netuid }).catch((error) => {
        console.error('Scheduled ingest failed:', error);
      });
    }, config.pollIntervalMs);
    timer.unref();
    return {
      pollIntervalMinutes: normalizedMinutes,
      nextPollAtIso: config.nextPollAtIso,
    };
  };

  const app = createDashboardServer({
    db,
    ingestService,
    config,
    onPollIntervalChange: async (minutes) => {
      const normalizedMinutes = normalizePollIntervalMinutes(minutes, config.pollIntervalMinutes);
      setSetting(db, 'poll_interval_minutes', normalizedMinutes);
      return schedulePolling(normalizedMinutes);
    },
  });

  schedulePolling(config.pollIntervalMinutes);
  await app.start(config.port);
  console.log(`SN${config.netuid} dashboard running on http://localhost:${config.port}`);
  console.log(`SQLite database: ${config.dbPath}`);
  if (config.taostatsRateLimiter) {
    console.log(`Taostats API rate limit: ${config.taostatsRateLimiter.maxRequests}/${config.taostatsRateLimiter.intervalMs / 1000}s`);
  }
  if (config.taostatsBackfillOnStartup && config.taostatsBackfillDays > 0) {
    console.log(`Historical backfill: enabled (${config.taostatsBackfillDays} days, ${config.taostatsBackfillFrequency})`);
  }

  const startupTask = config.taostatsBackfillOnStartup && config.taostatsBackfillDays > 0
    ? ingestService.backfillHistoricalSnapshots({
        netuid: config.netuid,
        days: config.taostatsBackfillDays,
        frequency: config.taostatsBackfillFrequency,
      }).then(() => ingestService.ingestOnce({ netuid: config.netuid }))
    : ingestService.ingestOnce({ netuid: config.netuid });

  void startupTask.catch((error) => {
    console.error('Initial ingest failed:', error);
  });

  const shutdown = async () => {
    if (timer) {
      clearInterval(timer);
    }
    await app.close();
    db.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
