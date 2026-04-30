'use strict';

const {
  fetchLatestSnapshot,
  fetchHistoricalSnapshots,
  fetchTaoPriceLatest,
  fetchTaoPriceHistory,
} = require('./taostats');
const {
  insertSnapshot,
  insertTaoPriceSnapshot,
  insertIngestRun,
  snapshotExists,
  deleteSnapshotsInRange,
  deleteTaoPriceHistoryInRange,
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
      ok = true;
      message = `Captured ${result.snapshot.name || `SN${netuid}`} from ${source}`;
      return {
        ok,
        source,
        fallbackUsed,
        snapshotId,
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

      ok = true;
      message = `Backfilled ${inserted} historical snapshots`;
      detail.inserted = inserted;
      detail.skipped = skipped;
      detail.deleted = deleted;
      detail.priceInserted = priceInserted;
      detail.priceDeleted = priceDeleted;
      detail.priceSkipped = priceSkipped;
      return {
        ok,
        source,
        inserted,
        skipped,
        deleted,
        priceInserted,
        priceDeleted,
        priceSkipped,
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
