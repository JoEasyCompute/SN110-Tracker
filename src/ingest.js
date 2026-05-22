'use strict';

const defaultTaostats = require('./taostats');
const {
  buildWalletTransactionTimeline,
  buildWalletTransactionDbRecord,
  buildWalletTransactionTimelineFromRows,
} = require('./wallet-activity');
const {
  normalizeSnapshot,
} = require('./taostats');
const {
  insertSnapshot,
  insertTaoPriceSnapshot,
  insertTaoFlowSnapshot,
  insertWalletSnapshot,
  insertWalletStakePosition,
  insertAlphaHolderSnapshot,
  insertWalletTransaction,
  insertIngestRun,
  backfillChainBuysInRange,
  upsertSubnetMetadata,
  getSubnetMetadataMap,
  snapshotExists,
  taoFlowSnapshotExists,
  walletSnapshotExists,
  walletStakePositionExists,
  deleteSnapshotsInRange,
  deleteTaoPriceHistoryInRange,
  deleteTaoFlowHistoryInRange,
  deleteWalletSnapshotsInRange,
  deleteWalletStakePositionsInRange,
  deleteAlphaHolderSnapshotsInRange,
  getAlphaHolderSnapshotLatestCapturedAt,
  getWalletTransactions,
  getSetting,
  setSetting,
} = require('./db');

const ALPHA_HOLDER_BACKFILL_ACTIVE_KEY = 'alpha_holder_backfill_active';
const ALPHA_HOLDER_BACKFILL_STARTED_AT_KEY = 'alpha_holder_backfill_started_at';
const DEFAULT_RETRY_DELAY_MS = 60_000;
const TAOSTATS_CREDITS_EXHAUSTED_RETRY_MS = 6 * 60 * 60 * 1000;

function isTaostatsCreditsExhaustedError(error) {
  const bodyText = typeof error?.body === 'string' ? error.body : '';
  const message = String(error?.body?.message || error?.body?.error || bodyText || error?.message || error || '');
  return /insufficient credits/i.test(message);
}

function retryDelayFromTaostatsError(error, fallbackMs = DEFAULT_RETRY_DELAY_MS) {
  if (!error || Number(error?.status) !== 429) {
    return null;
  }
  const retryAfterMs = Number(error?.retryAfterMs);
  if (Number.isFinite(retryAfterMs) && retryAfterMs > 0) {
    return retryAfterMs;
  }
  if (isTaostatsCreditsExhaustedError(error)) {
    return TAOSTATS_CREDITS_EXHAUSTED_RETRY_MS;
  }
  const fallbackDelayMs = Number(fallbackMs);
  return Number.isFinite(fallbackDelayMs) && fallbackDelayMs > 0 ? fallbackDelayMs : DEFAULT_RETRY_DELAY_MS;
}

function retryDelayFromError(error, fallbackMs = DEFAULT_RETRY_DELAY_MS) {
  return retryDelayFromTaostatsError(error, fallbackMs);
}

