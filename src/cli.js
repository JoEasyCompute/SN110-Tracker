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

function formatDuration(ms) {
  const value = Math.max(0, Math.round(Number(ms) || 0));
  const seconds = Math.floor(value / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

function formatEta(etaIso) {
  if (!etaIso) return '—';
  const date = new Date(etaIso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function createProgressPrinter(label) {
  const stream = process.stderr;
  let lastLine = '';

  const write = (line, final = false) => {
    if (stream.isTTY) {
      const padded = line.padEnd(Math.max(lastLine.length, line.length), ' ');
      stream.write(`\r${padded}`);
      if (final) stream.write('\n');
      lastLine = line;
      return;
    }
    stream.write(`${line}\n`);
  };

  return (progress) => {
    if (!progress || typeof progress !== 'object') return;
    const total = Number(progress.total ?? 0);
    const completed = Number(progress.completed ?? 0);
    const remaining = Number(progress.remaining ?? Math.max(0, total - completed));
    const etaText = progress.etaIso ? `ETA ${formatEta(progress.etaIso)}` : 'ETA —';
    const elapsedText = `elapsed ${formatDuration(progress.elapsedMs)}`;
    const barWidth = 18;
    const filled = total > 0 ? Math.min(barWidth, Math.round((completed / total) * barWidth)) : 0;
    const bar = total > 0
      ? `[${'█'.repeat(filled)}${'░'.repeat(Math.max(0, barWidth - filled))}]`
      : '[░░░░░░░░░░░░░░░░░░]';
    const netuidLabel = Number.isFinite(Number(progress.netuid)) ? ` SN${Number(progress.netuid)}` : '';
    const counts = [];
    if (Number.isFinite(Number(progress.fetched))) counts.push(`fetched ${Number(progress.fetched).toLocaleString('en-US')}`);
    if (Number.isFinite(Number(progress.inserted))) counts.push(`inserted ${Number(progress.inserted).toLocaleString('en-US')}`);
    if (Number.isFinite(Number(progress.deleted)) && Number(progress.deleted) > 0) counts.push(`deleted ${Number(progress.deleted).toLocaleString('en-US')}`);
    if (Number.isFinite(Number(progress.skipped)) && Number(progress.skipped) > 0) counts.push(`skipped ${Number(progress.skipped).toLocaleString('en-US')}`);
    const countsText = counts.length ? ` • ${counts.join(' • ')}` : '';
    const status = progress.phase === 'done'
      ? 'done'
      : progress.error
        ? `error: ${progress.error}`
        : progress.message || 'running';
    const line = total > 0
      ? `[${label}] ${completed}/${total}${remaining > 0 ? ` (${remaining} remaining)` : ''}${netuidLabel} ${bar} ${etaText} • ${elapsedText}${countsText} • ${status}`
      : `[${label}] ${netuidLabel ? `${netuidLabel} ` : ''}${status}`;
    write(line, progress.phase === 'done');
  };
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
  const alphaHolderProgress = createProgressPrinter(alphaHolderBackfill ? 'alpha-holder-history' : 'alpha-holder-sync');

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
      onProgress: alphaHolderProgress,
    });
  } else if (alphaHolderSync) {
    result = await ingestService.backfillAlphaHolderSnapshots({
      capturedAt: new Date().toISOString(),
      skipIfAlreadyCapturedToday: boolArg('skip-if-captured-today', true),
      limit: intArg(readArg('limit', 1024), 1024),
      onProgress: alphaHolderProgress,
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
