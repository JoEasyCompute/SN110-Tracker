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
  let subnetCatalogTimer = null;
  let alphaHolderTimer = null;
  let schedulerQueue = Promise.resolve();
  const isAlphaHolderBackfillActive = () => ingestService.isAlphaHolderBackfillActive();

  const enqueueSerialTask = (task) => {
    schedulerQueue = schedulerQueue.then(task, task);
    return schedulerQueue;
  };

  const createRecurringSerialScheduler = ({
    initialDelayMs,
    getDefaultDelayMs,
    isPaused = () => false,
    updateNextRunIso = () => {},
    run,
    retryDelayMs = 30_000,
  }) => {
    let currentTimer = null;
    let cancelled = false;

    const schedule = (delayMs) => {
      if (cancelled) {
        return;
      }
      const effectiveDelayMs = Math.max(1_000, Number(delayMs) || 0);
      updateNextRunIso(new Date(Date.now() + effectiveDelayMs).toISOString());
      if (currentTimer) {
        clearTimeout(currentTimer);
      }
      currentTimer = setTimeout(() => {
        void enqueueSerialTask(async () => {
          if (cancelled) {
            return;
          }
          if (isPaused()) {
            schedule(retryDelayMs);
            return;
          }
          try {
            const result = await run();
            const nextDelayMs = Number(result?.retryAfterMs) > 0
              ? Number(result.retryAfterMs)
              : getDefaultDelayMs(result);
            schedule(nextDelayMs);
          } catch (error) {
            const nextDelayMs = Number(error?.retryAfterMs) > 0
              ? Number(error?.retryAfterMs)
              : retryDelayMs;
            schedule(nextDelayMs);
          }
        });
      }, effectiveDelayMs);
      currentTimer.unref();
    };

    schedule(initialDelayMs);

    return {
      stop() {
        cancelled = true;
        if (currentTimer) {
          clearTimeout(currentTimer);
        }
      },
    };
  };

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
      alphaHolderTimer.stop();
      alphaHolderTimer = null;
    }
    const nextRunMs = msUntilNextUtcMidnight();
    alphaHolderTimer = createRecurringSerialScheduler({
      initialDelayMs: nextRunMs,
      getDefaultDelayMs: () => msUntilNextUtcMidnight(),
      isPaused: () => ingestService.isActive() || isAlphaHolderBackfillActive(),
      updateNextRunIso: (iso) => {
        config.nextAlphaHolderSnapshotAtIso = iso;
      },
      run: () => ingestService.syncAllAlphaHolderSnapshots({ capturedAt: new Date().toISOString() }).catch((error) => {
        console.error('Scheduled alpha-holder snapshot batch failed:', error);
        throw error;
      }),
    });
    return {
      nextAlphaHolderSnapshotAtIso: config.nextAlphaHolderSnapshotAtIso,
    };
  };

  const schedulePolling = (minutes) => {
    const normalizedMinutes = normalizePollIntervalMinutes(minutes, config.pollIntervalMinutes);
    config.pollIntervalMinutes = normalizedMinutes;
    config.pollIntervalMs = normalizedMinutes * 60 * 1000;
    if (timer) {
      timer.stop();
      timer = null;
    }
    timer = createRecurringSerialScheduler({
      initialDelayMs: config.pollIntervalMs,
      getDefaultDelayMs: () => config.pollIntervalMs,
      isPaused: () => ingestService.isActive() || isAlphaHolderBackfillActive(),
      updateNextRunIso: (iso) => {
        config.nextPollAtIso = iso;
      },
      run: async () => {
        const result = await ingestService.ingestOnce({ netuid: config.netuid });
        if (result?.skipped && result.reason === 'ingest already running') {
          return { retryAfterMs: 30_000 };
        }
        return result;
      },
    });
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
    if (walletActivityTimer) {
      walletActivityTimer.stop();
      walletActivityTimer = null;
    }
    walletActivityTimer = createRecurringSerialScheduler({
      initialDelayMs: normalizedMinutes * 60 * 1000,
      getDefaultDelayMs: () => normalizedMinutes * 60 * 1000,
      isPaused: () => ingestService.isActive() || isAlphaHolderBackfillActive(),
      updateNextRunIso: (iso) => {
        config.nextWalletActivitySyncAtIso = iso;
      },
      run: async () => {
        const result = await ingestService.syncWalletActivity({
          days: config.taostatsWalletActivitySyncDays,
        });
        if (result?.skipped && result.reason === 'ingest already running') {
          return { retryAfterMs: 30_000 };
        }
        return result;
      },
    });
    return {
      walletActivitySyncIntervalMinutes: normalizedMinutes,
      nextWalletActivitySyncAtIso: config.nextWalletActivitySyncAtIso,
    };
  };

  const scheduleSubnetCatalogSnapshot = (minutes = config.taostatsSubnetCatalogSnapshotIntervalMinutes || 30) => {
    if (!config.taostatsAuthHeader) {
      return null;
    }
    const normalizedMinutes = Number.isFinite(Number(minutes)) && Number(minutes) > 0
      ? Number(minutes)
      : 30;
    config.taostatsSubnetCatalogSnapshotIntervalMinutes = normalizedMinutes;
    if (subnetCatalogTimer) {
      subnetCatalogTimer.stop();
      subnetCatalogTimer = null;
    }
    subnetCatalogTimer = createRecurringSerialScheduler({
      initialDelayMs: normalizedMinutes * 60 * 1000,
      getDefaultDelayMs: () => normalizedMinutes * 60 * 1000,
      isPaused: () => ingestService.isActive() || isAlphaHolderBackfillActive(),
      updateNextRunIso: (iso) => {
        config.nextSubnetCatalogSnapshotAtIso = iso;
      },
      run: async () => {
        const result = await ingestService.backfillSubnetCatalogSnapshots({ overwrite: false });
        if (result?.skipped && result.reason === 'ingest already running') {
          return { retryAfterMs: 30_000 };
        }
        return result;
      },
    });
    return {
      subnetCatalogSnapshotIntervalMinutes: normalizedMinutes,
      nextSubnetCatalogSnapshotAtIso: config.nextSubnetCatalogSnapshotAtIso,
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
  scheduleSubnetCatalogSnapshot(config.taostatsSubnetCatalogSnapshotIntervalMinutes);
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
    console.log(`Subnet table snapshots: every ${config.taostatsSubnetCatalogSnapshotIntervalMinutes} minute${config.taostatsSubnetCatalogSnapshotIntervalMinutes === 1 ? '' : 's'}`);
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
      timer.stop();
    }
    if (walletActivityTimer) {
      walletActivityTimer.stop();
    }
    if (subnetCatalogTimer) {
      subnetCatalogTimer.stop();
    }
    if (alphaHolderTimer) {
      alphaHolderTimer.stop();
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