function createIngestService({ db, config, taostats = defaultTaostats } = {}) {
  const {
    fetchLatestSnapshot,
    fetchHistoricalSnapshots,
    fetchSubnetLatestCatalog,
    fetchFromPublicPage,
    fetchTaoPriceLatest,
    fetchTaoPriceHistory,
    fetchTaoFlowHistory,
    fetchAccountLatest,
    fetchAccountHistory,
    fetchStakeBalanceLatest,
    fetchHistoricalStakeBalance,
  } = taostats;

  let active = false;
  let activeJob = null;

  function getActiveJob() {
    if (!activeJob) return null;
    const startedAtMs = Date.parse(activeJob.startedAtIso);
    return {
      ...activeJob,
      elapsedMs: Number.isFinite(startedAtMs) ? Math.max(0, Date.now() - startedAtMs) : null,
    };
  }

  function activeSkipResult() {
    return { skipped: true, reason: 'ingest already running', activeJob: getActiveJob() };
  }

  function beginActiveJob(kind, detail = {}) {
    const startedAt = new Date();
    active = true;
    activeJob = {
      kind,
      label: detail.label || kind,
      startedAtIso: startedAt.toISOString(),
      ...detail,
    };
    return startedAt;
  }

  function updateActiveJobDetail(detail = {}) {
    if (!activeJob) return null;
    activeJob = {
      ...activeJob,
      ...detail,
    };
    return getActiveJob();
  }

  function finishActiveJob() {
    active = false;
    activeJob = null;
  }

  function isAlphaHolderBackfillActive() {
    return String(getSetting(db, ALPHA_HOLDER_BACKFILL_ACTIVE_KEY) || '').trim() === '1';
  }

  function setAlphaHolderBackfillActive(activeState) {
    setSetting(db, ALPHA_HOLDER_BACKFILL_ACTIVE_KEY, activeState ? '1' : '0');
    if (activeState) {
      setSetting(db, ALPHA_HOLDER_BACKFILL_STARTED_AT_KEY, new Date().toISOString());
    }
    return activeState;
  }

  function recordAlphaHolderSnapshotRun({ startedAt, capturedAt, result = null, error = null }) {
    const finishedAt = new Date();
    const allResults = Array.isArray(result?.results) ? result.results : [];
    const notableResults = allResults
      .filter((row) => row && (row.ok === false || row.reason || row.error))
      .slice(0, 25);
    const retryAfterMs = Number.isFinite(Number(result?.retryAfterMs)) && Number(result.retryAfterMs) > 0
      ? Number(result.retryAfterMs)
      : null;
    const errorMessage = error instanceof Error
      ? error.message
      : (error ? String(error) : (retryAfterMs ? (result?.reason || notableResults[0]?.reason || 'Alpha-holder snapshot batch deferred') : (result?.ok === false ? (result.reason || notableResults[0]?.reason || 'Alpha-holder snapshot batch failed') : null)));
    const detail = {
      capturedAt,
      fetched: Number(result?.fetched || 0),
      inserted: Number(result?.inserted || 0),
      netuids: Number(result?.netuids || allResults.length || 0),
      skipped: Boolean(result?.skipped),
      reason: result?.reason || null,
      failedSubnets: allResults.filter((row) => row?.ok === false).length,
      skippedSubnets: allResults.filter((row) => row?.skipped).length,
      deferredSubnets: Math.max(0, Number(result?.netuids || 0) - allResults.length),
      retryAfterMs,
      notableResults,
    };
    const message = retryAfterMs
      ? 'Alpha-holder snapshot batch deferred'
      : errorMessage
        ? 'Alpha-holder snapshot batch failed'
        : result?.skipped
          ? `Alpha-holder snapshot skipped: ${result.reason || 'not run'}`
          : 'Alpha-holder snapshot batch completed';
    insertIngestRun(db, {
      netuid: config.netuid,
      started_at: startedAt.toISOString(),
      finished_at: finishedAt.toISOString(),
      duration_ms: finishedAt.getTime() - startedAt.getTime(),
      source: 'alpha-holder-snapshot-all',
      fallback_used: false,
      ok: !errorMessage && !retryAfterMs,
      snapshot_id: null,
      message,
      error: errorMessage,
      detail_json: JSON.stringify(detail),
    });
  }

  function resolveWalletConfig(address) {
    return (config.wallets || []).find((wallet) => String(wallet.ss58 || wallet.coldkey || '') === String(address || ''))
      || {
        name: String(address || 'Wallet'),
        ss58: String(address || ''),
        coldkey: String(address || ''),
        network: 'finney',
        hotkeys: [],
      };
  }

  function normalizeWalletDays(days, fallback) {
    const parsed = Number.parseInt(String(days ?? ''), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  }

  async function storeWalletTimelineRows({ walletConfig, rows, sourceUrl = null, source = 'api-history' }) {
    let inserted = 0;
    for (const row of Array.isArray(rows) ? rows : []) {
      const record = buildWalletTransactionDbRecord({
        walletConfig,
        row,
        sourceUrl,
        source,
      });
      insertWalletTransaction(db, record);
      inserted += 1;
    }
    return inserted;
  }

  async function storeAlphaHolderRows({ rows, source = 'api', sourceUrl = null, capturedAt = null }) {
    let inserted = 0;
    const normalizedRows = Array.isArray(rows) ? rows : [];
    if (!normalizedRows.length) {
      return inserted;
    }
    db.exec('BEGIN');
    try {
      for (const row of normalizedRows) {
        const blockNumber = row.block_number ?? null;
        const dedupeKey = [
          row.netuid ?? config.netuid ?? 'unknown',
          blockNumber ?? row.remote_timestamp ?? row.captured_at ?? capturedAt ?? 'unknown',
          row.wallet_address_ss58 ?? row.coldkey_ss58 ?? 'unknown',
          row.hotkey_address_ss58 ?? 'unknown',
        ].join(':');
        insertAlphaHolderSnapshot(db, {
          ...row,
          source: row.source || source,
          source_url: row.source_url || sourceUrl,
          captured_at: row.captured_at || capturedAt || new Date().toISOString(),
          dedupe_key: row.dedupe_key || dedupeKey,
        });
        inserted += 1;
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    return inserted;
  }

  async function syncSubnetMetadataCatalog({
    limit = 1024,
    concurrency = 1,
    onProgress = null,
  } = {}) {
    if (!config.taostatsAuthHeader) {
      return { fetched: 0, inserted: 0, skipped: 0, rows: [] };
    }

    const catalog = await fetchSubnetLatestCatalog({
      taostatsBaseUrl: config.taostatsBaseUrl,
      taostatsAuthHeader: config.taostatsAuthHeader,
      rateLimiter: config.taostatsRateLimiter || null,
      limit,
    });

    const rows = Array.isArray(catalog) ? catalog : [];
    const cachedRows = getSubnetMetadataMap(db, rows.map((row) => row?.netuid));
    const startedAtMs = Date.now();
    const emitProgress = (payload) => {
      if (typeof onProgress === 'function') {
        onProgress(payload);
      }
    };
    const total = rows.length;
    const resolvedRows = [];
    const skippedRows = [];
    let inserted = 0;
    let skipped = 0;
    let completedCount = 0;
    const parsedConcurrency = Number.parseInt(String(concurrency), 10);
    const workersTotal = Math.max(1, Math.min(3, Number.isFinite(parsedConcurrency) && parsedConcurrency > 0 ? parsedConcurrency : 1));

    emitProgress({
      phase: 'start',
      operation: 'subnet-name-backfill',
      total,
      completed: 0,
      remaining: total,
      elapsedMs: 0,
      etaMs: null,
      etaIso: null,
      netuid: null,
      fetched: total,
      inserted: 0,
      skipped: 0,
      ok: true,
      workersTotal,
      message: total > 0 ? 'running' : 'no subnets discovered',
    });

    const processRow = async (row, index, workerId = null) => {
      const netuid = Number.parseInt(String(row?.netuid), 10);
      const startedElapsedMs = Date.now() - startedAtMs;
      const startedEtaMs = completedCount > 0 && completedCount < total
        ? Math.max(0, Math.round((startedElapsedMs / completedCount) * (total - completedCount)))
        : 0;
      emitProgress({
        phase: 'item-start',
        operation: 'subnet-name-backfill',
        total,
        completed: completedCount,
        remaining: Math.max(0, total - completedCount),
        elapsedMs: startedElapsedMs,
        etaMs: startedEtaMs,
        etaIso: startedEtaMs > 0 ? new Date(Date.now() + startedEtaMs).toISOString() : null,
        netuid: Number.isFinite(netuid) && netuid > 0 ? netuid : null,
        fetched: total,
        inserted,
        skipped,
        ok: true,
        message: Number.isFinite(netuid) && netuid > 0 ? `SN${netuid}` : 'invalid subnet',
        workerId,
        workersTotal,
      });

      if (!Number.isFinite(netuid) || netuid <= 0) {
        skipped += 1;
        skippedRows.push({ netuid: null, reason: 'invalid subnet' });
        completedCount += 1;
        const completed = completedCount;
        const elapsedMs = Date.now() - startedAtMs;
        const etaMs = completed > 0 && completed < total
          ? Math.max(0, Math.round((elapsedMs / completed) * (total - completed)))
          : 0;
        emitProgress({
          phase: 'item',
          operation: 'subnet-name-backfill',
          total,
          completed,
          remaining: Math.max(0, total - completed),
          elapsedMs,
          etaMs,
          etaIso: etaMs > 0 ? new Date(Date.now() + etaMs).toISOString() : null,
          netuid: null,
          fetched: total,
          inserted,
          skipped,
          ok: true,
          message: 'skipped invalid subnet',
          workerId,
          workersTotal,
        });
        return;
      }

      let name = String(row?.name ?? '').trim();
      let symbol = row?.symbol ?? null;
      let sourceUrl = `${config.taostatsBaseUrl.replace(/\/$/, '')}/api/subnet/latest/v1`;
      if (!name) {
        const cached = cachedRows.get(netuid);
        if (cached?.name) {
          name = String(cached.name).trim();
          symbol = cached.symbol ?? symbol;
          sourceUrl = cached.source_url || sourceUrl;
        } else {
          try {
            const snapshotResult = await fetchLatestSnapshot({
              netuid,
              taostatsBaseUrl: config.taostatsBaseUrl,
              taostatsPublicBaseUrl: config.taostatsPublicBaseUrl,
              taostatsAuthHeader: config.taostatsAuthHeader,
              rateLimiter: config.taostatsRateLimiter || null,
            });
            if (snapshotResult?.snapshot?.name) {
              name = String(snapshotResult.snapshot.name).trim();
              symbol = snapshotResult.snapshot.symbol ?? symbol;
              sourceUrl = snapshotResult.snapshot.source_url || sourceUrl;
            }
          } catch {
            // Missing subnet name is non-fatal here; keep the cache additive and fall back elsewhere.
          }
        }
      }

      if (!name) {
        skipped += 1;
        skippedRows.push({ netuid, reason: 'missing subnet name' });
        completedCount += 1;
        const completed = completedCount;
        const elapsedMs = Date.now() - startedAtMs;
        const etaMs = completed > 0 && completed < total
          ? Math.max(0, Math.round((elapsedMs / completed) * (total - completed)))
          : 0;
        emitProgress({
          phase: 'item',
          operation: 'subnet-name-backfill',
          total,
          completed,
          remaining: Math.max(0, total - completed),
          elapsedMs,
          etaMs,
          etaIso: etaMs > 0 ? new Date(Date.now() + etaMs).toISOString() : null,
          netuid,
          fetched: total,
          inserted,
          skipped,
          ok: true,
          message: 'missing subnet name',
          workerId,
          workersTotal,
        });
        return;
      }

      resolvedRows.push({
        netuid,
        name,
        symbol,
        source: 'api',
        source_url: sourceUrl,
        captured_at: row?.timestamp ?? row?.last_updated ?? row?.updated_at ?? row?.created_at ?? new Date().toISOString(),
        raw_json: JSON.stringify(row),
      });
      inserted += 1;
      completedCount += 1;
      const completed = completedCount;
      const elapsedMs = Date.now() - startedAtMs;
      const etaMs = completed > 0 && completed < total
        ? Math.max(0, Math.round((elapsedMs / completed) * (total - completed)))
        : 0;
      emitProgress({
        phase: 'item',
        operation: 'subnet-name-backfill',
        total,
        completed,
        remaining: Math.max(0, total - completed),
        elapsedMs,
        etaMs,
        etaIso: etaMs > 0 ? new Date(Date.now() + etaMs).toISOString() : null,
        netuid,
        fetched: total,
        inserted,
        skipped,
        ok: true,
        message: name,
        workerId,
        workersTotal,
      });
    };

    if (workersTotal <= 1 || rows.length <= 1) {
      for (const [index, row] of rows.entries()) {
        // eslint-disable-next-line no-await-in-loop
        await processRow(row, index, 1);
      }
    } else {
      let nextIndex = 0;
      await Promise.all(Array.from({ length: workersTotal }, async (_, workerIndex) => {
        const workerId = workerIndex + 1;
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const currentIndex = nextIndex;
          nextIndex += 1;
          if (currentIndex >= rows.length) {
            break;
          }
          // eslint-disable-next-line no-await-in-loop
          await processRow(rows[currentIndex], currentIndex, workerId);
        }
      }));
    }

    if (resolvedRows.length > 0) {
      db.exec('BEGIN');
      try {
        for (const row of resolvedRows) {
          upsertSubnetMetadata(db, row);
        }
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    }

    const elapsedMs = Date.now() - startedAtMs;
    emitProgress({
      phase: 'done',
      operation: 'subnet-name-backfill',
      total,
      completed: total,
      remaining: 0,
      elapsedMs,
      etaMs: 0,
      etaIso: null,
      netuid: null,
      fetched: total,
      inserted,
      skipped,
      ok: true,
      message: total > 0 ? 'done' : 'no subnets discovered',
    });

    return {
      fetched: rows.length,
      inserted,
      skipped,
      rows,
      skippedRows,
    };
  }

  async function backfillSubnetNames({
    limit = 1024,
    concurrency = 1,
    onProgress = null,
  } = {}) {
    return syncSubnetMetadataCatalog({
      limit,
      concurrency,
      onProgress,
    });
  }

  async function syncAlphaHolderSnapshot({
    netuid = config.netuid,
    capturedAt = new Date().toISOString(),
    skipIfAlreadyCapturedToday = true,
    limit = 1024,
    onProgress = null,
    workerId = null,
    maxRetries = 3,
    retryDelayMs = 60_000,
  } = {}) {
    if (!config.taostatsAuthHeader) {
      return {
        ok: false,
        skipped: true,
        source: 'alpha-holder-snapshot',
        fetched: 0,
        inserted: 0,
        reason: 'Taostats API auth header is required for alpha holder snapshots',
      };
    }

    if (skipIfAlreadyCapturedToday) {
      const latestCapturedAt = getAlphaHolderSnapshotLatestCapturedAt(db, netuid);
      const latestDay = latestCapturedAt ? String(latestCapturedAt).slice(0, 10) : null;
      const currentDay = String(capturedAt).slice(0, 10);
      if (latestDay && latestDay === currentDay) {
        return {
          ok: true,
          skipped: true,
          source: 'alpha-holder-snapshot',
          fetched: 0,
          inserted: 0,
          capturedAt,
          reason: 'Alpha holder snapshot already captured today',
        };
      }
    }

    try {
      const rows = await fetchStakeBalanceLatest({
        netuid,
        taostatsBaseUrl: config.taostatsBaseUrl,
        taostatsAuthHeader: config.taostatsAuthHeader,
        rateLimiter: config.taostatsRateLimiter || null,
        capturedAt,
        limit,
        onProgress,
        maxRetries,
        retryDelayMs,
        workerId,
      });
      const inserted = await storeAlphaHolderRows({
        rows,
        source: 'api',
        sourceUrl: `${config.taostatsBaseUrl.replace(/\/$/, '')}/api/dtao/stake_balance/latest/v1`,
        capturedAt,
      });

      return {
        ok: true,
        skipped: false,
        source: 'alpha-holder-snapshot',
        fetched: rows.length,
        inserted,
        capturedAt,
      };
    } catch (error) {
      const retryAfterMs = retryDelayFromError(error);
      if (retryAfterMs !== null) {
        return {
          ok: false,
          skipped: false,
          source: 'alpha-holder-snapshot',
          fetched: 0,
          inserted: 0,
          capturedAt,
          retryAfterMs,
          retryable: true,
          reason: 'Alpha-holder snapshot is temporarily rate-limited by Taostats; retrying later.',
        };
      }
      throw error;
    }
  }

  async function resolveAlphaHolderNetuids({
    netuid = null,
    limit = 1024,
  } = {}) {
    const netuids = new Set();
    const fallbackNetuid = Number.parseInt(String(netuid ?? config.netuid), 10);
    if (Number.isFinite(fallbackNetuid) && fallbackNetuid > 0) {
      netuids.add(fallbackNetuid);
    }

    if (!config.taostatsAuthHeader) {
      return [...netuids].sort((a, b) => a - b);
    }

    try {
      const { rows: catalog } = await syncSubnetMetadataCatalog({ limit, concurrency: 1 });
      for (const subnet of Array.isArray(catalog) ? catalog : []) {
        const subnetNetuid = Number.parseInt(String(subnet?.netuid), 10);
        if (Number.isFinite(subnetNetuid) && subnetNetuid > 0) {
          netuids.add(subnetNetuid);
        }
      }
    } catch {
      // Compatibility path: keep the configured subnet even if catalog discovery fails.
    }

    return [...netuids].sort((a, b) => a - b);
  }

  async function backfillSubnetCatalogSnapshots({
    overwrite = false,
    limit = 1024,
  } = {}) {
    if (active) {
      return activeSkipResult();
    }
    if (isAlphaHolderBackfillActive()) {
      return { skipped: true, reason: 'alpha-holder backfill is running' };
    }

    const startedAt = beginActiveJob('subnet-table-snapshot-backfill', {
      label: 'Subnet table snapshot backfill',
      netuid: config.netuid,
      overwrite: Boolean(overwrite),
      limit,
    });
    const startedIso = startedAt.toISOString();
    const durationMs = () => Math.max(0, Date.now() - startedAt.getTime());
    let ok = false;
    let source = 'subnet-catalog-snapshot';
    let errorMessage = null;
    let message = 'Subnet table snapshot backfill failed';
    let snapshotId = null;
    const detail = { overwrite: Boolean(overwrite), limit };
    let fetched = 0;
    let inserted = 0;
    let skipped = 0;
    let deleted = 0;
    let processed = 0;

    try {
      if (!config.taostatsAuthHeader) {
        throw new Error('Taostats API auth header is required for subnet table snapshots');
      }

      const { rows: catalog } = await syncSubnetMetadataCatalog({ limit, concurrency: 1 });
      const capturedAt = new Date().toISOString();
      const sourceUrl = `${config.taostatsBaseUrl.replace(/\/$/, '')}/api/subnet/latest/v1`;

      fetched = Array.isArray(catalog) ? catalog.length : 0;
      detail.fetched = fetched;
      detail.capturedAt = capturedAt;
      updateActiveJobDetail({
        total: fetched,
        processed: 0,
        remaining: fetched,
        progressPct: fetched > 0 ? 0 : null,
        etaMs: null,
        etaIso: null,
        currentNetuid: null,
        currentLabel: null,
      });

      for (const row of Array.isArray(catalog) ? catalog : []) {
        const subnetNetuid = Number.parseInt(String(row?.netuid), 10);
        const currentLabel = row?.subnet_name || row?.name || row?.label || (Number.isFinite(subnetNetuid) ? `SN${subnetNetuid}` : null);
        updateActiveJobDetail({
          currentNetuid: Number.isFinite(subnetNetuid) ? subnetNetuid : null,
          currentLabel: currentLabel ? String(currentLabel) : null,
        });
        if (!Number.isFinite(subnetNetuid) || subnetNetuid <= 0) {
          skipped += 1;
          processed += 1;
          const remaining = Math.max(0, fetched - processed);
          const elapsedMs = Date.now() - startedAt.getTime();
          const etaMs = processed > 0 && remaining > 0 ? Math.max(0, Math.round((elapsedMs / processed) * remaining)) : null;
          updateActiveJobDetail({
            processed,
            remaining,
            progressPct: fetched > 0 ? Math.min(100, Math.round((processed / fetched) * 100)) : null,
            etaMs,
            etaIso: etaMs > 0 ? new Date(Date.now() + etaMs).toISOString() : null,
          });
          continue;
        }

        let publicSnapshot = null;
        try {
          publicSnapshot = await fetchFromPublicPage({
            netuid: subnetNetuid,
            taostatsPublicBaseUrl: config.taostatsPublicBaseUrl,
            rateLimiter: config.taostatsRateLimiter || null,
            includeHolders: false,
          });
        } catch {
          publicSnapshot = null;
        }
        const normalizedSnapshot = publicSnapshot || normalizeSnapshot(row, {
          source,
          sourceUrl,
          netuid: subnetNetuid,
          capturedAt,
        });
        normalizedSnapshot.source = source;
        normalizedSnapshot.captured_at = capturedAt;
        const snapshot = normalizedSnapshot;

        if (!overwrite && snapshot.block_number !== null && snapshot.block_number !== undefined && snapshotExists(db, subnetNetuid, snapshot.block_number)) {
          skipped += 1;
          continue;
        }

        if (overwrite && snapshot.block_number !== null && snapshot.block_number !== undefined) {
          const deleteResult = db.prepare(`
            DELETE FROM snapshots
            WHERE netuid = ? AND block_number = ?
          `).run(subnetNetuid, snapshot.block_number);
          deleted += Number(deleteResult?.changes || 0);
        }

        snapshotId = insertSnapshot(db, snapshot);
        inserted += 1;
        processed += 1;
        const remaining = Math.max(0, fetched - processed);
        const elapsedMs = Date.now() - startedAt.getTime();
        const etaMs = processed > 0 && remaining > 0 ? Math.max(0, Math.round((elapsedMs / processed) * remaining)) : null;
        updateActiveJobDetail({
          processed,
          remaining,
          progressPct: fetched > 0 ? Math.min(100, Math.round((processed / fetched) * 100)) : null,
          etaMs,
          etaIso: etaMs > 0 ? new Date(Date.now() + etaMs).toISOString() : null,
        });
      }

      ok = true;
      message = `Backfilled ${inserted} subnet table snapshots`;
      detail.inserted = inserted;
      detail.skipped = skipped;
      detail.deleted = deleted;
      detail.durationMs = durationMs();
      return {
        ok,
        source,
        fetched,
        inserted,
        skipped,
        deleted,
        durationMs: durationMs(),
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
        fetched,
        inserted,
        skipped,
        deleted,
        durationMs: durationMs(),
        snapshotId: null,
        detail,
        error: errorMessage,
        message,
      };
    } finally {
      const finishedAt = new Date();
      insertIngestRun(db, {
        netuid: config.netuid,
        started_at: startedIso,
        finished_at: finishedAt.toISOString(),
        duration_ms: finishedAt.getTime() - startedAt.getTime(),
        source,
        fallback_used: false,
        ok,
        snapshot_id: snapshotId,
        message,
        error: errorMessage,
        detail_json: detail ? JSON.stringify(detail) : null,
      });
      finishActiveJob();
    }
  }

  async function backfillAllSubnetHistoricalSnapshots({
    days = config.taostatsBackfillDays ?? 30,
    frequency = config.taostatsBackfillFrequency ?? 'by_hour',
    overwrite = config.taostatsBackfillOverwrite ?? true,
    limit = 1024,
  } = {}) {
    if (active) {
      return activeSkipResult();
    }
    if (isAlphaHolderBackfillActive()) {
      return { skipped: true, reason: 'alpha-holder backfill is running' };
    }

    const startedAt = beginActiveJob('all-subnet-historical-backfill', {
      label: 'All subnet historical backfill',
      netuid: config.netuid,
      days,
      frequency,
      overwrite: Boolean(overwrite),
      limit,
    });
    const startedIso = startedAt.toISOString();
    const durationMs = () => Math.max(0, Date.now() - startedAt.getTime());
    let ok = false;
    let source = 'all-subnet-historical-backfill';
    let errorMessage = null;
    let message = 'Historical subnet backfill failed';
    let snapshotId = null;
    const detail = { days, frequency, overwrite: Boolean(overwrite), limit };
    let fetched = 0;
    let inserted = 0;
    let skipped = 0;
    let deleted = 0;
    let retryAfterMs = null;
    let deferred = false;
    const results = [];
    let processed = 0;

    try {
      if (!config.taostatsAuthHeader) {
        throw new Error('Taostats API auth header is required for historical subnet snapshots');
      }

      const { rows: catalog } = await syncSubnetMetadataCatalog({ limit, concurrency: 1 });
      const netuids = [...new Set((Array.isArray(catalog) ? catalog : [])
        .map((row) => Number.parseInt(String(row?.netuid), 10))
        .filter((value) => Number.isFinite(value) && value > 0))].sort((a, b) => a - b);

      detail.netuids = netuids.length;
      updateActiveJobDetail({
        total: netuids.length,
        processed: 0,
        remaining: netuids.length,
        progressPct: netuids.length > 0 ? 0 : null,
        etaMs: null,
        etaIso: null,
        currentNetuid: null,
        currentLabel: null,
      });

      for (const subnetNetuid of netuids) {
        const subnetResult = {
          netuid: subnetNetuid,
          fetched: 0,
          inserted: 0,
          skipped: 0,
          deleted: 0,
        };
        updateActiveJobDetail({
          currentNetuid: subnetNetuid,
          currentLabel: `SN${subnetNetuid}`,
        });
        try {
          const snapshots = await fetchHistoricalSnapshots({
            netuid: subnetNetuid,
            taostatsBaseUrl: config.taostatsBaseUrl,
            taostatsAuthHeader: config.taostatsAuthHeader,
            rateLimiter: config.taostatsRateLimiter || null,
            days,
            frequency,
          });

          subnetResult.fetched = snapshots.length;
          fetched += snapshots.length;

          if (overwrite && snapshots.length > 0) {
            const capturedAts = snapshots
              .map((snapshot) => snapshot.captured_at)
              .filter(Boolean)
              .sort();
            if (capturedAts.length > 0) {
              const startIso = capturedAts[0];
              const endIso = capturedAts[capturedAts.length - 1];
              subnetResult.deleted = deleteSnapshotsInRange(db, subnetNetuid, startIso, endIso);
              deleted += subnetResult.deleted;
            }
          }

          for (const snapshot of snapshots) {
            if (!overwrite && snapshot.block_number !== null && snapshot.block_number !== undefined && snapshotExists(db, subnetNetuid, snapshot.block_number)) {
              subnetResult.skipped += 1;
              skipped += 1;
              continue;
            }
            snapshotId = insertSnapshot(db, snapshot);
            subnetResult.inserted += 1;
            inserted += 1;
          }
        } catch (error) {
          const delayMs = retryDelayFromError(error);
          if (delayMs !== null) {
            retryAfterMs = Math.max(Number(retryAfterMs) || 0, delayMs);
            deferred = true;
          }
          subnetResult.error = error instanceof Error ? error.message : String(error);
          results.push(subnetResult);
          processed += 1;
          const remaining = Math.max(0, netuids.length - processed);
          const elapsedMs = Date.now() - startedAt.getTime();
          const etaMs = processed > 0 && remaining > 0 ? Math.max(0, Math.round((elapsedMs / processed) * remaining)) : null;
          updateActiveJobDetail({
            processed,
            remaining,
            progressPct: netuids.length > 0 ? Math.min(100, Math.round((processed / netuids.length) * 100)) : null,
            etaMs,
            etaIso: etaMs > 0 ? new Date(Date.now() + etaMs).toISOString() : null,
            lastError: subnetResult.error || null,
          });
          if (delayMs !== null) {
            break;
          }
          continue;
        }
        results.push(subnetResult);
        processed += 1;
        const remaining = Math.max(0, netuids.length - processed);
        const elapsedMs = Date.now() - startedAt.getTime();
        const etaMs = processed > 0 && remaining > 0 ? Math.max(0, Math.round((elapsedMs / processed) * remaining)) : null;
        updateActiveJobDetail({
          processed,
          remaining,
          progressPct: netuids.length > 0 ? Math.min(100, Math.round((processed / netuids.length) * 100)) : null,
          etaMs,
          etaIso: etaMs > 0 ? new Date(Date.now() + etaMs).toISOString() : null,
          lastError: null,
        });
      }

      detail.results = results;
      detail.fetched = fetched;
      detail.inserted = inserted;
      detail.skipped = skipped;
      detail.deleted = deleted;
      if (retryAfterMs) {
        detail.retryAfterMs = retryAfterMs;
      }

      if (retryAfterMs) {
        ok = false;
        message = 'Historical subnet backfill deferred';
        return {
          ok,
          deferred: true,
          retryAfterMs,
          source,
          fetched,
          inserted,
          skipped,
          deleted,
          durationMs: durationMs(),
          snapshotId,
          detail,
          message,
        };
      }

      ok = true;
      message = `Backfilled ${inserted} historical subnet snapshots across ${netuids.length} subnets`;
      return {
        ok,
        deferred: false,
        retryAfterMs: null,
        source,
        fetched,
        inserted,
        skipped,
        deleted,
        durationMs: durationMs(),
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
        fetched,
        inserted,
        skipped,
        deleted,
        durationMs: durationMs(),
        snapshotId: null,
        detail,
        error: errorMessage,
        message,
      };
    } finally {
      const finishedAt = new Date();
      insertIngestRun(db, {
        netuid: config.netuid,
        started_at: startedIso,
        finished_at: finishedAt.toISOString(),
        duration_ms: finishedAt.getTime() - startedAt.getTime(),
        source,
        fallback_used: false,
        ok,
        snapshot_id: snapshotId,
        message,
        error: errorMessage,
        detail_json: detail ? JSON.stringify(detail) : null,
      });
      finishActiveJob();
    }
  }

  async function syncAllAlphaHolderSnapshots({
    capturedAt = new Date().toISOString(),
    skipIfAlreadyCapturedToday = true,
    limit = 1024,
    concurrency = 1,
    onProgress = null,
    respectAlphaHolderBackfillLock = true,
  } = {}) {
    const startedAt = new Date();
    if (!config.taostatsAuthHeader) {
      const result = {
        ok: false,
        skipped: true,
        source: 'alpha-holder-snapshot-all',
        fetched: 0,
        inserted: 0,
        netuids: 0,
        reason: 'Taostats API auth header is required for alpha holder snapshots',
      };
      recordAlphaHolderSnapshotRun({ startedAt, capturedAt, result });
      return result;
    }

    if (respectAlphaHolderBackfillLock && isAlphaHolderBackfillActive()) {
      const result = {
        ok: true,
        skipped: true,
        source: 'alpha-holder-snapshot-all',
        fetched: 0,
        inserted: 0,
        netuids: 0,
        capturedAt,
        reason: 'Alpha-holder backfill is running',
      };
      recordAlphaHolderSnapshotRun({ startedAt, capturedAt, result });
      return result;
    }

    const startedAtMs = startedAt.getTime();
    const workersTotal = 1;
    const emitProgress = (payload) => {
      if (typeof onProgress === 'function') {
        onProgress(payload);
      }
    };

    let subnets = [];
    try {
      subnets = await resolveAlphaHolderNetuids({ limit });

      emitProgress({
        phase: 'start',
        operation: 'alpha-holder-sync',
        total: subnets.length,
        completed: 0,
        remaining: subnets.length,
        elapsedMs: 0,
        etaMs: null,
        etaIso: null,
        netuid: null,
        fetched: 0,
        inserted: 0,
        skipped: false,
        ok: true,
        capturedAt,
        workersTotal,
        message: workersTotal > 1 ? `running with ${workersTotal} workers` : 'running',
      });

      let fetched = 0;
      let inserted = 0;
      let ok = true;
      let retryAfterMs = null;
      let deferred = false;
      const results = [];
      let completedCount = 0;

      const processSubnet = async (netuid, index, workerId = null) => {
        const startedCompleted = completedCount;
        const startedElapsedMs = Date.now() - startedAtMs;
        const startedEtaMs = startedCompleted > 0 && startedCompleted < subnets.length
          ? Math.max(0, Math.round((startedElapsedMs / startedCompleted) * (subnets.length - startedCompleted)))
          : 0;
        emitProgress({
          phase: 'item-start',
          operation: 'alpha-holder-sync',
          total: subnets.length,
          completed: startedCompleted,
          remaining: Math.max(0, subnets.length - startedCompleted),
          elapsedMs: startedElapsedMs,
          etaMs: startedEtaMs,
          etaIso: startedEtaMs > 0 ? new Date(Date.now() + startedEtaMs).toISOString() : null,
          netuid,
          fetched: 0,
          inserted: 0,
          skipped: false,
          ok: true,
          message: `SN${netuid}`,
          workerId,
          workersTotal,
        });

        try {
          const snapshot = await syncAlphaHolderSnapshot({
            netuid,
            capturedAt,
            skipIfAlreadyCapturedToday,
            limit,
            onProgress,
            workerId,
          });
          fetched += Number(snapshot.fetched || 0);
          inserted += Number(snapshot.inserted || 0);
          if (snapshot.ok === false || snapshot.error) {
            ok = false;
          }
          if (Number(snapshot.retryAfterMs) > 0) {
            retryAfterMs = Math.max(Number(retryAfterMs) || 0, Number(snapshot.retryAfterMs));
            deferred = true;
            ok = false;
          }
          results[index] = {
            netuid,
            ok: snapshot.ok !== false && !snapshot.error,
            skipped: Boolean(snapshot.skipped),
            fetched: Number(snapshot.fetched || 0),
            inserted: Number(snapshot.inserted || 0),
            reason: snapshot.reason || null,
            retryAfterMs: Number(snapshot.retryAfterMs) > 0 ? Number(snapshot.retryAfterMs) : null,
          };
          completedCount += 1;
          const completed = completedCount;
          const elapsedMs = Date.now() - startedAtMs;
          const etaMs = completed > 0 && completed < subnets.length
            ? Math.max(0, Math.round((elapsedMs / completed) * (subnets.length - completed)))
            : 0;
          emitProgress({
            phase: 'item',
            operation: 'alpha-holder-sync',
            total: subnets.length,
            completed,
            remaining: Math.max(0, subnets.length - completed),
            elapsedMs,
            etaMs,
            etaIso: etaMs > 0 ? new Date(Date.now() + etaMs).toISOString() : null,
            netuid,
            fetched: Number(snapshot.fetched || 0),
            inserted: Number(snapshot.inserted || 0),
            skipped: Boolean(snapshot.skipped),
            ok: snapshot.ok !== false && !snapshot.error,
            message: `SN${netuid}`,
            workerId,
            workersTotal,
          });
          if (deferred) {
            return;
          }
        } catch (error) {
          ok = false;
          const delayMs = retryDelayFromError(error);
          if (delayMs !== null) {
            retryAfterMs = Math.max(Number(retryAfterMs) || 0, delayMs);
            deferred = true;
          }
          results[index] = {
            netuid,
            ok: false,
            skipped: false,
            fetched: 0,
            inserted: 0,
            reason: error instanceof Error ? error.message : String(error),
            retryAfterMs: delayMs,
          };
          completedCount += 1;
          const completed = completedCount;
          const elapsedMs = Date.now() - startedAtMs;
          const etaMs = completed > 0 && completed < subnets.length
            ? Math.max(0, Math.round((elapsedMs / completed) * (subnets.length - completed)))
            : 0;
          emitProgress({
            phase: 'item',
            operation: 'alpha-holder-sync',
            total: subnets.length,
            completed,
            remaining: Math.max(0, subnets.length - completed),
            elapsedMs,
            etaMs,
            etaIso: etaMs > 0 ? new Date(Date.now() + etaMs).toISOString() : null,
            netuid,
            fetched: 0,
            inserted: 0,
            skipped: false,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
            message: `SN${netuid}`,
            workerId,
            workersTotal,
          });
        }
      };

      if (workersTotal <= 1 || subnets.length <= 1) {
        for (const [index, netuid] of subnets.entries()) {
          // eslint-disable-next-line no-await-in-loop
          await processSubnet(netuid, index, 1);
          if (deferred) {
            break;
          }
        }
      } else {
        let nextIndex = 0;
        await Promise.all(Array.from({ length: workersTotal }, async (_, workerIndex) => {
          const workerId = workerIndex + 1;
          // eslint-disable-next-line no-constant-condition
          while (true) {
            const currentIndex = nextIndex;
            nextIndex += 1;
            if (currentIndex >= subnets.length) {
              break;
            }
            // eslint-disable-next-line no-await-in-loop
            await processSubnet(subnets[currentIndex], currentIndex, workerId);
          }
        }));
      }

      emitProgress({
        phase: 'done',
        operation: 'alpha-holder-sync',
        total: subnets.length,
        completed: completedCount,
        remaining: Math.max(0, subnets.length - completedCount),
        elapsedMs: Date.now() - startedAtMs,
        etaMs: 0,
        etaIso: null,
        netuid: null,
        fetched,
        inserted,
        skipped: false,
        ok,
        results,
        capturedAt,
        workersTotal,
        retryAfterMs,
        deferred,
      });

      const result = {
        ok: ok && !deferred,
        skipped: false,
        source: 'alpha-holder-snapshot-all',
        fetched,
        inserted,
        netuids: subnets.length,
        capturedAt,
        results,
        retryAfterMs,
        deferred,
      };
      recordAlphaHolderSnapshotRun({ startedAt, capturedAt, result });
      return result;
    } catch (error) {
      recordAlphaHolderSnapshotRun({ startedAt, capturedAt, result: { netuids: subnets.length }, error });
      throw error;
    }
  }

  async function runWalletActivityForWallet({
    walletConfig = null,
    address = null,
    days = config.walletActivitySyncDays ?? 7,
    limit = 200,
    stakePositions = null,
    forceRefresh = false,
  } = {}) {
    const wallet = walletConfig || resolveWalletConfig(address);
    const effectiveDays = normalizeWalletDays(days, config.walletActivitySyncDays ?? 7);
    if (!config.taostatsAuthHeader) {
      return {
        ok: false,
        wallet: wallet.name,
        address: wallet.ss58,
        days: effectiveDays,
        rowsFetched: 0,
        rowsInserted: 0,
        source: 'wallet-activity',
        partial: false,
        reason: 'Taostats API access is required to sync wallet activity.',
        warning: null,
        skipped: true,
      };
    }
    const summary = {
      ok: false,
      wallet: wallet.name,
      address: wallet.ss58,
      days: effectiveDays,
      rowsFetched: 0,
      rowsInserted: 0,
      source: 'wallet-activity',
      partial: false,
      reason: null,
      warning: null,
      skipped: false,
    };

    try {
      const resolvedStakePositions = Array.isArray(stakePositions)
        ? stakePositions
        : [];
      const timeline = await buildWalletTransactionTimeline({
        address: wallet.ss58,
        walletConfig: wallet,
        stakePositions: resolvedStakePositions,
        taostatsBaseUrl: config.taostatsBaseUrl,
        taostatsAuthHeader: config.taostatsAuthHeader,
        rateLimiter: config.taostatsRateLimiter || null,
        days: effectiveDays,
        limit,
        fetchers: taostats,
      });
      summary.partial = timeline.partial;
      summary.reason = timeline.reason;
      summary.warning = timeline.warning;
      summary.retryAfterMs = Number(timeline.retryAfterMs) > 0 ? Number(timeline.retryAfterMs) : null;
      summary.rowsFetched = Array.isArray(timeline.rows) ? timeline.rows.length : 0;
      if (!summary.retryAfterMs && (timeline.available || forceRefresh || summary.rowsFetched > 0 || timeline.reason)) {
        summary.rowsInserted = await storeWalletTimelineRows({
          walletConfig: wallet,
          rows: timeline.rows,
          sourceUrl: 'wallet-activity-sync',
          source: 'api-history',
        });
      }
      const noTransactionsReason = 'No wallet transactions were found for the selected period.';
      summary.ok = !summary.retryAfterMs && !summary.partial && (!summary.reason || summary.reason === noTransactionsReason);
      if (summary.retryAfterMs) {
        summary.partial = true;
        summary.warning = summary.warning || 'Wallet activity hit a Taostats rate limit; retrying later.';
      }
      return {
        ...summary,
        rows: timeline.rows,
      };
    } catch (error) {
      const retryAfterMs = retryDelayFromError(error);
      return {
        ...summary,
        ok: false,
        retryAfterMs,
        retryable: retryAfterMs !== null,
        error: retryAfterMs !== null ? null : (error instanceof Error ? error.message : String(error)),
        warning: retryAfterMs !== null
          ? (summary.warning || 'Wallet activity hit a Taostats rate limit; retrying later.')
          : summary.warning,
      };
    }
  }

  async function refreshWalletSnapshotCacheForWallet({
    walletConfig = null,
    address = null,
    capturedAt = new Date().toISOString(),
    limit = 200,
  } = {}) {
    const wallet = walletConfig || resolveWalletConfig(address);
    const effectiveAddress = wallet.ss58 || String(address || '').trim();
    const summary = {
      wallet: wallet.name,
      address: effectiveAddress,
      source: 'wallet-snapshot',
      skipped: false,
      partial: false,
      reason: null,
      warning: null,
      snapshotFetched: 0,
      snapshotInserted: 0,
      stakeFetched: 0,
      stakeInserted: 0,
      stakePositions: [],
    };

    if (!config.taostatsAuthHeader) {
      return {
        ...summary,
        ok: false,
        skipped: true,
        reason: 'Taostats API access is required to sync wallet snapshots.',
      };
    }

    const fetchOptions = {
      taostatsBaseUrl: config.taostatsBaseUrl,
      taostatsAuthHeader: config.taostatsAuthHeader,
      rateLimiter: config.taostatsRateLimiter || null,
      capturedAt,
    };

    try {
      const latestSnapshot = await fetchAccountLatest({
        address: effectiveAddress,
        network: wallet.network || 'finney',
        ...fetchOptions,
      });
      if (latestSnapshot) {
        latestSnapshot.wallet_name = wallet.name;
        insertWalletSnapshot(db, latestSnapshot);
        summary.snapshotFetched = 1;
        summary.snapshotInserted = 1;
      }
    } catch (error) {
      summary.partial = true;
      const message = error instanceof Error ? error.message : String(error);
      if (Number(error?.status) === 429) {
        summary.retryAfterMs = Math.max(Number(summary.retryAfterMs) || 0, retryDelayFromError(error) || 0) || null;
        summary.warning = summary.warning || (
          isTaostatsCreditsExhaustedError(error)
            ? 'Taostats credits are exhausted; retrying wallet balance snapshot later.'
            : 'Wallet balance snapshot is temporarily rate-limited by Taostats; retrying later.'
        );
      } else {
        summary.reason = summary.reason || `Wallet snapshot unavailable: ${message}`;
      }
    }

    if (summary.retryAfterMs) {
      summary.ok = !summary.retryAfterMs && !summary.reason;
      return summary;
    }

    try {
      const stakePositions = await fetchStakeBalanceLatest({
        coldkey: effectiveAddress,
        taostatsBaseUrl: config.taostatsBaseUrl,
        taostatsAuthHeader: config.taostatsAuthHeader,
        rateLimiter: config.taostatsRateLimiter || null,
        capturedAt,
        limit,
      });
      summary.stakeFetched = stakePositions.length;
      summary.stakePositions = stakePositions;
      for (const stakePosition of stakePositions) {
        stakePosition.wallet_name = wallet.name;
        insertWalletStakePosition(db, stakePosition);
        summary.stakeInserted += 1;
      }
    } catch (error) {
      summary.partial = true;
      const message = error instanceof Error ? error.message : String(error);
      if (Number(error?.status) === 429) {
        summary.retryAfterMs = Math.max(Number(summary.retryAfterMs) || 0, retryDelayFromError(error) || 0) || null;
        summary.warning = summary.warning || 'Wallet stake snapshot is temporarily rate-limited by Taostats; retrying later.';
      } else {
        summary.reason = summary.reason || `Wallet stake snapshot unavailable: ${message}`;
      }
    }

    summary.ok = !summary.retryAfterMs && !summary.reason;
    return summary;
  }

  function buildWalletActivityDeferredResult({
    walletConfig = null,
    address = null,
    days = config.walletActivitySyncDays ?? 7,
    retryAfterMs = null,
    snapshotResult = null,
  } = {}) {
    const wallet = walletConfig || resolveWalletConfig(address);
    const snapshotWarning = snapshotResult?.warning || null;
    return {
      ok: false,
      wallet: wallet.name,
      address: wallet.ss58,
      days,
      rowsFetched: 0,
      rowsInserted: 0,
      source: 'wallet-activity',
      partial: true,
      reason: snapshotResult?.reason || null,
      warning: snapshotWarning,
      skipped: false,
      retryAfterMs: Number.isFinite(Number(retryAfterMs)) && Number(retryAfterMs) > 0 ? Number(retryAfterMs) : null,
      rows: [],
      walletSnapshot: snapshotResult ? {
        source: snapshotResult.source,
        snapshotFetched: snapshotResult.snapshotFetched,
        snapshotInserted: snapshotResult.snapshotInserted,
        stakeFetched: snapshotResult.stakeFetched,
        stakeInserted: snapshotResult.stakeInserted,
        partial: snapshotResult.partial,
        skipped: snapshotResult.skipped,
        reason: snapshotResult.reason,
        warning: snapshotResult.warning,
        retryAfterMs: snapshotResult.retryAfterMs || null,
      } : null,
    };
  }

  async function syncWalletActivityForWallet({
    walletConfig = null,
    address = null,
    days = config.walletActivitySyncDays ?? 7,
    limit = 200,
    stakePositions = null,
    forceRefresh = false,
  } = {}) {
    if (active) {
      return activeSkipResult();
    }
    if (isAlphaHolderBackfillActive()) {
      return { skipped: true, reason: 'alpha-holder backfill is running' };
    }

    const startedAt = beginActiveJob('wallet-activity-wallet', {
      label: 'Wallet activity sync',
      address: address || walletConfig?.ss58 || null,
      wallet: walletConfig?.name || null,
      days,
    });
    const startedIso = startedAt.toISOString();
    let result;
    try {
      const snapshotResult = await refreshWalletSnapshotCacheForWallet({
        walletConfig,
        address,
        capturedAt: startedIso,
      });
      if (snapshotResult.retryAfterMs) {
        result = buildWalletActivityDeferredResult({
          walletConfig,
          address,
          days,
          retryAfterMs: snapshotResult.retryAfterMs,
          snapshotResult,
        });
        return result;
      }
      result = await runWalletActivityForWallet({
        walletConfig,
        address,
        days,
        limit,
        stakePositions: Array.isArray(snapshotResult.stakePositions) ? snapshotResult.stakePositions : stakePositions,
        forceRefresh,
      });
      result.walletSnapshot = {
        source: snapshotResult.source,
        snapshotFetched: snapshotResult.snapshotFetched,
        snapshotInserted: snapshotResult.snapshotInserted,
        stakeFetched: snapshotResult.stakeFetched,
        stakeInserted: snapshotResult.stakeInserted,
        partial: snapshotResult.partial,
        skipped: snapshotResult.skipped,
        reason: snapshotResult.reason,
        warning: snapshotResult.warning,
        retryAfterMs: snapshotResult.retryAfterMs || null,
      };
      if (snapshotResult.retryAfterMs) {
        result.retryAfterMs = Math.max(Number(result.retryAfterMs) || 0, Number(snapshotResult.retryAfterMs));
      }
      if (snapshotResult.reason && !result.reason) {
        result.reason = snapshotResult.reason;
      }
      if (snapshotResult.warning) {
        result.warning = result.warning ? `${result.warning} | ${snapshotResult.warning}` : snapshotResult.warning;
      }
      if (snapshotResult.partial) {
        result.partial = true;
      }
      return result;
    } finally {
      const finishedAt = new Date();
      const logDetail = result ? { ...result } : {};
      delete logDetail.rows;
      insertIngestRun(db, {
        netuid: config.netuid,
        started_at: startedIso,
        finished_at: finishedAt.toISOString(),
        duration_ms: finishedAt.getTime() - startedAt.getTime(),
        source: 'wallet-activity',
        fallback_used: false,
        ok: Boolean(result?.ok) && !result?.retryAfterMs,
        snapshot_id: null,
        message: result?.retryAfterMs
          ? `Wallet activity sync deferred for ${result.wallet}`
          : (result?.ok ? `Wallet activity synced for ${result.wallet}` : 'Wallet activity sync failed'),
        error: result?.error || null,
        detail_json: JSON.stringify(logDetail),
      });
      finishActiveJob();
    }
  }

  async function syncWalletActivity({
    wallets = config.wallets || [],
    days = config.walletActivitySyncDays ?? 7,
    limit = 200,
    forceRefresh = false,
  } = {}) {
    if (active) {
      return activeSkipResult();
    }
    if (isAlphaHolderBackfillActive()) {
      return { skipped: true, reason: 'alpha-holder backfill is running' };
    }

    const startedAt = beginActiveJob('wallet-activity', {
      label: 'Wallet activity sync',
      wallets: Array.isArray(wallets) ? wallets.length : 0,
      days,
    });
    const startedIso = startedAt.toISOString();
    const results = [];
    const detail = {
      days,
      limit,
      wallets: Array.isArray(wallets) ? wallets.length : 0,
    };

    try {
      for (const wallet of Array.isArray(wallets) ? wallets : []) {
        const snapshotResult = await refreshWalletSnapshotCacheForWallet({
          walletConfig: wallet,
          capturedAt: startedIso,
        });
        if (snapshotResult.retryAfterMs) {
          const result = buildWalletActivityDeferredResult({
            walletConfig: wallet,
            days,
            retryAfterMs: snapshotResult.retryAfterMs,
            snapshotResult,
          });
          results.push(result);
          break;
        }
        const result = await runWalletActivityForWallet({
          walletConfig: wallet,
          days,
          limit,
          stakePositions: Array.isArray(snapshotResult.stakePositions) ? snapshotResult.stakePositions : [],
          forceRefresh,
        });
        result.walletSnapshot = {
          source: snapshotResult.source,
          snapshotFetched: snapshotResult.snapshotFetched,
          snapshotInserted: snapshotResult.snapshotInserted,
          stakeFetched: snapshotResult.stakeFetched,
          stakeInserted: snapshotResult.stakeInserted,
          partial: snapshotResult.partial,
          skipped: snapshotResult.skipped,
          reason: snapshotResult.reason,
          warning: snapshotResult.warning,
          retryAfterMs: snapshotResult.retryAfterMs || null,
        };
        if (snapshotResult.retryAfterMs) {
          result.retryAfterMs = Math.max(Number(result.retryAfterMs) || 0, Number(snapshotResult.retryAfterMs));
        }
        if (snapshotResult.reason && !result.reason) {
          result.reason = snapshotResult.reason;
        }
        if (snapshotResult.warning) {
          result.warning = result.warning ? `${result.warning} | ${snapshotResult.warning}` : snapshotResult.warning;
        }
        if (snapshotResult.partial) {
          result.partial = true;
        }
        results.push(result);
        if (result.retryAfterMs) {
          break;
        }
      }
      const retryAfterMs = results.reduce((max, result) => Math.max(max, Number(result.retryAfterMs) || 0), 0) || null;
      const deferred = Boolean(retryAfterMs);
      const ok = results.every((result) => result.ok !== false && !result.error) && !deferred;
      detail.results = results.map((result) => ({
        wallet: result.wallet,
        address: result.address,
        rowsFetched: result.rowsFetched,
        rowsInserted: result.rowsInserted,
        partial: result.partial,
        warning: result.warning,
        reason: result.reason,
        walletSnapshot: result.walletSnapshot || null,
        retryAfterMs: result.retryAfterMs || null,
      }));
      return {
        ok,
        days,
        limit,
        results,
        retryAfterMs,
        deferred,
        detail,
      };
    } finally {
      const finishedAt = new Date();
      insertIngestRun(db, {
        netuid: config.netuid,
        started_at: startedIso,
        finished_at: finishedAt.toISOString(),
        duration_ms: finishedAt.getTime() - startedAt.getTime(),
        source: 'wallet-activity',
        fallback_used: false,
        ok: results.every((result) => result.ok !== false && !result.error) && !results.some((result) => Number(result.retryAfterMs) > 0),
        snapshot_id: null,
        message: results.some((result) => Number(result.retryAfterMs) > 0)
          ? 'Wallet activity sync batch deferred'
          : 'Wallet activity sync batch completed',
        error: null,
        detail_json: JSON.stringify(detail),
      });
      finishActiveJob();
    }
  }

  async function backfillWalletActivity({
    wallets = config.wallets || [],
    days = config.walletActivityBackfillDays ?? 60,
    limit = 200,
  } = {}) {
    return syncWalletActivity({
      wallets,
      days,
      limit,
      forceRefresh: true,
    });
  }

  async function backfillWalletStakeHistory({
    wallets = config.wallets || [],
    days = config.taostatsWalletActivityBackfillDays ?? config.taostatsBackfillDays ?? 60,
    startIso = null,
    endIso = null,
    limit = 200,
    overwrite = false,
    onProgress = null,
  } = {}) {
    if (active) {
      return activeSkipResult();
    }
    if (isAlphaHolderBackfillActive()) {
      return { skipped: true, reason: 'alpha-holder backfill is running' };
    }
    if (!config.taostatsAuthHeader) {
      return {
        ok: false,
        skipped: true,
        source: 'wallet-stake-backfill',
        days,
        startIso: startIso || null,
        endIso: endIso || null,
        overwrite: Boolean(overwrite),
        fetched: 0,
        inserted: 0,
        skipped: 0,
        deleted: 0,
        results: [],
        reason: 'Taostats API access is required to backfill wallet stake history.',
      };
    }

    const walletList = Array.isArray(wallets) ? wallets : [];
    const startedAt = beginActiveJob('wallet-stake-backfill', {
      label: 'Wallet stake history backfill',
      wallets: walletList.length,
      days,
      startIso: startIso || null,
      endIso: endIso || null,
      overwrite: Boolean(overwrite),
    });
    const startedIso = startedAt.toISOString();
    const emitProgress = (payload) => {
      if (typeof onProgress === 'function') {
        onProgress(payload);
      }
    };
    const results = [];
    let fetched = 0;
    let inserted = 0;
    let skipped = 0;
    let deleted = 0;
    let ok = true;
    const detail = {
      wallets: walletList.length,
      days,
      limit,
      startIso: startIso || null,
      endIso: endIso || null,
      overwrite: Boolean(overwrite),
    };

    emitProgress({
      phase: 'start',
      operation: 'wallet-stake-backfill',
      total: walletList.length,
      completed: 0,
      remaining: walletList.length,
      elapsedMs: 0,
      etaMs: null,
      etaIso: null,
      ok: true,
      days,
      startIso: startIso || null,
      endIso: endIso || null,
      overwrite: Boolean(overwrite),
    });

    try {
      for (const [index, wallet] of walletList.entries()) {
        const hotkeys = Array.isArray(wallet?.hotkeys) ? wallet.hotkeys : [];
        const walletDetail = {
          wallet: wallet?.name || wallet?.ss58 || `Wallet ${index + 1}`,
          address: wallet?.ss58 || wallet?.coldkey || null,
          hotkeys: hotkeys.length,
          fetched: 0,
          inserted: 0,
          skipped: 0,
          deleted: 0,
          ok: true,
        };

        emitProgress({
          phase: 'item-start',
          operation: 'wallet-stake-backfill',
          total: walletList.length,
          completed: index,
          remaining: Math.max(0, walletList.length - index),
          elapsedMs: Date.now() - startedAt.getTime(),
          etaMs: null,
          etaIso: null,
          wallet: walletDetail.wallet,
          address: walletDetail.address,
          hotkeys: hotkeys.length,
          ok: true,
        });

        for (const hotkey of hotkeys) {
          try {
            const history = await fetchHistoricalStakeBalance({
              coldkey: wallet.ss58,
              hotkey: hotkey.ss58,
              netuid: hotkey.netuid ?? null,
              taostatsBaseUrl: config.taostatsBaseUrl,
              taostatsAuthHeader: config.taostatsAuthHeader,
              rateLimiter: config.taostatsRateLimiter || null,
              days,
              startIso,
              endIso,
              limit,
            });
            walletDetail.fetched += history.length;
            fetched += history.length;

            if (overwrite && history.length > 0) {
              const capturedAts = history
                .map((row) => row.captured_at)
                .filter(Boolean)
                .sort();
              const deleteStartIso = capturedAts[0];
              const deleteEndIso = capturedAts[capturedAts.length - 1];
              const removed = deleteWalletStakePositionsInRange(db, wallet.ss58, deleteStartIso, deleteEndIso);
              deleted += removed;
              walletDetail.deleted += removed;
            }

            for (const row of history) {
              const netuidValue = row.netuid ?? hotkey.netuid ?? null;
              const capturedAt = row.captured_at || row.remote_timestamp || row.timestamp || null;
              const hotkeyAddress = row.hotkey_address_ss58 ?? hotkey.ss58 ?? null;
              if (!overwrite && walletStakePositionExists(db, wallet.ss58, netuidValue, hotkeyAddress, capturedAt)) {
                skipped += 1;
                walletDetail.skipped += 1;
                continue;
              }
              row.wallet_name = wallet.name;
              insertWalletStakePosition(db, row);
              inserted += 1;
              walletDetail.inserted += 1;
            }
          } catch (error) {
            ok = false;
            const reason = error instanceof Error ? error.message : String(error);
            walletDetail.ok = false;
            walletDetail.error = reason;
            walletDetail.reason = reason;
          }
        }

        results.push(walletDetail);
        const completed = index + 1;
        const elapsedMs = Date.now() - startedAt.getTime();
        const etaMs = completed > 0 && completed < walletList.length
          ? Math.max(0, Math.round((elapsedMs / completed) * (walletList.length - completed)))
          : 0;
        emitProgress({
          phase: 'item',
          operation: 'wallet-stake-backfill',
          total: walletList.length,
          completed,
          remaining: Math.max(0, walletList.length - completed),
          elapsedMs,
          etaMs,
          etaIso: etaMs > 0 ? new Date(Date.now() + etaMs).toISOString() : null,
          wallet: walletDetail.wallet,
          address: walletDetail.address,
          hotkeys: hotkeys.length,
          fetched: walletDetail.fetched,
          inserted: walletDetail.inserted,
          skipped: walletDetail.skipped,
          deleted: walletDetail.deleted,
          ok: walletDetail.ok,
          message: walletDetail.wallet,
        });
      }

      detail.fetched = fetched;
      detail.inserted = inserted;
      detail.skipped = skipped;
      detail.deleted = deleted;
      detail.results = results;
      emitProgress({
        phase: 'done',
        operation: 'wallet-stake-backfill',
        total: walletList.length,
        completed: walletList.length,
        remaining: 0,
        elapsedMs: Date.now() - startedAt.getTime(),
        etaMs: 0,
        etaIso: null,
        fetched,
        inserted,
        skipped,
        deleted,
        ok,
        days,
        startIso: startIso || null,
        endIso: endIso || null,
        overwrite: Boolean(overwrite),
        results,
      });

      return {
        ok,
        skipped: false,
        source: 'wallet-stake-backfill',
        days,
        startIso: startIso || null,
        endIso: endIso || null,
        overwrite: Boolean(overwrite),
        fetched,
        inserted,
        skipped,
        deleted,
        results,
        detail,
      };
    } finally {
      const finishedAt = new Date();
      insertIngestRun(db, {
        netuid: config.netuid,
        started_at: startedIso,
        finished_at: finishedAt.toISOString(),
        duration_ms: finishedAt.getTime() - startedAt.getTime(),
        source: 'wallet-stake-backfill',
        fallback_used: false,
        ok,
        snapshot_id: null,
        message: ok ? 'Wallet stake history backfill completed' : 'Wallet stake history backfill completed with errors',
        error: null,
        detail_json: JSON.stringify(detail),
      });
      finishActiveJob();
    }
  }

  async function backfillAlphaHolderSnapshots({
    capturedAt = new Date().toISOString(),
    skipIfAlreadyCapturedToday = false,
    limit = 1024,
    concurrency = 1,
    onProgress = null,
  } = {}) {
    setAlphaHolderBackfillActive(true);
    try {
      return await syncAllAlphaHolderSnapshots({
        capturedAt,
        skipIfAlreadyCapturedToday,
        limit,
        concurrency,
        onProgress,
        respectAlphaHolderBackfillLock: false,
      });
    } finally {
      setAlphaHolderBackfillActive(false);
    }
  }

  async function backfillAlphaHolderHistoryForNetuid({
    netuid,
    days = config.taostatsBackfillDays ?? 30,
    overwrite = config.taostatsBackfillOverwrite ?? true,
  } = {}) {
    if (!config.taostatsAuthHeader) {
      return {
        ok: false,
        netuid,
        fetched: 0,
        inserted: 0,
        deleted: 0,
        skipped: 0,
        reason: 'Taostats API auth header is required for alpha holder history backfill',
      };
    }

    const rows = await fetchHistoricalStakeBalance({
      netuid,
      taostatsBaseUrl: config.taostatsBaseUrl,
      taostatsAuthHeader: config.taostatsAuthHeader,
      rateLimiter: config.taostatsRateLimiter || null,
      days,
    });

    let deleted = 0;
    let inserted = 0;
    let skipped = 0;

    if (overwrite && rows.length > 0) {
      const capturedAts = rows
        .map((row) => row.captured_at)
        .filter(Boolean)
        .sort();
      const startIso = capturedAts[0];
      const endIso = capturedAts[capturedAts.length - 1];
      deleted = deleteAlphaHolderSnapshotsInRange(db, netuid, startIso, endIso);
    }

    for (const row of rows) {
      if (!overwrite && row.block_number !== null && row.block_number !== undefined) {
        const existing = db.prepare(`
          SELECT 1
          FROM alpha_holder_snapshots
          WHERE netuid = ? AND block_number = ? AND coldkey_ss58 = ? AND hotkey_address_ss58 = ?
          LIMIT 1
        `).get(netuid, row.block_number, row.wallet_address_ss58 ?? null, row.hotkey_address_ss58 ?? null);
        if (existing) {
          skipped += 1;
          continue;
        }
      }

      insertAlphaHolderSnapshot(db, {
        ...row,
        source: row.source || 'api-history',
        source_url: row.source_url || `${config.taostatsBaseUrl.replace(/\/$/, '')}/api/dtao/stake_balance/history/v1`,
        captured_at: row.captured_at || new Date().toISOString(),
        dedupe_key: [
          row.netuid ?? netuid,
          row.block_number ?? row.remote_timestamp ?? row.captured_at,
          row.wallet_address_ss58 ?? row.coldkey_ss58 ?? 'unknown',
          row.hotkey_address_ss58 ?? 'unknown',
        ].join(':'),
      });
      inserted += 1;
    }

    return {
      ok: true,
      netuid,
      fetched: rows.length,
      inserted,
      deleted,
      skipped,
    };
  }

  async function backfillAlphaHolderHistory({
    netuid = null,
    days = config.taostatsBackfillDays ?? 30,
    overwrite = config.taostatsBackfillOverwrite ?? true,
    limit = 1024,
    onProgress = null,
  } = {}) {
    if (!config.taostatsAuthHeader) {
      return {
        ok: false,
        skipped: true,
        source: 'alpha-holder-history-backfill',
        fetched: 0,
        inserted: 0,
        deleted: 0,
        netuids: 0,
        reason: 'Taostats API auth header is required for alpha holder history backfill',
      };
    }
    setAlphaHolderBackfillActive(true);
    try {
      const subnets = await resolveAlphaHolderNetuids({ netuid, limit });
      const startedAtMs = Date.now();
      const emitProgress = (payload) => {
        if (typeof onProgress === 'function') {
          onProgress(payload);
        }
      };

      emitProgress({
        phase: 'start',
        operation: 'alpha-holder-history-backfill',
        total: subnets.length,
        completed: 0,
        remaining: subnets.length,
        elapsedMs: 0,
        etaMs: null,
        etaIso: null,
        netuid: null,
        fetched: 0,
        inserted: 0,
        deleted: 0,
        skipped: 0,
        ok: true,
        days,
        overwrite: Boolean(overwrite),
      });

      let fetched = 0;
      let inserted = 0;
      let deleted = 0;
      let skipped = 0;
      let ok = true;
      const results = [];

      for (const [index, subnetNetuid] of subnets.entries()) {
        try {
          const startedCompleted = index;
          const startedElapsedMs = Date.now() - startedAtMs;
          const startedEtaMs = startedCompleted > 0 && startedCompleted < subnets.length
            ? Math.max(0, Math.round((startedElapsedMs / startedCompleted) * (subnets.length - startedCompleted)))
            : 0;
          emitProgress({
            phase: 'item-start',
            operation: 'alpha-holder-history-backfill',
            total: subnets.length,
            completed: startedCompleted,
            remaining: Math.max(0, subnets.length - startedCompleted),
            elapsedMs: startedElapsedMs,
            etaMs: startedEtaMs,
            etaIso: startedEtaMs > 0 ? new Date(Date.now() + startedEtaMs).toISOString() : null,
            netuid: subnetNetuid,
            fetched: 0,
            inserted: 0,
            deleted: 0,
            skipped: 0,
            ok: true,
            message: `SN${subnetNetuid}`,
          });
          const result = await backfillAlphaHolderHistoryForNetuid({
            netuid: subnetNetuid,
            days,
            overwrite,
          });
          fetched += Number(result.fetched || 0);
          inserted += Number(result.inserted || 0);
          deleted += Number(result.deleted || 0);
          skipped += Number(result.skipped || 0);
          if (result.ok === false || result.error) {
            ok = false;
          }
          results.push({
            ...result,
            ok: result.ok !== false && !result.error,
          });
          const completed = index + 1;
          const elapsedMs = Date.now() - startedAtMs;
          const etaMs = completed > 0 && completed < subnets.length
            ? Math.max(0, Math.round((elapsedMs / completed) * (subnets.length - completed)))
            : 0;
          emitProgress({
            phase: 'item',
            operation: 'alpha-holder-history-backfill',
            total: subnets.length,
            completed,
            remaining: Math.max(0, subnets.length - completed),
            elapsedMs,
            etaMs,
            etaIso: etaMs > 0 ? new Date(Date.now() + etaMs).toISOString() : null,
            netuid: subnetNetuid,
            fetched: Number(result.fetched || 0),
            inserted: Number(result.inserted || 0),
            deleted: Number(result.deleted || 0),
            skipped: Number(result.skipped || 0),
            ok: result.ok !== false && !result.error,
            message: `SN${subnetNetuid}`,
          });
        } catch (error) {
          results.push({
            ok: false,
            netuid: subnetNetuid,
            fetched: 0,
            inserted: 0,
            deleted: 0,
            skipped: 0,
            reason: error instanceof Error ? error.message : String(error),
          });
          ok = false;
          const completed = index + 1;
          const elapsedMs = Date.now() - startedAtMs;
          const etaMs = completed > 0 && completed < subnets.length
            ? Math.max(0, Math.round((elapsedMs / completed) * (subnets.length - completed)))
            : 0;
          emitProgress({
            phase: 'item',
            operation: 'alpha-holder-history-backfill',
            total: subnets.length,
            completed,
            remaining: Math.max(0, subnets.length - completed),
            elapsedMs,
            etaMs,
            etaIso: etaMs > 0 ? new Date(Date.now() + etaMs).toISOString() : null,
            netuid: subnetNetuid,
            fetched: 0,
            inserted: 0,
            deleted: 0,
            skipped: 0,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
            message: `SN${subnetNetuid}`,
          });
        }
      }

      emitProgress({
        phase: 'done',
        operation: 'alpha-holder-history-backfill',
        total: subnets.length,
        completed: subnets.length,
        remaining: 0,
        elapsedMs: Date.now() - startedAtMs,
        etaMs: 0,
        etaIso: null,
        netuid: null,
        fetched,
        inserted,
        deleted,
        skipped,
        ok,
        results,
        days,
        overwrite: Boolean(overwrite),
      });

      return {
        ok,
        skipped: false,
        source: 'alpha-holder-history-backfill',
        fetched,
        inserted,
        deleted,
        skipped,
        days,
        overwrite: Boolean(overwrite),
        netuids: subnets.length,
        results,
      };
    } finally {
      setAlphaHolderBackfillActive(false);
    }
  }

  async function ingestOnce({ netuid = config.netuid } = {}) {
    if (active) {
      return activeSkipResult();
    }
    if (isAlphaHolderBackfillActive()) {
      return { skipped: true, reason: 'alpha-holder backfill is running' };
    }

    const startedAt = beginActiveJob('subnet-ingest', {
      label: `Subnet ${netuid} ingest`,
      netuid,
    });
    const startedIso = startedAt.toISOString();
    let snapshotId = null;
    let ok = false;
    let message = 'Snapshot ingested';
    let errorMessage = null;
    let source = 'scrape';
    let fallbackUsed = false;
    let detail = null;

    try {
      try {
        await syncSubnetMetadataCatalog({ limit: 1024, concurrency: 1 });
      } catch {
        // Non-fatal metadata cache refresh: keep the ingest flowing even if the subnet catalog is temporarily unavailable.
      }
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
      const retryAfterMs = retryDelayFromError(error);
      message = retryAfterMs ? 'Snapshot ingest deferred' : 'Snapshot ingest failed';
      return {
        ok: false,
        source,
        fallbackUsed,
        snapshotId: null,
        detail,
        error: errorMessage,
        retryAfterMs,
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
      finishActiveJob();
    }
  }

  async function backfillHistoricalSnapshots({
    netuid = config.netuid,
    days = config.taostatsBackfillDays ?? 30,
    frequency = config.taostatsBackfillFrequency ?? 'by_hour',
    overwrite = config.taostatsBackfillOverwrite ?? true,
  } = {}) {
    if (active) {
      return activeSkipResult();
    }
    if (isAlphaHolderBackfillActive()) {
      return { skipped: true, reason: 'alpha-holder backfill is running' };
    }

    const startedAt = beginActiveJob('historical-backfill', {
      label: `Subnet ${netuid} historical backfill`,
      netuid,
      days,
      frequency,
      overwrite: Boolean(overwrite),
    });
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
    let walletStakeHistoryFetched = 0;
    let walletStakeHistoryInserted = 0;
    let walletStakeHistoryDeleted = 0;
    let alphaHolderHistoryFetched = 0;
    let alphaHolderHistoryInserted = 0;
    let alphaHolderHistoryDeleted = 0;
    let alphaHolderHistorySkipped = 0;

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

      try {
        const alphaHolderHistory = await fetchHistoricalStakeBalance({
          netuid,
          taostatsBaseUrl: config.taostatsBaseUrl,
          taostatsAuthHeader: config.taostatsAuthHeader,
          rateLimiter: config.taostatsRateLimiter || null,
          days,
        });
        alphaHolderHistoryFetched = alphaHolderHistory.length;
        if (overwrite && alphaHolderHistory.length > 0) {
          const capturedAts = alphaHolderHistory
            .map((row) => row.captured_at)
            .filter(Boolean)
            .sort();
          const holderStartIso = capturedAts[0];
          const holderEndIso = capturedAts[capturedAts.length - 1];
          alphaHolderHistoryDeleted = deleteAlphaHolderSnapshotsInRange(db, netuid, holderStartIso, holderEndIso);
          detail.alphaHolderStartIso = holderStartIso;
          detail.alphaHolderEndIso = holderEndIso;
        }
        for (const row of alphaHolderHistory) {
          if (!overwrite && row.block_number !== null && row.block_number !== undefined) {
            const existing = db.prepare(`
              SELECT 1
              FROM alpha_holder_snapshots
              WHERE netuid = ? AND block_number = ? AND coldkey_ss58 = ? AND hotkey_address_ss58 = ?
              LIMIT 1
            `).get(netuid, row.block_number, row.wallet_address_ss58 ?? null, row.hotkey_address_ss58 ?? null);
            if (existing) {
              alphaHolderHistorySkipped += 1;
              continue;
            }
          }
          insertAlphaHolderSnapshot(db, {
            ...row,
            dedupe_key: [
              row.netuid ?? netuid,
              row.block_number ?? row.remote_timestamp ?? row.captured_at,
              row.wallet_address_ss58 ?? row.coldkey_ss58 ?? 'unknown',
              row.hotkey_address_ss58 ?? 'unknown',
            ].join(':'),
          });
          alphaHolderHistoryInserted += 1;
        }
      } catch (alphaHolderError) {
        detail.alphaHolderError = alphaHolderError instanceof Error ? alphaHolderError.message : String(alphaHolderError);
      }

      if (Array.isArray(config.wallets) && config.wallets.length > 0) {
        const walletErrors = [];
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

            try {
              const walletStakeHistory = await fetchHistoricalStakeBalance({
                coldkey: wallet.ss58,
                taostatsBaseUrl: config.taostatsBaseUrl,
                taostatsAuthHeader: config.taostatsAuthHeader,
                rateLimiter: config.taostatsRateLimiter || null,
                days,
              });
              walletStakeHistoryFetched += walletStakeHistory.length;
              if (overwrite && walletStakeHistory.length > 0) {
                const capturedAts = walletStakeHistory
                  .map((row) => row.captured_at)
                  .filter(Boolean)
                  .sort();
                const walletStakeStartIso = capturedAts[0];
                const walletStakeEndIso = capturedAts[capturedAts.length - 1];
                walletStakeHistoryDeleted += deleteWalletStakePositionsInRange(db, wallet.ss58, walletStakeStartIso, walletStakeEndIso);
                detail.walletStakeStartIso = detail.walletStakeStartIso || walletStakeStartIso;
                detail.walletStakeEndIso = detail.walletStakeEndIso || walletStakeEndIso;
              }
              for (const row of walletStakeHistory) {
                row.wallet_name = wallet.name;
                insertWalletStakePosition(db, row);
                walletStakeHistoryInserted += 1;
              }
            } catch (walletStakeError) {
              walletErrors.push({
                name: wallet.name,
                ss58: wallet.ss58,
                error: walletStakeError instanceof Error ? walletStakeError.message : String(walletStakeError),
              });
            }
          } catch (walletError) {
            walletErrors.push({
              name: wallet.name,
              ss58: wallet.ss58,
              error: walletError instanceof Error ? walletError.message : String(walletError),
            });
          }
        }
        detail.walletHistoryFetched = walletHistoryFetched;
        detail.walletHistoryInserted = walletHistoryInserted;
        detail.walletHistoryDeleted = walletHistoryDeleted;
        detail.walletHistorySkipped = walletHistorySkipped;
        detail.walletStakeHistoryFetched = walletStakeHistoryFetched;
        detail.walletStakeHistoryInserted = walletStakeHistoryInserted;
        detail.walletStakeHistoryDeleted = walletStakeHistoryDeleted;
        detail.alphaHolderHistoryFetched = alphaHolderHistoryFetched;
        detail.alphaHolderHistoryInserted = alphaHolderHistoryInserted;
        detail.alphaHolderHistoryDeleted = alphaHolderHistoryDeleted;
        detail.alphaHolderHistorySkipped = alphaHolderHistorySkipped;
        if (walletErrors.length) {
          detail.walletErrors = walletErrors;
          detail.walletError = walletErrors[0].error;
        }
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
      detail.walletStakeHistoryFetched = walletStakeHistoryFetched;
      detail.walletStakeHistoryInserted = walletStakeHistoryInserted;
      detail.walletStakeHistoryDeleted = walletStakeHistoryDeleted;
      detail.alphaHolderHistoryFetched = alphaHolderHistoryFetched;
      detail.alphaHolderHistoryInserted = alphaHolderHistoryInserted;
      detail.alphaHolderHistoryDeleted = alphaHolderHistoryDeleted;
      detail.alphaHolderHistorySkipped = alphaHolderHistorySkipped;
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
        walletStakeHistoryFetched,
        walletStakeHistoryInserted,
        walletStakeHistoryDeleted,
        alphaHolderHistoryFetched,
        alphaHolderHistoryInserted,
        alphaHolderHistoryDeleted,
        alphaHolderHistorySkipped,
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
        walletStakeHistoryFetched,
        walletStakeHistoryInserted,
        walletStakeHistoryDeleted,
        alphaHolderHistoryFetched,
        alphaHolderHistoryInserted,
        alphaHolderHistoryDeleted,
        alphaHolderHistorySkipped,
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
      finishActiveJob();
    }
  }

  async function backfillChainBuysHistory({
    netuid = config.netuid,
    startIso = null,
    endIso = null,
    overwrite = false,
  } = {}) {
    if (active) {
      return activeSkipResult();
    }
    if (isAlphaHolderBackfillActive()) {
      return { skipped: true, reason: 'alpha-holder backfill is running' };
    }
    if (!startIso || !endIso) {
      return {
        ok: false,
        skipped: true,
        source: 'chain-buys-backfill',
        startIso: startIso || null,
        endIso: endIso || null,
        overwrite: Boolean(overwrite),
        scanned: 0,
        updated: 0,
        skipped: 0,
        reason: 'A start and end date are required to backfill chain buys history.',
      };
    }

    const startedAt = beginActiveJob('chain-buys-backfill', {
      label: `Subnet ${netuid} chain buys backfill`,
      netuid,
      startIso,
      endIso,
      overwrite: Boolean(overwrite),
    });
    const startedIso = startedAt.toISOString();
    let ok = false;
    let source = 'chain-buys-backfill';
    let errorMessage = null;
    let message = 'Chain buys backfill failed';
    const detail = { startIso, endIso, overwrite: Boolean(overwrite) };

    try {
      const result = backfillChainBuysInRange(db, netuid, startIso, endIso, { overwrite: Boolean(overwrite) });
      ok = true;
      message = `Backfilled ${result.updated} chain buys rows`;
      detail.scanned = result.scanned;
      detail.updated = result.updated;
      detail.skipped = result.skipped;
      return {
        ok,
        source,
        startIso,
        endIso,
        overwrite: Boolean(overwrite),
        scanned: result.scanned,
        updated: result.updated,
        skipped: result.skipped,
        detail,
        message,
      };
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error);
      detail.error = errorMessage;
      return {
        ok: false,
        source,
        startIso,
        endIso,
        overwrite: Boolean(overwrite),
        scanned: 0,
        updated: 0,
        skipped: 0,
        detail,
        error: errorMessage,
        message,
      };
    } finally {
      const finishedAt = new Date();
      insertIngestRun(db, {
        netuid,
        started_at: startedIso,
        finished_at: finishedAt.toISOString(),
        duration_ms: finishedAt.getTime() - startedAt.getTime(),
        source,
        fallback_used: false,
        ok,
        snapshot_id: null,
        message,
        error: errorMessage,
        detail_json: detail ? JSON.stringify(detail) : null,
      });
      finishActiveJob();
    }
  }

  return {
    ingestOnce,
    backfillHistoricalSnapshots,
    backfillChainBuysHistory,
    backfillSubnetCatalogSnapshots,
    backfillAllSubnetHistoricalSnapshots,
    syncAlphaHolderSnapshot,
    syncAllAlphaHolderSnapshots,
    backfillAlphaHolderSnapshots,
    backfillAlphaHolderHistory,
    backfillSubnetNames,
    syncWalletActivity,
    syncWalletActivityForWallet,
    backfillWalletActivity,
    backfillWalletStakeHistory,
    isActive: () => active,
    getActiveJob,
    isAlphaHolderBackfillActive,
  };
}

module.exports = { createIngestService };
