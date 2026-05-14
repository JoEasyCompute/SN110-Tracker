'use strict';

const defaultTaostats = require('./taostats');
const {
  buildWalletTransactionTimeline,
  buildWalletTransactionDbRecord,
  buildWalletTransactionTimelineFromRows,
} = require('./wallet-activity');
const {
  insertSnapshot,
  insertTaoPriceSnapshot,
  insertTaoFlowSnapshot,
  insertWalletSnapshot,
  insertWalletStakePosition,
  insertAlphaHolderSnapshot,
  insertWalletTransaction,
  insertIngestRun,
  upsertSubnetMetadata,
  getSubnetMetadataMap,
  snapshotExists,
  taoFlowSnapshotExists,
  walletSnapshotExists,
  deleteSnapshotsInRange,
  deleteTaoPriceHistoryInRange,
  deleteTaoFlowHistoryInRange,
  deleteWalletSnapshotsInRange,
  deleteWalletStakePositionsInRange,
  deleteAlphaHolderSnapshotsInRange,
  getAlphaHolderSnapshotLatestCapturedAt,
  getWalletTransactions,
} = require('./db');

function createIngestService({ db, config, taostats = defaultTaostats } = {}) {
  const {
    fetchLatestSnapshot,
    fetchHistoricalSnapshots,
    fetchSubnetLatestCatalog,
    fetchTaoPriceLatest,
    fetchTaoPriceHistory,
    fetchTaoFlowHistory,
    fetchAccountLatest,
    fetchAccountHistory,
    fetchStakeBalanceLatest,
    fetchHistoricalStakeBalance,
  } = taostats;

  let active = false;

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
    concurrency = 3,
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
    concurrency = 3,
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

    const rows = await fetchStakeBalanceLatest({
      netuid,
      taostatsBaseUrl: config.taostatsBaseUrl,
      taostatsAuthHeader: config.taostatsAuthHeader,
      rateLimiter: config.taostatsRateLimiter || null,
      capturedAt,
      limit,
      onProgress,
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
      const { rows: catalog } = await syncSubnetMetadataCatalog({ limit });
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

  async function syncAllAlphaHolderSnapshots({
    capturedAt = new Date().toISOString(),
    skipIfAlreadyCapturedToday = true,
    limit = 1024,
    concurrency = 1,
    onProgress = null,
  } = {}) {
    if (!config.taostatsAuthHeader) {
      return {
        ok: false,
        skipped: true,
        source: 'alpha-holder-snapshot-all',
        fetched: 0,
        inserted: 0,
        netuids: 0,
        reason: 'Taostats API auth header is required for alpha holder snapshots',
      };
    }

    const subnets = await resolveAlphaHolderNetuids({ limit });
    const startedAtMs = Date.now();
    const parsedConcurrency = Number.parseInt(String(concurrency), 10);
    const workersTotal = Math.max(1, Math.min(3, Number.isFinite(parsedConcurrency) && parsedConcurrency > 0 ? parsedConcurrency : 1));
    const emitProgress = (payload) => {
      if (typeof onProgress === 'function') {
        onProgress(payload);
      }
    };

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
        results[index] = {
          netuid,
          ok: snapshot.ok !== false && !snapshot.error,
          skipped: Boolean(snapshot.skipped),
          fetched: Number(snapshot.fetched || 0),
          inserted: Number(snapshot.inserted || 0),
          reason: snapshot.reason || null,
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
      } catch (error) {
        ok = false;
        results[index] = {
          netuid,
          ok: false,
          skipped: false,
          fetched: 0,
          inserted: 0,
          reason: error instanceof Error ? error.message : String(error),
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
      completed: subnets.length,
      remaining: 0,
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
    });

    return {
      ok,
      skipped: false,
      source: 'alpha-holder-snapshot-all',
      fetched,
      inserted,
      netuids: subnets.length,
      capturedAt,
      results,
    };
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
      summary.rowsFetched = Array.isArray(timeline.rows) ? timeline.rows.length : 0;
      if (timeline.available || forceRefresh || summary.rowsFetched > 0 || timeline.reason) {
        summary.rowsInserted = await storeWalletTimelineRows({
          walletConfig: wallet,
          rows: timeline.rows,
          sourceUrl: 'wallet-activity-sync',
          source: 'api-history',
        });
      }
      summary.ok = true;
      return {
        ...summary,
        rows: timeline.rows,
      };
    } catch (error) {
      return {
        ...summary,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
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
      return { skipped: true, reason: 'ingest already running' };
    }

    active = true;
    const startedAt = new Date();
    const startedIso = startedAt.toISOString();
    let result;
    try {
      result = await runWalletActivityForWallet({
        walletConfig,
        address,
        days,
        limit,
        stakePositions,
        forceRefresh,
      });
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
        ok: Boolean(result?.ok),
        snapshot_id: null,
        message: result?.ok ? `Wallet activity synced for ${result.wallet}` : 'Wallet activity sync failed',
        error: result?.error || null,
        detail_json: JSON.stringify(logDetail),
      });
      active = false;
    }
  }

  async function syncWalletActivity({
    wallets = config.wallets || [],
    days = config.walletActivitySyncDays ?? 7,
    limit = 200,
    forceRefresh = false,
  } = {}) {
    if (active) {
      return { skipped: true, reason: 'ingest already running' };
    }

    active = true;
    const startedAt = new Date();
    const startedIso = startedAt.toISOString();
    const results = [];
    const detail = {
      days,
      limit,
      wallets: Array.isArray(wallets) ? wallets.length : 0,
    };

    try {
      for (const wallet of Array.isArray(wallets) ? wallets : []) {
        const result = await runWalletActivityForWallet({
          walletConfig: wallet,
          days,
          limit,
          forceRefresh,
        });
        results.push(result);
      }
      const ok = results.every((result) => result.ok !== false && !result.error);
      detail.results = results.map((result) => ({
        wallet: result.wallet,
        address: result.address,
        rowsFetched: result.rowsFetched,
        rowsInserted: result.rowsInserted,
        partial: result.partial,
        warning: result.warning,
        reason: result.reason,
      }));
      return {
        ok,
        days,
        limit,
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
        source: 'wallet-activity',
        fallback_used: false,
        ok: results.every((result) => result.ok !== false && !result.error),
        snapshot_id: null,
        message: 'Wallet activity sync batch completed',
        error: null,
        detail_json: JSON.stringify(detail),
      });
      active = false;
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

  async function backfillAlphaHolderSnapshots({
    capturedAt = new Date().toISOString(),
    skipIfAlreadyCapturedToday = false,
    limit = 1024,
    concurrency = 3,
    onProgress = null,
  } = {}) {
    return syncAllAlphaHolderSnapshots({
      capturedAt,
      skipIfAlreadyCapturedToday,
      limit,
      concurrency,
      onProgress,
    });
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
  }

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
    let walletStakeFetched = 0;
    let walletStakeInserted = 0;
    let alphaHolderFetched = 0;
    let alphaHolderInserted = 0;

    try {
      try {
        await syncSubnetMetadataCatalog({ limit: 1024 });
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

      if (Array.isArray(config.wallets) && config.wallets.length > 0) {
        if (!config.taostatsAuthHeader) {
          detail = {
            ...detail,
            walletWarning: 'Configured wallets were skipped because Taostats auth header is missing.',
          };
        } else {
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

              const stakePositions = await fetchStakeBalanceLatest({
                coldkey: wallet.ss58,
                taostatsBaseUrl: config.taostatsBaseUrl,
                taostatsAuthHeader: config.taostatsAuthHeader,
                rateLimiter: config.taostatsRateLimiter || null,
                capturedAt: result.snapshot.captured_at,
              });
              walletStakeFetched += stakePositions.length;
              for (const stakePosition of stakePositions) {
                stakePosition.wallet_name = wallet.name;
                insertWalletStakePosition(db, stakePosition);
                walletStakeInserted += 1;
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
            walletStakeFetched,
            walletStakeInserted,
          };
          if (walletErrors.length) {
            detail = {
              ...detail,
              walletErrors,
              walletError: walletErrors[0].error,
            };
          }
        }
      }
      try {
        const alphaHolderSnapshot = await syncAllAlphaHolderSnapshots({
          capturedAt: result.snapshot.captured_at,
          skipIfAlreadyCapturedToday: true,
          limit: 1024,
        });
        alphaHolderFetched = alphaHolderSnapshot.fetched || 0;
        alphaHolderInserted = alphaHolderSnapshot.inserted || 0;
        detail = {
          ...detail,
          alphaHolderFetched,
          alphaHolderInserted,
          alphaHolderSnapshotSkipped: Boolean(alphaHolderSnapshot.skipped),
          alphaHolderSnapshotCapturedAt: alphaHolderSnapshot.capturedAt || result.snapshot.captured_at,
          alphaHolderSubnetCount: alphaHolderSnapshot.netuids || 0,
        };
      } catch (alphaHolderError) {
        detail = {
          ...detail,
          alphaHolderError: alphaHolderError instanceof Error ? alphaHolderError.message : String(alphaHolderError),
        };
      }
      ok = true;
      message = `Captured ${result.snapshot.name || `SN${netuid}`} from ${source}`;
      return {
        ok,
        source,
        fallbackUsed,
        snapshotId,
        walletInserted,
        alphaHolderFetched,
        alphaHolderInserted,
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
        alphaHolderFetched,
        alphaHolderInserted,
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
      active = false;
    }
  }

  return {
    ingestOnce,
    backfillHistoricalSnapshots,
    syncAlphaHolderSnapshot,
    syncAllAlphaHolderSnapshots,
    backfillAlphaHolderSnapshots,
    backfillAlphaHolderHistory,
    backfillSubnetNames,
    syncWalletActivity,
    syncWalletActivityForWallet,
    backfillWalletActivity,
    isActive: () => active,
  };
}

module.exports = { createIngestService };
