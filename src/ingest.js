'use strict';

const {
  fetchLatestSnapshot,
  fetchHistoricalSnapshots,
  fetchTaoPriceLatest,
  fetchTaoPriceHistory,
  fetchTaoFlowHistory,
  fetchAccountLatest,
  fetchAccountHistory,
} = require('./taostats');
const {
  insertSnapshot,
  insertTaoPriceSnapshot,
  insertTaoFlowSnapshot,
  insertWalletSnapshot,
  insertIngestRun,
  snapshotExists,
  taoFlowSnapshotExists,
  walletSnapshotExists,
  deleteSnapshotsInRange,
  deleteTaoPriceHistoryInRange,
  deleteTaoFlowHistoryInRange,
  deleteWalletSnapshotsInRange,
} = require('./db');

function createIngestService({ db, config }) {
  let active = false;

  async function ingestOnce({ netuid = config.netuid } = {}) {
    if (active) {
      return { skipped: true, reason: 'ingest already running' };
    }

    active = true;
    const startedAt = new Date();
    const startedIso = startedAt.toISOString();
    let snapshotId = null;
    let ok = false;
    let message = 'Snapshot ingested';
    let errorMessage = null;
    let source = 'scrape';
    let fallbackUsed = false;
    let detail = null;
    let walletInserted = 0;
    let walletFetched = 0;
    let walletErrors = [];

    try {
      const result = await fetchLatestSnapshot({
        netuid,
        taostatsBaseUrl: config.taostatsBaseUrl,
        taostatsPublicBaseUrl: config.taostatsPublicBaseUrl,
        taostatsAuthHeader: config.taostatsAuthHeader,
        rateLimiter: config.taostatsRateLimiter || null,
      });

      source = result.source;
      fallbackUsed = result.fallbackUsed;
      detail = result.detail;
      snapshotId = insertSnapshot(db, result.snapshot);
      if (config.taostatsAuthHeader) {
        try {
          const priceSnapshot = await fetchTaoPriceLatest({
            taostatsBaseUrl: config.taostatsBaseUrl,
            taostatsAuthHeader: config.taostatsAuthHeader,
            rateLimiter: config.taostatsRateLimiter || null,
            capturedAt: result.snapshot.captured_at,
          });
          if (priceSnapshot) {
            const taoPriceSnapshotId = insertTaoPriceSnapshot(db, priceSnapshot);
            detail = {
              ...detail,
              taoPriceSnapshotId,
              taoPriceUsd: priceSnapshot.price_usd,
            };
          }
        } catch (priceError) {
          detail = {
            ...detail,
            taoPriceError: priceError instanceof Error ? priceError.message : String(priceError),
          };
        }
      }

      if (Array.isArray(config.wallets) && config.wallets.length > 0 && config.taostatsAuthHeader) {
        for (const wallet of config.wallets) {
          try {
            const walletSnapshot = await fetchAccountLatest({
              address: wallet.ss58,
              network: wallet.network || 'finney',
              taostatsBaseUrl: config.taostatsBaseUrl,
              taostatsAuthHeader: config.taostatsAuthHeader,
              rateLimiter: config.taostatsRateLimiter || null,
              capturedAt: result.snapshot.captured_at,
            });
            walletFetched += 1;
            if (walletSnapshot) {
              walletSnapshot.wallet_name = wallet.name;
              const walletSnapshotId = insertWalletSnapshot(db, walletSnapshot);
              walletInserted += 1;
              detail = {
                ...detail,
                walletSnapshotId,
              };
            }
          } catch (walletError) {
            walletErrors.push({
              name: wallet.name,
              ss58: wallet.ss58,
              error: walletError instanceof Error ? walletError.message : String(walletError),
            });
          }
        }
        detail = {
          ...detail,
          walletFetched,
          walletInserted,
        };
        if (walletErrors.length) {
          detail = {
            ...detail,
            walletErrors,
          };
        }
      }
      ok = true;
      message = `Captured ${result.snapshot.name || `SN${netuid}`} from ${source}`;
      return {
        ok,
        source,
        fallbackUsed,
        snapshotId,
        walletInserted,
        detail,
        message,
      };
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error);
      message = 'Snapshot ingest failed';
      return {
        ok: false,
        source,
        fallbackUsed,
        snapshotId: null,
        walletInserted,
        detail,
        error: errorMessage,
        message,
      };
    } finally {
      const finishedAt = new Date();
      const durationMs = finishedAt.getTime() - startedAt.getTime();
      insertIngestRun(db, {
        netuid,
        started_at: startedIso,
        finished_at: finishedAt.toISOString(),
        duration_ms: durationMs,
        source,
        fallback_used: fallbackUsed,
        ok,
        snapshot_id: snapshotId,
        message,
        error: errorMessage,
        detail_json: detail ? JSON.stringify(detail) : null,
      });
      active = false;
    }
  }

  async function backfillHistoricalSnapshots({
    netuid = config.netuid,
    days = config.taostatsBackfillDays ?? 30,
    frequency = config.taostatsBackfillFrequency ?? 'by_hour',
    overwrite = config.taostatsBackfillOverwrite ?? true,
  } = {}) {
    if (active) {
      return { skipped: true, reason: 'ingest already running' };
    }

    active = true;
    const startedAt = new Date();
    const startedIso = startedAt.toISOString();
    let ok = false;
    let source = 'api-history';
    let errorMessage = null;
    let message = 'Historical backfill failed';
    let snapshotId = null;
    let detail = { days, frequency, overwrite: Boolean(overwrite) };
    let inserted = 0;
    let skipped = 0;
    let deleted = 0;
    let priceInserted = 0;
    let priceDeleted = 0;
    let priceSkipped = 0;
    let flowInserted = 0;
    let flowDeleted = 0;
    let flowSkipped = 0;
    let walletHistoryFetched = 0;
    let walletHistoryInserted = 0;
    let walletHistoryDeleted = 0;
    let walletHistorySkipped = 0;

    try {
      if (!config.taostatsAuthHeader) {
        throw new Error('Taostats API auth header is required for historical backfill');
      }

      const snapshots = await fetchHistoricalSnapshots({
        netuid,
        taostatsBaseUrl: config.taostatsBaseUrl,
        taostatsAuthHeader: config.taostatsAuthHeader,
        rateLimiter: config.taostatsRateLimiter || null,
        days,
        frequency,
      });

      detail = {
        ...detail,
        fetched: snapshots.length,
      };

      if (overwrite && snapshots.length > 0) {
        const capturedAts = snapshots
          .map((snapshot) => snapshot.captured_at)
          .filter(Boolean)
          .sort();
        const startIso = capturedAts[0];
        const endIso = capturedAts[capturedAts.length - 1];
        deleted = deleteSnapshotsInRange(db, netuid, startIso, endIso);
        priceDeleted = deleteTaoPriceHistoryInRange(db, startIso, endIso);
        detail.deleted = deleted;
        detail.priceDeleted = priceDeleted;
        detail.startIso = startIso;
        detail.endIso = endIso;
      }

      try {
        const taoFlowHistory = await fetchTaoFlowHistory({
          netuid,
          taostatsBaseUrl: config.taostatsBaseUrl,
          taostatsAuthHeader: config.taostatsAuthHeader,
          rateLimiter: config.taostatsRateLimiter || null,
          days,
        });

        detail.flowFetched = taoFlowHistory.length;

        if (overwrite && taoFlowHistory.length > 0) {
          const capturedAts = taoFlowHistory
            .map((row) => row.captured_at)
            .filter(Boolean)
            .sort();
          const flowStartIso = capturedAts[0];
          const flowEndIso = capturedAts[capturedAts.length - 1];
          flowDeleted = deleteTaoFlowHistoryInRange(db, netuid, flowStartIso, flowEndIso);
          detail.flowDeleted = flowDeleted;
          detail.flowStartIso = flowStartIso;
          detail.flowEndIso = flowEndIso;
        }

        for (const flowSnapshot of taoFlowHistory) {
        if (!overwrite && flowSnapshot.block_number !== null && flowSnapshot.block_number !== undefined && taoFlowSnapshotExists(db, netuid, flowSnapshot.block_number)) {
          flowSkipped += 1;
          continue;
        }
          insertTaoFlowSnapshot(db, flowSnapshot);
          flowInserted += 1;
        }
      } catch (flowError) {
        detail.flowError = flowError instanceof Error ? flowError.message : String(flowError);
      }

      for (const snapshot of snapshots) {
        if (!overwrite && snapshot.block_number !== null && snapshotExists(db, netuid, snapshot.block_number)) {
          skipped += 1;
          continue;
        }
        snapshotId = insertSnapshot(db, snapshot);
        inserted += 1;
      }

      try {
        const taoPriceHistory = await fetchTaoPriceHistory({
          taostatsBaseUrl: config.taostatsBaseUrl,
          taostatsAuthHeader: config.taostatsAuthHeader,
          rateLimiter: config.taostatsRateLimiter || null,
          days,
        });
        for (const priceSnapshot of taoPriceHistory) {
          insertTaoPriceSnapshot(db, priceSnapshot);
          priceInserted += 1;
        }
        detail.priceFetched = taoPriceHistory.length;
      } catch (priceError) {
        detail.priceError = priceError instanceof Error ? priceError.message : String(priceError);
      }

      if (Array.isArray(config.wallets) && config.wallets.length > 0) {
        for (const wallet of config.wallets) {
          try {
            const walletHistory = await fetchAccountHistory({
              address: wallet.ss58,
              network: wallet.network || 'finney',
              taostatsBaseUrl: config.taostatsBaseUrl,
              taostatsAuthHeader: config.taostatsAuthHeader,
              rateLimiter: config.taostatsRateLimiter || null,
              days,
            });
            walletHistoryFetched += walletHistory.length;
            if (overwrite && walletHistory.length > 0) {
              const capturedAts = walletHistory
                .map((row) => row.captured_at)
                .filter(Boolean)
                .sort();
              const walletStartIso = capturedAts[0];
              const walletEndIso = capturedAts[capturedAts.length - 1];
              walletHistoryDeleted += deleteWalletSnapshotsInRange(db, wallet.ss58, walletStartIso, walletEndIso);
              detail.walletStartIso = detail.walletStartIso || walletStartIso;
              detail.walletEndIso = detail.walletEndIso || walletEndIso;
            }
            for (const row of walletHistory) {
              if (!overwrite && row.block_number !== null && row.block_number !== undefined && walletSnapshotExists(db, wallet.ss58, row.block_number)) {
                walletHistorySkipped += 1;
                continue;
              }
              row.wallet_name = wallet.name;
              insertWalletSnapshot(db, row);
              walletHistoryInserted += 1;
            }
          } catch (walletError) {
            detail.walletError = walletError instanceof Error ? walletError.message : String(walletError);
          }
        }
        detail.walletHistoryFetched = walletHistoryFetched;
        detail.walletHistoryInserted = walletHistoryInserted;
        detail.walletHistoryDeleted = walletHistoryDeleted;
        detail.walletHistorySkipped = walletHistorySkipped;
      }

      ok = true;
      message = `Backfilled ${inserted} historical snapshots`;
      detail.inserted = inserted;
      detail.skipped = skipped;
      detail.deleted = deleted;
      detail.priceInserted = priceInserted;
      detail.priceDeleted = priceDeleted;
      detail.priceSkipped = priceSkipped;
      detail.flowInserted = flowInserted;
      detail.flowDeleted = flowDeleted;
      detail.flowSkipped = flowSkipped;
      detail.walletHistoryFetched = walletHistoryFetched;
      detail.walletHistoryInserted = walletHistoryInserted;
      detail.walletHistoryDeleted = walletHistoryDeleted;
      detail.walletHistorySkipped = walletHistorySkipped;
      return {
        ok,
        source,
        inserted,
        skipped,
        deleted,
        priceInserted,
        priceDeleted,
        priceSkipped,
        flowInserted,
        flowDeleted,
        flowSkipped,
        walletHistoryFetched,
        walletHistoryInserted,
        walletHistoryDeleted,
        walletHistorySkipped,
        snapshotId,
        detail,
        message,
      };
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error);
      detail.error = errorMessage;
      return {
        ok: false,
        source,
        inserted,
        skipped,
        deleted,
        priceInserted,
        priceDeleted,
        priceSkipped,
        flowInserted,
        flowDeleted,
        flowSkipped,
        walletHistoryFetched,
        walletHistoryInserted,
        walletHistoryDeleted,
        walletHistorySkipped,
        snapshotId: null,
        detail,
        error: errorMessage,
        message,
      };
    } finally {
      const finishedAt = new Date();
      const durationMs = finishedAt.getTime() - startedAt.getTime();
      insertIngestRun(db, {
        netuid,
        started_at: startedIso,
        finished_at: finishedAt.toISOString(),
        duration_ms: durationMs,
        source,
        fallback_used: false,
        ok,
        snapshot_id: snapshotId,
        message,
        error: errorMessage,
        detail_json: detail ? JSON.stringify(detail) : null,
      });
      active = false;
    }
  }

  return {
    ingestOnce,
    backfillHistoricalSnapshots,
    isActive: () => active,
  };
}

module.exports = { createIngestService };
