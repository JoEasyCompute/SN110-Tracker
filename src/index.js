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
  let walletActivityTimer = null;
  let alphaHolderTimer = null;
  const isAlphaHolderBackfillActive = () => ingestService.isAlphaHolderBackfillActive();

  const msUntilNextUtcMidnight = (now = Date.now()) => {
    const current = new Date(now);
    const nextMidnight = Date.UTC(
      current.getUTCFullYear(),
      current.getUTCMonth(),
      current.getUTCDate() + 1,
      0,
      0,
      0,
      0,
    );
    return Math.max(1000, nextMidnight - now);
  };

  const scheduleAlphaHolderSnapshot = () => {
    if (!config.taostatsAuthHeader) {
      return null;
    }
    if (alphaHolderTimer) {
      clearTimeout(alphaHolderTimer);
      alphaHolderTimer = null;
    }
    const nextRunMs = msUntilNextUtcMidnight();
    config.nextAlphaHolderSnapshotAtIso = new Date(Date.now() + nextRunMs).toISOString();
    alphaHolderTimer = setTimeout(() => {
      if (ingestService.isActive() || isAlphaHolderBackfillActive()) {
        scheduleAlphaHolderSnapshot();
        return;
      }
      void ingestService.syncAllAlphaHolderSnapshots({ capturedAt: new Date().toISOString() }).catch((error) => {
        console.error('Scheduled alpha-holder snapshot batch failed:', error);
      }).finally(() => {
        scheduleAlphaHolderSnapshot();
      });
    }, nextRunMs);
    alphaHolderTimer.unref();
    return {
      nextAlphaHolderSnapshotAtIso: config.nextAlphaHolderSnapshotAtIso,
    };
  };

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
      if (isAlphaHolderBackfillActive()) {
        return;
      }
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

  const scheduleWalletActivitySync = (minutes) => {
    if (!config.taostatsAuthHeader || !Array.isArray(config.wallets) || config.wallets.length === 0) {
      return null;
    }
    const normalizedMinutes = Number.isFinite(Number(minutes)) && Number(minutes) > 0
      ? Number(minutes)
      : config.taostatsWalletActivitySyncIntervalMinutes || 60;
    config.walletActivitySyncIntervalMinutes = normalizedMinutes;
    config.nextWalletActivitySyncAtIso = new Date(Date.now() + normalizedMinutes * 60 * 1000).toISOString();
    if (walletActivityTimer) {
      clearInterval(walletActivityTimer);
    }
    walletActivityTimer = setInterval(() => {
      config.nextWalletActivitySyncAtIso = new Date(Date.now() + normalizedMinutes * 60 * 1000).toISOString();
      if (isAlphaHolderBackfillActive()) {
        return;
      }
      void ingestService.syncWalletActivity({
        days: config.taostatsWalletActivitySyncDays,
      }).catch((error) => {
        console.error('Scheduled wallet activity sync failed:', error);
      });
    }, normalizedMinutes * 60 * 1000);
    walletActivityTimer.unref();
    return {
      walletActivitySyncIntervalMinutes: normalizedMinutes,
      nextWalletActivitySyncAtIso: config.nextWalletActivitySyncAtIso,
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
  scheduleWalletActivitySync(config.taostatsWalletActivitySyncIntervalMinutes);
  scheduleAlphaHolderSnapshot();
  await app.start(config.port);
  console.log(`SN${config.netuid} dashboard running on http://localhost:${config.port}`);
  console.log(`SQLite database: ${config.dbPath}`);
  if (config.taostatsRateLimiter) {
    console.log(`Taostats API rate limit: ${config.taostatsRateLimiter.maxRequests}/${config.taostatsRateLimiter.intervalMs / 1000}s`);
  }
  if (Array.isArray(config.wallets) && config.wallets.length > 0) {
    console.log(`Wallet tracking: ${config.wallets.length} wallet${config.wallets.length === 1 ? '' : 's'} configured`);
  }
  if (config.taostatsAuthHeader && Array.isArray(config.wallets) && config.wallets.length > 0) {
    console.log(`Wallet activity sync: every ${config.taostatsWalletActivitySyncIntervalMinutes} minute${config.taostatsWalletActivitySyncIntervalMinutes === 1 ? '' : 's'} (recent ${config.taostatsWalletActivitySyncDays} days)`);
  }
  if (config.taostatsAuthHeader) {
    console.log('Alpha-holder snapshots: all subnets daily at UTC midnight');
  }
  if (isAlphaHolderBackfillActive()) {
    console.log('Alpha-holder backfill is active; background polling and sync jobs are paused.');
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

  void startupTask
    .catch((error) => {
      console.error('Initial ingest failed:', error);
    })
    .finally(() => {
      if (!config.taostatsAuthHeader || !Array.isArray(config.wallets) || config.wallets.length === 0) {
        return;
      }
      void ingestService.syncWalletActivity({
        days: config.taostatsWalletActivitySyncDays,
      }).catch((error) => {
        console.error('Initial wallet activity sync failed:', error);
      });
    });

  const shutdown = async () => {
    if (timer) {
      clearInterval(timer);
    }
    if (walletActivityTimer) {
      clearInterval(walletActivityTimer);
    }
    if (alphaHolderTimer) {
      clearTimeout(alphaHolderTimer);
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
