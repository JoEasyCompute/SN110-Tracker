'use strict';

const crypto = require('node:crypto');
const http = require('node:http');

const {
  getLatestSnapshot,
  getRecentSnapshots,
  getHistory,
  getLatestTaoPrice,
  getTaoPriceHistory,
  getTaoFlowHistory,
  getLatestWalletSnapshot,
  getLatestWalletStakePositions,
  getWalletHistory,
  getWalletStakePositionsHistory,
  getWalletTransactions,
  getLatestIngestRun,
  getLatestIngestRunBySource,
  getLatestIngestRunBySources,
  getSubnetMetadata,
  getLatestAlphaHolderSnapshots,
  getLatestAlphaHolderCount,
  getAlphaHolderLatestRanking,
  getAlphaHolderSnapshotHistory,
  getAlphaHolderSnapshotCounts,
  countSnapshots,
  countWalletSnapshots,
  countWalletTransactions,
  getSetting,
} = require('./db');
const { buildWalletTransactionTimelineFromRows } = require('./wallet-activity');
const { POLL_INTERVAL_OPTIONS } = require('./config');
const {
  buildPoolGrowthEstimatorState,
  buildPoolGrowthScenarioSeries,
  estimatePoolGrowth,
} = require('./pool-estimator');
const {
  fetchExtrinsicsHistory,
  fetchTransferHistory,
  fetchHistoricalStakeBalance,
} = require('./taostats');

const TAO_PER_RAO = 1_000_000_000;
const ADMIN_SESSION_COOKIE = 'sn110_admin_session';
const ADMIN_SESSION_MAX_AGE_SECONDS = 12 * 60 * 60;

function formatPollInterval(minutes) {
  const value = Number(minutes);
  if (!Number.isFinite(value) || value <= 0) return '—';
  if (value % 60 === 0) {
    const hours = value / 60;
    return `${hours} hour${hours === 1 ? '' : 's'}`;
  }
  return `${value} minute${value === 1 ? '' : 's'}`;
}

function formatPollTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
}

function readAdminApiKey(req) {
  return String(req.headers['x-admin-api-key'] || '').trim();
}

function parseCookies(req) {
  const header = String(req.headers.cookie || '');
  const cookies = new Map();
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (!key) continue;
    cookies.set(key, decodeURIComponent(value));
  }
  return cookies;
}

function adminSessionSignature(secret, timestamp) {
  return crypto
    .createHmac('sha256', secret)
    .update(`sn110-admin-session:${timestamp}`)
    .digest('base64url');
}

function timingSafeEqualText(left, right) {
  const leftBuffer = Buffer.from(String(left || ''));
  const rightBuffer = Buffer.from(String(right || ''));
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function createAdminSessionValue(config, nowMs = Date.now()) {
  const secret = String(config?.taostatsAdminApiKey || '').trim();
  if (!secret) return null;
  const timestamp = String(nowMs);
  return `${timestamp}.${adminSessionSignature(secret, timestamp)}`;
}

function verifyAdminSession(req, config) {
  const secret = String(config?.taostatsAdminApiKey || '').trim();
  if (!secret) return false;
  const raw = parseCookies(req).get(ADMIN_SESSION_COOKIE);
  if (!raw) return false;
  const [timestamp, signature] = String(raw).split('.');
  const issuedAtMs = Number(timestamp);
  if (!Number.isFinite(issuedAtMs) || !signature) return false;
  if (Date.now() - issuedAtMs > ADMIN_SESSION_MAX_AGE_SECONDS * 1000) return false;
  if (issuedAtMs - Date.now() > 60_000) return false;
  return timingSafeEqualText(signature, adminSessionSignature(secret, timestamp));
}

function setAdminSessionCookie(res, config) {
  const value = createAdminSessionValue(config);
  if (!value) return;
  res.setHeader('set-cookie', `${ADMIN_SESSION_COOKIE}=${encodeURIComponent(value)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${ADMIN_SESSION_MAX_AGE_SECONDS}`);
}

function clearAdminSessionCookie(res) {
  res.setHeader('set-cookie', `${ADMIN_SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
}

function requireAdminApiKey(req, config) {
  const expected = String(config?.taostatsAdminApiKey || '').trim();
  if (!expected) return null;
  const provided = readAdminApiKey(req);
  if (provided && provided === expected) return null;
  if (verifyAdminSession(req, config)) return null;
  return {
    error: 'Admin API key required.',
    status: 403,
  };
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        reject(new Error('Request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      resolve(body);
    });
    req.on('error', reject);
  });
}

function readJsonBody(req) {
  return readRawBody(req).then((body) => {
    if (!body) return {};
    try {
      return JSON.parse(body);
    } catch (error) {
      throw new Error('Request body must be valid JSON');
    }
  });
}

async function readAdminLoginBody(req) {
  const body = await readRawBody(req);
  const contentType = String(req.headers['content-type'] || '').toLowerCase();
  if (contentType.includes('application/json')) {
    if (!body) return {};
    try {
      return JSON.parse(body);
    } catch (error) {
      throw new Error('Request body must be valid JSON');
    }
  }
  const form = new URLSearchParams(body);
  return {
    adminKey: form.get('adminKey') || form.get('admin_key') || form.get('password') || '',
  };
}

function renderAdminLoginPage({ config, error = null } = {}) {
  const enabled = Boolean(String(config?.taostatsAdminApiKey || '').trim());
  const dashboardPath = `/subnets/${config?.netuid || 110}`;
  return `<!doctype html>
  <html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>SN110 Admin Login</title>
    <style>
      :root { color-scheme: dark; --bg: #0b0f14; --panel: #101722; --border: #223043; --text: #e7eef7; --muted: #8fa3b8; --accent: #00dbbc; --negative: #ff6b6b; }
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: var(--bg); color: var(--text); font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      main { width: min(420px, calc(100vw - 32px)); border: 1px solid var(--border); background: var(--panel); padding: 24px; border-radius: 8px; }
      h1 { margin: 0 0 8px; font-size: 24px; letter-spacing: 0; }
      p { margin: 0 0 18px; color: var(--muted); line-height: 1.5; }
      label { display: grid; gap: 8px; color: var(--muted); font-size: 13px; }
      input { width: 100%; box-sizing: border-box; border: 1px solid var(--border); border-radius: 8px; background: #0f1620; color: var(--text); padding: 11px 12px; font: inherit; }
      .actions { display: flex; gap: 10px; align-items: center; margin-top: 16px; }
      button, a { border: 1px solid var(--border); border-radius: 8px; background: var(--accent); color: #03130f; padding: 10px 14px; font-weight: 700; text-decoration: none; cursor: pointer; }
      a { background: transparent; color: var(--text); }
      .error { color: var(--negative); margin-top: 12px; }
    </style>
  </head>
  <body>
    <main>
      <h1>Admin Login</h1>
      <p>${enabled ? 'Enter the local admin key to unlock dashboard controls in this browser.' : 'Admin access is disabled because TAOSTATS_ADMIN_API_KEY is not configured.'}</p>
      ${enabled ? `<form method="post" action="/admin/login">
        <label>
          Admin key
          <input type="password" name="adminKey" autocomplete="current-password" autofocus required>
        </label>
        ${error ? `<p class="error">${escapeHtml(error)}</p>` : ''}
        <div class="actions">
          <button type="submit">Log in</button>
          <a href="${escapeHtml(dashboardPath)}">Back to dashboard</a>
        </div>
      </form>` : `<div class="actions"><a href="${escapeHtml(dashboardPath)}">Back to dashboard</a></div>`}
    </main>
  </body>
  </html>`;
}

function collectResultIssues(result) {
  if (!result || typeof result !== 'object') return [];
  const issues = [];
  const pushIssue = (value, prefix = '') => {
    if (value === null || value === undefined || value === '') return;
    const text = String(value).trim();
    if (!text) return;
    issues.push(prefix ? `${prefix}${text}` : text);
  };
  pushIssue(result.error);
  pushIssue(result.reason);
  const detail = result.detail && typeof result.detail === 'object' ? result.detail : null;
  if (!detail) return issues;
  pushIssue(detail.error);
  pushIssue(detail.walletWarning);
  pushIssue(detail.taoPriceError, 'TAO price: ');
  pushIssue(detail.priceError, 'TAO price history: ');
  pushIssue(detail.flowError, 'TAO flow history: ');
  pushIssue(detail.alphaHolderError, 'Alpha holders: ');
  pushIssue(detail.walletStakeHistoryError, 'Wallet stake history: ');
  pushIssue(detail.walletError, 'Wallet: ');
  if (Array.isArray(detail.walletErrors)) {
    for (const walletError of detail.walletErrors) {
      if (!walletError || typeof walletError !== 'object') continue;
      const name = walletError.name || walletError.ss58 || 'wallet';
      pushIssue(walletError.error, `${name}: `);
    }
  }
  return issues;
}

function summarizeResultFailure(label, result) {
  const issues = collectResultIssues(result);
  if (issues.length) return `${label}: ${issues.join(' | ')}`;
  if (result?.reason) return `${label}: ${result.reason}`;
  if (result?.message) return `${label}: ${result.message}`;
  return label;
}

function summarizeBackfillOutcome(backfill, live) {
  const issues = [...collectResultIssues(backfill), ...collectResultIssues(live)];
  if (!issues.length) return null;
  const label = !backfill?.ok ? 'Backfill failed' : live && !live.ok ? 'Live refresh failed' : 'Completed with warnings';
  return `${label}: ${issues.join(' | ')}`;
}

function statusForAdminResult(result) {
  if (result?.skipped) return 409;
  return result?.ok ? 200 : 500;
}

function summarizeBackfillWarnings(backfill, live) {
  const warnings = [];
  const addWarnings = (result) => {
    if (!result || typeof result !== 'object' || !result.detail || typeof result.detail !== 'object') return;
    if (result.detail.walletWarning) warnings.push(String(result.detail.walletWarning));
    if (Array.isArray(result.detail.walletErrors)) {
      for (const walletError of result.detail.walletErrors) {
        if (!walletError || typeof walletError !== 'object') continue;
        const name = walletError.name || walletError.ss58 || 'wallet';
        if (walletError.error) {
          warnings.push(`${name}: ${walletError.error}`);
        }
      }
    }
  };
  addWarnings(backfill);
  addWarnings(live);
  return warnings;
}

function formatIso(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'medium' });
}

function formatRelativeIso(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  const diffMs = date.getTime() - Date.now();
  const abs = Math.abs(diffMs);
  const parts = [
    { unit: 'day', ms: 86400000 },
    { unit: 'hour', ms: 3600000 },
    { unit: 'minute', ms: 60000 },
    { unit: 'second', ms: 1000 },
  ];
  for (const part of parts) {
    if (abs >= part.ms) {
      const valueAbs = Math.round(abs / part.ms);
      return diffMs < 0 ? `${valueAbs} ${part.unit}${valueAbs === 1 ? '' : 's'} ago` : `in ${valueAbs} ${part.unit}${valueAbs === 1 ? '' : 's'}`;
    }
  }
  return 'just now';
}

function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.round(Number(ms) / 1000));
  if (!Number.isFinite(totalSeconds)) return '—';
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function formatChartDate(value, days) {
  const numericValue = Number(value);
  const date = Number.isFinite(numericValue) ? new Date(numericValue) : new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  if (days <= 1) {
    const dateLabel = date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
    const timeLabel = date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    return `${dateLabel} ${timeLabel}`;
  }
  if (days <= 7) {
    return date.toLocaleString('en-GB', { weekday: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  }
  if (days <= 30) {
    return date.toLocaleDateString('en-GB', { month: 'short', day: 'numeric' });
  }
  return date.toLocaleDateString('en-GB', { month: 'short', day: 'numeric', year: '2-digit' });
}

function compact(value, digits = 2) {
  if (value === null || value === undefined || value === '') return '—';
  const num = Number(value);
  if (!Number.isFinite(num)) return String(value);
  return new Intl.NumberFormat('en-US', {
    notation: 'compact',
    maximumFractionDigits: digits,
  }).format(num);
}

function integer(value) {
  if (value === null || value === undefined || value === '') return '—';
  const num = Number(value);
  if (!Number.isFinite(num)) return String(value);
  return new Intl.NumberFormat('en-US', {
    maximumFractionDigits: 0,
  }).format(num);
}

function signedCompact(value, digits = 2) {
  if (value === null || value === undefined || value === '') return '—';
  const num = Number(value);
  if (!Number.isFinite(num)) return String(value);
  const sign = num > 0 ? '+' : num < 0 ? '-' : '';
  const abs = Math.abs(num);
  if (abs >= 10000) {
    return `${sign}${compact(abs, digits)}`;
  }
  return `${sign}${num.toFixed(digits)}`;
}

function percentDigits(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 2;
  const abs = Math.abs(num);
  if (abs === 0) return 3;
  return abs < 1 ? 3 : 2;
}

function percent(value, digits = null) {
  if (value === null || value === undefined || value === '') return '—';
  const num = Number(value);
  if (!Number.isFinite(num)) return String(value);
  const precision = digits === null ? percentDigits(num) : digits;
  return `${num.toFixed(precision)}%`;
}

function tao(value, digits = 4) {
  if (value === null || value === undefined || value === '') return '—';
  const num = Number(value);
  if (!Number.isFinite(num)) return String(value);
  return `τ ${new Intl.NumberFormat('en-US', { maximumFractionDigits: digits }).format(num)}`;
}

function alpha(value, digits = 4) {
  if (value === null || value === undefined || value === '') return '—';
  const num = Number(value);
  if (!Number.isFinite(num)) return String(value);
  return `α ${new Intl.NumberFormat('en-US', {
    notation: 'compact',
    maximumFractionDigits: digits,
  }).format(num)}`;
}

function formatUsd(value, digits = 2) {
  if (value === null || value === undefined || value === '') return '—';
  const num = Number(value);
  if (!Number.isFinite(num)) return String(value);
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    notation: 'compact',
    maximumFractionDigits: digits,
  }).format(num);
}

function formatSignedUsd(value, digits = 2) {
  if (value === null || value === undefined || value === '') return '—';
  const num = Number(value);
  if (!Number.isFinite(num)) return String(value);
  const sign = num > 0 ? '+' : num < 0 ? '-' : '';
  return sign + formatUsd(Math.abs(num), digits);
}

function signedTao(value, digits = 4) {
  if (value === null || value === undefined || value === '') return '—';
  const num = Number(value);
  if (!Number.isFinite(num)) return String(value);
  const sign = num > 0 ? '+' : num < 0 ? '-' : '';
  return `${sign}τ ${new Intl.NumberFormat('en-US', { maximumFractionDigits: digits }).format(Math.abs(num))}`;
}

function percentRatio(value, digits = null) {
  if (value === null || value === undefined || value === '') return '—';
  const num = Number(value);
  if (!Number.isFinite(num)) return String(value);
  const pct = num * 100;
  const precision = digits === null ? percentDigits(pct) : digits;
  return `${pct.toFixed(precision)}%`;
}

function signedPercent(value, digits = null) {
  if (value === null || value === undefined || value === '') return '—';
  const num = Number(value);
  if (!Number.isFinite(num)) return String(value);
  const sign = num > 0 ? '+' : '';
  const precision = digits === null ? percentDigits(num) : digits;
  return `${sign}${num.toFixed(precision)}%`;
}

function signedValue(value, digits = 2) {
  if (value === null || value === undefined || value === '') return '—';
  const num = Number(value);
  if (!Number.isFinite(num)) return String(value);
  const sign = num > 0 ? '+' : '';
  return `${sign}${num.toFixed(digits)}`;
}

function formatNumber(value) {
  if (value === null || value === undefined || value === '') return '—';
  const num = Number(value);
  if (!Number.isFinite(num)) return String(value);
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 4 }).format(num);
}

function formatMetricValue(value, format) {
  switch (format) {
    case 'number':
      return formatNumber(value);
    case 'compact':
      return compact(value);
    case 'integer':
      return integer(value);
    case 'signedCompact':
      return signedCompact(value);
    case 'signedPercent':
      return signedPercent(value);
    case 'percent':
      return percent(value);
    case 'percentRatio':
      return percentRatio(value);
    case 'signedValue':
      return signedValue(value);
    case 'tao':
      return tao(value);
    case 'signedTao':
      return signedTao(value);
    case 'text':
    default:
      return value === null || value === undefined || value === '' ? '—' : String(value);
  }
}

function applyScale(value, scale = 1) {
  if (value === null || value === undefined || value === '') return null;
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  return num * scale;
}

function numericMetricValue(value) {
  if (value === null || value === undefined || value === '') return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function resolveSentimentValue(row) {
  if (!row) return null;
  const candidates = [
    row.sentiment_index_num,
    row.ssi_num,
    row.sentiment_index_text,
    row.ssi_text,
    row.subnet_sentiment_index_num,
    row.subnet_sentiment_index_text,
    row.sentiment_score_num,
    row.sentiment_score_text,
    row.fear_and_greed_index,
  ];
  for (const candidate of candidates) {
    const num = numericMetricValue(candidate);
    if (num !== null) return num;
  }
  if (row.raw_json) {
    try {
      const payload = JSON.parse(row.raw_json);
      const payloadCandidates = [
        payload?.ssi,
        payload?.sentiment_index,
        payload?.subnet_sentiment_index,
        payload?.sentiment_score,
        payload?.fear_and_greed_index,
      ];
      for (const candidate of payloadCandidates) {
        const num = numericMetricValue(candidate);
        if (num !== null) return num;
      }
    } catch {
      // ignore parse errors and fall back to null
    }
  }
  return null;
}

function resolveSentimentSource(row) {
  if (!row) return null;
  const source = String(row.sentiment_index_source_text || '').trim().toLowerCase();
  if (source === 'ssi') return 'SSI';
  if (source === 'fear_and_greed' || source === 'fear-and-greed' || source === 'fear & greed') return 'Fear & Greed';
  if (numericMetricValue(row.sentiment_index_num) !== null || numericMetricValue(row.ssi_num) !== null || numericMetricValue(row.sentiment_index_text) !== null || numericMetricValue(row.ssi_text) !== null || numericMetricValue(row.subnet_sentiment_index_num) !== null || numericMetricValue(row.subnet_sentiment_index_text) !== null || numericMetricValue(row.sentiment_score_num) !== null || numericMetricValue(row.sentiment_score_text) !== null) {
    return 'SSI';
  }
  if (numericMetricValue(row.fear_and_greed_index) !== null) return 'Fear & Greed';
  if (row.raw_json) {
    try {
      const payload = JSON.parse(row.raw_json);
      if (numericMetricValue(payload?.ssi) !== null || numericMetricValue(payload?.sentiment_index) !== null || numericMetricValue(payload?.subnet_sentiment_index) !== null || numericMetricValue(payload?.sentiment_score) !== null) {
        return 'SSI';
      }
      if (numericMetricValue(payload?.fear_and_greed_index) !== null) return 'Fear & Greed';
    } catch {
      // ignore parse errors and fall back to null
    }
  }
  return null;
}

function resolveSentimentRawText(row) {
  if (!row) return '—';
  const source = resolveSentimentSource(row);
  const value = resolveSentimentValue(row);
  if (source && value !== null) return `${source} ${value}`;
  if (source) return source;
  return row.sentiment_index_text ?? row.fear_and_greed_index ?? (row.raw_json ? (() => {
    try {
      const payload = JSON.parse(row.raw_json);
      return payload?.ssi ?? payload?.sentiment_index ?? payload?.subnet_sentiment_index ?? payload?.sentiment_score ?? payload?.fear_and_greed_index ?? '—';
    } catch {
      return '—';
    }
  })() : '—');
}

function attachTaoPrice(rows, priceRows) {
  if (!rows.length) return rows;
  const indexedRows = rows.map((row, index) => ({
    index,
    row,
    time: new Date(row.captured_at).getTime(),
  }));
  const sortedRows = indexedRows.sort((a, b) => a.time - b.time);
  const prices = [...priceRows]
    .map((row) => ({
      row,
      time: new Date(row.captured_at).getTime(),
    }))
    .filter((entry) => Number.isFinite(entry.time))
    .sort((a, b) => a.time - b.time);
  const output = new Array(rows.length);
  let priceIndex = 0;
  let currentPrice = null;
  for (const entry of sortedRows) {
    while (priceIndex < prices.length && prices[priceIndex].time <= entry.time) {
      currentPrice = prices[priceIndex].row;
      priceIndex += 1;
    }
    output[entry.index] = {
      ...entry.row,
      tao_price_usd: currentPrice ? currentPrice.price_usd : null,
      tao_price_captured_at: currentPrice ? currentPrice.captured_at : null,
    };
  }
  return output;
}

function attachAlphaHolderCounts(rows, alphaHolderCounts) {
  if (!rows.length) return rows;
  const countsByCapturedAt = new Map(
    Array.isArray(alphaHolderCounts)
      ? alphaHolderCounts
        .filter((row) => row && row.captured_at)
        .map((row) => [row.captured_at, Number(row.alpha_holders_num ?? row.count ?? 0)])
      : [],
  );

  return rows.map((row) => {
    const alphaHolders = countsByCapturedAt.get(row.captured_at);
    if (!Number.isFinite(alphaHolders)) return row;
    return {
      ...row,
      alpha_holders_num: alphaHolders,
      alpha_holders_text: String(alphaHolders),
    };
  });
}

function formatSubnetLabel(name, netuid) {
  const subnetId = Number(netuid);
  const subnetLabel = Number.isFinite(subnetId) && subnetId > 0 ? `SN${subnetId}` : 'SN?';
  const cleanName = String(name ?? '').trim();
  return cleanName ? `${cleanName} (${subnetLabel})` : subnetLabel;
}

function buildTaostatsSubnetUrl(netuid, publicBaseUrl = 'https://taostats.io') {
  const subnetId = Number(netuid);
  if (!Number.isFinite(subnetId) || subnetId <= 0) return null;
  const base = String(publicBaseUrl || 'https://taostats.io').replace(/\/+$/, '');
  return `${base}/subnets/${subnetId}`;
}

function buildSparklinePath(values, width = 88, height = 28) {
  const series = Array.isArray(values)
    ? values.map((value) => Number(value)).filter((value) => Number.isFinite(value))
    : [];
  if (!series.length) return '';
  if (series.length === 1) {
    const midpoint = Math.round(height / 2);
    return `M 0 ${midpoint} L ${width} ${midpoint}`;
  }
  const min = Math.min(...series);
  const max = Math.max(...series);
  const range = Math.max(1, max - min);
  const step = series.length > 1 ? width / (series.length - 1) : width;
  return series.map((value, index) => {
    const x = index * step;
    const y = height - ((value - min) / range) * (height - 4) - 2;
    return `${index === 0 ? 'M' : 'L'} ${x.toFixed(2)} ${y.toFixed(2)}`;
  }).join(' ');
}

function renderMiniSparkline(values) {
  const series = Array.isArray(values)
    ? values.map((value) => Number(value)).filter((value) => Number.isFinite(value))
    : [];
  if (!series.length) {
    return '<span class="alpha-holder-sparkline-empty">—</span>';
  }
  const path = buildSparklinePath(series);
  const current = series.at(-1);
  const previous = series.length > 1 ? series.at(-2) : null;
  const change = Number.isFinite(current) && Number.isFinite(previous) ? current - previous : null;
  return `
    <span class="alpha-holder-sparkline">
      <svg viewBox="0 0 88 28" role="img" aria-label="Alpha holder trend sparkline">
        <path d="${path}" class="alpha-holder-sparkline-line"></path>
      </svg>
      <span class="alpha-holder-sparkline-value">${change === null ? '—' : `${change >= 0 ? '+' : ''}${integer(change)}`}</span>
    </span>
  `;
}

function buildAlphaHolderRankingRows(rows, currentNetuid = null, trendByNetuid = new Map()) {
  const sortedRows = Array.isArray(rows)
    ? rows
        .filter((row) => row && Number.isFinite(Number(row.netuid)))
        .slice()
        .sort((a, b) => {
          const countDelta = Number(b.alpha_holders_num ?? 0) - Number(a.alpha_holders_num ?? 0);
          if (countDelta !== 0) return countDelta;
          const captureDelta = new Date(b.captured_at).getTime() - new Date(a.captured_at).getTime();
          if (captureDelta !== 0) return captureDelta;
          return Number(a.netuid) - Number(b.netuid);
        })
    : [];

  let previousCount = null;
  let previousRank = 0;
  const rankedRows = sortedRows.map((row, index) => {
    const count = Number(row.alpha_holders_num ?? 0);
    const rank = count !== previousCount ? index + 1 : previousRank;
    previousCount = count;
    previousRank = rank;
    return {
      netuid: Number(row.netuid),
      captured_at: row.captured_at || null,
      alpha_holders_num: Number.isFinite(count) ? count : 0,
      rank_num: rank,
      current: currentNetuid !== null && Number(row.netuid) === Number(currentNetuid),
      subnet_name: row.subnet_name || row.name || null,
      subnet_label: formatSubnetLabel(row.subnet_name || row.name, row.netuid),
      trend: trendByNetuid.get(Number(row.netuid)) || null,
    };
  });

  return rankedRows;
}

function fetchAlphaHolderCurrentRanking(db, currentNetuid = null) {
  const rows = db.prepare(`
    WITH latest_capture AS (
      SELECT netuid, MAX(captured_at) AS captured_at
      FROM alpha_holder_snapshots
      GROUP BY netuid
    ),
    latest_counts AS (
      SELECT
        a.netuid,
        l.captured_at,
        COUNT(*) AS alpha_holders_num
      FROM alpha_holder_snapshots a
      JOIN latest_capture l
        ON a.netuid = l.netuid
       AND a.captured_at = l.captured_at
      WHERE COALESCE(a.balance_as_tao_num, 0) > 0
      GROUP BY a.netuid, l.captured_at
    ),
    latest_subnet_names AS (
      SELECT
        s.netuid,
        s.name AS subnet_name
      FROM snapshots s
      JOIN (
        SELECT netuid, MAX(captured_at) AS captured_at
        FROM snapshots
        GROUP BY netuid
      ) latest_snapshot
        ON s.netuid = latest_snapshot.netuid
       AND s.captured_at = latest_snapshot.captured_at
    ),
    metadata_names AS (
      SELECT
        m.netuid,
        m.name AS metadata_name
      FROM subnet_metadata m
    )
    SELECT
      lc.netuid,
      lc.captured_at,
      lc.alpha_holders_num,
      COALESCE(mn.metadata_name, ls.subnet_name) AS subnet_name
    FROM latest_counts lc
    LEFT JOIN latest_subnet_names ls
      ON ls.netuid = lc.netuid
    LEFT JOIN metadata_names mn
      ON mn.netuid = lc.netuid
    ORDER BY lc.alpha_holders_num DESC, lc.captured_at DESC, lc.netuid ASC
  `).all();
  const sinceIso = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const trendByNetuid = new Map();
  for (const row of rows) {
    const netuid = Number(row.netuid);
    if (!Number.isFinite(netuid) || netuid <= 0 || trendByNetuid.has(netuid)) continue;
    const history = getAlphaHolderSnapshotHistory(db, netuid, sinceIso);
    const points = history
      .map((point) => Number(point.alpha_holders_num ?? 0))
      .filter((value) => Number.isFinite(value));
    const latest = points.length ? points.at(-1) : null;
    const previous = points.length > 1 ? points.at(-2) : null;
    trendByNetuid.set(netuid, {
      points,
      latest,
      previous,
      change_num: Number.isFinite(latest) && Number.isFinite(previous) ? latest - previous : null,
      captured_at: history.at(-1)?.captured_at || null,
      series_length: points.length,
    });
  }
  return buildAlphaHolderRankingRows(rows, currentNetuid, trendByNetuid);
}

function fetchAlphaHolderRankHistory(db, netuid, sinceIso) {
  const rows = db.prepare(`
    WITH daily_latest AS (
      SELECT
        netuid,
        substr(captured_at, 1, 10) AS day,
        MAX(captured_at) AS captured_at
      FROM alpha_holder_snapshots
      WHERE captured_at >= ?
      GROUP BY netuid, substr(captured_at, 1, 10)
    ),
    daily_counts AS (
      SELECT
        a.netuid,
        l.day,
        l.captured_at,
        COUNT(*) AS alpha_holders_num
      FROM alpha_holder_snapshots a
      JOIN daily_latest l
        ON a.netuid = l.netuid
       AND substr(a.captured_at, 1, 10) = l.day
       AND a.captured_at = l.captured_at
      WHERE COALESCE(a.balance_as_tao_num, 0) > 0
      GROUP BY a.netuid, l.day, l.captured_at
      ORDER BY l.day ASC, alpha_holders_num DESC, a.netuid ASC
    )
    SELECT
      netuid,
      day,
      captured_at,
      alpha_holders_num
    FROM daily_counts
    ORDER BY day ASC, alpha_holders_num DESC, netuid ASC
  `).all(sinceIso);

  const groupedByDay = new Map();
  for (const row of rows) {
    if (!row || !row.day || !Number.isFinite(Number(row.netuid))) continue;
    if (!groupedByDay.has(row.day)) groupedByDay.set(row.day, []);
    groupedByDay.get(row.day).push({
      netuid: Number(row.netuid),
      captured_at: row.captured_at || null,
      alpha_holders_num: Number(row.alpha_holders_num ?? 0),
    });
  }

  const history = [];
  for (const [day, dayRows] of groupedByDay.entries()) {
    const sortedRows = dayRows
      .slice()
      .sort((a, b) => {
        const countDelta = Number(b.alpha_holders_num ?? 0) - Number(a.alpha_holders_num ?? 0);
        if (countDelta !== 0) return countDelta;
        const captureDelta = new Date(b.captured_at).getTime() - new Date(a.captured_at).getTime();
        if (captureDelta !== 0) return captureDelta;
        return Number(a.netuid) - Number(b.netuid);
      });
    let previousCount = null;
    let previousRank = 0;
    for (const [index, row] of sortedRows.entries()) {
      const count = Number(row.alpha_holders_num ?? 0);
      const rank = count !== previousCount ? index + 1 : previousRank;
      previousCount = count;
      previousRank = rank;
      if (Number(row.netuid) !== Number(netuid)) continue;
      history.push({
        netuid: Number(row.netuid),
        captured_at: row.captured_at || `${day}T00:00:00.000Z`,
        alpha_holders_num: count,
        rank_num: rank,
        subnet_count_num: sortedRows.length,
      });
      break;
    }
  }

  return history;
}

function currencyScaleForField(field) {
  return {
    market_cap_num: 1 / TAO_PER_RAO,
    liquidity_num: 1 / TAO_PER_RAO,
    tao_volume_24_hr_num: 1 / TAO_PER_RAO,
    net_flow_1_day_num: 1 / TAO_PER_RAO,
    net_flow_7_days_num: 1 / TAO_PER_RAO,
    net_flow_30_days_num: 1 / TAO_PER_RAO,
    price_num: 1,
    emission_per_day_tao_num: 1,
    owner_per_day_tao_num: 1,
    miner_per_day_tao_num: 1,
    validator_per_day_tao_num: 1,
    recycled_24_hours_num: 1,
    registration_cost_num: 1,
  }[field] || 1;
}

function getLatestMetricDefs() {
  return [
    { key: 'price_num', label: 'Token Price', description: 'This is the price one unit of the subnet token is trading at right now, in TAO terms.', valueField: 'price_num', valueFormat: 'tao', rawField: 'price_text', historyField: 'price_num', chartLabel: 'Token Price', chartColor: '#00dbbc', clickable: true, currencyMode: 'tao' },
    { key: 'market_cap_num', label: 'Subnet Market Cap', description: 'Taostats stores this market-cap figure in rao-style units, so we convert it to TAO here. It is the subnet’s overall size at today’s price, which is easier to compare across subnets.', valueField: 'market_cap_num', valueFormat: 'tao', valueScale: 1 / TAO_PER_RAO, rawField: 'market_cap_text', historyField: 'market_cap_num', chartLabel: 'Subnet Market Cap', chartColor: '#1db954', clickable: true, currencyMode: 'tao' },
    { key: 'liquidity_num', label: 'Pool Liquidity', description: 'This tells you how much TAO is sitting in the pool, ready for buyers and sellers. More liquidity usually means smoother trading.', valueField: 'liquidity_num', valueFormat: 'tao', valueScale: 1 / TAO_PER_RAO, rawField: 'liquidity_text', historyField: 'liquidity_num', chartLabel: 'Pool Liquidity', chartColor: '#6c8cff', clickable: true, currencyMode: 'tao' },
    { key: 'emission_num', label: 'Raw Emission', description: 'This is the raw emission number from Taostats before we convert it into the friendlier percent and TAO/day views.', valueField: 'emission_num', valueFormat: 'compact', rawField: 'emission_text', historyField: 'emission_num', chartLabel: 'Raw Emission', chartColor: '#f59e0b', clickable: true },
    { key: 'projected_emission_num', label: 'Emission Forecast', description: 'This is Taostats’ best guess for where the emission rate is heading next.', valueField: 'projected_emission_num', valueFormat: 'number', rawField: 'projected_emission_text', historyField: 'projected_emission_num', chartLabel: 'Emission Forecast', chartColor: '#c084fc', clickable: true },
    { key: 'net_flow_1_day_num', label: 'Money In/Out (1d)', description: 'This shows whether TAO flowed into the subnet or out of it over the last day.', valueField: 'net_flow_1_day_num', valueFormat: 'signedTao', valueScale: 1 / TAO_PER_RAO, rawField: 'net_flow_1_day_text', historyField: 'net_flow_1_day_num', chartLabel: 'Money In/Out (1d)', chartColor: '#ef4444', clickable: true, currencyMode: 'tao', historySource: 'subnet' },
    { key: 'net_flow_7_days_num', label: 'Money In/Out (7d)', description: 'This shows the same idea, but over the last week instead of just one day.', valueField: 'net_flow_7_days_num', valueFormat: 'signedTao', valueScale: 1 / TAO_PER_RAO, rawField: 'net_flow_7_days_text', historyField: 'net_flow_7_days_num', chartLabel: 'Money In/Out (7d)', chartColor: '#a855f7', clickable: true, currencyMode: 'tao', historySource: 'subnet' },
    { key: 'net_flow_30_days_num', label: 'Money In/Out (30d)', description: 'This shows the longer-term net movement of TAO over the last month.', valueField: 'net_flow_30_days_num', valueFormat: 'signedTao', valueScale: 1 / TAO_PER_RAO, rawField: 'net_flow_30_days_text', historyField: 'net_flow_30_days_num', chartLabel: 'Money In/Out (30d)', chartColor: '#f97316', clickable: true, currencyMode: 'tao', historySource: 'subnet' },
    { key: 'tao_volume_24_hr_num', label: 'Trading Volume', description: 'This is how much TAO changed hands in the pool during the last 24 hours.', valueField: 'tao_volume_24_hr_num', valueFormat: 'tao', valueScale: 1 / TAO_PER_RAO, rawField: 'tao_volume_24_hr_text', historyField: 'tao_volume_24_hr_num', chartLabel: 'Trading Volume', chartColor: '#22c55e', clickable: true, currencyMode: 'tao' },
    { key: 'price_change_1_hour_text', label: 'Price Move (1h)', description: 'This is the price move over the last hour, shown as a percentage.', valueField: 'price_change_1_hour_text', valueFormat: 'signedPercent', historyField: 'price_change_1_hour_text', chartLabel: 'Price Move (1h)', chartColor: '#38bdf8', clickable: true },
    { key: 'price_change_1_day_text', label: 'Price Move (24h)', description: 'This is the price move over the last 24 hours, shown as a percentage.', valueField: 'price_change_1_day_text', valueFormat: 'signedPercent', historyField: 'price_change_1_day_text', chartLabel: 'Price Move (24h)', chartColor: '#60a5fa', clickable: true },
    { key: 'price_change_1_week_text', label: 'Price Move (7d)', description: 'This is the price move over the last 7 days, shown as a percentage.', valueField: 'price_change_1_week_text', valueFormat: 'signedPercent', historyField: 'price_change_1_week_text', chartLabel: 'Price Move (7d)', chartColor: '#818cf8', clickable: true },
    { key: 'price_change_1_month_text', label: 'Price Move (30d)', description: 'This is the price move over the last 30 days, shown as a percentage.', valueField: 'price_change_1_month_text', valueFormat: 'signedPercent', historyField: 'price_change_1_month_text', chartLabel: 'Price Move (30d)', chartColor: '#c084fc', clickable: true },
    { key: 'rank', label: 'Rank', description: 'This is the subnet’s place in the Taostats rankings. Lower numbers usually mean a stronger spot.', valueField: 'rank', valueFormat: 'text', historyField: 'rank', chartLabel: 'Rank', chartColor: '#f59e0b', clickable: true },
    { key: 'root_prop_text', label: 'Root Share', description: 'This shows how much of the pool belongs to the root portion of the subnet.', valueField: 'root_prop_text', valueFormat: 'percentRatio', historyField: 'root_prop_text', chartLabel: 'Root Share', chartColor: '#14b8a6', clickable: true },
    {
      key: 'root_sell_text',
      label: 'Root Sell',
      description: 'This tells you whether root selling is switched on. If it is, the subnet can sell root-side assets according to the protocol rules.',
      valueField: 'root_sell_text',
      valueFormat: 'text',
      historyField: 'root_sell_bool',
      chartLabel: 'Root Sell',
      chartColor: '#fb7185',
      clickable: true,
      latestValue: (row) => {
        if (row.root_sell_bool === null || row.root_sell_bool === undefined) return '—';
        return row.root_sell_bool ? 'Yes' : 'No';
      },
      rawValue: (row) => row.root_sell_bool === null || row.root_sell_bool === undefined ? '—' : String(Boolean(row.root_sell_bool)),
    },
    {
      key: 'sentiment_index_num',
      label: 'Subnet Sentiment (SSI)',
      description: 'This is Taostats’ sentiment score for the subnet. Think of it like a market mood meter for the subnet: lower values usually mean traders are more cautious or selling, while higher values mean they are more optimistic or buying. Taostats now prefers SSI when it is available and falls back to the older Fear & Greed score on legacy rows.',
      valueField: 'sentiment_index_num',
      valueFormat: 'number',
      rawField: 'sentiment_index_text',
      historyField: 'sentiment_index_num',
      chartLabel: 'Subnet Sentiment (SSI)',
      chartColor: '#eab308',
      clickable: true,
      latestValue: (row, scaledLatestValue) => formatMetricValue(resolveSentimentValue(row) ?? scaledLatestValue, 'number'),
      rawValue: (row) => resolveSentimentRawText(row),
      sourceText: (row) => resolveSentimentSource(row) || 'Unavailable',
      subtext: (row) => {
        const source = resolveSentimentSource(row);
        if (source) return `Source: ${source}`;
        return 'Sentiment data unavailable';
      },
    },
    { key: 'source', label: 'Source', valueField: 'source', valueFormat: 'text', clickable: false, latestValue: (row) => row.source || '—' },
  ];
}

function getSubnetDataMetricDefs(subnetLabel = null) {
  const labelText = subnetLabel || 'this subnet';
  return [
    { key: 'emission_percent_num', label: 'Emission Rate', description: 'This is the share of TAO being released into the subnet pool each cycle, shown as a percentage.', valueField: 'emission_percent_num', valueFormat: 'percent', historyField: 'emission_percent_num', chartLabel: 'Emission Rate', chartColor: '#f59e0b', clickable: true },
    {
      key: 'root_prop_text',
      label: 'Root Share',
      description: 'This shows the part of the subnet pool that belongs to root — think of it like the main account at the top of the structure.',
      valueField: 'root_prop_text',
      valueFormat: 'percentRatio',
      historyField: 'root_prop_text',
      chartLabel: 'Root Share',
      chartColor: '#14b8a6',
      clickable: true,
    },
    { key: 'emission_per_day_tao_num', label: 'New TAO / Day', description: 'This is the estimated TAO created for the subnet each day. A simple way to think about it is the subnet’s daily “new money” coming in.', valueField: 'emission_per_day_tao_num', valueFormat: 'tao', historyField: 'emission_per_day_tao_num', chartLabel: 'New TAO / Day', chartColor: '#f97316', clickable: true },
    { key: 'owner_per_day_tao_num', label: 'Owner Share', description: 'This is the part of that daily TAO that goes to the subnet owner.', valueField: 'owner_per_day_tao_num', valueFormat: 'tao', historyField: 'owner_per_day_tao_num', chartLabel: 'Owner Share', chartColor: '#60a5fa', clickable: true },
    { key: 'miner_per_day_tao_num', label: 'Miner Share', description: 'This is the part of the daily TAO that goes to miners for doing the work that supports the subnet.', valueField: 'miner_per_day_tao_num', valueFormat: 'tao', historyField: 'miner_per_day_tao_num', chartLabel: 'Miner Share', chartColor: '#22c55e', clickable: true },
    { key: 'validator_per_day_tao_num', label: 'Validator Share', description: 'This is the part of the daily TAO that goes to validators for checking and confirming activity.', valueField: 'validator_per_day_tao_num', valueFormat: 'tao', historyField: 'validator_per_day_tao_num', chartLabel: 'Validator Share', chartColor: '#a855f7', clickable: true },
    { key: 'alpha_holders_num', label: 'Alpha Holders', description: `This is the number of holder rows in the latest subnet snapshot, derived from the stored holder snapshots. Click it to see the historical trend, and use the new all-subnet ranking view below to compare ${labelText} with the rest.`, valueField: 'alpha_holders_num', valueFormat: 'integer', historyField: 'alpha_holders_num', chartLabel: 'Alpha Holders', chartColor: '#38bdf8', clickable: true, historySource: 'alpha-holder' },
    { key: 'incentive_burn_num', label: 'Burn Rate', description: 'This shows how much reward is burned instead of being paid out. Higher values mean more gets removed from circulation.', valueField: 'incentive_burn_num', valueFormat: 'percent', historyField: 'incentive_burn_num', chartLabel: 'Burn Rate', chartColor: '#fb7185', clickable: true },
    { key: 'recycled_24_hours_num', label: 'Recycled TAO', description: 'This is the amount of TAO that got recycled in the last 24 hours. In plain English, it’s TAO that came back into use instead of staying spent.', valueField: 'recycled_24_hours_num', valueFormat: 'tao', historyField: 'recycled_24_hours_num', chartLabel: 'Recycled TAO', chartColor: '#38bdf8', clickable: true },
    { key: 'registration_cost_num', label: 'Registration Fee', description: 'This is the fee to register a new neuron. Think of it as the cost to get a seat at the table.', valueField: 'registration_cost_num', valueFormat: 'tao', historyField: 'registration_cost_num', chartLabel: 'Registration Fee', chartColor: '#c084fc', clickable: true },
    {
      key: 'uids',
      label: 'UIDs',
      description: 'This compares how many neuron slots are active right now versus the maximum the subnet can hold.',
      valueField: 'active_keys_num',
      valueFormat: 'integer',
      historyField: 'active_keys_num',
      chartLabel: 'UIDs',
      chartColor: '#eab308',
      clickable: true,
      latestValue: (row) => `${integer(row.active_keys_num)}/${integer(row.max_neurons_num)}`,
      rawValue: (row) => `${row.active_keys_text ?? '—'}/${row.max_neurons_text ?? '—'}`,
    },
  ];
}

function getChartMetricConfigs() {
  return [
    { id: 'price-chart', label: 'Token Price', field: 'price_num', valueScale: 1, valueFormat: 'tao', currencyMode: 'tao', color: '#00dbbc' },
    { id: 'net-flow-1d-chart', label: 'Money In/Out (1d)', field: 'net_flow_1_day_num', historySource: 'subnet', valueScale: 0.000000001, valueFormat: 'signedTao', currencyMode: 'tao', color: '#ef4444' },
    { id: 'sentiment-chart', label: 'Subnet Sentiment (SSI)', field: 'sentiment_index_num', historySource: 'subnet', valueScale: 1, valueFormat: 'number', currencyMode: 'none', color: '#eab308' },
    { id: 'emission-rate-chart', label: 'Emission Rate', field: 'emission_percent_num', valueScale: 1, valueFormat: 'percent', currencyMode: 'none', color: '#f59e0b' },
    { id: 'market-cap-chart', label: 'Subnet Market Cap', field: 'market_cap_num', valueScale: 0.000000001, valueFormat: 'tao', currencyMode: 'tao', color: '#1db954' },
    { id: 'liquidity-chart', label: 'Pool Liquidity', field: 'liquidity_num', valueScale: 0.000000001, valueFormat: 'tao', currencyMode: 'tao', color: '#6c8cff' },
  ];
}

function buildMetricCardModel(latest, def, { defaultSubtext = true } = {}) {
  const scaledLatestValue = def.valueScale ? applyScale(latest[def.valueField], def.valueScale) : latest[def.valueField];
  const latestValue = typeof def.latestValue === 'function'
    ? def.latestValue(latest, scaledLatestValue)
    : formatMetricValue(scaledLatestValue, def.valueFormat);
  const taoValue = ['tao', 'signedTao'].includes(def.valueFormat) || def.currencyMode === 'tao'
    ? scaledLatestValue
    : null;
  const rawValue = typeof def.rawValue === 'function'
    ? def.rawValue(latest)
    : (def.rawField ? (latest[def.rawField] ?? '—') : null);
  const metricData = {
    key: def.key,
    label: def.label,
    description: def.description || '',
    valueField: def.valueField,
    valueFormat: def.valueFormat,
    historyField: def.historyField || def.valueField,
    chartLabel: def.chartLabel || def.label,
    chartColor: def.chartColor || '#00dbbc',
    valueScale: def.valueScale || 1,
    currencyMode: def.currencyMode || (['tao', 'signedTao'].includes(def.valueFormat) ? 'tao' : 'none'),
    historySource: def.historySource || 'subnet',
    taoValue,
    taoPriceUsd: latest.tao_price_usd ?? null,
    clickable: Boolean(def.clickable),
    latestValue,
    rawValue,
    sourceText: typeof def.sourceText === 'function' ? def.sourceText(latest, latestValue, rawValue) : null,
  };
  const subtext = typeof def.subtext === 'function'
    ? def.subtext(latest, latestValue, rawValue)
    : (def.subtext !== undefined
      ? def.subtext
      : defaultSubtext
        ? (def.rawField
          ? `Raw: ${rawValue ?? '—'}`
          : def.key === 'root_sell_text'
            ? 'Tap to inspect historical root-sell state'
            : def.key === 'sentiment_index_num' || def.key === 'fear_and_greed_index'
              ? 'Tap to inspect historical sentiment'
              : def.key === 'rank'
                ? 'Tap to inspect rank history'
                : '')
        : '');
  return { scaledLatestValue, latestValue, rawValue, metricData, subtext };
}

function findMetricDef(defs, key) {
  return defs.find((def) => def.key === key) || null;
}

function buildSignalSummary(latest, comparisons, latestMetricDefs = getLatestMetricDefs(), subnetMetricDefs = getSubnetDataMetricDefs()) {
  const comparisonMap = new Map(comparisons.map((comparison) => [comparison.field, comparison]));
  const priceComparison = comparisonMap.get('price_num');
  const sentimentValue = resolveSentimentValue(latest);
  const sentimentSource = resolveSentimentSource(latest);
  const emissionRate = numericMetricValue(latest.emission_percent_num);
  const burnRate = numericMetricValue(latest.incentive_burn_num);
  const flow7Value = applyScale(latest.net_flow_7_days_num, 1 / TAO_PER_RAO);
  const priceDef = findMetricDef(latestMetricDefs, 'price_num');
  const flowDef = findMetricDef(latestMetricDefs, 'net_flow_7_days_num');
  const sentimentDef = findMetricDef(latestMetricDefs, 'sentiment_index_num');
  const emissionDef = findMetricDef(subnetMetricDefs, 'emission_percent_num');
  const positiveSignals = [];
  const negativeSignals = [];

  if (priceComparison && Number.isFinite(priceComparison.pct)) {
    if (priceComparison.pct > 0) positiveSignals.push('Price momentum is positive.');
    else if (priceComparison.pct < 0) negativeSignals.push('Price momentum is negative.');
  }

  if (Number.isFinite(flow7Value)) {
    if (flow7Value > 0) positiveSignals.push('Net TAO flow over the week is positive.');
    else if (flow7Value < 0) negativeSignals.push('Net TAO flow over the week is negative.');
  }

  if (Number.isFinite(sentimentValue)) {
    if (sentimentValue >= 60) positiveSignals.push('Sentiment is leaning optimistic.');
    else if (sentimentValue <= 40) negativeSignals.push('Sentiment is leaning cautious.');
  }

  if (Number.isFinite(emissionRate)) {
    if (emissionRate <= 0.75) positiveSignals.push('Emission pressure is relatively light.');
    else if (emissionRate >= 1.25) negativeSignals.push('Emission pressure is relatively heavy.');
  }

  if (Number.isFinite(burnRate) && burnRate >= 1) {
    negativeSignals.push('Burn rate is removing a noticeable share of rewards.');
  }

  const score = positiveSignals.length - negativeSignals.length;
  const tone = score >= 2 ? 'positive' : score <= -2 ? 'negative' : 'neutral';
  const headline = tone === 'positive' ? 'Bullish' : tone === 'negative' ? 'Bearish' : 'Neutral';
  const summary = tone === 'positive'
    ? 'Price, flow, and sentiment are mostly pointing the same way, so the setup looks constructive.'
    : tone === 'negative'
      ? 'Price, flow, and sentiment are leaning cautious, so the setup looks softer right now.'
      : 'The signals are mixed, so the dashboard stays neutral until more evidence lines up.';
  const scoreLabel = score >= 3
    ? 'Strong constructive read'
    : score <= -3
      ? 'Strong cautious read'
      : 'Mixed evidence';

  const cards = [
    {
      label: 'Price momentum',
      value: priceComparison && Number.isFinite(priceComparison.pct)
        ? signedPercent(priceComparison.pct, 2)
        : '—',
      subtext: priceComparison && Number.isFinite(priceComparison.pct)
        ? 'Token Price change over the last 24 hours'
        : 'Not enough history yet for a 24h price read',
      tone: priceComparison && Number.isFinite(priceComparison.pct)
        ? (priceComparison.pct >= 0 ? 'positive' : 'negative')
        : 'neutral',
      metricData: priceDef ? { ...buildMetricCardModel(latest, priceDef).metricData, displayValue: priceComparison && Number.isFinite(priceComparison.pct) ? signedPercent(priceComparison.pct, 2) : '—' } : null,
    },
    {
      label: 'Money flow',
      value: Number.isFinite(flow7Value)
        ? (flow7Value > 0 ? 'Inflow' : flow7Value < 0 ? 'Outflow' : 'Balanced')
        : '—',
      subtext: Number.isFinite(flow7Value)
        ? '7d net TAO movement into or out of the subnet'
        : 'Not enough flow history yet',
      tone: Number.isFinite(flow7Value)
        ? (flow7Value > 0 ? 'positive' : flow7Value < 0 ? 'negative' : 'neutral')
        : 'neutral',
      metricData: flowDef ? { ...buildMetricCardModel(latest, flowDef).metricData, displayValue: Number.isFinite(flow7Value) ? (flow7Value > 0 ? 'Inflow' : flow7Value < 0 ? 'Outflow' : 'Balanced') : '—' } : null,
    },
    {
      label: 'Market mood',
      value: Number.isFinite(sentimentValue)
        ? `${sentimentSource ? `${sentimentSource} ` : ''}${Number(sentimentValue).toFixed(1)}`
        : '—',
      subtext: Number.isFinite(sentimentValue)
        ? 'Higher means traders feel more optimistic'
        : 'Sentiment data is unavailable for this row',
      tone: Number.isFinite(sentimentValue)
        ? (sentimentValue >= 60 ? 'positive' : sentimentValue <= 40 ? 'negative' : 'neutral')
        : 'neutral',
      metricData: sentimentDef ? { ...buildMetricCardModel(latest, sentimentDef).metricData, displayValue: Number.isFinite(sentimentValue) ? `${sentimentSource ? `${sentimentSource} ` : ''}${Number(sentimentValue).toFixed(1)}` : '—' } : null,
    },
    {
      label: 'Supply pressure',
      value: Number.isFinite(emissionRate)
        ? `${percent(emissionRate, 3)} emitted`
        : '—',
      subtext: Number.isFinite(emissionRate)
        ? (Number.isFinite(burnRate)
          ? `Burn rate: ${percent(burnRate, 2)}`
          : 'Lower emission is gentler on supply pressure')
        : 'Emission rate is unavailable',
      tone: Number.isFinite(emissionRate)
        ? (emissionRate <= 0.75 ? 'positive' : emissionRate >= 1.25 ? 'negative' : 'neutral')
        : 'neutral',
      metricData: emissionDef ? { ...buildMetricCardModel(latest, emissionDef).metricData, displayValue: Number.isFinite(emissionRate) ? `${percent(emissionRate, 3)} emitted` : '—' } : null,
    },
  ];

  const bullets = [
    ...positiveSignals.slice(0, 2),
    ...negativeSignals.slice(0, 2),
  ];

  return {
    tone,
    headline,
    summary,
    scoreLabel,
    bullets,
    cards,
    latest,
    comparisons,
  };
}

function renderMetricCards(latest, defs, { defaultSubtext = true } = {}) {
  return defs.map((def) => {
    const model = buildMetricCardModel(latest, def, { defaultSubtext });

    return metricCard({
      label: def.label,
      value: model.latestValue,
      subtext: model.subtext,
      tone: def.tone || 'neutral',
      clickable: def.clickable,
      metricData: model.metricData,
    });
  }).join('');
}

function renderLatestSnapshotCards(latest, defs) {
  return renderMetricCards(latest, defs, { defaultSubtext: true });
}

function renderSubnetDataCards(latest, subnetLabel = null) {
  return renderMetricCards(latest, getSubnetDataMetricDefs(subnetLabel), { defaultSubtext: false });
}

function renderAlphaHolderSection(rows, {
  latestCaptureAt = null,
  totalRowCount = null,
  rankingRows = [],
  currentRankingRow = null,
  currentNetuid = null,
  rankHistoryStartAt = null,
  taostatsPublicBaseUrl = 'https://taostats.io',
} = {}) {
  const entries = Array.isArray(rows) ? rows : [];
  const latestCapturedAt = latestCaptureAt || entries[0]?.captured_at || null;
  const latestText = latestCapturedAt ? `Latest snapshot captured ${formatIso(latestCapturedAt)} from the local SQLite history.` : 'No alpha holder snapshots have been stored yet.';
  const totalLabel = Number.isFinite(Number(totalRowCount)) && Number(totalRowCount) > 0
    ? `${Number(totalRowCount).toLocaleString('en-US')} holder rows are present in the latest snapshot.`
    : '';
  const topLabel = entries.length ? `Showing the top ${entries.length} addresses from the latest holder snapshot.` : '';
  const rankingEntries = Array.isArray(rankingRows) ? rankingRows.slice() : [];
  const visibleRankingEntries = rankingEntries.slice(0, 15);
  const currentVisibleRow = currentRankingRow && !visibleRankingEntries.some((row) => Number(row.netuid) === Number(currentRankingRow.netuid))
    ? currentRankingRow
    : null;
  if (currentVisibleRow) {
    visibleRankingEntries.push(currentVisibleRow);
  }
  const currentRankLabel = currentRankingRow
    ? (currentRankingRow.subnet_label || formatSubnetLabel(currentRankingRow.subnet_name, currentNetuid))
    : 'No current subnet ranking yet';
  const currentRankValue = currentRankingRow ? `#${integer(currentRankingRow.rank_num)}` : '—';
  const currentRankSubtext = currentRankingRow
    ? [
      `Current local rank among ${integer(rankingEntries.length)} tracked subnets`,
      rankHistoryStartAt ? `History starts at ${formatIso(rankHistoryStartAt)}` : null,
      'Click to expand the ranking table',
    ].filter(Boolean).join(' • ')
    : 'No ranking data is available yet.';
  const rankingSummary = `
    <summary class="alpha-holder-ranking-summary">
      <span class="alpha-holder-ranking-summary-kicker">Alpha-holder ranking across subnets</span>
      <span class="alpha-holder-ranking-summary-title">Current subnet alpha-holder rank</span>
      <span class="alpha-holder-ranking-summary-label">${escapeHtml(currentRankLabel)}</span>
      <span class="alpha-holder-ranking-summary-value">${escapeHtml(currentRankValue)}</span>
      <span class="alpha-holder-ranking-summary-subtext">${escapeHtml(currentRankSubtext)}</span>
    </summary>
  `;
  const rankingBody = visibleRankingEntries.length
    ? visibleRankingEntries.map((row) => {
        const isCurrent = currentNetuid !== null && Number(row.netuid) === Number(currentNetuid);
        const subnetLabel = row.subnet_label || formatSubnetLabel(row.subnet_name, row.netuid);
        const subnetUrl = buildTaostatsSubnetUrl(row.netuid, taostatsPublicBaseUrl);
        const change = Number(row.trend?.change_num ?? NaN);
        const changeClass = Number.isFinite(change)
          ? (change > 0 ? 'positive' : change < 0 ? 'negative' : 'neutral')
          : 'muted';
        const changeLabel = Number.isFinite(change)
          ? `${change >= 0 ? '+' : ''}${integer(change)}`
          : '—';
        const sparkline = renderMiniSparkline(row.trend?.points || []);
        return `
          <tr${isCurrent ? ' class="current"' : ''}>
            <td>${escapeHtml(integer(row.rank_num))}</td>
            <td>
              ${subnetUrl ? `<a class="alpha-holder-subnet-link" href="${escapeHtml(subnetUrl)}" target="_blank" rel="noopener noreferrer" title="Open ${escapeHtml(subnetLabel)} on Taostats">${escapeHtml(subnetLabel)}</a>` : escapeHtml(subnetLabel)}
              ${isCurrent ? ' <span class="ranking-current-tag">Current</span>' : ''}
            </td>
            <td>${escapeHtml(integer(row.alpha_holders_num))}</td>
            <td class="alpha-holder-ranking-change ${changeClass}">${escapeHtml(changeLabel)}</td>
            <td class="alpha-holder-ranking-sparkline-cell">${sparkline}</td>
          </tr>
        `;
      }).join('')
    : '<tr><td colspan="5" class="empty">No ranking rows are available yet.</td></tr>';
  const body = entries.length
    ? entries.map((row, index) => {
        const address = row.coldkey_ss58 || row.wallet_address_ss58 || '—';
        const validator = row.hotkey_name || row.hotkey_address_ss58 || '—';
        return `
          <tr>
            <td>${escapeHtml(integer(index + 1))}</td>
            <td title="${escapeHtml(address)}">${escapeHtml(shortAddress(address))}</td>
            <td title="${escapeHtml(row.hotkey_address_ss58 || validator)}">${escapeHtml(validator)}</td>
            <td>${escapeHtml(formatNumber(row.balance_num))}</td>
            <td>${escapeHtml(formatNumber(row.balance_as_tao_num))}</td>
          </tr>
        `;
      }).join('')
    : '<tr><td colspan="5" class="empty">No holder rows available yet.</td></tr>';

  return `
    <section class="section">
      <details class="alpha-holder-details">
        <summary>Alpha holder addresses</summary>
        <p class="muted">${escapeHtml(latestText)} ${escapeHtml(totalLabel)} ${escapeHtml(topLabel)}</p>
        <div class="panel">
          <div class="table-wrap alpha-holder-table-wrap">
            <table class="data-table alpha-holder-table">
              <thead>
                <tr>
                  <th>Rank</th>
                  <th>Address</th>
                  <th>Validator</th>
                  <th>Alpha</th>
                  <th>Tao</th>
                </tr>
              </thead>
              <tbody>${body}</tbody>
            </table>
          </div>
        </div>
      </details>
      <details class="alpha-holder-ranking-details">
        ${rankingSummary}
        <div class="panel alpha-holder-ranking-panel">
          <div class="alpha-holder-ranking-head">
            <div>
              <h3>Latest alpha-holder leaderboard</h3>
              <p class="muted">This table compares the latest local alpha-holder snapshot for every subnet stored in SQLite and adds a small trend sparkline per row.</p>
            </div>
          </div>
          <div class="table-wrap alpha-holder-ranking-table-wrap">
            <table class="data-table alpha-holder-ranking-table">
              <thead>
                <tr>
                  <th>Rank</th>
                  <th>Subnet</th>
                  <th>Alpha holders</th>
                  <th>Change</th>
                  <th>Trend</th>
                </tr>
              </thead>
              <tbody>${rankingBody}</tbody>
            </table>
          </div>
        </div>
      </details>
    </section>
  `;
}

function renderSignalSection(signal) {
  if (!signal) return '';
  const bullets = signal.bullets.length
    ? signal.bullets.map((bullet) => `<li>${escapeHtml(bullet)}</li>`).join('')
    : '<li>There is not enough history yet to make a strong read.</li>';
  const cards = signal.cards.map((card) => metricCard({
    label: card.label,
    value: card.value,
    subtext: card.subtext,
    tone: card.tone || 'neutral',
    clickable: Boolean(card.metricData),
    metricData: card.metricData,
  })).join('');
  return `
    <section class="section signal-section">
      <div class="panel signal-panel ${escapeHtml(signal.tone || 'neutral')}">
        <div class="signal-panel-head">
          <div>
            <div class="eyebrow">Signal now</div>
            <h2>${escapeHtml(signal.headline || 'Neutral')}</h2>
            <p>${escapeHtml(signal.summary || '')}</p>
          </div>
          <div class="signal-badge">${escapeHtml(signal.scoreLabel || 'Mixed evidence')}</div>
        </div>
        <ul class="signal-bullets">${bullets}</ul>
        <div class="signal-hint">Tap any evidence card below to open the historical chart for that metric.</div>
      </div>
      <div class="section-copy">
        <h2>Why this signal?</h2>
        <p class="muted">These four cards explain the main forces that shape the read above: price, money flow, sentiment, and supply pressure.</p>
      </div>
      <div class="grid signal-grid">${cards}</div>
    </section>
  `;
}

function buildInsightSummary(latest, comparisons, signal) {
  if (!latest || !signal) return null;
  const comparisonMap = new Map(comparisons.map((comparison) => [comparison.field, comparison]));
  const priceComparison = comparisonMap.get('price_num');
  const flow7Value = applyScale(latest.net_flow_7_days_num, 1 / TAO_PER_RAO);
  const sentimentValue = resolveSentimentValue(latest);
  const sentimentSource = resolveSentimentSource(latest);
  const emissionRate = numericMetricValue(latest.emission_percent_num);
  const burnRate = numericMetricValue(latest.incentive_burn_num);
  const pricePct = priceComparison && Number.isFinite(priceComparison.pct) ? priceComparison.pct : null;
  const priceFlowAligned = Number.isFinite(pricePct) && Number.isFinite(flow7Value)
    ? ((pricePct >= 0 && flow7Value >= 0) || (pricePct < 0 && flow7Value < 0))
    : null;

  const takeaways = [
    {
      label: 'Price + flow',
      value: priceFlowAligned === null
        ? 'Not enough history'
        : priceFlowAligned
          ? 'Aligned'
          : 'Diverging',
      subtext: Number.isFinite(pricePct) && Number.isFinite(flow7Value)
        ? `Price is ${signedPercent(pricePct, 2)} and 7d money flow is ${flow7Value >= 0 ? 'inflow' : 'outflow'}.`
        : 'Compare price change with 7d money flow to see whether buyers are backing the move.',
      tone: priceFlowAligned === null
        ? 'neutral'
        : priceFlowAligned
          ? (pricePct >= 0 && flow7Value >= 0 ? 'positive' : 'negative')
          : 'negative',
    },
    {
      label: 'Sentiment',
      value: Number.isFinite(sentimentValue)
        ? `${sentimentSource ? `${sentimentSource} ` : ''}${Number(sentimentValue).toFixed(1)}`
        : 'Unavailable',
      subtext: Number.isFinite(sentimentValue)
        ? (sentimentValue >= 60
          ? 'Traders look more optimistic than cautious.'
          : sentimentValue <= 40
            ? 'Traders look more cautious than optimistic.'
            : 'Traders are in a mixed / balanced mood.')
        : 'Sentiment helps show whether the crowd is getting more confident.',
      tone: Number.isFinite(sentimentValue)
        ? (sentimentValue >= 60 ? 'positive' : sentimentValue <= 40 ? 'negative' : 'neutral')
        : 'neutral',
    },
    {
      label: 'Supply pressure',
      value: Number.isFinite(emissionRate)
        ? `${percent(emissionRate, 3)} emitted`
        : 'Unavailable',
      subtext: Number.isFinite(emissionRate)
        ? (Number.isFinite(burnRate)
          ? `Burn rate: ${percent(burnRate, 2)}`
          : 'Lower emission usually means gentler supply pressure.')
        : 'Emission tells you how much new supply is entering the subnet.',
      tone: Number.isFinite(emissionRate)
        ? (emissionRate <= 0.75 ? 'positive' : emissionRate >= 1.25 ? 'negative' : 'neutral')
        : 'neutral',
    },
  ];

  const bullets = [];
  if (priceFlowAligned !== null) {
    bullets.push(priceFlowAligned
      ? 'Price and money flow are moving together, which usually makes the move easier to trust.'
      : 'Price and money flow are not aligned yet, so this move may need confirmation.');
  }
  if (Number.isFinite(sentimentValue)) {
    bullets.push(sentimentValue >= 60
      ? 'Sentiment is leaning optimistic, which can help keep buyers engaged.'
      : sentimentValue <= 40
        ? 'Sentiment is leaning cautious, which can keep pressure on price.'
        : 'Sentiment is balanced, so the chart needs other signals for confirmation.');
  }
  if (Number.isFinite(emissionRate)) {
    bullets.push(emissionRate <= 0.75
      ? 'Supply pressure looks light.'
      : emissionRate >= 1.25
        ? 'Supply pressure looks heavy.'
        : 'Supply pressure is in the middle.');
  }

  return {
    headline: 'What matters most today',
    summary: signal.tone === 'positive'
      ? 'The current read looks constructive, so price and flow are the first pair worth watching.'
      : signal.tone === 'negative'
        ? 'The current read looks cautious, so the main question is whether flow and sentiment can improve.'
        : 'The signals are mixed, so the safest read comes from comparing price, flow, sentiment, and supply together.',
    badge: '3 quick takeaways',
    bullets,
    cards: takeaways,
  };
}

function buildWatchlistSummary(latest, comparisons, signal) {
  if (!latest || !signal) return null;
  const comparisonMap = new Map(comparisons.map((comparison) => [comparison.field, comparison]));
  const priceComparison = comparisonMap.get('price_num');
  const flow7Value = applyScale(latest.net_flow_7_days_num, 1 / TAO_PER_RAO);
  const sentimentValue = resolveSentimentValue(latest);
  const sentimentSource = resolveSentimentSource(latest);
  const emissionRate = numericMetricValue(latest.emission_percent_num);
  const burnRate = numericMetricValue(latest.incentive_burn_num);
  const pricePct = priceComparison && Number.isFinite(priceComparison.pct) ? priceComparison.pct : null;
  const priceFlowAligned = Number.isFinite(pricePct) && Number.isFinite(flow7Value)
    ? ((pricePct >= 0 && flow7Value >= 0) || (pricePct < 0 && flow7Value < 0))
    : null;

  const items = [
    {
      label: 'Price vs flow',
      value: priceFlowAligned === null ? '—' : (priceFlowAligned ? 'Aligned' : 'Diverging'),
      subtext: priceFlowAligned === null
        ? 'We need both price and weekly money flow to compare the move.'
        : (priceFlowAligned
          ? 'Price and weekly money flow point in the same direction.'
          : 'Price and weekly money flow disagree, so the move may need confirmation.'),
      tone: priceFlowAligned === null ? 'neutral' : (priceFlowAligned ? 'positive' : 'negative'),
    },
    {
      label: 'Sentiment watch',
      value: Number.isFinite(sentimentValue)
        ? `${sentimentSource ? `${sentimentSource} ` : ''}${Number(sentimentValue).toFixed(1)}`
        : '—',
      subtext: Number.isFinite(sentimentValue)
        ? (sentimentValue >= 60
          ? 'Traders look optimistic; that can help keep buyers engaged.'
          : sentimentValue <= 40
            ? 'Traders look cautious; that can keep pressure on price.'
            : 'Traders are in a mixed mood; other signals matter more here.')
        : 'No sentiment sample is available yet, so this watch item will light up once one appears.',
      tone: Number.isFinite(sentimentValue)
        ? (sentimentValue >= 60 ? 'positive' : sentimentValue <= 40 ? 'negative' : 'neutral')
        : 'neutral',
    },
    {
      label: 'Supply watch',
      value: Number.isFinite(emissionRate) ? `${percent(emissionRate, 3)} emitted` : '—',
      subtext: Number.isFinite(emissionRate)
        ? (Number.isFinite(burnRate)
          ? `Burn rate: ${percent(burnRate, 2)}`
          : 'Supply pressure stays a bit gentler when emission is lower.')
        : 'No emission sample is available yet, so this watch item will update when supply data arrives.',
      tone: Number.isFinite(emissionRate)
        ? (emissionRate <= 0.75 ? 'positive' : emissionRate >= 1.25 ? 'negative' : 'neutral')
        : 'neutral',
    },
  ];

  const bullets = [];
  if (priceFlowAligned === false) {
    bullets.push('Price and money flow are not aligned yet, so this move needs extra confirmation.');
  } else if (priceFlowAligned === true) {
    bullets.push('Price and money flow are aligned, which makes the move easier to trust.');
  }
  if (Number.isFinite(sentimentValue) && sentimentValue <= 40) {
    bullets.push('Sentiment is cautious, so buyers may need stronger evidence.');
  }
  if (Number.isFinite(emissionRate) && emissionRate >= 1.25) {
    bullets.push('Supply pressure is elevated, which can make upside harder to sustain.');
  }

  return {
    headline: 'Watchlist',
    summary: 'These are the main things worth keeping an eye on if you want to turn the dashboard into a decision aid.',
    badge: 'Keep watching',
    bullets,
    cards: items,
  };
}

function renderInsightSection(insight) {
  if (!insight) return '';
  const bullets = insight.bullets.length
    ? insight.bullets.map((bullet) => `<li>${escapeHtml(bullet)}</li>`).join('')
    : '<li>Look for price and money flow first, then check sentiment and supply.</li>';
  const cards = insight.cards.map((card) => metricCard({
    label: card.label,
    value: card.value,
    subtext: card.subtext,
    tone: card.tone || 'neutral',
    clickable: false,
  })).join('');
  return `
    <section class="section insight-section">
      <div class="panel signal-panel ${escapeHtml(insight.tone || 'neutral')}">
        <div class="signal-panel-head">
          <div>
            <div class="eyebrow">Quick read</div>
            <h2>${escapeHtml(insight.headline || 'What matters most today')}</h2>
            <p>${escapeHtml(insight.summary || '')}</p>
          </div>
          <div class="signal-badge">${escapeHtml(insight.badge || '3 quick takeaways')}</div>
        </div>
        <ul class="signal-bullets">${bullets}</ul>
      </div>
      <div class="grid compact">${cards}</div>
    </section>
  `;
}

function renderWatchlistSection(watchlist) {
  if (!watchlist) return '';
  const bullets = watchlist.bullets.length
    ? watchlist.bullets.map((bullet) => `<li>${escapeHtml(bullet)}</li>`).join('')
    : '<li>No urgent watch items yet. The signals are relatively balanced.</li>';
  const cards = watchlist.cards.map((card) => metricCard({
    label: card.label,
    value: card.value,
    subtext: card.subtext,
    tone: card.tone || 'neutral',
    clickable: false,
  })).join('');
  return `
    <section class="section watchlist-section">
      <div class="section-copy">
        <h2>${escapeHtml(watchlist.headline || 'Watchlist')}</h2>
        <p class="muted">${escapeHtml(watchlist.summary || '')}</p>
      </div>
      <div class="signal-badge">${escapeHtml(watchlist.badge || 'Keep watching')}</div>
      <div class="grid compact">${cards}</div>
      <ul class="signal-bullets" style="margin-top: 14px;">${bullets}</ul>
    </section>
  `;
}

function shortAddress(address) {
  const text = String(address || '').trim();
  if (text.length <= 14) return text || '—';
  return `${text.slice(0, 6)}…${text.slice(-6)}`;
}

function normalizeHotkeyRole(role) {
  const text = String(role || '').trim().toLowerCase();
  if (!text) return null;
  if (['validator', 'owner', 'shared', 'other', 'unclassified', 'unknown'].includes(text)) {
    return text === 'unknown' ? 'unclassified' : text;
  }
  return text;
}

function labelHotkeyRole(role) {
  switch (normalizeHotkeyRole(role)) {
    case 'validator':
      return 'Validator';
    case 'owner':
      return 'Owner';
    case 'shared':
      return 'Shared';
    case 'other':
      return 'Other';
    case 'unclassified':
      return 'Unclassified';
    default:
      return '—';
  }
}

function summarizeHotkeyRoles(hotkeys = []) {
  const counts = new Map();
  for (const hotkey of Array.isArray(hotkeys) ? hotkeys : []) {
    const role = normalizeHotkeyRole(hotkey?.role) || 'unclassified';
    counts.set(role, (counts.get(role) || 0) + 1);
  }

  const hasRecognizedRole = ['validator', 'owner', 'shared', 'other'].some((role) => (counts.get(role) || 0) > 0);
  if (!hasRecognizedRole) {
    const total = Array.isArray(hotkeys) ? hotkeys.length : 0;
    return total > 0 ? `${total} hotkeys configured` : 'No hotkeys configured';
  }

  const parts = [];
  const order = ['validator', 'owner', 'shared', 'other', 'unclassified'];
  for (const role of order) {
    const count = counts.get(role) || 0;
    if (!count) continue;
    parts.push(`${count} ${labelHotkeyRole(role).toLowerCase()}${count === 1 ? '' : 's'}`);
  }

  return parts.length ? parts.join(', ') : 'No hotkeys configured';
}

function inferHotkeyRoleFromMetadata(hotkey = null, configuredHotkeyMap = new Map()) {
  if (!hotkey) return null;
  const ss58 = hotkey.hotkey_address_ss58 ? String(hotkey.hotkey_address_ss58) : '';
  if (ss58 && configuredHotkeyMap.has(ss58)) {
    return normalizeHotkeyRole(configuredHotkeyMap.get(ss58)?.role);
  }
  const name = hotkey.hotkey_name ? String(hotkey.hotkey_name).trim().toLowerCase() : '';
  if (name.includes('validator')) return 'validator';
  if (name.includes('owner')) return 'owner';
  if (name.includes('shared')) return 'shared';
  return null;
}

function buildWalletAttributionSummary({ totalChange = null, stakePositions = [], configuredHotkeys = [] } = {}) {
  const change = Number(totalChange);
  const changeIsFinite = Number.isFinite(change);
  const hotkeyMap = new Map(
    (Array.isArray(configuredHotkeys) ? configuredHotkeys : [])
      .filter((hotkey) => hotkey && hotkey.ss58)
      .map((hotkey) => [String(hotkey.ss58), hotkey]),
  );
  const roleBalances = new Map();
  let knownWeight = 0;
  let totalWeight = 0;
  let hasRoleMetadata = false;

  for (const position of Array.isArray(stakePositions) ? stakePositions : []) {
    const balance = Number(position?.balance_as_tao_num ?? position?.balance_num ?? 0);
    if (!Number.isFinite(balance) || balance <= 0) continue;
    totalWeight += balance;
    const role = inferHotkeyRoleFromMetadata(position, hotkeyMap) || 'unclassified';
    if (role !== 'unclassified') hasRoleMetadata = true;
    roleBalances.set(role, (roleBalances.get(role) || 0) + balance);
    if (role !== 'unclassified') {
      knownWeight += balance;
    }
  }

  const prioritizedRoles = ['validator', 'owner', 'shared', 'other'];
  const estimated = new Map();
  let assigned = 0;

  if (changeIsFinite && change !== 0 && knownWeight > 0 && totalWeight > 0) {
    const coverage = knownWeight / totalWeight;
    for (const role of prioritizedRoles) {
      const weight = roleBalances.get(role) || 0;
      if (!weight) continue;
      const portion = (change * coverage * weight) / knownWeight;
      estimated.set(role, portion);
      assigned += portion;
    }
  }

  const residual = changeIsFinite ? change - assigned : null;
  const recognizedCoveragePct = totalWeight > 0 ? (knownWeight / totalWeight) * 100 : null;
  const hasAnySplit = hasRoleMetadata && estimated.size > 0;

  return {
    hasRoleMetadata,
    hasAnySplit,
    totalChange: changeIsFinite ? change : null,
    validator: estimated.get('validator') ?? null,
    owner: estimated.get('owner') ?? null,
    shared: estimated.get('shared') ?? null,
    other: estimated.get('other') ?? null,
    residual,
    recognizedCoveragePct,
    roleBalances,
  };
}

function parseJsonPayload(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object') return value;
  if (typeof value !== 'string') return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function walletTransactionTimestamp(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'string' && value.includes('T')) return value;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  const ms = parsed > 1e12 ? parsed : parsed * 1000;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function walletTransactionAmountTao(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  return num / TAO_PER_RAO;
}

function readTransactionAmount(payload = {}) {
  const candidates = [
    payload.amount,
    payload.amount_rao,
    payload.amountRao,
    payload.amount_staked,
    payload.amountStaked,
    payload.value,
    payload.balance,
  ];
  for (const candidate of candidates) {
    const num = Number(candidate);
    if (Number.isFinite(num)) return num;
  }
  return null;
}

function normalizeWalletTxAction(fullName) {
  const name = String(fullName || '').trim();
  const lower = name.toLowerCase();
  if (lower.includes('add_stake')) return { action: 'Stake add', actionKey: 'stake_add', group: 'stake' };
  if (lower.includes('remove_stake') || lower.includes('unstake')) return { action: 'Unstake', actionKey: 'unstake', group: 'stake' };
  if (lower.includes('move_stake')) return { action: 'Stake move', actionKey: 'stake_move', group: 'stake' };
  if (lower.includes('swap_stake')) return { action: 'Stake swap', actionKey: 'stake_swap', group: 'stake' };
  if (lower.includes('transfer_stake')) return { action: 'Stake transfer', actionKey: 'stake_transfer', group: 'stake' };
  if (lower.includes('transfer')) return { action: 'Transfer', actionKey: 'transfer', group: 'transfer' };
  if (lower.includes('register')) return { action: 'Register', actionKey: 'register', group: 'other' };
  return {
    action: name || 'Extrinsic',
    actionKey: lower.replace(/[^a-z0-9]+/g, '_') || 'extrinsic',
    group: 'other',
  };
}

function extractWalletTransactionAddresses(payload = {}) {
  const from = payload.from && typeof payload.from === 'object' ? payload.from.ss58 ?? payload.from.hex ?? null : payload.from ?? null;
  const to = payload.to && typeof payload.to === 'object' ? payload.to.ss58 ?? payload.to.hex ?? null : payload.to ?? null;
  return { from, to };
}

function mergeWalletHotkeyTargets(walletConfig = null, stakePositions = []) {
  const hotkeyMap = new Map();
  const configuredHotkeys = Array.isArray(walletConfig?.hotkeys) ? walletConfig.hotkeys : [];
  for (const hotkey of configuredHotkeys) {
    if (!hotkey || !hotkey.ss58) continue;
    hotkeyMap.set(String(hotkey.ss58), {
      ss58: String(hotkey.ss58),
      name: hotkey.name || String(hotkey.ss58),
      netuid: hotkey.netuid ?? null,
      role: normalizeHotkeyRole(hotkey.role),
      network: hotkey.network || walletConfig?.network || 'finney',
      source: 'configured',
    });
  }
  for (const position of Array.isArray(stakePositions) ? stakePositions : []) {
    const ss58 = position?.hotkey_address_ss58 ? String(position.hotkey_address_ss58) : '';
    if (!ss58 || hotkeyMap.has(ss58)) continue;
    hotkeyMap.set(ss58, {
      ss58,
      name: position.hotkey_name || shortAddress(ss58),
      netuid: position.netuid ?? null,
      role: null,
      network: walletConfig?.network || 'finney',
      source: 'stake',
    });
  }
  return [...hotkeyMap.values()];
}

async function buildWalletTransactionTimeline({
  address,
  walletConfig = null,
  stakePositions = [],
  taostatsBaseUrl,
  taostatsAuthHeader,
  rateLimiter = null,
  days = 30,
  limit = 200,
}) {
  const network = walletConfig?.network || 'finney';
  const result = {
    available: false,
    partial: false,
    reason: null,
    warning: null,
    days,
    address,
    walletName: walletConfig?.name || null,
    network,
    rows: [],
    summary: {
      total: 0,
      extrinsics: 0,
      transfers: 0,
      stakeSnapshots: 0,
      stakeDelta: 0,
      hotkeysTracked: 0,
    },
    hotkeys: [],
  };

  if (!taostatsAuthHeader) {
    result.reason = 'Taostats API access is required to load wallet transactions.';
    return result;
  }

  const hotkeys = mergeWalletHotkeyTargets(walletConfig, stakePositions);
  result.hotkeys = hotkeys;
  result.summary.hotkeysTracked = hotkeys.length;

  const fetchOptions = {
    taostatsBaseUrl,
    taostatsAuthHeader,
    rateLimiter,
    days,
    limit,
  };

  const [extrinsicsRaw, transfersRaw] = await Promise.all([
    fetchExtrinsicsHistory({
      signerAddress: address,
      ...fetchOptions,
    }).catch((error) => {
      result.partial = true;
      result.reason = result.reason || `Extrinsics unavailable: ${error.message}`;
      return [];
    }),
    fetchTransferHistory({
      address,
      network,
      ...fetchOptions,
    }).catch((error) => {
      result.partial = true;
      result.reason = result.reason || `Transfers unavailable: ${error.message}`;
      return [];
    }),
  ]);

  const rows = [];
  const hotkeyLookup = new Map(hotkeys.map((hotkey) => [String(hotkey.ss58), hotkey]));
  const stakeSnapshotsRaw = [];

  for (const hotkey of hotkeys) {
    try {
      const rowsForHotkey = await fetchHistoricalStakeBalance({
        coldkey: address,
        hotkey: hotkey.ss58,
        netuid: hotkey.netuid ?? null,
        ...fetchOptions,
      });
      stakeSnapshotsRaw.push({ hotkey, rows: rowsForHotkey });
    } catch (error) {
      result.partial = true;
      if (Number(error?.status) === 429) {
        result.warning = result.warning || 'Stake history is temporarily rate-limited by Taostats; showing extrinsics and transfers only.';
      } else {
        result.reason = result.reason || `Stake history unavailable: ${error.message}`;
      }
      stakeSnapshotsRaw.push({ hotkey, rows: [] });
    }
  }

  for (const raw of extrinsicsRaw) {
    const payload = parseJsonPayload(raw) || {};
    const fullName = String(payload.full_name || payload.fullName || payload.name || '').trim();
    const actionInfo = normalizeWalletTxAction(fullName);
    const callArgs = parseJsonPayload(payload.call_args || payload.args || payload.parameters || {});
    const hotkeyAddress = callArgs?.hotkey?.ss58
      || callArgs?.hotkey_address_ss58
      || callArgs?.hotkey
      || payload.hotkey_address_ss58
      || payload.hotkey
      || null;
    const hotkey = hotkeyAddress ? hotkeyLookup.get(String(hotkeyAddress)) || null : null;
    const amountRao = readTransactionAmount(callArgs || payload);
    rows.push({
      source_type: 'extrinsic',
      timestamp: walletTransactionTimestamp(payload.timestamp ?? payload.created_at ?? payload.last_updated ?? payload.updated_at),
      block_number: Number.isFinite(Number(payload.block_number)) ? Number(payload.block_number) : null,
      extrinsic_id: payload.id ?? payload.extrinsic_id ?? null,
      transaction_hash: payload.hash ?? payload.transaction_hash ?? null,
      coldkey_ss58: address,
      hotkey_ss58: hotkeyAddress ? String(hotkeyAddress) : null,
      hotkey_name: hotkey ? hotkey.name : (payload.hotkey_name ?? null),
      netuid: Number.isFinite(Number(callArgs?.netuid ?? payload.netuid)) ? Number(callArgs?.netuid ?? payload.netuid) : null,
      action: actionInfo.action,
      action_key: actionInfo.actionKey,
      amount_tao: amountRao === null ? null : walletTransactionAmountTao(amountRao),
      amount_alpha: null,
      from_ss58: address,
      to_ss58: hotkeyAddress ? String(hotkeyAddress) : null,
      status: payload.success === false ? 'failed' : (payload.success === true ? 'success' : 'unknown'),
      note: payload.error ? String(payload.error) : (actionInfo.group === 'stake' ? 'Stake-related extrinsic' : null),
      raw: payload,
    });
  }

  for (const raw of transfersRaw) {
    const payload = parseJsonPayload(raw) || {};
    const { from, to } = extractWalletTransactionAddresses(payload);
    const amountRao = readTransactionAmount(payload);
    rows.push({
      source_type: 'transfer',
      timestamp: walletTransactionTimestamp(payload.timestamp ?? payload.created_at ?? payload.last_updated ?? payload.updated_at),
      block_number: Number.isFinite(Number(payload.block_number)) ? Number(payload.block_number) : null,
      extrinsic_id: payload.extrinsic_id ?? null,
      transaction_hash: payload.transaction_hash ?? payload.hash ?? null,
      coldkey_ss58: address,
      hotkey_ss58: null,
      hotkey_name: null,
      netuid: null,
      action: 'Transfer',
      action_key: 'transfer',
      amount_tao: amountRao === null ? null : walletTransactionAmountTao(amountRao),
      amount_alpha: null,
      from_ss58: from ? String(from) : null,
      to_ss58: to ? String(to) : null,
      status: 'unknown',
      note: 'Coldkey transfer',
      raw: payload,
    });
  }

  for (const bundle of stakeSnapshotsRaw) {
    const hotkey = bundle.hotkey;
    const history = Array.isArray(bundle.rows) ? bundle.rows : [];
    let previous = null;
    for (const row of history) {
      const balance = Number(row.balance_as_tao_num ?? row.balance_num ?? row.balance_as_tao ?? row.balance ?? null);
      const capturedAt = row.captured_at || row.timestamp || row.remote_timestamp || null;
      if (previous !== null && Number.isFinite(balance)) {
        const delta = balance - previous;
        if (delta !== 0) {
          rows.push({
            source_type: 'stake_history',
            timestamp: walletTransactionTimestamp(capturedAt),
            block_number: null,
            extrinsic_id: null,
            transaction_hash: null,
            coldkey_ss58: address,
            hotkey_ss58: hotkey.ss58,
            hotkey_name: hotkey.name,
            netuid: hotkey.netuid ?? Number(row.netuid ?? null),
            action: delta > 0 ? 'Stake increase' : 'Stake decrease',
            action_key: 'stake_delta',
            amount_tao: delta,
            amount_alpha: null,
            from_ss58: null,
            to_ss58: null,
            status: 'unknown',
            note: `Derived from stake snapshot delta for ${hotkey.name || shortAddress(hotkey.ss58)}`,
            raw: row,
          });
        }
      }
      previous = Number.isFinite(balance) ? balance : previous;
      result.summary.stakeSnapshots += 1;
    }
  }

  rows.sort((a, b) => new Date(b.timestamp || 0).getTime() - new Date(a.timestamp || 0).getTime());
  result.rows = rows;
  result.summary.total = rows.length;
  result.summary.extrinsics = rows.filter((row) => row.source_type === 'extrinsic').length;
  result.summary.transfers = rows.filter((row) => row.source_type === 'transfer').length;
  result.summary.stakeDelta = rows.filter((row) => row.source_type === 'stake_history').length;
  result.available = rows.length > 0;
  if (!result.reason && !rows.length && result.warning) {
    result.reason = result.warning;
  }
  if (!result.reason && !rows.length) {
    result.reason = 'No wallet transactions were found for the selected period.';
  }
  return result;
}

function renderWalletSection(walletEntries, latestSubnet = null, walletActivityStatus = null) {
  if (!Array.isArray(walletEntries) || !walletEntries.length) return '';
  const poolEstimator = buildPoolGrowthEstimatorState(latestSubnet);
  const cards = walletEntries.map(({ wallet, latest, stakePositions = [], hotkeys = [] }) => {
    const total = latest ? numericMetricValue(latest.balance_total_num) : null;
    const free = latest ? numericMetricValue(latest.balance_free_num) : null;
    const staked = latest ? numericMetricValue(latest.balance_staked_num) : null;
    const root = latest ? numericMetricValue(latest.balance_staked_root_num) : null;
    const alpha = latest ? numericMetricValue(latest.balance_staked_alpha_as_tao_num) : null;
    const change24h = latest ? numericMetricValue(latest.balance_total_change_24hr_num) : null;
    const positions = Array.isArray(stakePositions) ? stakePositions : [];
    const configuredHotkeys = Array.isArray(hotkeys) ? hotkeys : [];
    const hotkeySummary = summarizeHotkeyRoles(configuredHotkeys);
    const walletProfile = latest ? {
      rank: latest.rank ?? null,
      createdOnDate: latest.created_on_date ?? null,
      createdOnNetwork: latest.created_on_network ?? wallet.network ?? 'finney',
      coldkeySwap: latest.coldkey_swap ?? null,
      rawJson: latest.raw_json ?? null,
      hotkeyCount: configuredHotkeys.length,
      hotkeySummary,
    } : null;
    const metricData = {
      kind: 'wallet',
      key: `wallet:${wallet.ss58}`,
      label: wallet.name,
      description: `Wallet balance for ${wallet.name}. Taostats account history shows the balance trend, and the wallet breakdown shows free, staked, root, alpha, and current subnet stake positions.`,
      valueField: 'balance_total_num',
      historyField: 'balance_total_num',
      valueFormat: 'tao',
      currencyMode: 'tao',
      historySource: 'wallet',
      historyId: wallet.ss58,
      chartLabel: `${wallet.name} balance`,
      chartColor: wallet.color || '#00dbbc',
      clickable: true,
      taoValue: total,
      latestTaoPriceUsd: latest ? (latest.tao_price_usd ?? null) : null,
      rawValue: wallet.ss58,
      sourceText: wallet.ss58,
      badge: hotkeySummary,
      walletProfile,
      poolEstimator,
      walletBreakdown: latest ? {
        total: latest.balance_total_num ?? null,
        free: latest.balance_free_num ?? null,
        staked: latest.balance_staked_num ?? null,
        root: latest.balance_staked_root_num ?? null,
        alpha: latest.balance_staked_alpha_as_tao_num ?? null,
        change24h: latest.balance_total_change_24hr_num ?? null,
        free24h: latest.balance_free_change_24hr_num ?? null,
        staked24h: latest.balance_staked_change_24hr_num ?? null,
        root24h: latest.balance_staked_root_change_24hr_num ?? null,
        alpha24h: latest.balance_staked_alpha_as_tao_change_24hr_num ?? null,
      } : null,
      stakeCount: positions.length,
      configuredHotkeys,
      stakePositions: positions.slice(0, 20).map((position) => ({
        netuid: position.netuid ?? null,
        hotkey_name: position.hotkey_name ?? null,
        hotkey_address_ss58: position.hotkey_address_ss58 ?? null,
        balance_as_tao_num: position.balance_as_tao_num ?? null,
        balance_num: position.balance_num ?? null,
        subnet_rank: position.subnet_rank ?? null,
      })),
    };
    const value = total === null ? '—' : tao(total, 2);
    const positionsLabel = positions.length ? ` • Stakes ${positions.length} subnet${positions.length === 1 ? '' : 's'}` : '';
    const subtext = latest
      ? `${shortAddress(wallet.ss58)} • ${wallet.network || 'finney'} • 24h ${change24h === null ? '—' : signedTao(change24h, 2)} • Free ${free === null ? '—' : tao(free, 2)} • Staked ${staked === null ? '—' : tao(staked, 2)}${positionsLabel} • ${Number.isFinite(Number(walletProfile?.rank)) ? ('Rank ' + compact(walletProfile.rank, 0)) : 'Rank —'} • ${walletProfile?.createdOnDate || 'Created date unknown'}`
      : `${shortAddress(wallet.ss58)} • ${wallet.network || 'finney'} • waiting for first wallet snapshot`;
    const extra = latest
      ? `Root ${root === null ? '—' : tao(root, 2)} • Alpha ${alpha === null ? '—' : tao(alpha, 2)}`
      : 'History will appear after the first ingest or backfill.';
    return metricCard({
      label: wallet.name,
      value,
      subtext: `${subtext} • ${extra}`,
      tone: change24h === null ? 'neutral' : (change24h >= 0 ? 'positive' : 'negative'),
      clickable: true,
      metricData,
    });
  }).join('');
  const activityText = formatWalletActivityStatusText(walletActivityStatus);
  const activityLine = activityText
    ? `<p class="muted wallet-activity-status">${escapeHtml(activityText)}</p>`
    : '';

  return `
    <section class="section wallet-section">
      <div class="section-copy">
        <h2>Wallet balances</h2>
        <p class="muted">Configured ss58 addresses from the .env file. Click a wallet card to inspect its historical balance chart.</p>
        ${activityLine}
      </div>
      <div class="grid compact">${cards}</div>
    </section>
  `;
}

function formatWalletActivityStatusText(walletActivityStatus = null) {
  if (!walletActivityStatus) return '';
  const parts = [];
  if (Number.isFinite(Number(walletActivityStatus.transactionCount))) {
    parts.push(`${compact(walletActivityStatus.transactionCount, 0)} wallet activity rows cached`);
  }
  if (walletActivityStatus.lastRunAtIso) {
    parts.push(`last synced ${formatRelativeIso(walletActivityStatus.lastRunAtIso)}`);
  } else {
    parts.push('last synced never');
  }
  if (walletActivityStatus.nextSyncAtIso) {
    parts.push(`next sync ${formatRelativeIso(walletActivityStatus.nextSyncAtIso)}`);
  } else if (Number.isFinite(Number(walletActivityStatus.syncIntervalMinutes))) {
    parts.push(`syncs every ${formatPollInterval(walletActivityStatus.syncIntervalMinutes)}`);
  }
  return parts.length ? `Wallet activity cache: ${parts.join(' • ')}` : '';
}

function renderWalletActivityStatusBadge(walletActivityStatus = null, { id = 'wallet-activity-badge' } = {}) {
  const text = formatWalletActivityStatusText(walletActivityStatus);
  if (!text) return '';
  const hasRows = Number.isFinite(Number(walletActivityStatus?.transactionCount)) && Number(walletActivityStatus.transactionCount) > 0;
  const tone = walletActivityStatus?.lastRunAtIso
    ? (hasRows ? 'positive' : 'accent')
    : 'neutral';
  const label = walletActivityStatus?.lastRunAtIso
    ? (hasRows ? 'Wallet activity cached' : 'Wallet activity synced')
    : 'Wallet activity idle';
  return `<span class="wallet-activity-badge status-badge status-badge-${tone}" id="${escapeHtml(id)}" title="${escapeHtml(text)}">${escapeHtml(label)}</span>`;
}

function formatSchedulerRunSummary(run = null) {
  if (!run) {
    return {
      tone: 'neutral',
      label: 'Never run',
      text: 'No recorded run yet.',
      error: null,
    };
  }
  const ok = run.ok !== false && !run.error;
  const tone = ok ? 'positive' : 'negative';
  const label = ok ? 'OK' : 'Failed';
  const parts = [];
  if (run.started_at) {
    parts.push(formatRelativeIso(run.started_at));
  }
  if (run.source) {
    parts.push(run.source);
  }
  if (run.fallback_used) {
    parts.push('fallback used');
  }
  if (run.duration_ms !== null && run.duration_ms !== undefined) {
    parts.push(`${compact(run.duration_ms, 0)} ms`);
  }
  return {
    tone,
    label,
    text: parts.length ? parts.join(' • ') : 'Run recorded.',
    error: run.error || null,
  };
}

function renderScheduleStatusBadge(schedule = null, { id = 'schedule-status-badge' } = {}) {
  if (!schedule) return '';
  const summary = formatSchedulerRunSummary(schedule.lastRun || null);
  let tone = summary.tone;
  let label = summary.label;
  if (schedule.paused) {
    tone = 'accent';
    label = 'Paused';
  } else if (schedule.enabled === false) {
    tone = 'neutral';
    label = 'Disabled';
  } else if (!schedule.lastRun) {
    tone = 'neutral';
    label = 'Never run';
  }
  return `<span class="status-badge status-badge-${tone}" id="${escapeHtml(id)}" title="${escapeHtml(schedule.title || schedule.label || 'Schedule status')}">${escapeHtml(label)}</span>`;
}

function buildScheduleQueuePreview(schedules = [], {
  ingestActive = false,
  activeIngestJob = null,
  alphaHolderBackfillActive = false,
  alphaHolderBackfillStartedAtIso = null,
} = {}) {
  const queue = [];
  const activeJob = ingestActive && activeIngestJob && typeof activeIngestJob === 'object' ? activeIngestJob : null;
  if (activeJob) {
    queue.push({
      key: 'active-ingest',
      type: 'active',
      title: activeJob.label || activeJob.kind || 'Ingest job',
      label: activeJob.label || activeJob.kind || 'Ingest job',
      statusLabel: 'Running',
      tone: 'accent',
      nextRunIso: activeJob.startedAtIso || null,
      detail: `${formatRelativeIso(activeJob.startedAtIso)}${Number.isFinite(Number(activeJob.elapsedMs)) ? ` • running for ${formatDuration(Number(activeJob.elapsedMs))}` : ''}`,
    });
  }

  const upcoming = (Array.isArray(schedules) ? schedules : [])
    .filter((schedule) => schedule && schedule.enabled !== false && schedule.nextRunIso)
    .map((schedule) => ({
      key: `schedule-${schedule.key || schedule.label || 'schedule'}`,
      type: 'schedule',
      title: schedule.title || schedule.label || 'Schedule',
      label: schedule.label || schedule.title || 'Schedule',
      statusLabel: schedule.paused ? 'Paused' : 'Queued',
      tone: schedule.paused ? 'accent' : 'neutral',
      nextRunIso: schedule.nextRunIso,
      detail: schedule.paused
        ? `Waiting for alpha-holder backfill to finish${alphaHolderBackfillStartedAtIso ? ` • started ${formatRelativeIso(alphaHolderBackfillStartedAtIso)}` : ''}`
        : `Due ${formatPollTime(schedule.nextRunIso)}`,
      note: schedule.description || null,
    }))
    .sort((left, right) => new Date(left.nextRunIso).getTime() - new Date(right.nextRunIso).getTime());

  queue.push(...upcoming);
  return queue.slice(0, 4);
}

function renderScheduleQueuePreview(queue = [], { paused = false, backfillStartedAtIso = null } = {}) {
  const rows = Array.isArray(queue) ? queue : [];
  const pausedNotice = paused
    ? `<p class="empty schedule-paused-note">Queued work is paused while alpha-holder backfill is running${backfillStartedAtIso ? ` • started ${escapeHtml(formatRelativeIso(backfillStartedAtIso))}` : ''}.</p>`
    : '';
  const itemsHtml = rows.length
    ? rows.map((item, index) => {
        const title = item.label || item.title || 'Schedule';
        const detail = item.detail || item.note || '—';
        return `
          <li class="schedule-queue-item schedule-queue-item-${escapeHtml(item.type || 'schedule')}">
            <div class="schedule-queue-item-head">
              <div>
                <div class="schedule-queue-item-kicker">${index === 0 ? 'Next up' : 'After that'}</div>
                <div class="schedule-queue-item-title">${escapeHtml(title)}</div>
              </div>
              <span class="status-badge status-badge-${escapeHtml(item.tone || 'neutral')}">${escapeHtml(item.statusLabel || 'Queued')}</span>
            </div>
            <div class="schedule-queue-item-meta">${escapeHtml(detail)}</div>
          </li>
        `;
      }).join('')
    : '<li class="schedule-queue-empty">No queued jobs at the moment.</li>';

  return `
    ${pausedNotice}
    <div class="schedule-queue">
      <div class="schedule-queue-head">
        <div>
          <div class="eyebrow">Expected next</div>
          <h3>Queue</h3>
        </div>
        <div class="schedule-queue-hint">Running job first, then the next scheduled work in order.</div>
      </div>
      <ol class="schedule-queue-list">${itemsHtml}</ol>
    </div>
  `;
}

function renderScheduleStatusTable(schedules = [], { paused = false, backfillStartedAtIso = null } = {}) {
  const rows = Array.isArray(schedules) ? schedules : [];
  const pausedNotice = paused
    ? `<p class="empty schedule-paused-note">Background polling is paused while alpha-holder backfill is running${backfillStartedAtIso ? ` • started ${escapeHtml(formatRelativeIso(backfillStartedAtIso))}` : ''}.</p>`
    : '';
  const rowsHtml = rows.length
    ? rows.map((schedule, index) => {
        const summary = formatSchedulerRunSummary(schedule.lastRun || null);
        const nextRunText = schedule.nextRunIso ? formatPollTime(schedule.nextRunIso) : '—';
        const nextRunTitle = schedule.nextRunIso ? `Scheduled for ${formatIso(schedule.nextRunIso)}` : 'No next run scheduled';
        const cadenceText = schedule.cadenceText || '—';
        const scheduleBadge = renderScheduleStatusBadge(schedule, { id: `schedule-status-badge-${index}` });
        const errorText = summary.error ? summary.error : (schedule.lastRun?.message || '—');
        return `
          <tr class="${schedule.paused ? 'current' : ''}">
            <td>
              <div class="schedule-row-title">${escapeHtml(schedule.label || 'Schedule')}</div>
              <div class="schedule-row-subtext">${escapeHtml(schedule.description || '')}</div>
            </td>
            <td>${escapeHtml(cadenceText)}</td>
            <td title="${escapeHtml(nextRunTitle)}">${escapeHtml(nextRunText)}</td>
            <td>
              <div class="schedule-run-summary">${escapeHtml(summary.text)}</div>
            </td>
            <td>${scheduleBadge}</td>
            <td class="${summary.error ? 'negative' : 'neutral'}">${escapeHtml(errorText)}</td>
          </tr>
        `;
      }).join('')
    : '<tr><td colspan="6" class="empty">No schedules configured.</td></tr>';
  return `
    ${pausedNotice}
    <div class="table-wrap">
      <table class="schedule-status-table">
        <thead>
          <tr>
            <th>Schedule</th>
            <th>Cadence</th>
            <th>Next run</th>
            <th>Last run</th>
            <th>Status</th>
            <th>Error / notes</th>
          </tr>
        </thead>
        <tbody>${rowsHtml}</tbody>
      </table>
    </div>
  `;
}

function renderPoolGrowthScenarioChartMarkup(series, selectedResult, maxInjected) {
  if (!series?.available || !Array.isArray(series.points) || series.points.length < 2 || !selectedResult?.available) {
  return `
      <div class="pool-estimator-scenario pool-estimator-scenario-details pool-estimator-scenario-unavailable" data-pool-scenario-chart="true" data-pool-scenario-open="false" data-pool-scenario-max-tao-injected="${escapeHtml(maxInjected)}">
        <div class="pool-estimator-scenario-summary">
          <div class="pool-estimator-scenario-summary-text">
            <div class="label">Alpha price change curve</div>
            <div class="pool-estimator-scenario-title">Scenario chart unavailable</div>
          </div>
          <button class="pool-estimator-scenario-summary-hint" type="button" onmousedown="window.togglePoolGrowthScenario(this); return false;" onkeydown="if(event.key==='Enter'||event.key===' '){window.togglePoolGrowthScenario(this); return false;}">
            Show chart
          </button>
        </div>
        <div class="pool-estimator-scenario-caption">The current snapshot does not contain enough pool data to draw the scenario curve.</div>
      </div>
    `;
  }

  const width = 500;
  const height = 170;
  const padding = { top: 14, right: 14, bottom: 28, left: 54 };
  const innerWidth = width - padding.left - padding.right;
  const innerHeight = height - padding.top - padding.bottom;
  const points = series.points;
  const values = points.map((point) => Number(point.priceChangePct)).filter((value) => Number.isFinite(value));
  const minValue = Math.min(0, ...values);
  const maxValue = Math.max(0, ...values);
  const valueSpan = Math.max(1e-6, maxValue - minValue);
  const gridValues = [minValue, minValue + (valueSpan / 2), maxValue];
  const xForIndex = (index) => padding.left + (index / (points.length - 1)) * innerWidth;
  const yForValue = (value) => padding.top + (1 - ((Number(value) - minValue) / valueSpan)) * innerHeight;
  const coords = points.map((point, index) => ({
    x: xForIndex(index),
    y: yForValue(point.priceChangePct),
    point,
    index,
  }));
  const linePath = coords.map(({ x, y }, index) => `${index === 0 ? 'M' : 'L'} ${x.toFixed(2)} ${y.toFixed(2)}`).join(' ');
  const areaPath = [
    `M ${padding.left.toFixed(2)} ${(padding.top + innerHeight).toFixed(2)}`,
    ...coords.map(({ x, y }) => `L ${x.toFixed(2)} ${y.toFixed(2)}`),
    `L ${(padding.left + innerWidth).toFixed(2)} ${(padding.top + innerHeight).toFixed(2)}`,
    'Z',
  ].join(' ');
  const xAxisLabelLeft = '0 TAO';
  const selectedInjected = Number(selectedResult.taoInjected);
  const selectedX = Number.isFinite(selectedInjected) ? padding.left + Math.max(0, Math.min(selectedInjected, maxInjected)) / maxInjected * innerWidth : padding.left;
  const selectedY = padding.top + (1 - ((Number(selectedResult.priceChangePct) - minValue) / valueSpan)) * innerHeight;

  return `
      <div class="pool-estimator-scenario pool-estimator-scenario-details" data-pool-scenario-chart="true" data-pool-scenario-open="false" data-pool-scenario-max-tao-injected="${escapeHtml(maxInjected)}" data-pool-scenario-min-change="${escapeHtml(minValue)}" data-pool-scenario-max-change="${escapeHtml(maxValue)}">
        <div class="pool-estimator-scenario-summary">
          <div class="pool-estimator-scenario-summary-text">
            <div class="label">Alpha price change curve</div>
            <div class="pool-estimator-scenario-title">Projected alpha price change vs TAO injected</div>
          </div>
          <button class="pool-estimator-scenario-summary-hint" type="button" onmousedown="window.togglePoolGrowthScenario(this); return false;" onkeydown="if(event.key==='Enter'||event.key===' '){window.togglePoolGrowthScenario(this); return false;}">Show chart</button>
        </div>
      <div class="pool-estimator-scenario-body">
        <div class="pool-estimator-scenario-meta-row">
          <div class="pool-estimator-scenario-meta" id="pool-growth-scenario-meta">
            ${escapeHtml(tao(selectedResult.taoInjected, 2))} injected → ${escapeHtml(signedPercent(selectedResult.priceChangePct, 2))} • ${escapeHtml(tao(selectedResult.projectedPrice, 6))} / α
          </div>
        </div>
        <div class="pool-estimator-scenario-plot">
          <svg class="pool-estimator-scenario-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="Alpha price change versus TAO injected scenario curve">
            <defs>
              <linearGradient id="pool-growth-scenario-fill" x1="0%" x2="0%" y1="0%" y2="100%">
                <stop offset="0%" stop-color="#00dbbc" stop-opacity="0.32"/>
                <stop offset="100%" stop-color="#00dbbc" stop-opacity="0.04"/>
              </linearGradient>
            </defs>
            ${gridValues.map((value) => {
              const y = yForValue(value);
              return `
                <line x1="${padding.left}" y1="${y.toFixed(2)}" x2="${padding.left + innerWidth}" y2="${y.toFixed(2)}" class="pool-estimator-scenario-grid-line" />
                <text x="${padding.left - 10}" y="${(y + 3).toFixed(2)}" text-anchor="end" class="pool-estimator-scenario-grid-label">${escapeHtml(signedPercent(value, 0))}</text>
              `;
            }).join('')}
            <line x1="${padding.left}" y1="${padding.top + innerHeight}" x2="${padding.left + innerWidth}" y2="${padding.top + innerHeight}" class="pool-estimator-scenario-axis-line" />
            <line x1="${padding.left}" y1="${padding.top}" x2="${padding.left}" y2="${padding.top + innerHeight}" class="pool-estimator-scenario-axis-line" />
            <path d="${areaPath}" class="pool-estimator-scenario-area"></path>
            <path d="${linePath}" class="pool-estimator-scenario-line"></path>
            <line class="pool-estimator-scenario-crosshair vertical" x1="${selectedX.toFixed(2)}" x2="${selectedX.toFixed(2)}" y1="${padding.top}" y2="${padding.top + innerHeight}" />
            <line class="pool-estimator-scenario-crosshair horizontal" x1="${padding.left}" x2="${padding.left + innerWidth}" y1="${selectedY.toFixed(2)}" y2="${selectedY.toFixed(2)}" />
            <rect class="pool-estimator-scenario-hit-area" x="${padding.left}" y="${padding.top}" width="${innerWidth}" height="${innerHeight}" />
            <text x="${padding.left}" y="${height - 16}" font-size="8" font-weight="600" class="pool-estimator-scenario-axis-label">${escapeHtml(xAxisLabelLeft)}</text>
            <text x="${padding.left + innerWidth / 2}" y="${height - 16}" text-anchor="middle" font-size="8" font-weight="600" class="pool-estimator-scenario-axis-label">TAO 1,250</text>
            <text x="${padding.left + innerWidth}" y="${height - 16}" text-anchor="end" font-size="8" font-weight="600" class="pool-estimator-scenario-axis-label">TAO 2,500</text>
          </svg>
          <div class="pool-estimator-scenario-tooltip" hidden>
            <div class="pool-estimator-scenario-tooltip-title" id="pool-growth-scenario-tooltip-title">TAO injected</div>
            <div class="pool-estimator-scenario-tooltip-value" id="pool-growth-scenario-tooltip-value"></div>
            <div class="pool-estimator-scenario-tooltip-subtext" id="pool-growth-scenario-tooltip-subtext"></div>
          </div>
        </div>
        <div class="pool-estimator-scenario-caption" id="pool-growth-scenario-caption">At ${escapeHtml(tao(selectedResult.taoInjected, 2))} injected, the projected alpha price change is ${escapeHtml(signedPercent(selectedResult.priceChangePct, 2))}.</div>
      </div>
    </div>
  `;
}

function renderPoolGrowthSection(latestSubnet = null) {
  const poolEstimator = buildPoolGrowthEstimatorState(latestSubnet);
  const rootAttrs = [
    'id="pool-growth-estimator"',
    'class="pool-growth-estimator"',
    'open',
    'data-pool-growth-root="page"',
    'data-pool-available="' + (poolEstimator.available ? 'true' : 'false') + '"',
    'data-pool-scenario-open="false"',
    'data-pool-tao-in-pool="' + escapeHtml(poolEstimator.currentPool?.taoInPool ?? '') + '"',
    'data-pool-alpha-in-pool="' + escapeHtml(poolEstimator.currentPool?.alphaInPool ?? '') + '"',
    'data-pool-current-price="' + escapeHtml(poolEstimator.currentPool?.currentPrice ?? '') + '"',
    'data-pool-market-cap="' + escapeHtml(poolEstimator.currentPool?.marketCap ?? '') + '"',
    'data-pool-scenario-max-tao-injected="' + escapeHtml(Math.max(poolEstimator.defaultTaoInjected ?? 10, ...(Array.isArray(poolEstimator.presets) ? poolEstimator.presets : [1, 10, 50]), 50)) + '"',
    'data-pool-reason="' + escapeHtml(poolEstimator.reason ?? '') + '"',
    'data-pool-default-tao-injected="' + escapeHtml(poolEstimator.defaultTaoInjected ?? 10) + '"',
    'data-pool-presets="' + escapeHtml((Array.isArray(poolEstimator.presets) ? poolEstimator.presets : [1, 10, 50]).join(',')) + '"',
  ].join(' ');

  if (!poolEstimator.available) {
    return `
      <section class="section pool-growth-section">
        <div class="section-copy">
          <h2>Pool growth estimator</h2>
          <p class="muted">Estimate only — this uses the latest subnet snapshot and simulates TAO injection locally.</p>
        </div>
        <details ${rootAttrs}>
          <summary>Pool growth estimator</summary>
          <div class="pool-growth-estimator-body">
            <p class="wallet-history-note">Estimate only — the latest subnet snapshot does not include enough pool data to simulate TAO injection safely.</p>
            <p class="pool-estimator-unavailable">${escapeHtml(poolEstimator.reason || 'Pool data unavailable for this subnet.')}</p>
          </div>
        </details>
      </section>
    `;
  }

  const currentPool = poolEstimator.currentPool;
  const scenarioMaxInjected = 2500;
  const initialResult = estimatePoolGrowth({
    taoInPool: currentPool.taoInPool,
    alphaInPool: currentPool.alphaInPool,
    taoInjected: poolEstimator.defaultTaoInjected,
    marketCap: currentPool.marketCap,
  });
  const scenarioSeries = buildPoolGrowthScenarioSeries({
    taoInPool: currentPool.taoInPool,
    alphaInPool: currentPool.alphaInPool,
    marketCap: currentPool.marketCap,
  }, { maxInjected: scenarioMaxInjected, pointCount: 81 });
  const presets = Array.isArray(poolEstimator.presets) && poolEstimator.presets.length ? poolEstimator.presets : [1, 10, 50];
  const chartScale = Math.max(initialResult.currentPrice, initialResult.projectedPrice, initialResult.currentPrice * 1.25, 1e-12);
  const currentWidth = Math.max(4, Math.min(100, (initialResult.currentPrice / chartScale) * 100));
  const projectedWidth = Math.max(4, Math.min(100, (initialResult.projectedPrice / chartScale) * 100));
  const marketCapChangeText = initialResult.currentMarketCap === null || initialResult.projectedMarketCap === null
    ? 'Market cap unavailable from snapshot.'
    : `Change: ${signedPercent(initialResult.marketCapChangePct, 2)} • current ${tao(initialResult.currentMarketCap, 2)}`;
  const scenarioChartMarkup = renderPoolGrowthScenarioChartMarkup(scenarioSeries, initialResult, scenarioMaxInjected);

  return `
    <section class="section pool-growth-section">
      <div class="section-copy">
        <h2>Pool growth estimator</h2>
        <p class="muted">Estimate only — this uses the latest subnet pool snapshot. TAO injection, alpha received, and price impact are simulated locally from the current reserves.</p>
      </div>
      <details ${rootAttrs}>
        <summary>Pool growth estimator</summary>
        <div class="pool-growth-estimator-body" data-pool-estimator="true">
          <p class="wallet-history-note">Estimate only — this uses the current constant-product AMM reserve ratio. Fees, future emissions, and other live activity can move the outcome.</p>
          <div class="pool-estimator-layout">
            <div class="pool-estimator-main-column">
              <div class="pool-estimator-controls">
                <div class="pool-estimator-input-row">
                  <label for="pool-growth-tao-injected">
                    TAO injected
                    <input id="pool-growth-tao-injected" type="number" min="0" step="0.1" inputmode="decimal" value="${escapeHtml(String(poolEstimator.defaultTaoInjected ?? 10))}">
                  </label>
                  <div class="pool-estimator-presets" role="group" aria-label="Quick TAO presets">
                    ${presets.map((preset) => `<button type="button" class="button" data-pool-preset="${escapeHtml(String(preset))}">${escapeHtml(tao(preset, 0))}</button>`).join('')}
                  </div>
                </div>
                <div class="pool-estimator-summary" id="pool-growth-summary">Current pool: ${escapeHtml(tao(currentPool.taoInPool, 2))} • ${escapeHtml(alpha(currentPool.alphaInPool, 2))} • price ${escapeHtml(tao(currentPool.currentPrice, 6))} / α</div>
              </div>
              <div class="wallet-breakdown-grid pool-estimator-results">
                <div class="wallet-breakdown-card">
                  <div class="label">Estimated alpha received</div>
                  <div class="value" id="pool-growth-alpha-received">${escapeHtml(alpha(initialResult.alphaReceived, 4))}</div>
                  <div class="subtext" id="pool-growth-alpha-ideal">No-slippage baseline: ${escapeHtml(alpha(initialResult.idealAlphaReceived, 4))}</div>
                </div>
                <div class="wallet-breakdown-card">
                  <div class="label">Projected alpha price</div>
                  <div class="value" id="pool-growth-projected-price">${escapeHtml(tao(initialResult.projectedPrice, 6))} / α</div>
                  <div class="subtext" id="pool-growth-post-pool">Projected alpha reserve: ${escapeHtml(alpha(initialResult.projectedAlphaInPool, 2))}</div>
                </div>
                <div class="wallet-breakdown-card">
                  <div class="label">Price change %</div>
                  <div class="value" id="pool-growth-price-change">${escapeHtml(signedPercent(initialResult.priceChangePct, 2))}</div>
                  <div class="subtext" id="pool-growth-slippage">Slippage: ${escapeHtml(alpha(initialResult.alphaShortfall, 4))} • ${escapeHtml(signedPercent(initialResult.slippagePct, 2))} of ideal</div>
                </div>
                <div class="wallet-breakdown-card">
                  <div class="label">Implied subnet market cap</div>
                  <div class="value" id="pool-growth-projected-market-cap">${escapeHtml(tao(initialResult.projectedMarketCap, 2))}</div>
                  <div class="subtext" id="pool-growth-market-cap-change">${escapeHtml(marketCapChangeText)}</div>
                </div>
                <div class="wallet-breakdown-card">
                  <div class="label">Projected TAO in pool</div>
                  <div class="value" id="pool-growth-projected-tao-reserve">${escapeHtml(tao(initialResult.projectedTaoInPool, 2))}</div>
                  <div class="subtext" id="pool-growth-tao-reserve-change">Pool change: ${escapeHtml(signedTao(initialResult.taoReserveChangeAbsolute, 2))} • ${escapeHtml(signedPercent(initialResult.taoReserveChangePct, 2))}</div>
                </div>
              </div>
              <div class="pool-estimator-chart" aria-label="Current versus projected alpha price">
                <div class="pool-estimator-chart-row">
                  <div class="pool-estimator-chart-label">Current</div>
                  <div class="pool-estimator-chart-track"><div class="pool-estimator-chart-fill current" style="width: ${currentWidth.toFixed(2)}%"></div></div>
                  <div class="pool-estimator-chart-value" id="pool-growth-chart-current-value">${escapeHtml(tao(initialResult.currentPrice, 6))} / α</div>
                </div>
                <div class="pool-estimator-chart-row">
                  <div class="pool-estimator-chart-label">Projected</div>
                  <div class="pool-estimator-chart-track"><div class="pool-estimator-chart-fill projected" style="width: ${projectedWidth.toFixed(2)}%"></div></div>
                  <div class="pool-estimator-chart-value" id="pool-growth-chart-projected-value">${escapeHtml(tao(initialResult.projectedPrice, 6))} / α</div>
                </div>
                <div class="pool-estimator-chart-caption" id="pool-growth-chart-caption">Current: ${escapeHtml(tao(initialResult.currentPrice, 6))} / α • projected: ${escapeHtml(tao(initialResult.projectedPrice, 6))} / α • TAO injected: ${escapeHtml(tao(initialResult.taoInjected, 2))}</div>
              </div>
            </div>
            <div class="pool-estimator-scenario-column">
              ${scenarioChartMarkup}
            </div>
          </div>
        </div>
      </details>
    </section>
  `;
}

function renderFinancialPerspectiveSection(signal, insight) {
  const watchlist = buildWatchlistSummary(
    signal ? signal.latest : null,
    signal ? signal.comparisons : [],
    signal,
  );
  if (!signal && !insight && !watchlist) return '';
  return `
    <details class="financial-panel">
      <summary>Financial perspective</summary>
      <div class="financial-panel-body">
        ${renderSignalSection(signal)}
        ${renderInsightSection(insight)}
        ${renderWatchlistSection(watchlist)}
      </div>
    </details>
  `;
}

function nearestBefore(history, cutoffMs, field) {
  let candidate = null;
  for (const row of history) {
    const rowTime = new Date(row.captured_at).getTime();
    if (Number.isNaN(rowTime)) continue;
    if (rowTime <= cutoffMs && row[field] !== null && row[field] !== undefined) {
      candidate = row;
    }
    if (rowTime > cutoffMs && candidate) break;
  }
  return candidate;
}

function buildComparisons(history, latest) {
  const latestTime = new Date(latest.captured_at).getTime();
  const scaleMap = {
    price_num: 1,
    market_cap_num: 1 / TAO_PER_RAO,
    liquidity_num: 1 / TAO_PER_RAO,
    tao_volume_24_hr_num: 1 / TAO_PER_RAO,
    net_flow_1_day_num: 1 / TAO_PER_RAO,
    net_flow_7_days_num: 1 / TAO_PER_RAO,
    net_flow_30_days_num: 1 / TAO_PER_RAO,
  };
  const fields = [
    { field: 'price_num', label: 'Token Price', currencyMode: 'tao' },
    { field: 'market_cap_num', label: 'Subnet Market Cap', currencyMode: 'tao' },
    { field: 'liquidity_num', label: 'Pool Liquidity', currencyMode: 'tao' },
    { field: 'emission_num', label: 'Raw Emission', currencyMode: 'none' },
    { field: 'projected_emission_num', label: 'Emission Forecast', currencyMode: 'none' },
    { field: 'net_flow_1_day_num', label: 'Money In/Out (1d)', currencyMode: 'tao' },
    { field: 'net_flow_7_days_num', label: 'Money In/Out (7d)', currencyMode: 'tao' },
    { field: 'net_flow_30_days_num', label: 'Money In/Out (30d)', currencyMode: 'tao' },
  ];

  return fields.map(({ field, label, currencyMode }) => {
    const scale = scaleMap[field] || 1;
    const prior = nearestBefore(history, latestTime - 24 * 60 * 60 * 1000, field);
    const priorValue = prior ? applyScale(prior[field], scale) : null;
    const latestValue = applyScale(latest[field], scale);
    const delta = Number.isFinite(latestValue) && Number.isFinite(priorValue) ? latestValue - priorValue : null;
    const pct = Number.isFinite(latestValue) && Number.isFinite(priorValue) && priorValue !== 0
      ? (delta / priorValue) * 100
      : null;

    return {
      label,
      field,
      prior,
      currencyMode,
      latestValue,
      priorValue,
      latestTaoPriceUsd: latest.tao_price_usd ?? null,
      priorTaoPriceUsd: prior ? (prior.tao_price_usd ?? null) : null,
      delta,
      pct,
    };
  });
}

function buildAlphaHolderRanking(rows) {
  return (Array.isArray(rows) ? rows : [])
    .map((row, index) => ({
      rank: index + 1,
      netuid: Number(row.netuid),
      captured_at: row.captured_at,
      alpha_holders_num: Number(row.alpha_holders_num ?? 0),
    }))
    .filter((row) => Number.isFinite(row.netuid) && row.netuid > 0)
    .map((row) => ({
      ...row,
      label: formatSubnetLabel(row.subnet_name || row.name, row.netuid),
    }));
}

function buildAlphaHolderRankHistory(rows, netuid) {
  const targetNetuid = Number(netuid);
  const days = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const rowNetuid = Number(row.netuid);
    const dayKey = String(row.day || row.captured_at || '').slice(0, 10);
    const capturedAt = row.captured_at || `${dayKey}T00:00:00.000Z`;
    if (!Number.isFinite(rowNetuid) || rowNetuid <= 0 || !dayKey) continue;
    const bucket = days.get(dayKey) || [];
    bucket.push({
      netuid: rowNetuid,
      captured_at: capturedAt,
      alpha_holders_num: Number(row.alpha_holders_num ?? 0),
    });
    days.set(dayKey, bucket);
  }

  const history = [];
  for (const [dayKey, bucket] of [...days.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const ordered = bucket
      .slice()
      .sort((left, right) => right.alpha_holders_num - left.alpha_holders_num || left.netuid - right.netuid);
    const entry = ordered.find((row) => row.netuid === targetNetuid);
    if (!entry) continue;
    history.push({
      captured_at: entry.captured_at,
      day: dayKey,
      netuid: targetNetuid,
      alpha_holders_num: entry.alpha_holders_num,
      alpha_holder_rank: ordered.findIndex((row) => row.netuid === targetNetuid) + 1,
      subnet_count: ordered.length,
    });
  }
  return history.sort((left, right) => new Date(left.captured_at).getTime() - new Date(right.captured_at).getTime());
}

function buildPageModel({ db, config, netuid }) {
  const latest = getLatestSnapshot(db, netuid);
  const recent = getRecentSnapshots(db, netuid, 12);
  const ingestRun = getLatestIngestRun(db, netuid);
  const totalSnapshots = countSnapshots(db, netuid);
  const totalWalletSnapshots = countWalletSnapshots(db);
  const sinceIso = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const historyRaw = latest ? getHistory(db, netuid, sinceIso) : [];
  const taoPriceHistory = latest ? getTaoPriceHistory(db, sinceIso) : [];
  const latestTaoPrice = getLatestTaoPrice(db);
  const history = attachTaoPrice(historyRaw, taoPriceHistory);
  const recentWithPrice = attachTaoPrice(recent.slice().reverse(), taoPriceHistory).reverse();
  const alphaHolderHistoryCounts = latest ? getAlphaHolderSnapshotCounts(db, netuid, sinceIso) : [];
  const latestAlphaHolderCount = latest ? getLatestAlphaHolderCount(db, netuid) : null;
  const historyWithAlphaHolders = attachAlphaHolderCounts(history, alphaHolderHistoryCounts);
  const subnetMetadata = getSubnetMetadata(db, netuid);
  const latestWithPrice = latest
    ? {
        ...latest,
        alpha_holders_num: Number.isFinite(latestAlphaHolderCount) ? latestAlphaHolderCount : latest.alpha_holders_num,
        alpha_holders_text: Number.isFinite(latestAlphaHolderCount) ? String(latestAlphaHolderCount) : latest.alpha_holders_text,
        tao_price_usd: latest.tao_price_usd ?? latestTaoPrice?.price_usd ?? null,
        tao_price_captured_at: latest.tao_price_captured_at ?? latestTaoPrice?.captured_at ?? null,
      }
    : null;
  const subnetLabel = formatSubnetLabel(latest?.name ?? subnetMetadata?.name ?? null, netuid);
  const walletEntries = (config.wallets || []).map((wallet) => ({
    wallet,
    latest: getLatestWalletSnapshot(db, wallet.ss58),
    stakePositions: getLatestWalletStakePositions(db, wallet.ss58),
    hotkeys: Array.isArray(wallet.hotkeys) ? wallet.hotkeys : [],
  }));
  const latestWalletActivityRun = getLatestIngestRunBySource(db, 'wallet-activity');
  const latestAlphaHolderRun = getLatestIngestRunBySource(db, 'alpha-holder-snapshot-all');
  const latestSubnetPollRun = getLatestIngestRunBySources(db, netuid, ['api', 'scrape']);
  const alphaHolderBackfillActive = String(getSetting(db, 'alpha_holder_backfill_active') || '').trim() === '1';
  const latestAlphaHolderRows = getLatestAlphaHolderSnapshots(db, netuid, 20);
  const alphaHolderRankingRows = fetchAlphaHolderCurrentRanking(db, netuid);
  const alphaHolderCurrentRankRow = alphaHolderRankingRows.find((row) => Number(row.netuid) === Number(netuid)) || null;
  const alphaHolderRankHistory = fetchAlphaHolderRankHistory(db, netuid, sinceIso);
  const comparisons = latestWithPrice ? buildComparisons(historyWithAlphaHolders, latestWithPrice) : [];
  const scheduleStatus = [
    {
      key: 'polling',
      label: 'Subnet poll ingest',
      title: 'Latest subnet ingest',
      description: 'Fetches the current subnet snapshot for the dashboard and keeps the latest local row current.',
      cadenceText: formatPollInterval(config.pollIntervalMinutes),
      nextRunIso: config.nextPollAtIso ?? null,
      enabled: true,
      paused: alphaHolderBackfillActive,
      lastRun: latestSubnetPollRun,
    },
    {
      key: 'wallet-activity',
      label: 'Wallet activity sync',
      title: 'Wallet activity cache',
      description: 'Refreshes configured wallet balances, stake positions, and history.',
      cadenceText: config.walletActivitySyncIntervalMinutes ? formatPollInterval(config.walletActivitySyncIntervalMinutes) : formatPollInterval(config.taostatsWalletActivitySyncIntervalMinutes || 60),
      nextRunIso: config.nextWalletActivitySyncAtIso ?? null,
      enabled: Boolean(config.taostatsAuthHeader && Array.isArray(config.wallets) && config.wallets.length > 0),
      paused: alphaHolderBackfillActive,
      lastRun: latestWalletActivityRun,
    },
    {
      key: 'alpha-holder',
      label: 'Alpha-holder snapshot',
      title: 'All-subnet alpha-holder collection',
      description: 'Snapshots every discovered subnet at UTC midnight so the leaderboard and rank history stay local.',
      cadenceText: 'daily at UTC midnight',
      nextRunIso: config.nextAlphaHolderSnapshotAtIso ?? null,
      enabled: Boolean(config.taostatsAuthHeader),
      paused: alphaHolderBackfillActive,
      lastRun: latestAlphaHolderRun,
    },
  ];
  const scheduleQueue = buildScheduleQueuePreview(scheduleStatus, {
    ingestActive: Boolean(config.ingestActive),
    activeIngestJob: config.activeIngestJob || null,
    alphaHolderBackfillActive,
    alphaHolderBackfillStartedAtIso: getSetting(db, 'alpha_holder_backfill_started_at') || null,
  });

  return {
    config,
    netuid,
    latest: latestWithPrice,
    recent: recentWithPrice,
    ingestRun,
    totalSnapshots,
    history: historyWithAlphaHolders,
    comparisons,
    latestTaoPrice,
    latestTaoPriceUsd: latestWithPrice?.tao_price_usd ?? latestTaoPrice?.price_usd ?? null,
    walletEntries,
    walletActivityStatus: {
      transactionCount: countWalletTransactions(db),
      lastRunAtIso: latestWalletActivityRun?.started_at ?? null,
      nextSyncAtIso: config.nextWalletActivitySyncAtIso ?? null,
      syncIntervalMinutes: config.walletActivitySyncIntervalMinutes ?? config.taostatsWalletActivitySyncIntervalMinutes ?? null,
    },
    alphaHolderRows: latestAlphaHolderRows,
    alphaHolderRowCount: Number.isFinite(latestAlphaHolderCount) ? latestAlphaHolderCount : 0,
    alphaHolderRankingRows,
    alphaHolderCurrentRankRow,
    alphaHolderRankHistory,
    alphaHolderRankHistoryStartAt: alphaHolderRankHistory[0]?.captured_at ?? null,
    scheduleStatus,
    scheduleQueue,
    alphaHolderBackfillActive,
    alphaHolderBackfillStartedAtIso: getSetting(db, 'alpha_holder_backfill_started_at') || null,
    subnetLabel,
    subnetName: latest?.name ?? null,
    totalWalletSnapshots,
    nextPollAtIso: config.nextPollAtIso ?? null,
    ingestActive: Boolean(config.ingestActive),
    activeIngestJob: config.activeIngestJob || null,
    hasApiKey: Boolean(config.taostatsAuthHeader),
  };
}

function metricDataAttribute(metricData) {
  return metricData ? ` data-metric="${escapeHtml(JSON.stringify(metricData || {}))}"` : '';
}

function metricUnitHint(metricData = null) {
  if (!metricData) return '';
  const format = metricData.valueFormat || '';
  const label = String(metricData.label || '').toLowerCase();
  if (format === 'percentRatio') {
    return 'Percentage of the whole pool';
  }
  if (format === 'signedPercent' || label.includes('price move')) {
    return 'Percentage change';
  }
  if (format === 'percent' || label.includes('emission rate') || label.includes('burn rate')) {
    return 'Percentage value';
  }
  return '';
}

function metricCard({ label, value, subtext = '', tone = 'neutral', clickable = false, metricData = null }) {
  const description = metricData?.description || '';
  const unitHint = metricUnitHint(metricData);
  const badgeText = String(metricData?.badge || '').trim();
  const metricAttr = metricDataAttribute(metricData);
  const attrs = clickable
    ? `type="button" class="card card-button ${tone}"${metricAttr}${unitHint ? ` title="${escapeHtml(unitHint)}"` : ''}`
    : `class="card ${tone}"${metricAttr}${unitHint ? ` title="${escapeHtml(unitHint)}"` : ''}`;
  const tag = clickable ? 'button' : 'section';
  return `
    <${tag} ${attrs}>
      ${description ? `<span class="card-info-badge" title="${escapeHtml(description)}" aria-label="${escapeHtml(description)}" aria-hidden="true">i</span>` : ''}
      <div class="card-label">${escapeHtml(label)}</div>
      ${badgeText ? `<div class="card-badge">${escapeHtml(badgeText)}</div>` : ''}
      <div class="card-value">${escapeHtml(value)}</div>
      ${subtext ? `<div class="card-subtext">${escapeHtml(subtext)}</div>` : ''}
    </${tag}>
  `;
}

function renderComparisonCard(comparison) {
  const pctLabel = comparison.pct === null ? '—' : signedPercent(comparison.pct, 2);
  const latestValue = comparison.latestValue;
  const priorValue = comparison.priorValue;
  const deltaLabel = comparison.currencyMode === 'tao'
    ? signedTao(comparison.delta, 4)
    : signedCompact(comparison.delta, 4);
  return metricCard({
    label: `${comparison.label} vs 24h ago`,
    value: `${comparison.delta === null ? '—' : deltaLabel} (${pctLabel})`,
    subtext: comparison.prior
      ? `Prior sample: ${formatIso(comparison.prior.captured_at)}`
      : 'No sample at least 24h ago',
    tone: comparison.delta !== null && comparison.delta >= 0 ? 'positive' : 'negative',
    metricData: {
      kind: 'comparison',
      field: comparison.field,
      label: comparison.label,
      currencyMode: comparison.currencyMode,
      latestValue,
      priorValue,
      latestTaoPriceUsd: comparison.latestTaoPriceUsd,
      priorTaoPriceUsd: comparison.priorTaoPriceUsd,
      delta: comparison.delta,
      pct: comparison.pct,
    },
  });
}

function renderComparisonSection(comparisons) {
  if (!comparisons.length) {
    return '<p class="empty">No 24h comparison data yet. After the tracker collects at least one day of history, the deltas will appear here.</p>';
  }
  return `<div class="grid compact">${comparisons.map(renderComparisonCard).join('')}</div>`;
}

function renderHistoryTable(rows) {
  if (!rows.length) {
    return '<p class="empty">No historical snapshots yet. The first ingest will populate this table.</p>';
  }

  const historyCurrencyCell = (text, metricData) => `<td${metricDataAttribute(metricData)}>${escapeHtml(text)}</td>`;

  const rowsHtml = rows.map((row) => `
    <tr>
      <td>${escapeHtml(formatIso(row.captured_at))}</td>
      <td>${escapeHtml(row.source)}</td>
      ${historyCurrencyCell(tao(row.price_num), {
        kind: 'tableCurrency',
        field: 'price_num',
        label: 'Token Price',
        currencyMode: 'tao',
        valueFormat: 'tao',
        taoValue: numericMetricValue(row.price_num),
        taoPriceUsd: row.tao_price_usd ?? null,
      })}
      ${historyCurrencyCell(tao(applyScale(row.market_cap_num, 1 / TAO_PER_RAO)), {
        kind: 'tableCurrency',
        field: 'market_cap_num',
        label: 'Subnet Market Cap',
        currencyMode: 'tao',
        valueFormat: 'tao',
        taoValue: applyScale(row.market_cap_num, 1 / TAO_PER_RAO),
        taoPriceUsd: row.tao_price_usd ?? null,
      })}
      ${historyCurrencyCell(tao(applyScale(row.liquidity_num, 1 / TAO_PER_RAO)), {
        kind: 'tableCurrency',
        field: 'liquidity_num',
        label: 'Pool Liquidity',
        currencyMode: 'tao',
        valueFormat: 'tao',
        taoValue: applyScale(row.liquidity_num, 1 / TAO_PER_RAO),
        taoPriceUsd: row.tao_price_usd ?? null,
      })}
      <td>${escapeHtml(compact(row.emission_num))}</td>
      <td>${escapeHtml(percentRatio(row.root_prop_text))}</td>
      ${historyCurrencyCell(signedTao(applyScale(row.net_flow_1_day_num, 1 / TAO_PER_RAO)), {
        kind: 'tableCurrency',
        field: 'net_flow_1_day_num',
        label: 'Money In/Out (1d)',
        currencyMode: 'tao',
        valueFormat: 'signedTao',
        taoValue: applyScale(row.net_flow_1_day_num, 1 / TAO_PER_RAO),
        taoPriceUsd: row.tao_price_usd ?? null,
      })}
      <td>${escapeHtml(signedPercent(row.price_change_1_day_text))}</td>
      <td>${escapeHtml(row.rank ?? '—')}</td>
    </tr>
  `).join('');

  return `
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Captured</th>
            <th>Source</th>
            <th>Token Price</th>
            <th>Subnet Market Cap</th>
            <th>Pool Liquidity</th>
            <th>Raw Emission</th>
            <th>Root Share</th>
            <th>Money In/Out (1d)</th>
            <th>24h Change</th>
            <th>Rank</th>
          </tr>
        </thead>
        <tbody>${rowsHtml}</tbody>
      </table>
    </div>
  `;
}

function renderAdminPanel({ netuid, config, recent, latestRunCard, ingestRun, pollIntervalButtons, walletActivityStatus = null, scheduleStatus = [], scheduleQueue = [], alphaHolderBackfillActive = false, alphaHolderBackfillStartedAtIso = null }) {
  if (!config.adminAuthenticated) {
    return '';
  }
  const ingestActive = Boolean(config.ingestActive);
  const activeIngestJob = config.activeIngestJob && typeof config.activeIngestJob === 'object' ? config.activeIngestJob : null;
  const activeJobText = activeIngestJob
    ? `${activeIngestJob.label || activeIngestJob.kind || 'Ingest job'} started ${formatRelativeIso(activeIngestJob.startedAtIso)}${Number.isFinite(Number(activeIngestJob.elapsedMs)) ? ` and has been running for ${formatDuration(Number(activeIngestJob.elapsedMs))}` : ''}.`
    : 'An ingest job is currently running.';
  const walletActivityText = formatWalletActivityStatusText(walletActivityStatus);
  const walletActivityBadge = renderWalletActivityStatusBadge(walletActivityStatus, { id: 'wallet-activity-admin-badge' });
  const queuePreview = renderScheduleQueuePreview(scheduleQueue, {
    paused: alphaHolderBackfillActive,
    backfillStartedAtIso: alphaHolderBackfillStartedAtIso,
  });
  const scheduleTable = renderScheduleStatusTable(scheduleStatus, {
    paused: alphaHolderBackfillActive,
    backfillStartedAtIso: alphaHolderBackfillStartedAtIso,
  });
  return `
      <details class="admin-panel">
        <summary>Admin panel</summary>
        <div class="admin-panel-body">
          <form class="admin-session-form" method="post" action="/admin/logout">
            <button class="button" type="submit">Log out admin</button>
          </form>
          <div class="panel admin-controls">
            <h3>Live controls</h3>
            ${walletActivityBadge ? `<div class="wallet-activity-status admin-wallet-activity-status" id="wallet-activity-admin-status">${walletActivityBadge}<span class="muted">${escapeHtml(walletActivityText)}</span></div>` : ''}
            ${ingestActive ? `<p class="empty" data-status="warning">${escapeHtml(activeJobText)} Manual refresh and backfill actions will be available when it finishes.</p>` : ''}
            <p class="admin-helper">Subnet refresh updates the SN${netuid} snapshot. Use the wallet activity panel below for wallet balance, stake, and transaction cache refreshes.</p>
            <div class="admin-actions">
              <button class="button primary" type="button" id="refresh-btn">Refresh subnet now</button>
              <div class="poll-switcher" role="tablist" aria-label="Polling interval">
                ${pollIntervalButtons}
              </div>
            </div>
          </div>
          <div class="panel">
            <h3>Queue</h3>
            ${queuePreview}
          </div>
          <div class="admin-actions">
            <a class="button" href="/api/subnets/${netuid}/latest">Latest JSON</a>
            <a class="button" href="/api/subnets/${netuid}/history?days=30">History JSON</a>
          </div>
          <div class="panel">
            <h3>Backfill</h3>
            <div class="admin-form">
              <div class="admin-form-row">
                <label>
                  Days
                  <input type="number" id="backfill-days" min="1" max="3650" step="1" value="${escapeHtml(String(config.taostatsBackfillDays || 30))}">
                </label>
                <label>
                  Frequency
                  <select id="backfill-frequency">
                    <option value="by_hour" ${config.taostatsBackfillFrequency === 'by_hour' ? 'selected' : ''}>by_hour</option>
                    <option value="by_day" ${config.taostatsBackfillFrequency === 'by_day' ? 'selected' : ''}>by_day</option>
                    <option value="by_block" ${config.taostatsBackfillFrequency === 'by_block' ? 'selected' : ''}>by_block</option>
                  </select>
                </label>
                <label class="admin-checkbox">
                  <input type="checkbox" id="backfill-overwrite" ${config.taostatsBackfillOverwrite ? 'checked' : ''}>
                  Overwrite overlapping data
                </label>
              </div>
              <div class="admin-actions">
                <button class="button primary" type="button" id="backfill-btn">Run backfill</button>
              </div>
              <progress class="admin-progress" id="backfill-progress" hidden></progress>
              <p class="empty" id="backfill-status" hidden></p>
            </div>
          </div>
          <div class="panel">
            <h3>Wallet activity</h3>
            <div class="admin-form">
              <div class="admin-form-row">
                <label>
                  Days
                  <input type="number" id="wallet-backfill-days" min="1" max="3650" step="1" value="${escapeHtml(String(config.taostatsWalletActivityBackfillDays || 60))}">
                </label>
                <p class="admin-helper">Backfills extrinsics, transfers, and derived stake deltas for every configured wallet.</p>
              </div>
              <div class="admin-actions">
                <button class="button primary" type="button" id="wallet-backfill-btn">Refresh wallet activity</button>
              </div>
              <progress class="admin-progress" id="wallet-backfill-progress" hidden></progress>
              <p class="empty" id="wallet-backfill-status" hidden></p>
            </div>
          </div>
          <div class="panel">
            <h3>Schedules & runs</h3>
            <p class="admin-helper">This panel shows what the server is scheduled to do, when each job should run next, and the last recorded result stored in SQLite.</p>
            ${scheduleTable}
          </div>
          <div class="admin-grid">
            <div class="panel">
              <h3>Recent snapshots</h3>
              ${renderHistoryTable(recent)}
            </div>
            <div class="panel">
              <h3>Latest ingest run</h3>
              <div class="grid compact">
                ${latestRunCard}
              </div>
              ${ingestRun && ingestRun.error ? `<p class="empty"><strong>Error:</strong> ${escapeHtml(ingestRun.error)}</p>` : ''}
            </div>
          </div>
        </div>
      </details>`;
}

function renderDashboardClientScript({ netuid, config }) {
  return `    <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.3/dist/chart.umd.min.js"></script>
    <script>
      const netuid = ${JSON.stringify(netuid)};
      const shell = document.querySelector('.shell');
      const state = {
        displayCurrency: localStorage.getItem('sn110-display-currency') === 'usd' ? 'usd' : 'tao',
        latestTaoPriceUsd: Number(shell?.dataset.taoPriceUsd || ''),
        nextPollAtIso: shell?.dataset.nextPollAt || null,
        latestSnapshotSignature: shell?.dataset.latestSnapshotSignature || '',
        latestIngestRunId: shell?.dataset.latestIngestRunId || '',
        pollIntervalMinutes: ${JSON.stringify(config.pollIntervalMinutes)},
        adminAuthenticated: ${JSON.stringify(Boolean(config.adminAuthenticated))},
        history: null,
        flowHistory: null,
        walletStakeHistory: null,
        pendingLiveReload: false,
        liveRefreshInFlight: false,
        loading: null,
        historyCache: new Map(),
        historyLoading: new Map(),
        charts: new Map(),
        modalChart: null,
        modalMetric: null,
        modalHistory: null,
        modalStakeHistory: null,
        modalTransactions: null,
        modalHistoryDays: 7,
        modalTransactionsDays: 7,
        modalHistoryRequestId: 0,
        modalTransactionsRequestId: 0,
        modalTransactionsCache: new Map(),
        modalHistoryWindowEndMs: null,
        modalHistoryAutoFollow: true,
        modalTransactionsFilter: 'all',
        explanationOpen: true,
      };

      if (!Number.isFinite(state.latestTaoPriceUsd)) {
        state.latestTaoPriceUsd = null;
      }

      function escapeHtml(value) {
        return String(value ?? '')
          .replaceAll('&', '&amp;')
          .replaceAll('<', '&lt;')
          .replaceAll('>', '&gt;')
          .replaceAll('"', '&quot;')
          .replaceAll("'", '&#39;');
      }

      function adminFetchHeaders(contentType = 'application/json') {
        const headers = {};
        if (contentType) headers['content-type'] = contentType;
        return headers;
      }

      function shortAddress(address) {
        const text = String(address || '').trim();
        if (text.length <= 14) return text || '—';
        return text.slice(0, 6) + '…' + text.slice(-6);
      }

      function resolveColdkeySwapSummary(rawJson, fallback = null) {
        if (rawJson) {
          try {
            const payload = typeof rawJson === 'string' ? JSON.parse(rawJson) : rawJson;
            const swap = payload?.coldkey_swap;
            if (swap && typeof swap === 'object') {
              const oldKey = swap.old_coldkey?.ss58 || swap.old_coldkey?.hex || null;
              const newKey = swap.new_coldkey?.ss58 || swap.new_coldkey?.hex || null;
              if (oldKey && newKey) {
                return 'Swapped from ' + shortAddress(oldKey) + ' to ' + shortAddress(newKey);
              }
              return 'Coldkey swap recorded';
            }
            if (swap) {
              return String(swap);
            }
          } catch {
            // ignore parse errors and fall through
          }
        }
        if (fallback === null || fallback === undefined || fallback === '') {
          return '—';
        }
        const text = String(fallback);
        if (text === '[object Object]') {
          return 'Coldkey swap recorded';
        }
        return text;
      }

      function normalizeHotkeyRole(role) {
        const text = String(role || '').trim().toLowerCase();
        if (!text) return null;
        if (['validator', 'owner', 'shared', 'other', 'unclassified', 'unknown'].includes(text)) {
          return text === 'unknown' ? 'unclassified' : text;
        }
        return text;
      }

      function labelHotkeyRole(role) {
        switch (normalizeHotkeyRole(role)) {
          case 'validator':
            return 'Validator';
          case 'owner':
            return 'Owner';
          case 'shared':
            return 'Shared';
          case 'other':
            return 'Other';
          case 'unclassified':
            return 'Unclassified';
          default:
            return '—';
        }
      }

      function inferHotkeyRoleFromMetadata(hotkey = null, configuredHotkeyMap = new Map()) {
        if (!hotkey) return null;
        const ss58 = hotkey.hotkey_address_ss58 ? String(hotkey.hotkey_address_ss58) : '';
        if (ss58 && configuredHotkeyMap.has(ss58)) {
          return normalizeHotkeyRole(configuredHotkeyMap.get(ss58)?.role);
        }
        const name = hotkey.hotkey_name ? String(hotkey.hotkey_name).trim().toLowerCase() : '';
        if (name.includes('validator')) return 'validator';
        if (name.includes('owner')) return 'owner';
        if (name.includes('shared')) return 'shared';
        return null;
      }

      function buildWalletAttributionSummary({ totalChange = null, stakePositions = [], configuredHotkeys = [] } = {}) {
        const change = Number(totalChange);
        const changeIsFinite = Number.isFinite(change);
        const hotkeyMap = new Map(
          (Array.isArray(configuredHotkeys) ? configuredHotkeys : [])
            .filter((hotkey) => hotkey && hotkey.ss58)
            .map((hotkey) => [String(hotkey.ss58), hotkey]),
        );
        const roleBalances = new Map();
        let knownWeight = 0;
        let hasRoleMetadata = false;

        for (const position of Array.isArray(stakePositions) ? stakePositions : []) {
          const balance = Number(position?.balance_as_tao_num ?? position?.balance_num ?? 0);
          if (!Number.isFinite(balance) || balance <= 0) continue;
          const role = inferHotkeyRoleFromMetadata(position, hotkeyMap) || 'unclassified';
          if (role !== 'unclassified') hasRoleMetadata = true;
          roleBalances.set(role, (roleBalances.get(role) || 0) + balance);
          if (role !== 'unclassified') {
            knownWeight += balance;
          }
        }

        const prioritizedRoles = ['validator', 'owner', 'shared', 'other'];
        const estimated = new Map();
        let assigned = 0;

        if (changeIsFinite && change !== 0 && knownWeight > 0) {
          for (const role of prioritizedRoles) {
            const weight = roleBalances.get(role) || 0;
            if (!weight) continue;
            const portion = (change * weight) / knownWeight;
            estimated.set(role, portion);
            assigned += portion;
          }
        }

        const residual = changeIsFinite ? change - assigned : null;
        const hasAnySplit = hasRoleMetadata && estimated.size > 0;

        return {
          hasRoleMetadata,
          hasAnySplit,
          totalChange: changeIsFinite ? change : null,
          validator: estimated.get('validator') ?? null,
          owner: estimated.get('owner') ?? null,
          shared: estimated.get('shared') ?? null,
          other: estimated.get('other') ?? null,
          residual,
          roleBalances,
        };
      }

      const modalElements = {
        backdrop: document.getElementById('history-modal'),
        title: document.getElementById('history-modal-title'),
        subtitle: document.getElementById('history-modal-subtitle'),
        latestValue: document.getElementById('history-modal-latest-value'),
        latestRaw: document.getElementById('history-modal-latest-raw'),
        samples: document.getElementById('history-modal-samples'),
        samplesNote: document.getElementById('history-modal-samples-note'),
        captured: document.getElementById('history-modal-captured'),
        chartTitle: document.getElementById('history-modal-chart-title'),
        info: document.getElementById('history-modal-info'),
        explanation: document.getElementById('history-modal-explanation'),
        walletDetails: document.getElementById('history-modal-wallet-details'),
        canvas: document.getElementById('history-modal-canvas'),
        empty: document.getElementById('history-modal-empty'),
        note: document.getElementById('history-modal-note'),
        close: document.getElementById('history-modal-close'),
        windowPrev: document.getElementById('history-window-prev'),
        windowNext: document.getElementById('history-window-next'),
        windowLabel: document.getElementById('history-window-label'),
      };

      const txModalElements = {
        backdrop: document.getElementById('wallet-transactions-modal'),
        title: document.getElementById('wallet-transactions-modal-title'),
        subtitle: document.getElementById('wallet-transactions-modal-subtitle'),
        explanation: document.getElementById('wallet-transactions-modal-explanation'),
        refresh: document.getElementById('wallet-transactions-refresh'),
        close: document.getElementById('wallet-transactions-modal-close'),
        count: document.getElementById('wallet-transactions-count'),
        stakeCount: document.getElementById('wallet-transactions-stake-count'),
        transferCount: document.getElementById('wallet-transactions-transfer-count'),
        countNote: document.getElementById('wallet-transactions-count-note'),
        rangeLabel: document.getElementById('wallet-transactions-range-label'),
        note: document.getElementById('wallet-transactions-note'),
        tableBody: document.getElementById('wallet-transactions-table-body'),
        detailEmpty: document.getElementById('wallet-transactions-detail-empty'),
        detail: document.getElementById('wallet-transactions-detail'),
      };

      const rangeButtons = Array.from(document.querySelectorAll('[data-history-range]'));
      const txRangeButtons = Array.from(document.querySelectorAll('[data-wallet-tx-range]'));
      const txFilterButtons = Array.from(document.querySelectorAll('[data-wallet-tx-filter]'));
      const pollButtons = Array.from(document.querySelectorAll('[data-poll-interval]'));

      const currencyToggle = document.getElementById('currency-toggle');
      const taoPriceLabel = document.getElementById('tao-price-label');
      const pollIntervalLabel = document.getElementById('poll-interval-label');
      const nextPollLabel = document.getElementById('next-poll-label');
      const adminPanel = document.querySelector('.admin-panel');
      const financialPanel = document.querySelector('.financial-panel');
      const backfillDaysInput = document.getElementById('backfill-days');
      const backfillFrequencySelect = document.getElementById('backfill-frequency');
      const backfillOverwriteInput = document.getElementById('backfill-overwrite');
      const backfillButton = document.getElementById('backfill-btn');
      const backfillStatus = document.getElementById('backfill-status');
      const backfillProgress = document.getElementById('backfill-progress');
      const walletBackfillDaysInput = document.getElementById('wallet-backfill-days');
      const walletBackfillButton = document.getElementById('wallet-backfill-btn');
      const walletBackfillStatus = document.getElementById('wallet-backfill-status');
      const walletBackfillProgress = document.getElementById('wallet-backfill-progress');

      const chartConfigs = ${JSON.stringify(getChartMetricConfigs())};

      function isFiniteNumber(value) {
        return Number.isFinite(Number(value));
      }

      function formatCompact(value, digits = 2) {
        if (value === null || value === undefined || value === '') return '—';
        const num = Number(value);
        if (!Number.isFinite(num)) return String(value);
        return new Intl.NumberFormat('en-US', {
          notation: 'compact',
          maximumFractionDigits: digits,
        }).format(num);
      }

      function formatInteger(value) {
        if (value === null || value === undefined || value === '') return '—';
        const num = Number(value);
        if (!Number.isFinite(num)) return String(value);
        return new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(num);
      }

      function formatSignedCompact(value, digits = 2) {
        if (value === null || value === undefined || value === '') return '—';
        const num = Number(value);
        if (!Number.isFinite(num)) return String(value);
        const sign = num > 0 ? '+' : num < 0 ? '-' : '';
        const abs = Math.abs(num);
        const formatted = abs >= 10000
          ? new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: digits }).format(abs)
          : num.toFixed(digits);
        return sign + formatted;
      }

      function percentDigits(value) {
        const num = Number(value);
        if (!Number.isFinite(num)) return 2;
        const abs = Math.abs(num);
        if (abs === 0) return 3;
        return abs < 1 ? 3 : 2;
      }

      function formatPercent(value, digits = null) {
        if (value === null || value === undefined || value === '') return '—';
        const num = Number(value);
        if (!Number.isFinite(num)) return String(value);
        const precision = digits === null ? percentDigits(num) : digits;
        return num.toFixed(precision) + '%';
      }

      function formatSignedPercent(value, digits = null) {
        if (value === null || value === undefined || value === '') return '—';
        const num = Number(value);
        if (!Number.isFinite(num)) return String(value);
        const sign = num > 0 ? '+' : '';
        const precision = digits === null ? percentDigits(num) : digits;
        return sign + num.toFixed(precision) + '%';
      }

      function formatPercentRatio(value, digits = null) {
        if (value === null || value === undefined || value === '') return '—';
        const num = Number(value);
        if (!Number.isFinite(num)) return String(value);
        const pct = num * 100;
        const precision = digits === null ? percentDigits(pct) : digits;
        return pct.toFixed(precision) + '%';
      }

      function formatTao(value, digits = 4) {
        if (value === null || value === undefined || value === '') return '—';
        const num = Number(value);
        if (!Number.isFinite(num)) return String(value);
        return 'τ ' + new Intl.NumberFormat('en-US', { maximumFractionDigits: digits }).format(num);
      }

      function formatAlpha(value, digits = 4) {
        if (value === null || value === undefined || value === '') return '—';
        const num = Number(value);
        if (!Number.isFinite(num)) return String(value);
        return 'α ' + new Intl.NumberFormat('en-US', {
          notation: 'compact',
          maximumFractionDigits: digits,
        }).format(num);
      }

      function formatSignedTao(value, digits = 4) {
        if (value === null || value === undefined || value === '') return '—';
        const num = Number(value);
        if (!Number.isFinite(num)) return String(value);
        const sign = num > 0 ? '+' : num < 0 ? '-' : '';
        return sign + 'τ ' + new Intl.NumberFormat('en-US', { maximumFractionDigits: digits }).format(Math.abs(num));
      }

      function formatUsd(value, digits = 2) {
        if (value === null || value === undefined || value === '') return '—';
        const num = Number(value);
        if (!Number.isFinite(num)) return String(value);
        if (num === 0) return '$0.00';
        if (Math.abs(num) < 0.01) return num > 0 ? '<$0.01' : '-$0.01';
        return new Intl.NumberFormat('en-US', {
          style: 'currency',
          currency: 'USD',
          notation: 'compact',
          maximumFractionDigits: digits,
        }).format(num);
      }

      function formatSignedUsd(value, digits = 2) {
        if (value === null || value === undefined || value === '') return '—';
        const num = Number(value);
        if (!Number.isFinite(num)) return String(value);
        const sign = num > 0 ? '+' : num < 0 ? '-' : '';
        const abs = Math.abs(num);
        if (abs === 0) return '$0.00';
        if (abs < 0.01) return sign + '<$0.01';
        return sign + formatUsd(abs, digits);
      }

      function estimatePoolGrowthClient(pool, taoInjected) {
        const taoInPool = Number(pool?.taoInPool);
        const alphaInPool = Number(pool?.alphaInPool);
        const marketCap = Number(pool?.marketCap);
        const injected = Number(taoInjected);
        if (!Number.isFinite(taoInPool) || !Number.isFinite(alphaInPool) || taoInPool <= 0 || alphaInPool <= 0 || !Number.isFinite(injected) || injected < 0) {
          return { available: false };
        }
        const currentPrice = Number(pool?.currentPrice);
        const resolvedCurrentPrice = Number.isFinite(currentPrice) && currentPrice > 0 ? currentPrice : taoInPool / alphaInPool;
        const resolvedMarketCap = Number.isFinite(marketCap) && marketCap > 0 ? marketCap : null;
        const taoInjectedSafe = Math.max(0, injected);
        const projectedTaoInPool = taoInPool + taoInjectedSafe;
        const alphaReceived = taoInjectedSafe === 0 ? 0 : (alphaInPool * taoInjectedSafe) / projectedTaoInPool;
        const projectedAlphaInPool = alphaInPool - alphaReceived;
        const projectedPrice = projectedTaoInPool / projectedAlphaInPool;
        const idealAlphaReceived = taoInjectedSafe === 0 ? 0 : taoInjectedSafe / resolvedCurrentPrice;
        const alphaShortfall = idealAlphaReceived - alphaReceived;
        const slippagePct = idealAlphaReceived > 0 ? (alphaShortfall / idealAlphaReceived) * 100 : 0;
        const priceChangePct = resolvedCurrentPrice > 0 ? ((projectedPrice - resolvedCurrentPrice) / resolvedCurrentPrice) * 100 : null;
        const taoReserveChangeAbsolute = projectedTaoInPool - taoInPool;
        const taoReserveChangePct = taoInPool > 0 ? (taoReserveChangeAbsolute / taoInPool) * 100 : null;
        const projectedMarketCap = resolvedMarketCap === null ? null : resolvedMarketCap * (projectedPrice / resolvedCurrentPrice);
        const marketCapChangePct = resolvedMarketCap === null || projectedMarketCap === null
          ? null
          : ((projectedMarketCap - resolvedMarketCap) / resolvedMarketCap) * 100;
        return {
          available: true,
          taoInPool,
          alphaInPool,
          marketCap: resolvedMarketCap,
          taoInjected: taoInjectedSafe,
          currentPrice: resolvedCurrentPrice,
          projectedTaoInPool,
          projectedAlphaInPool,
          projectedPrice,
          projectedMarketCap,
          alphaReceived,
          idealAlphaReceived,
          alphaShortfall,
          slippagePct,
          priceChangePct,
          taoReserveChangeAbsolute,
          taoReserveChangePct,
          marketCapChangePct,
        };
      }

      function buildPoolGrowthScenarioSeriesClient(pool, maxInjected, pointCount = 9) {
        const taoInPool = Number(pool?.taoInPool);
        const alphaInPool = Number(pool?.alphaInPool);
        const marketCap = Number(pool?.marketCap);
        const maxInjectedNum = Number(maxInjected);
        const maxInjectedSafe = Math.max(0, Number.isFinite(maxInjectedNum) ? maxInjectedNum : 0);
        const sampleCount = Math.max(2, Math.floor(Number(pointCount) || 9));
        if (!Number.isFinite(taoInPool) || !Number.isFinite(alphaInPool) || taoInPool <= 0 || alphaInPool <= 0) {
          return { available: false, points: [] };
        }
        const points = [];
        for (let index = 0; index < sampleCount; index += 1) {
          const taoInjected = sampleCount === 1 ? maxInjectedSafe : (maxInjectedSafe * index) / (sampleCount - 1);
          const result = estimatePoolGrowthClient(pool, taoInjected);
          if (!result.available) return { available: false, points: [] };
          points.push({
            taoInjected: result.taoInjected,
            priceChangePct: result.priceChangePct,
            projectedPrice: result.projectedPrice,
            projectedMarketCap: Number.isFinite(marketCap) ? result.projectedMarketCap : null,
          });
        }
        return {
          available: true,
          points,
          maxInjected: maxInjectedSafe,
        };
      }

      function renderPoolGrowthScenarioChartClient(series, selectedResult, maxInjected) {
        if (!series?.available || !Array.isArray(series.points) || series.points.length < 2 || !selectedResult?.available) {
          return [
            '<div class="pool-estimator-scenario pool-estimator-scenario-details pool-estimator-scenario-unavailable" data-pool-scenario-chart="true" data-pool-scenario-open="false" data-pool-scenario-max-tao-injected="' + maxInjected + '">',
            '  <div class="pool-estimator-scenario-summary">',
            '    <div class="pool-estimator-scenario-summary-text">',
            '      <div class="label">Alpha price change curve</div>',
            '      <div class="pool-estimator-scenario-title">Scenario chart unavailable</div>',
            '    </div>',
            '    <button class="pool-estimator-scenario-summary-hint" type="button" onmousedown="window.togglePoolGrowthScenario(this); return false;" onkeydown="if(event.key===\\'Enter\\'||event.key===\\' \\'){window.togglePoolGrowthScenario(this); return false;}">Show chart</button>',
            '  </div>',
            '  <div class="pool-estimator-scenario-caption">The current snapshot does not contain enough pool data to draw the scenario curve.</div>',
            '</div>',
          ].join('');
        }

        const points = series.points;
        const values = points.map((point) => Number(point.priceChangePct)).filter((value) => Number.isFinite(value));
        const width = 500;
        const height = 170;
        const padding = { top: 14, right: 14, bottom: 28, left: 54 };
        const innerWidth = width - padding.left - padding.right;
        const innerHeight = height - padding.top - padding.bottom;
        const minValue = Math.min(0, ...values);
        const maxValue = Math.max(0, ...values);
        const valueSpan = Math.max(1e-6, maxValue - minValue);
        const gridValues = [minValue, minValue + (valueSpan / 2), maxValue];
        const xForIndex = (index) => padding.left + (index / (points.length - 1)) * innerWidth;
        const yForValue = (value) => padding.top + (1 - ((Number(value) - minValue) / valueSpan)) * innerHeight;
        const coords = points.map((point, index) => ({
          x: xForIndex(index),
          y: yForValue(point.priceChangePct),
          point,
          index,
        }));
        const linePath = coords.map(({ x, y }, index) => (index === 0 ? 'M ' : 'L ') + x.toFixed(2) + ' ' + y.toFixed(2)).join(' ');
        const areaPath = [
          'M ' + padding.left.toFixed(2) + ' ' + (padding.top + innerHeight).toFixed(2),
          ...coords.map(({ x, y }) => 'L ' + x.toFixed(2) + ' ' + y.toFixed(2)),
          'L ' + (padding.left + innerWidth).toFixed(2) + ' ' + (padding.top + innerHeight).toFixed(2),
          'Z',
        ].join(' ');
        const xAxisLabelLeft = '0 TAO';
        const xAxisLabelMiddle = formatTao(maxInjected / 2, 2) + ' injected';
        const xAxisLabelRight = formatTao(maxInjected, 2) + ' injected';

        return [
          '<div class="pool-estimator-scenario pool-estimator-scenario-details" data-pool-scenario-chart="true" data-pool-scenario-open="false" data-pool-scenario-max-tao-injected="' + maxInjected + '" data-pool-scenario-min-change="' + minValue + '" data-pool-scenario-max-change="' + maxValue + '">',
          '  <div class="pool-estimator-scenario-summary">',
          '    <div class="pool-estimator-scenario-summary-text">',
          '      <div class="label">Alpha price change curve</div>',
          '      <div class="pool-estimator-scenario-title">Projected alpha price change vs TAO injected</div>',
          '    </div>',
          '    <button class="pool-estimator-scenario-summary-hint" type="button" onmousedown="window.togglePoolGrowthScenario(this); return false;" onkeydown="if(event.key===\\'Enter\\'||event.key===\\' \\'){window.togglePoolGrowthScenario(this); return false;}">Show chart</button>',
          '  </div>',
          '  <div class="pool-estimator-scenario-body">',
          '    <div class="pool-estimator-scenario-meta-row">',
          '      <div class="pool-estimator-scenario-meta" id="pool-growth-scenario-meta">',
          '        ' + formatTao(selectedResult.taoInjected, 2) + ' injected → ' + formatSignedPercent(selectedResult.priceChangePct, 2) + ' • ' + formatTao(selectedResult.projectedPrice, 6) + ' / α',
          '      </div>',
          '    </div>',
          '    <div class="pool-estimator-scenario-plot">',
          '      <svg class="pool-estimator-scenario-svg" viewBox="0 0 ' + width + ' ' + height + '" role="img" aria-label="Alpha price change versus TAO injected scenario curve">',
          '        <defs>',
          '          <linearGradient id="pool-growth-scenario-fill" x1="0%" x2="0%" y1="0%" y2="100%">',
          '            <stop offset="0%" stop-color="#00dbbc" stop-opacity="0.32"/>',
          '            <stop offset="100%" stop-color="#00dbbc" stop-opacity="0.04"/>',
          '          </linearGradient>',
          '        </defs>',
          ...gridValues.map((value) => {
            const y = yForValue(value);
            return [
              '        <line x1="' + padding.left + '" y1="' + y.toFixed(2) + '" x2="' + (padding.left + innerWidth) + '" y2="' + y.toFixed(2) + '" class="pool-estimator-scenario-grid-line" />',
              '        <text x="' + (padding.left - 10) + '" y="' + (y + 3).toFixed(2) + '" text-anchor="end" class="pool-estimator-scenario-grid-label">' + formatSignedPercent(value, 0) + '</text>',
            ].join('');
          }),
          '        <line x1="' + padding.left + '" y1="' + (padding.top + innerHeight) + '" x2="' + (padding.left + innerWidth) + '" y2="' + (padding.top + innerHeight) + '" class="pool-estimator-scenario-axis-line" />',
          '        <line x1="' + padding.left + '" y1="' + padding.top + '" x2="' + padding.left + '" y2="' + (padding.top + innerHeight) + '" class="pool-estimator-scenario-axis-line" />',
          '        <path d="' + areaPath + '" class="pool-estimator-scenario-area"></path>',
          '        <path d="' + linePath + '" class="pool-estimator-scenario-line"></path>',
          '        <line class="pool-estimator-scenario-crosshair vertical" x1="' + selectedX.toFixed(2) + '" x2="' + selectedX.toFixed(2) + '" y1="' + padding.top + '" y2="' + (padding.top + innerHeight) + '" />',
          '        <line class="pool-estimator-scenario-crosshair horizontal" x1="' + padding.left + '" x2="' + (padding.left + innerWidth) + '" y1="' + selectedY.toFixed(2) + '" y2="' + selectedY.toFixed(2) + '" />',
          '        <rect class="pool-estimator-scenario-hit-area" x="' + padding.left + '" y="' + padding.top + '" width="' + innerWidth + '" height="' + innerHeight + '" />',
          '        <text x="' + padding.left + '" y="' + (height - 16) + '" font-size="8" font-weight="600" class="pool-estimator-scenario-axis-label">' + xAxisLabelLeft + '</text>',
          '        <text x="' + (padding.left + innerWidth / 2) + '" y="' + (height - 16) + '" text-anchor="middle" font-size="8" font-weight="600" class="pool-estimator-scenario-axis-label">' + xAxisLabelMiddle + '</text>',
          '        <text x="' + (padding.left + innerWidth) + '" y="' + (height - 16) + '" text-anchor="end" font-size="8" font-weight="600" class="pool-estimator-scenario-axis-label">' + xAxisLabelRight + '</text>',
          '      </svg>',
          '      <div class="pool-estimator-scenario-tooltip" hidden>',
          '        <div class="pool-estimator-scenario-tooltip-title" id="pool-growth-scenario-tooltip-title">TAO injected</div>',
          '        <div class="pool-estimator-scenario-tooltip-value" id="pool-growth-scenario-tooltip-value"></div>',
          '        <div class="pool-estimator-scenario-tooltip-subtext" id="pool-growth-scenario-tooltip-subtext"></div>',
          '      </div>',
          '    </div>',
          '    <div class="pool-estimator-scenario-caption" id="pool-growth-scenario-caption">At ' + formatTao(selectedResult.taoInjected, 2) + ' injected, the projected alpha price change is ' + formatSignedPercent(selectedResult.priceChangePct, 2) + '.</div>',
          '  </div>',
          '</div>',
        ].join('');
      }

      function getPoolGrowthScenarioChart(root = getPoolGrowthEstimatorRoot()) {
        return root ? root.querySelector('[data-pool-scenario-chart="true"]') : null;
      }

      function syncPoolGrowthEstimatorLayout(root = getPoolGrowthEstimatorRoot()) {
        if (!root) return;
        const scenario = getPoolGrowthScenarioChart(root);
        root.dataset.poolScenarioOpen = scenario && scenario.dataset.poolScenarioOpen === 'true' ? 'true' : 'false';
        updatePoolGrowthScenarioToggleLabel(root);
      }

      function updatePoolGrowthScenarioToggleLabel(root = getPoolGrowthEstimatorRoot()) {
        const scenario = getPoolGrowthScenarioChart(root);
        if (!scenario) return;
        const toggle = scenario.querySelector('.pool-estimator-scenario-summary-hint');
        if (!toggle) return;
        toggle.textContent = scenario.dataset.poolScenarioOpen === 'true' ? 'Hide chart' : 'Show chart';
      }

      window.togglePoolGrowthScenario = function togglePoolGrowthScenario(button) {
        const scenario = button?.closest?.('.pool-estimator-scenario');
        if (!scenario) return false;
        scenario.dataset.poolScenarioOpen = scenario.dataset.poolScenarioOpen === 'true' ? 'false' : 'true';
        syncPoolGrowthEstimatorLayout(scenario.closest('#pool-growth-estimator') || getPoolGrowthEstimatorRoot());
        return false;
      };

      function clampScenarioInjected(value, maxInjected) {
        const injected = Number(value);
        const max = Number(maxInjected);
        if (!Number.isFinite(injected)) return 0;
        if (!Number.isFinite(max) || max <= 0) return Math.max(0, injected);
        return Math.max(0, Math.min(injected, max));
      }

      function getPoolGrowthScenarioSnap(root = getPoolGrowthEstimatorRoot(), injected = 0, maxInjected = 2500) {
        const pool = getPoolGrowthEstimatorState(root);
        const series = buildPoolGrowthScenarioSeriesClient(pool, maxInjected, 81);
        if (!series.available || !Array.isArray(series.points) || !series.points.length) return null;
        let nearest = series.points[0];
        let nearestDistance = Math.abs(Number(nearest.taoInjected) - Number(injected));
        for (const point of series.points) {
          const distance = Math.abs(Number(point.taoInjected) - Number(injected));
          if (distance < nearestDistance) {
            nearest = point;
            nearestDistance = distance;
          }
        }
        return { series, point: nearest };
      }

      function updatePoolGrowthScenarioSelection(root = getPoolGrowthEstimatorRoot(), result = null, hoveredInjected = null) {
        const scenario = getPoolGrowthScenarioChart(root);
        if (!scenario) return;
        const tooltip = scenario.querySelector('.pool-estimator-scenario-tooltip');
        const tooltipValue = scenario.querySelector('#pool-growth-scenario-tooltip-value');
        const tooltipSubtext = scenario.querySelector('#pool-growth-scenario-tooltip-subtext');
        const crosshairX = scenario.querySelector('.pool-estimator-scenario-crosshair.vertical');
        const crosshairY = scenario.querySelector('.pool-estimator-scenario-crosshair.horizontal');
        const meta = scenario.querySelector('#pool-growth-scenario-meta');
        const caption = scenario.querySelector('#pool-growth-scenario-caption');
        const pool = getPoolGrowthEstimatorState(root);
        const maxInjected = Number(scenario.dataset.poolScenarioMaxTaoInjected) || 2500;
        const minChange = Number(scenario.dataset.poolScenarioMinChange);
        const maxChange = Number(scenario.dataset.poolScenarioMaxChange);
        const currentResult = result && result.available ? result : estimatePoolGrowthClient(pool, Number(root.querySelector('#pool-growth-tao-injected')?.value) || 0);
        if (!currentResult.available) {
          if (tooltip) tooltip.hidden = true;
          if (crosshairX) crosshairX.style.display = 'none';
          if (crosshairY) crosshairY.style.display = 'none';
          if (caption) caption.textContent = 'The current snapshot does not contain enough pool data to draw the scenario curve.';
          if (meta) meta.textContent = 'Scenario unavailable.';
          return;
        }

        const injected = clampScenarioInjected(hoveredInjected === null || hoveredInjected === undefined ? currentResult.taoInjected : hoveredInjected, maxInjected);
        const activeResult = hoveredInjected === null || hoveredInjected === undefined
          ? currentResult
          : estimatePoolGrowthClient(pool, injected);
        if (!activeResult.available) return;

        const width = 500;
        const height = 170;
        const padding = { top: 14, right: 14, bottom: 28, left: 54 };
        const innerWidth = width - padding.left - padding.right;
        const innerHeight = height - padding.top - padding.bottom;
        const lower = Number.isFinite(minChange) ? minChange : 0;
        const upper = Number.isFinite(maxChange) ? maxChange : activeResult.priceChangePct;
        const changeSpan = Math.max(1e-6, upper - lower);
        const x = padding.left + (injected / Math.max(1, maxInjected)) * innerWidth;
        const y = padding.top + (1 - ((activeResult.priceChangePct - lower) / changeSpan)) * innerHeight;
        const plot = scenario.querySelector('.pool-estimator-scenario-plot');
        const plotRect = plot ? plot.getBoundingClientRect() : null;
        const renderedWidth = plotRect && Number.isFinite(plotRect.width) && plotRect.width > 0 ? plotRect.width : width;
        const renderedHeight = plotRect && Number.isFinite(plotRect.height) && plotRect.height > 0 ? plotRect.height : height;
        const tooltipLeft = Math.min(renderedWidth - 170, Math.max(0, (x / width) * renderedWidth + 12));
        const tooltipTop = Math.max(0, Math.min(renderedHeight - 40, (y / height) * renderedHeight - 16));

        if (crosshairX) {
          crosshairX.setAttribute('x1', x.toFixed(2));
          crosshairX.setAttribute('x2', x.toFixed(2));
          crosshairX.setAttribute('y1', padding.top.toFixed(2));
          crosshairX.setAttribute('y2', (padding.top + innerHeight).toFixed(2));
          crosshairX.style.display = '';
        }
        if (crosshairY) {
          crosshairY.setAttribute('x1', padding.left.toFixed(2));
          crosshairY.setAttribute('x2', (padding.left + innerWidth).toFixed(2));
          crosshairY.setAttribute('y1', y.toFixed(2));
          crosshairY.setAttribute('y2', y.toFixed(2));
          crosshairY.style.display = '';
        }
        if (tooltip) {
          tooltip.hidden = false;
          tooltip.style.left = String(tooltipLeft) + 'px';
          tooltip.style.top = String(tooltipTop) + 'px';
        }
        if (tooltipValue) {
          tooltipValue.textContent = [
            formatTao(activeResult.taoInjected, 2),
            ' → ',
            formatSignedPercent(activeResult.priceChangePct, 2),
          ].join('');
        }
        if (tooltipSubtext) {
          tooltipSubtext.textContent = [
            'Projected price ',
            formatTao(activeResult.projectedPrice, 6),
            ' / α • implied market cap ',
            formatTao(activeResult.projectedMarketCap, 2),
          ].join('');
        }
        if (meta) {
          meta.textContent = [
            formatTao(activeResult.taoInjected, 2),
            ' injected → ',
            formatSignedPercent(activeResult.priceChangePct, 2),
            ' • ',
            formatTao(activeResult.projectedPrice, 6),
            ' / α',
          ].join('');
        }
        if (caption) {
          caption.textContent = [
            'At ',
            formatTao(activeResult.taoInjected, 2),
            ' injected, the projected alpha price change is ',
            formatSignedPercent(activeResult.priceChangePct, 2),
            '.',
          ].join('');
        }
        scenario.dataset.poolScenarioActiveInjected = String(activeResult.taoInjected);
        syncPoolGrowthEstimatorLayout(root);
      }

      function initializePoolGrowthScenarioInteractions(root = getPoolGrowthEstimatorRoot()) {
        const scenario = getPoolGrowthScenarioChart(root);
        if (!scenario || scenario.dataset.poolScenarioInteractionsInitialized === 'true') return;
        scenario.dataset.poolScenarioInteractionsInitialized = 'true';
        const hitArea = scenario.querySelector('.pool-estimator-scenario-hit-area');
        const plot = scenario.querySelector('.pool-estimator-scenario-plot');
        const svg = scenario.querySelector('.pool-estimator-scenario-svg');
        const toggle = scenario.querySelector('.pool-estimator-scenario-summary-hint');
        const maxInjected = Number(scenario.dataset.poolScenarioMaxTaoInjected) || 2500;
        let hovering = false;
        let dragging = false;
        const getActiveRect = () => {
          const rect = plot ? plot.getBoundingClientRect() : null;
          if (rect && rect.width && rect.height) return rect;
          const svgRect = svg ? svg.getBoundingClientRect() : null;
          return svgRect && svgRect.width && svgRect.height ? svgRect : null;
        };
        const commitInjectedValue = (injected) => {
          const input = root.querySelector('#pool-growth-tao-injected');
          if (input) {
            input.value = String(clampScenarioInjected(injected, maxInjected));
          }
          updatePoolGrowthEstimator(root);
        };
        const updateFromEvent = (event) => {
          const activeRect = getActiveRect();
          if (!activeRect) return;
          const clientX = Number(event?.clientX);
          const clientY = Number(event?.clientY);
          if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) return;
          const within = clientX >= activeRect.left && clientX <= activeRect.right && clientY >= activeRect.top && clientY <= activeRect.bottom;
          if (!within) {
            if (hovering && !dragging) {
              hovering = false;
              updatePoolGrowthEstimator(root);
            }
            return;
          }
          hovering = true;
          const ratio = (clientX - activeRect.left) / activeRect.width;
          const injected = clampScenarioInjected(ratio * maxInjected, maxInjected);
          commitInjectedValue(injected);
        };
        const clearHover = () => {
          updatePoolGrowthEstimator(root);
        };
        const startDragging = (event) => {
          dragging = true;
          updateFromEvent(event);
          const target = event?.currentTarget || event?.target;
          if (target && typeof target.setPointerCapture === 'function' && Number.isFinite(event?.pointerId)) {
            try {
              target.setPointerCapture(event.pointerId);
            } catch (error) {
              // ignore pointer-capture failures in non-interactive test environments
            }
          }
        };
        const stopDragging = () => {
          dragging = false;
          clearHover();
        };
        const hoverTargets = [hitArea, svg, plot, scenario].filter(Boolean);
        const globalTargets = [document, window].filter(Boolean);
        for (const target of hoverTargets) {
          target.addEventListener('mousemove', updateFromEvent);
          target.addEventListener('pointermove', updateFromEvent);
          target.addEventListener('pointerdown', startDragging);
          target.addEventListener('mousedown', startDragging);
          target.addEventListener('pointerup', stopDragging);
          target.addEventListener('pointercancel', stopDragging);
          target.addEventListener('mouseup', stopDragging);
        }
        for (const target of globalTargets) {
          target.addEventListener('mousemove', updateFromEvent);
          target.addEventListener('pointermove', updateFromEvent);
          target.addEventListener('pointerup', stopDragging);
          target.addEventListener('pointercancel', stopDragging);
          target.addEventListener('mouseup', stopDragging);
        }
        if (plot) {
          plot.addEventListener('pointerleave', () => {
            if (!dragging) {
              hovering = false;
              clearHover();
            }
          });
          plot.addEventListener('mouseleave', () => {
            if (!dragging) {
              hovering = false;
              clearHover();
            }
          });
        } else if (hitArea) {
          hitArea.addEventListener('pointerleave', () => {
            if (!dragging) {
              hovering = false;
              clearHover();
            }
          });
          hitArea.addEventListener('mouseleave', () => {
            if (!dragging) {
              hovering = false;
              clearHover();
            }
          });
        }
        clearHover();
      }

      function getPoolGrowthEstimatorRoot() {
        return document.getElementById('pool-growth-estimator');
      }

      function getPoolGrowthEstimatorState(root = getPoolGrowthEstimatorRoot()) {
        if (!root) return { available: false };
        return {
          available: root.dataset.poolAvailable === 'true',
          reason: root.dataset.poolReason || null,
          taoInPool: Number(root.dataset.poolTaoInPool),
          alphaInPool: Number(root.dataset.poolAlphaInPool),
          currentPrice: Number(root.dataset.poolCurrentPrice),
          marketCap: Number(root.dataset.poolMarketCap),
          scenarioMaxInjected: Number(root.dataset.poolScenarioMaxTaoInjected),
        };
      }

      function getPoolGrowthEstimatorInitialInjection(root = getPoolGrowthEstimatorRoot()) {
        const existing = root?.querySelector('#pool-growth-tao-injected');
        const persisted = existing ? Number(existing.value) : null;
        if (Number.isFinite(persisted) && persisted >= 0) return persisted;
        const preset = Number(root?.dataset.poolDefaultTaoInjected);
        return Number.isFinite(preset) && preset >= 0 ? preset : 10;
      }

      function updatePoolGrowthEstimator(root = getPoolGrowthEstimatorRoot()) {
        if (!root) return;
        const pool = getPoolGrowthEstimatorState(root);
        const input = root.querySelector('#pool-growth-tao-injected');
        const summary = root.querySelector('#pool-growth-summary');
        const alphaReceived = root.querySelector('#pool-growth-alpha-received');
        const alphaIdeal = root.querySelector('#pool-growth-alpha-ideal');
        const projectedPrice = root.querySelector('#pool-growth-projected-price');
        const postPool = root.querySelector('#pool-growth-post-pool');
        const priceChange = root.querySelector('#pool-growth-price-change');
        const slippage = root.querySelector('#pool-growth-slippage');
        const projectedMarketCap = root.querySelector('#pool-growth-projected-market-cap');
        const marketCapChange = root.querySelector('#pool-growth-market-cap-change');
        const projectedTaoReserve = root.querySelector('#pool-growth-projected-tao-reserve');
        const taoReserveChange = root.querySelector('#pool-growth-tao-reserve-change');
        const chartCaption = root.querySelector('#pool-growth-chart-caption');
        const chartCurrentValue = root.querySelector('#pool-growth-chart-current-value');
        const chartProjectedValue = root.querySelector('#pool-growth-chart-projected-value');
        const currentBar = root.querySelector('.pool-estimator-chart-fill.current');
        const projectedBar = root.querySelector('.pool-estimator-chart-fill.projected');
        const injected = Number(input?.value);
        const result = estimatePoolGrowthClient(pool, Number.isFinite(injected) ? injected : 0);
        if (!result.available) {
          if (summary) summary.textContent = pool.reason || 'Pool data unavailable for this subnet.';
          if (alphaReceived) alphaReceived.textContent = '—';
          if (alphaIdeal) alphaIdeal.textContent = 'No-slippage baseline';
          if (projectedPrice) projectedPrice.textContent = '—';
          if (postPool) postPool.textContent = 'Projected post-injection reserves';
          if (priceChange) priceChange.textContent = '—';
          if (slippage) slippage.textContent = 'Compared with current price';
          if (projectedMarketCap) projectedMarketCap.textContent = '—';
          if (marketCapChange) marketCapChange.textContent = 'Market cap unavailable';
          if (projectedTaoReserve) projectedTaoReserve.textContent = '—';
          if (taoReserveChange) taoReserveChange.textContent = 'Reserve change unavailable';
          if (chartCaption) chartCaption.textContent = 'Pool data unavailable.';
          if (currentBar) currentBar.style.width = '0%';
          if (projectedBar) projectedBar.style.width = '0%';
          updatePoolGrowthScenarioSelection(root, result, null);
          return;
        }

        const priceLabel = formatTao(result.currentPrice, 6) + ' / α';
        const projectedLabel = formatTao(result.projectedPrice, 6) + ' / α';
        const displayScale = Math.max(result.currentPrice, result.projectedPrice, result.currentPrice * 1.25, 1e-12);
        const currentWidth = Math.max(4, Math.min(100, (result.currentPrice / displayScale) * 100));
        const projectedWidth = Math.max(4, Math.min(100, (result.projectedPrice / displayScale) * 100));

        if (summary) {
          summary.textContent = [
            'Current pool: ',
            formatTao(result.taoInPool, 2),
            ' • ',
            formatAlpha(result.alphaInPool, 2),
            ' • price ',
            priceLabel,
          ].join('');
        }
        if (alphaReceived) alphaReceived.textContent = formatAlpha(result.alphaReceived, 4);
        if (alphaIdeal) alphaIdeal.textContent = 'No-slippage baseline: ' + formatAlpha(result.idealAlphaReceived, 4);
        if (projectedPrice) projectedPrice.textContent = projectedLabel;
        if (postPool) {
          postPool.textContent = [
            'Projected post-injection reserves: ',
            formatTao(result.projectedTaoInPool, 2),
            ' • ',
            formatAlpha(result.projectedAlphaInPool, 2),
          ].join('');
        }
        if (priceChange) {
          const changeText = formatSignedPercent(result.priceChangePct, 2);
          priceChange.textContent = changeText;
        }
        if (slippage) {
          slippage.textContent = [
            'Slippage: ',
            formatAlpha(result.alphaShortfall, 4),
            ' • ',
            formatSignedPercent(result.slippagePct, 2),
            ' of ideal',
          ].join('');
        }
        if (projectedMarketCap) {
          projectedMarketCap.textContent = Number.isFinite(result.projectedMarketCap)
            ? formatTao(result.projectedMarketCap, 2)
            : '—';
        }
        if (marketCapChange) {
          marketCapChange.textContent = Number.isFinite(result.marketCapChangePct)
            ? [
              'Change: ',
              formatSignedPercent(result.marketCapChangePct, 2),
              ' • current ',
              formatTao(result.marketCap, 2),
            ].join('')
            : 'Market cap unavailable from snapshot.';
        }
        if (projectedTaoReserve) {
          projectedTaoReserve.textContent = formatTao(result.projectedTaoInPool, 2);
        }
        if (taoReserveChange) {
          taoReserveChange.textContent = [
            'Reserve change: ',
            formatSignedTao(result.taoReserveChangeAbsolute, 2),
            ' • ',
            formatSignedPercent(result.taoReserveChangePct, 2),
          ].join('');
        }
        if (chartCaption) {
          chartCaption.textContent = [
            'Current: ',
            priceLabel,
            ' • projected: ',
            projectedLabel,
            ' • TAO injected: ',
            formatTao(result.taoInjected, 2),
          ].join('');
        }
        if (chartCurrentValue) chartCurrentValue.textContent = priceLabel;
        if (chartProjectedValue) chartProjectedValue.textContent = projectedLabel;
        if (currentBar) currentBar.style.width = currentWidth.toFixed(2) + '%';
        if (projectedBar) projectedBar.style.width = projectedWidth.toFixed(2) + '%';
        updatePoolGrowthScenarioSelection(root, result, null);
      }

      function initializePoolGrowthEstimator(root = getPoolGrowthEstimatorRoot()) {
        if (!root || root.dataset.poolGrowthInitialized === 'true') return;
        root.dataset.poolGrowthInitialized = 'true';
        syncPoolGrowthEstimatorLayout(root);
        const input = root.querySelector('#pool-growth-tao-injected');
        if (input) {
          input.addEventListener('input', () => updatePoolGrowthEstimator(root));
          input.addEventListener('change', () => updatePoolGrowthEstimator(root));
        }
        root.querySelectorAll('[data-pool-preset]').forEach((button) => {
          button.addEventListener('click', () => {
            if (!input) return;
            input.value = String(button.dataset.poolPreset || '');
            updatePoolGrowthEstimator(root);
          });
        });
        updatePoolGrowthEstimator(root);
        initializePoolGrowthScenarioInteractions(root);
      }

      function formatBaseMetric(value, format) {
        switch (format) {
          case 'number': {
            const num = Number(value);
            return Number.isFinite(num)
              ? new Intl.NumberFormat('en-US', { maximumFractionDigits: 4 }).format(num)
              : '—';
          }
          case 'integer':
            return formatInteger(value);
          case 'compact':
            return formatCompact(value);
          case 'signedCompact':
            return formatSignedCompact(value);
          case 'signedPercent':
            return formatSignedPercent(value);
          case 'percent':
            return formatPercent(value);
          case 'percentRatio':
            return formatPercentRatio(value);
          case 'tao':
            return formatTao(value);
          case 'signedTao':
            return formatSignedTao(value);
          case 'usd':
            return formatUsd(value);
          case 'signedUsd':
            return formatSignedUsd(value);
          case 'text':
          default:
            return value === null || value === undefined || value === '' ? '—' : String(value);
        }
      }

      function resolveMetricFormat(metric) {
        if (metric.currencyMode === 'tao' && state.displayCurrency === 'usd') {
          if (metric.valueFormat === 'signedTao') return 'signedUsd';
          return 'usd';
        }
        return metric.valueFormat || 'text';
      }

      function getRowPriceUsd(metric) {
        const metricPrice = Number(metric.taoPriceUsd);
        if (Number.isFinite(metricPrice)) return metricPrice;
        if (Number.isFinite(state.latestTaoPriceUsd)) return state.latestTaoPriceUsd;
        return null;
      }

      function resolveUsdPrice(candidate, fallback) {
        const price = Number(candidate);
        if (Number.isFinite(price) && price > 0) return price;
        const fallbackPrice = Number(fallback);
        return Number.isFinite(fallbackPrice) && fallbackPrice > 0 ? fallbackPrice : null;
      }

      function valueToDisplay(metric, overrideValue) {
        const rawValue = overrideValue !== undefined ? overrideValue : metric.taoValue;
        const num = Number(rawValue);
        if (!Number.isFinite(num)) return null;
        if (metric.currencyMode === 'tao' && state.displayCurrency === 'usd') {
          const priceUsd = getRowPriceUsd(metric);
          if (!Number.isFinite(priceUsd)) return null;
          return num * priceUsd;
        }
        return num;
      }

      function formatMetricForDisplay(metric, overrideValue) {
        if (!metric) return '—';
        if (metric.kind === 'comparison') {
          return formatComparison(metric);
        }
        const displayValue = valueToDisplay(metric, overrideValue);
        return formatBaseMetric(displayValue, resolveMetricFormat(metric));
      }

      function formatComparison(metric) {
        const pctLabel = metric.pct === null || metric.pct === undefined ? '—' : formatSignedPercent(metric.pct, 2);
        if (metric.currencyMode === 'tao') {
          if (state.displayCurrency === 'usd') {
            const latestPrice = resolveUsdPrice(metric.latestTaoPriceUsd, state.latestTaoPriceUsd);
            const priorPrice = resolveUsdPrice(metric.priorTaoPriceUsd, state.latestTaoPriceUsd);
            if (!Number.isFinite(latestPrice) || !Number.isFinite(priorPrice)) {
              return '— (' + pctLabel + ')';
            }
            const latestUsd = Number(metric.latestValue) * latestPrice;
            const priorUsd = Number(metric.priorValue) * priorPrice;
            const deltaUsd = Number.isFinite(latestUsd) && Number.isFinite(priorUsd) ? latestUsd - priorUsd : null;
            return formatSignedUsd(deltaUsd, 4) + ' (' + pctLabel + ')';
          }
          return formatSignedTao(metric.delta, 4) + ' (' + pctLabel + ')';
        }
        return formatSignedCompact(metric.delta, 4) + ' (' + pctLabel + ')';
      }

      function displayMetricText(metric) {
        if (!metric) return '—';
        if (metric.kind === 'comparison') {
          return formatComparison(metric);
        }
        if (metric.currencyMode === 'tao') {
          return formatMetricForDisplay(metric);
        }
        return metric.latestValue ?? metric.rawValue ?? '—';
      }

      function displayCardText(metric) {
        if (!metric) return '—';
        if (metric.displayValue !== undefined) return metric.displayValue;
        return displayMetricText(metric);
      }

      function formatWalletAmount(value, digits = 2, priceUsd = null) {
        if (value === null || value === undefined || value === '') return '—';
        const num = Number(value);
        if (!Number.isFinite(num)) return '—';
        if (state.displayCurrency === 'usd') {
          const resolved = resolveUsdPrice(priceUsd, state.latestTaoPriceUsd);
          if (!Number.isFinite(resolved)) return '—';
          return formatUsd(num * resolved, digits);
        }
        return formatTao(num, digits);
      }

      function formatWalletSignedAmount(value, digits = 2, priceUsd = null) {
        if (value === null || value === undefined || value === '') return '—';
        const num = Number(value);
        if (!Number.isFinite(num)) return '—';
        if (state.displayCurrency === 'usd') {
          const resolved = resolveUsdPrice(priceUsd, state.latestTaoPriceUsd);
          if (!Number.isFinite(resolved)) return '—';
          return formatSignedUsd(num * resolved, digits);
        }
        return formatSignedTao(num, digits);
      }

      function formatSignedAlphaAmount(value, digits = 4) {
        if (value === null || value === undefined || value === '') return '—';
        const num = Number(value);
        if (!Number.isFinite(num)) return '—';
        const sign = num > 0 ? '+' : num < 0 ? '-' : '';
        return sign + formatAlpha(Math.abs(num), digits);
      }

      function toAlphaUnits(value) {
        if (value === null || value === undefined || value === '') return null;
        const num = Number(value);
        if (!Number.isFinite(num)) return null;
        return Math.abs(num) >= 1e6 ? num / 1e9 : num;
      }

      function renderWalletDetails(metric) {
        if (!modalElements.walletDetails) return;
        if (!metric || metric.kind !== 'wallet') {
          modalElements.walletDetails.hidden = true;
          modalElements.walletDetails.innerHTML = '';
          return;
        }

        try {
          const breakdown = metric.walletBreakdown || {};
          const toNumeric = (value) => {
            if (value === null || value === undefined || value === '') return null;
            const num = Number(value);
            return Number.isFinite(num) ? num : null;
          };
          const total = toNumeric(breakdown.total);
          const free = toNumeric(breakdown.free);
          const staked = toNumeric(breakdown.staked);
          const root = toNumeric(breakdown.root);
          const change24h = toNumeric(breakdown.change24h);
          const priceUsd = resolveUsdPrice(metric.latestTaoPriceUsd, state.latestTaoPriceUsd);
          const percent = (part, whole) => (Number.isFinite(part) && Number.isFinite(whole) && whole > 0 ? (part / whole) * 100 : null);
          const rootPct = percent(root, staked);
          const freePct = percent(free, total);
          const stakedPct = percent(staked, total);
          const stakeCount = Number(metric.stakeCount || 0);
          const stakeSummary = Number.isFinite(stakeCount) && stakeCount > 0
            ? stakeCount + ' current subnet stake position' + (stakeCount === 1 ? '' : 's')
            : 'No current subnet stake positions were returned for this wallet.';
          const stakePositions = Array.isArray(metric.stakePositions) ? metric.stakePositions.slice(0, 20) : [];
          const configuredHotkeys = Array.isArray(metric.configuredHotkeys) ? metric.configuredHotkeys.slice(0, 20) : [];
          const configuredHotkeyMap = new Map(configuredHotkeys
            .filter((hotkey) => hotkey && hotkey.ss58)
            .map((hotkey) => [String(hotkey.ss58), hotkey]));
          const walletAttribution = buildWalletAttributionSummary({
            totalChange: change24h,
            stakePositions,
            configuredHotkeys,
          });
          const configuredHotkeyRows = configuredHotkeys.length
            ? configuredHotkeys.map((hotkey) => {
                const label = hotkey.name || shortAddress(hotkey.ss58 || '—');
                const hotkeyNetuid = hotkey.netuid !== null && hotkey.netuid !== undefined ? 'Netuid ' + hotkey.netuid : null;
                const hotkeyNetwork = hotkey.network ? String(hotkey.network) : null;
                const hotkeyRole = labelHotkeyRole(hotkey.role);
                return [
                  '<span class="wallet-hotkey-pill">',
                  '<strong>' + escapeHtml(label) + '</strong>',
                  '<small>' + escapeHtml([shortAddress(hotkey.ss58 || '—'), hotkeyRole !== '—' ? hotkeyRole : null, hotkeyNetuid, hotkeyNetwork].filter(Boolean).join(' • ')) + '</small>',
                  '</span>',
                ].join('');
              }).join('')
            : '';
          const walletProfile = metric.walletProfile || {};
          const walletProfileCards = [
            {
              label: 'Rank',
              value: Number.isFinite(Number(walletProfile.rank)) ? formatInteger(walletProfile.rank) : '—',
              subtext: 'Current Taostats rank',
            },
            {
              label: 'Created',
              value: walletProfile.createdOnDate || '—',
              subtext: walletProfile.createdOnNetwork ? 'Created on ' + walletProfile.createdOnNetwork : 'Wallet creation date',
            },
            {
              label: 'Hotkeys',
              value: Number.isFinite(Number(walletProfile.hotkeyCount)) ? formatInteger(walletProfile.hotkeyCount) : '—',
              subtext: walletProfile.hotkeySummary || 'Configured hotkeys',
            },
            {
              label: 'Coldkey swap',
              value: resolveColdkeySwapSummary(walletProfile.rawJson, walletProfile.coldkeySwap),
              subtext: 'Coldkey swap status from Taostats',
            },
          ];
          const walletProfileRows = walletProfileCards.map((item) => [
            '<div class="wallet-breakdown-card">',
            '  <div class="label">' + escapeHtml(item.label) + '</div>',
            '  <div class="value">' + escapeHtml(item.value) + '</div>',
            '  <div class="subtext">' + escapeHtml(item.subtext) + '</div>',
            '</div>',
          ].join('')).join('');
          const alphaStakeRaw = (() => {
            const totalRaw = stakePositions.reduce((sum, position) => {
              const raw = toAlphaUnits(position.balance_num ?? position.balance ?? position.balance_as_tao_num ?? null);
              return Number.isFinite(raw) ? sum + raw : sum;
            }, 0);
            return Number.isFinite(totalRaw) && totalRaw > 0 ? totalRaw : null;
          })();
          const alphaPrice = Number(metric.poolEstimator?.currentPool?.currentPrice);
          const alphaChangeFromSnapshotTao = toNumeric(breakdown.alpha24h);
          const alphaChangeFromSnapshotRaw = Number.isFinite(alphaChangeFromSnapshotTao) && Number.isFinite(alphaPrice) && alphaPrice > 0
            ? alphaChangeFromSnapshotTao / alphaPrice
            : null;
          const alphaHistorySeries = (() => {
            if (!Array.isArray(state.modalStakeHistory) || !state.modalStakeHistory.length) return [];
            const totalsByCapture = new Map();
            for (const row of state.modalStakeHistory) {
              const capturedAt = row?.captured_at ? new Date(row.captured_at).getTime() : null;
              if (!Number.isFinite(capturedAt)) continue;
              const raw = toAlphaUnits(row.balance_num ?? row.balance ?? row.balance_as_tao_num ?? null);
              if (!Number.isFinite(raw)) continue;
              totalsByCapture.set(capturedAt, (totalsByCapture.get(capturedAt) || 0) + raw);
            }
            return [...totalsByCapture.entries()].sort((a, b) => a[0] - b[0]);
          })();
          const alphaHistoryChangeRaw = alphaHistorySeries.length > 1
            ? (() => {
                const latestPoint = alphaHistorySeries[alphaHistorySeries.length - 1];
                const targetTime = latestPoint[0] - (24 * 60 * 60 * 1000);
                let priorPoint = alphaHistorySeries[0];
                let closestDistance = Infinity;
                for (const point of alphaHistorySeries) {
                  const distance = Math.abs(point[0] - targetTime);
                  if (distance < closestDistance) {
                    closestDistance = distance;
                    priorPoint = point;
                  }
                }
                const delta = latestPoint[1] - priorPoint[1];
                return Number.isFinite(delta) ? delta : null;
              })()
            : null;
          const alphaDailyChangeRaw = Number.isFinite(alphaChangeFromSnapshotRaw)
            ? alphaChangeFromSnapshotRaw
            : alphaHistoryChangeRaw;
          const alphaDailyChangeTao = Number.isFinite(alphaChangeFromSnapshotTao)
            ? alphaChangeFromSnapshotTao
            : (Number.isFinite(alphaHistoryChangeRaw) && Number.isFinite(alphaPrice) && alphaPrice > 0
              ? alphaHistoryChangeRaw * alphaPrice
              : null);
          const stakeCards = stakePositions.map((position) => {
            const balance = toAlphaUnits(position.balance_num ?? position.balance ?? null);
            const hotkeyLabel = position.hotkey_name
              || (position.hotkey_address_ss58 && configuredHotkeyMap.has(String(position.hotkey_address_ss58))
                ? (configuredHotkeyMap.get(String(position.hotkey_address_ss58)).name || shortAddress(position.hotkey_address_ss58))
                : shortAddress(position.hotkey_address_ss58 || '—'));
            const hotkeyRole = labelHotkeyRole(inferHotkeyRoleFromMetadata(position, configuredHotkeyMap));
            return [
              '<div class="wallet-current-stake-card">',
              '  <div class="label">Netuid ' + escapeHtml(position.netuid ?? '—') + '</div>',
              '  <div class="value">' + escapeHtml(Number.isFinite(balance) ? formatAlpha(balance, 4) : '—') + '</div>',
              '  <div class="subtext">' + escapeHtml(hotkeyLabel) + (hotkeyRole !== '—' ? ' • ' + escapeHtml(hotkeyRole) : '') + ' • Rank ' + escapeHtml(position.subnet_rank ?? '—') + '</div>',
              '</div>',
            ].join('');
          }).join('');
          const walletStakeHistoryRows = Array.isArray(state.modalStakeHistory) && state.modalStakeHistory.length
            ? (() => {
                const chronological = [...state.modalStakeHistory]
                  .sort((a, b) => new Date(a.captured_at).getTime() - new Date(b.captured_at).getTime())
                  .slice(0, 200);
                const previousByKey = new Map();
                const rows = [];
                for (const position of chronological) {
                  const balance = toAlphaUnits(position.balance_num ?? position.balance ?? null);
                  const hotkeyKey = String(position.hotkey_address_ss58 || position.hotkey_name || position.netuid || 'unknown');
                  const priorBalance = previousByKey.has(hotkeyKey) ? previousByKey.get(hotkeyKey) : null;
                  const delta = Number.isFinite(Number(balance)) && Number.isFinite(Number(priorBalance))
                    ? Number(balance) - Number(priorBalance)
                    : null;
                  previousByKey.set(hotkeyKey, balance);
                  const hotkeyLabel = position.hotkey_name
                    || (position.hotkey_address_ss58 && configuredHotkeyMap.has(String(position.hotkey_address_ss58))
                      ? (configuredHotkeyMap.get(String(position.hotkey_address_ss58)).name || shortAddress(position.hotkey_address_ss58))
                      : shortAddress(position.hotkey_address_ss58 || '—'));
                  const snapshotLabel = position.captured_at
                    ? new Date(position.captured_at).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })
                    : '—';
                  const deltaClass = delta === null ? 'neutral' : (delta > 0 ? 'positive' : (delta < 0 ? 'negative' : 'neutral'));
                  rows.push([
                    '<tr>',
                    '<td>' + escapeHtml(snapshotLabel) + '</td>',
                    '<td>' + escapeHtml(hotkeyLabel) + '</td>',
                    '<td>' + escapeHtml(position.netuid ?? '—') + '</td>',
                    '<td>' + escapeHtml(Number.isFinite(balance) ? formatAlpha(balance, 4) : '—') + '</td>',
                    '<td>' + escapeHtml(position.subnet_rank ?? '—') + '</td>',
                    '<td><span class="wallet-history-delta ' + deltaClass + '">' + escapeHtml(delta === null ? '—' : formatSignedAlphaAmount(delta, 4)) + '</span></td>',
                    '</tr>',
                  ].join(''));
                }
                return rows.reverse().join('');
              })()
            : '';
          const walletAttributionHistoryRows = Array.isArray(state.modalHistory) && state.modalHistory.length > 1
            ? (() => {
                const chronological = [...state.modalHistory]
                  .sort((a, b) => new Date(a.captured_at).getTime() - new Date(b.captured_at).getTime())
                  .slice(0, 120);
                const rows = [];
                let previousTotal = null;
                for (const row of chronological) {
                  const currentTotal = Number(row.balance_total_num);
                  if (!Number.isFinite(currentTotal)) {
                    previousTotal = currentTotal;
                    continue;
                  }
                  const delta = Number.isFinite(Number(previousTotal)) ? currentTotal - Number(previousTotal) : null;
                  previousTotal = currentTotal;
                  const attribution = buildWalletAttributionSummary({
                    totalChange: delta,
                    stakePositions,
                    configuredHotkeys,
                  });
                  const snapshotLabel = row.captured_at
                    ? new Date(row.captured_at).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })
                    : '—';
                  rows.push([
                    '<tr>',
                    '<td>' + escapeHtml(snapshotLabel) + '</td>',
                    '<td>' + escapeHtml(formatWalletAmount(currentTotal, 2, priceUsd)) + '</td>',
                    '<td><span class="wallet-history-delta ' + (attribution.validator === null ? 'neutral' : (attribution.validator > 0 ? 'positive' : (attribution.validator < 0 ? 'negative' : 'neutral'))) + '">' + escapeHtml(formatWalletSignedAmount(attribution.validator, 2, priceUsd)) + '</span></td>',
                    '<td><span class="wallet-history-delta ' + (attribution.owner === null ? 'neutral' : (attribution.owner > 0 ? 'positive' : (attribution.owner < 0 ? 'negative' : 'neutral'))) + '">' + escapeHtml(formatWalletSignedAmount(attribution.owner, 2, priceUsd)) + '</span></td>',
                    '<td><span class="wallet-history-delta ' + (attribution.residual === null ? 'neutral' : (attribution.residual > 0 ? 'positive' : (attribution.residual < 0 ? 'negative' : 'neutral'))) + '">' + escapeHtml(formatWalletSignedAmount(attribution.residual, 2, priceUsd)) + '</span></td>',
                    '</tr>',
                  ].join(''));
                }
                return rows.reverse().join('');
              })()
            : '';

          modalElements.walletDetails.hidden = false;
          const freeText = freePct === null ? 'Available balance' : freePct.toFixed(1) + '% of total';
          const stakedText = stakedPct === null ? 'Locked in stake' : stakedPct.toFixed(1) + '% of total';
          const rootText = rootPct === null ? 'Stake at root' : rootPct.toFixed(1) + '% of staked';
          const alphaText = Number.isFinite(alphaStakeRaw)
            ? 'Raw α from current subnet stake positions'
            : 'Raw α unavailable until stake history loads';
          const alphaChangeText = Number.isFinite(alphaDailyChangeRaw)
            ? '24h change: ' + formatSignedAlphaAmount(alphaDailyChangeRaw, 4)
            : '24h change unavailable';
          const alphaChangeTaoText = Number.isFinite(alphaDailyChangeTao)
            ? '≈ ' + formatSignedTao(alphaDailyChangeTao, 2) + ' at current price'
            : 'Compared with the previous day';
          modalElements.walletDetails.innerHTML = [
            '<h4 class="wallet-details-title">Wallet breakdown</h4>',
            '<div class="wallet-breakdown-row">',
            '  <div class="wallet-breakdown-card">',
            '    <div class="label">Total</div>',
            '    <div class="value">' + escapeHtml(formatWalletAmount(total, 2, priceUsd)) + '</div>',
            '    <div class="subtext">Overall wallet balance</div>',
            '  </div>',
            '  <div class="wallet-breakdown-card">',
            '    <div class="label">Free</div>',
            '    <div class="value">' + escapeHtml(formatWalletAmount(free, 2, priceUsd)) + '</div>',
            '    <div class="subtext">' + escapeHtml(freeText) + '</div>',
            '  </div>',
            '  <div class="wallet-breakdown-card">',
            '    <div class="label">Staked</div>',
            '    <div class="value">' + escapeHtml(formatWalletAmount(staked, 2, priceUsd)) + '</div>',
            '    <div class="subtext">' + escapeHtml(stakedText) + '</div>',
            '  </div>',
            '  <div class="wallet-breakdown-card">',
            '    <div class="label">Root</div>',
            '    <div class="value">' + escapeHtml(formatWalletAmount(root, 2, priceUsd)) + '</div>',
            '    <div class="subtext">' + escapeHtml(rootText) + '</div>',
            '  </div>',
            '  <div class="wallet-breakdown-card">',
            '    <div class="label">Alpha stake</div>',
            '    <div class="value">' + escapeHtml(Number.isFinite(alphaStakeRaw) ? formatAlpha(alphaStakeRaw, 4) : '—') + '</div>',
            '    <div class="subtext">' + escapeHtml(alphaText) + '</div>',
            '    <div class="subtext wallet-alpha-change">' + escapeHtml(alphaChangeText) + '</div>',
            '    <div class="subtext wallet-alpha-change">' + escapeHtml(alphaChangeTaoText) + '</div>',
            '  </div>',
            '  <div class="wallet-breakdown-card">',
            '    <div class="label">24h Change</div>',
            '    <div class="value">' + escapeHtml(formatWalletSignedAmount(change24h, 2, priceUsd)) + '</div>',
            '    <div class="subtext">Compared with the previous day</div>',
            '  </div>',
            '</div>',
            '<div class="wallet-profile">',
            '  <h4 class="wallet-details-title">Wallet profile</h4>',
            '  <div class="wallet-breakdown-grid">' + walletProfileRows + '</div>',
            '</div>',
            '<div class="wallet-attribution">',
            '  <h4 class="wallet-details-title">Income sources</h4>',
            '  <p class="wallet-history-note">' + escapeHtml(walletAttribution.hasAnySplit
              ? 'Estimated split of recent wallet growth based on known hotkey roles only. Untagged balance stays in residual.'
              : 'Configure HOTKEY_ROLE values in .env to split validator and owner inflows. Until then, this section stays mixed.') + '</p>',
            '  <div class="wallet-current-stake-row">',
            '    <div class="wallet-current-stake-card">',
            '      <div class="label">24h change</div>',
            '      <div class="value">' + escapeHtml(formatWalletSignedAmount(walletAttribution.totalChange, 2, priceUsd)) + '</div>',
            '      <div class="subtext">Total wallet balance movement</div>',
            '    </div>',
            '    <div class="wallet-current-stake-card">',
            '      <div class="label">Validator</div>',
            '      <div class="value">' + escapeHtml(formatWalletSignedAmount(walletAttribution.validator, 2, priceUsd)) + '</div>',
            '      <div class="subtext">' + escapeHtml(walletAttribution.hasAnySplit ? 'Estimated validator-side inflow from known roles' : 'Needs hotkey role metadata') + '</div>',
            '    </div>',
            '    <div class="wallet-current-stake-card">',
            '      <div class="label">Owner</div>',
            '      <div class="value">' + escapeHtml(formatWalletSignedAmount(walletAttribution.owner, 2, priceUsd)) + '</div>',
            '      <div class="subtext">' + escapeHtml(walletAttribution.owner === null ? (walletAttribution.hasAnySplit ? 'Needs owner hotkey metadata' : 'Needs hotkey role metadata') : 'Estimated owner-side inflow') + '</div>',
            '    </div>',
            '    <div class="wallet-current-stake-card">',
            '      <div class="label">Residual</div>',
            '      <div class="value">' + escapeHtml(formatWalletSignedAmount(walletAttribution.residual, 2, priceUsd)) + '</div>',
            '      <div class="subtext">' + escapeHtml(walletAttribution.hasAnySplit ? 'Untagged / unclassified remainder' : 'Needs hotkey role metadata') + '</div>',
            '    </div>',
            '  </div>',
            walletAttributionHistoryRows
              ? [
                  '  <details class="wallet-attribution-history">',
                  '    <summary>Estimated income history</summary>',
                  '    <p class="wallet-history-note">Daily balance deltas split using the known hotkey role mix. Untagged remainder stays residual, and if you change roles later the historical estimates will follow the current labels.</p>',
                  '    <div class="wallet-positions-scroll wallet-history-scroll">',
                  '      <table class="wallet-positions-table">',
                  '        <thead>',
                  '          <tr>',
                  '            <th>Snapshot time</th>',
                  '            <th>Total change</th>',
                  '            <th>Validator est</th>',
                  '            <th>Owner est</th>',
                  '            <th>Residual</th>',
                  '          </tr>',
                  '        </thead>',
                  '        <tbody>' + walletAttributionHistoryRows + '</tbody>',
                  '      </table>',
                  '    </div>',
                  '  </details>',
                ].join('')
              : '',
            '</div>',
            '<div class="wallet-positions">',
            '  <div class="wallet-positions-head">',
            '    <h4 class="wallet-details-title">Current subnet stake</h4>',
            '    <p class="wallet-history-note">' + escapeHtml(stakeSummary) + '</p>',
            '  </div>',
            configuredHotkeyRows
              ? [
                  '  <div class="wallet-hotkeys">',
                  '    <h4 class="wallet-details-title">Configured hotkeys</h4>',
                  '    <div class="wallet-hotkey-list">' + configuredHotkeyRows + '</div>',
                  '  </div>',
                ].join('')
              : '',
            stakeCards
              ? [
                  '  <div class="wallet-current-stake-row">',
                  '    ' + stakeCards,
                  '  </div>',
                ].join('')
              : '<p class="wallet-positions-empty">No current subnet stake positions were returned for this wallet.</p>',
            [
              '  <details class="wallet-history-details">',
              '    <summary>Hotkey history</summary>',
              '    <p class="wallet-history-note">Daily stake snapshots from Taostats, useful for seeing how each hotkey has changed over time.</p>',
              state.modalStakeHistory === null
                ? '<p class="wallet-positions-empty">Loading hotkey history…</p>'
                : walletStakeHistoryRows
                  ? [
                      '    <div class="wallet-positions-scroll wallet-history-scroll">',
                      '      <table class="wallet-positions-table">',
                      '        <thead>',
                      '          <tr>',
                      '            <th>Snapshot time</th>',
                      '            <th>Hotkey</th>',
                      '            <th>Netuid</th>',
                      '            <th>Stake</th>',
                      '            <th>Rank</th>',
                      '            <th>Change</th>',
                      '          </tr>',
                      '        </thead>',
                      '        <tbody>' + walletStakeHistoryRows + '</tbody>',
                      '      </table>',
                      '    </div>',
                    ].join('')
                  : '<p class="wallet-positions-empty">No historical hotkey stake snapshots are stored yet.</p>',
              '  </details>',
            ].join(''),
            '</div>',
          ].join('');
        } catch (error) {
          console.warn('Unable to render wallet details for', metric.label, error);
          if (modalElements.walletDetails) {
            modalElements.walletDetails.hidden = false;
            const message = error && error.message ? error.message : String(error || 'Unknown error');
            const stack = error && error.stack ? String(error.stack).split('\\n').slice(0, 3).join('\\n') : '';
            modalElements.walletDetails.innerHTML = [
              '<div class="pool-estimator-unavailable">',
              '  <p>Wallet details could not render.</p>',
              '  <p><strong>Debug:</strong> ' + escapeHtml(message) + '</p>',
              stack ? '<pre style="white-space:pre-wrap;margin:0;color:#93a4ba;">' + escapeHtml(stack) + '</pre>' : '',
              '</div>',
            ].join('');
          }
        }
      }

      function walletTransactionRangeLabel(days) {
        if (days === 0) return 'All wallet transactions';
        if (days === 1) return 'Last 24 hours';
        if (days === 7) return 'Last 7 days';
        if (days === 30) return 'Last 30 days';
        if (days === 60) return 'Last 60 days';
        return 'Last ' + days + ' days';
      }

      function walletTransactionRangeSubtitle(days) {
        if (days === 0) return 'Showing every matched row available in the local SQLite cache.';
        if (days === 1) return 'Showing the last 24 hours of wallet activity.';
        return 'Showing the last ' + days + ' day' + (days === 1 ? '' : 's') + ' of wallet activity.';
      }

      function walletTransactionGroup(row) {
        const sourceType = String(row?.source_type || '').toLowerCase();
        const actionKey = String(row?.action_key || '').toLowerCase();
        if (sourceType === 'transfer' || actionKey === 'transfer') return 'transfer';
        if (sourceType === 'stake_history' || actionKey.startsWith('stake_') || actionKey === 'unstake') return 'stake';
        return 'other';
      }

      function walletTransactionCounterparty(row) {
        if (!row) return '—';
        if (row.source_type === 'transfer') {
          const parts = [];
          if (row.from_ss58) parts.push(shortAddress(row.from_ss58));
          if (row.to_ss58) parts.push(shortAddress(row.to_ss58));
          return parts.length ? parts.join(' → ') : 'Coldkey transfer';
        }
        if (row.hotkey_name) return row.hotkey_name;
        if (row.hotkey_ss58) return shortAddress(row.hotkey_ss58);
        return '—';
      }

      function walletTransactionDetailText(row) {
        if (!row) return '';
        const raw = row.raw ?? {};
        return JSON.stringify({
          source_type: row.source_type,
          action: row.action,
          action_key: row.action_key,
          timestamp: row.timestamp,
          block_number: row.block_number,
          extrinsic_id: row.extrinsic_id,
          transaction_hash: row.transaction_hash,
          coldkey_ss58: row.coldkey_ss58,
          hotkey_ss58: row.hotkey_ss58,
          hotkey_name: row.hotkey_name,
          netuid: row.netuid,
          amount_tao: row.amount_tao,
          amount_alpha: row.amount_alpha,
          from_ss58: row.from_ss58,
          to_ss58: row.to_ss58,
          status: row.status,
          note: row.note,
          raw,
        }, null, 2);
      }

      function walletTransactionFilterMatches(row, filter) {
        const effective = String(filter || 'all');
        if (effective === 'all') return true;
        return walletTransactionGroup(row) === effective;
      }

      function renderWalletTransactions(metric, payload = null) {
        if (!txModalElements.backdrop || !txModalElements.tableBody) return;
        const rows = Array.isArray(payload?.rows) ? payload.rows : [];
        const loading = Boolean(payload?.loading);
        const filteredRows = rows.filter((row) => walletTransactionFilterMatches(row, state.modalTransactionsFilter));
        const summary = payload?.summary || {};
        const stakeRows = rows.filter((row) => walletTransactionGroup(row) === 'stake').length;
        const transferRows = rows.filter((row) => walletTransactionGroup(row) === 'transfer').length;
        const syncStatusText = payload?.syncStatus?.text ? String(payload.syncStatus.text) : '';
        const syncStatusOk = payload?.syncStatus ? payload.syncStatus.ok !== false : true;
        txRangeButtons.forEach((button) => {
          const days = Number(button.dataset.walletTxRange);
          const active = days === state.modalTransactionsDays;
          button.classList.toggle('active', active);
          button.setAttribute('aria-pressed', active ? 'true' : 'false');
        });
        txFilterButtons.forEach((button) => {
          const filter = String(button.dataset.walletTxFilter || 'all');
          const active = filter === state.modalTransactionsFilter;
          button.classList.toggle('active', active);
          button.setAttribute('aria-pressed', active ? 'true' : 'false');
        });
        const walletLabel = metric?.label || metric?.sourceText || 'Wallet';
        txModalElements.title.textContent = walletLabel + ' transactions';
        txModalElements.subtitle.textContent = walletTransactionRangeLabel(state.modalTransactionsDays) + ' • ' + walletTransactionRangeSubtitle(state.modalTransactionsDays);
        const payloadIssue = !loading && payload && payload.reason && payload.available === false;
        const payloadWarning = payload && payload.warning ? String(payload.warning) : '';
        if (txModalElements.explanation) {
          txModalElements.explanation.hidden = !payloadIssue;
          txModalElements.explanation.textContent = payload?.reason || '';
        }
        if (txModalElements.count) txModalElements.count.textContent = loading ? '—' : (Number.isFinite(Number(summary.total)) ? formatInteger(summary.total) : String(rows.length || 0));
        if (txModalElements.stakeCount) txModalElements.stakeCount.textContent = loading ? '—' : formatInteger(stakeRows);
        if (txModalElements.transferCount) txModalElements.transferCount.textContent = loading ? '—' : formatInteger(transferRows);
        if (txModalElements.countNote) {
          txModalElements.countNote.textContent = loading
            ? 'Fetching wallet activity from the local SQLite cache…'
            : (payloadIssue
              ? payload.reason
              : (payloadWarning || syncStatusText || 'Matched rows from extrinsics, transfers, and hotkey stake snapshots.'));
        }
        if (txModalElements.note) {
          txModalElements.note.textContent = loading
            ? 'Fetching wallet activity…'
            : (payloadIssue
              ? payload.reason
              : (payloadWarning || syncStatusText || 'Click a row to inspect the raw payload and inference notes.'));
        }
        if (txModalElements.explanation && !loading && !payloadIssue && syncStatusText) {
          txModalElements.explanation.hidden = false;
          txModalElements.explanation.textContent = syncStatusOk
            ? 'Wallet sync status: ' + syncStatusText
            : 'Wallet sync deferred; showing cached transaction rows. ' + syncStatusText;
        }
        if (payloadWarning && txModalElements.explanation) {
          txModalElements.explanation.hidden = true;
          txModalElements.explanation.textContent = '';
        }
        if (payloadWarning && txModalElements.note && !payloadIssue) {
          txModalElements.note.textContent = payloadWarning;
        }
        if (payloadWarning && txModalElements.countNote && !payloadIssue) {
          txModalElements.countNote.textContent = payloadWarning;
        }

        if (loading) {
          txModalElements.tableBody.innerHTML = '<tr><td colspan="9" class="empty">Fetching wallet activity…</td></tr>';
          if (txModalElements.detailEmpty) txModalElements.detailEmpty.hidden = false;
          if (txModalElements.detail) {
            txModalElements.detail.hidden = true;
            txModalElements.detail.textContent = '';
          }
          return;
        }

        if (!filteredRows.length) {
          txModalElements.tableBody.innerHTML = '<tr><td colspan="9" class="empty">No matching transaction rows found for this filter.</td></tr>';
          if (txModalElements.detailEmpty) txModalElements.detailEmpty.hidden = false;
          if (txModalElements.detail) {
            txModalElements.detail.hidden = true;
            txModalElements.detail.textContent = '';
          }
          return;
        }

        txModalElements.tableBody.innerHTML = filteredRows.map((row, index) => {
          const amount = row.amount_tao === null || row.amount_tao === undefined ? '—' : formatWalletSignedAmount(row.amount_tao, 4, metric?.latestTaoPriceUsd ?? null);
          const time = row.timestamp ? new Date(row.timestamp).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }) : '—';
          const counterparty = walletTransactionCounterparty(row);
          const txId = row.extrinsic_id || row.transaction_hash || '—';
          const actionClass = walletTransactionGroup(row);
          const amountNum = Number(row.amount_tao);
          return [
            '<tr data-wallet-tx-row="', escapeHtml(String(index)), '" data-wallet-tx-filter-group="', escapeHtml(actionClass), '">',
            '<td>', escapeHtml(time), '</td>',
            '<td>', escapeHtml(row.action || '—'), '</td>',
            '<td>', escapeHtml(row.hotkey_name || (row.hotkey_ss58 ? shortAddress(row.hotkey_ss58) : '—')), '</td>',
            '<td>', escapeHtml(row.netuid ?? '—'), '</td>',
            '<td><span class="wallet-history-delta ', (Number.isFinite(amountNum) && amountNum !== 0 ? (amountNum > 0 ? 'positive' : 'negative') : 'neutral'), '">', escapeHtml(amount), '</span></td>',
            '<td>', escapeHtml(counterparty), '</td>',
            '<td>', escapeHtml(row.block_number ?? '—'), '</td>',
            '<td>', escapeHtml(String(txId).slice(0, 16)), '</td>',
            '<td>', escapeHtml(row.status || '—'), '</td>',
            '</tr>',
          ].join('');
        }).join('');

        const rowsHtml = filteredRows.map((row, index) => {
          const amount = row.amount_tao === null || row.amount_tao === undefined ? '—' : formatWalletSignedAmount(row.amount_tao, 4, metric?.latestTaoPriceUsd ?? null);
          const time = row.timestamp ? new Date(row.timestamp).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }) : '—';
          const counterparty = walletTransactionCounterparty(row);
          const txId = row.extrinsic_id || row.transaction_hash || '—';
          const actionClass = walletTransactionGroup(row);
          return {
            index,
            actionClass,
            detail: walletTransactionDetailText(row),
            time,
            amount,
            counterparty,
            txId,
            row,
          };
        });

        txModalElements.tableBody.querySelectorAll('[data-wallet-tx-row]').forEach((tr, index) => {
          tr.classList.toggle('active', index === 0);
          tr.addEventListener('click', () => {
            txModalElements.tableBody.querySelectorAll('[data-wallet-tx-row]').forEach((node) => node.classList.remove('active'));
            tr.classList.add('active');
            const item = rowsHtml[index];
            if (item && txModalElements.detail && txModalElements.detailEmpty) {
              txModalElements.detailEmpty.hidden = true;
              txModalElements.detail.hidden = false;
              txModalElements.detail.textContent = item.detail;
            }
          });
        });

        if (txModalElements.detail && txModalElements.detailEmpty) {
          const first = rowsHtml[0];
          txModalElements.detailEmpty.hidden = false;
          txModalElements.detail.hidden = true;
          txModalElements.detail.textContent = '';
          if (first) {
            txModalElements.detailEmpty.hidden = true;
            txModalElements.detail.hidden = false;
            txModalElements.detail.textContent = first.detail;
          }
        }
      }

      async function loadWalletTransactions(metric, days = 7, options = {}) {
        if (!metric || metric.kind !== 'wallet') return null;
        const address = metric.historyId || metric.walletAddress || metric.rawValue || metric.sourceText || '';
        if (!address) return null;
        const key = address + ':' + String(days);
        if (!options.refresh && state.modalTransactionsCache.has(key)) {
          return state.modalTransactionsCache.get(key);
        }
        const payload = await fetch('/api/wallets/' + encodeURIComponent(address) + '/transactions?days=' + encodeURIComponent(days) + (options.refresh ? '&refresh=1' : ''))
          .then(async (response) => {
            const json = await response.json();
            if (!response.ok) {
              return {
                available: false,
                reason: json?.error || json?.reason || ('Unable to load wallet transactions (' + response.status + ')'),
                rows: [],
                summary: {},
              };
            }
            return json;
          })
          .catch((error) => ({ available: false, reason: error?.message || 'Unable to load wallet transactions', rows: [], summary: {} }));
        if (Array.isArray(payload?.rows) && payload.rows.length > 0 && payload.available !== false) {
          state.modalTransactionsCache.set(key, payload);
        } else {
          state.modalTransactionsCache.delete(key);
        }
        return payload;
      }

      function openWalletTransactionsModal(metricJson) {
        const metric = typeof metricJson === 'string' ? JSON.parse(metricJson) : metricJson;
        state.modalTransactions = metric;
        state.modalTransactionsDays = 7;
        state.modalTransactionsFilter = 'all';
        if (modalElements.backdrop?.classList.contains('open')) {
          closeModal();
        }
        openModalTransactions();
        if (txModalElements.refresh) {
          txModalElements.refresh.hidden = false;
        }
        renderWalletTransactions(metric, { loading: true, available: true, rows: [], summary: {} });
        void loadWalletTransactions(metric, state.modalTransactionsDays).then((payload) => {
          if (state.modalTransactions !== metric) return;
          renderWalletTransactions(metric, payload || { available: false, rows: [], summary: {} });
        });
      }

      function openModalTransactions() {
        txModalElements.backdrop.classList.add('open');
        txModalElements.backdrop.setAttribute('aria-hidden', 'false');
        document.body.classList.add('modal-open');
      }

      function closeWalletTransactionsModal() {
        txModalElements.backdrop.classList.remove('open');
        txModalElements.backdrop.setAttribute('aria-hidden', 'true');
        document.body.classList.remove('modal-open');
        state.modalTransactions = null;
        state.modalTransactionsDays = 7;
        state.modalTransactionsFilter = 'all';
        if (txModalElements.detail) {
          txModalElements.detail.hidden = true;
          txModalElements.detail.textContent = '';
        }
        if (txModalElements.detailEmpty) {
          txModalElements.detailEmpty.hidden = false;
        }
        if (txModalElements.refresh) {
          txModalElements.refresh.hidden = true;
        }
      }

      function refreshWalletTransactionsView() {
        if (!state.modalTransactions) return;
        const metric = state.modalTransactions;
        const address = metric.historyId || metric.walletAddress || metric.rawValue || metric.sourceText || '';
        const cacheKey = address + ':' + String(state.modalTransactionsDays);
        const payload = state.modalTransactionsCache.get(cacheKey);
        renderWalletTransactions(metric, payload || { available: true, rows: [], summary: {} });
      }

      function refreshMetricElements() {
        document.querySelectorAll('[data-metric]').forEach((element) => {
          let metric = null;
          try {
            metric = JSON.parse(element.dataset.metric || '{}');
          } catch {
            metric = null;
          }
          if (!metric) return;
          const text = displayCardText(metric);
          if (element.classList.contains('card') || element.classList.contains('card-button')) {
            const valueEl = element.querySelector('.card-value');
            if (valueEl) valueEl.textContent = text;
          } else {
            element.textContent = text;
          }
        });
      }

      function updateCurrencyToggleButton() {
        if (!currencyToggle) return;
        const hasPrice = Number.isFinite(state.latestTaoPriceUsd);
        currencyToggle.disabled = !hasPrice;
        currencyToggle.textContent = state.displayCurrency === 'tao' ? 'Show USD' : 'Show TAO';
      }

      function updateTaoPriceLabel() {
        if (!taoPriceLabel) return;
        if (Number.isFinite(state.latestTaoPriceUsd)) {
          taoPriceLabel.textContent = 'TAO price used: τ 1 ≈ ' + formatUsd(state.latestTaoPriceUsd, 2);
          taoPriceLabel.title = 'Click to view TAO price history. USD values use this TAO price for conversion.';
          taoPriceLabel.setAttribute('aria-label', 'Click to view TAO price history');
        } else {
          taoPriceLabel.textContent = 'TAO price used: unavailable';
          taoPriceLabel.title = 'TAO price history is unavailable until a TAO price is stored';
          taoPriceLabel.setAttribute('aria-label', 'TAO price history unavailable');
        }
      }

      function buildTaoPriceMetric() {
        return {
          kind: 'tao-price',
          key: 'tao-price',
          label: 'TAO Price',
          description: 'This is the current market price of one TAO. It is the conversion rate the dashboard uses when you switch TAO values into USD.',
          valueField: 'price_usd',
          valueFormat: 'usd',
          historyField: 'price_usd',
          chartLabel: 'TAO Price',
          chartColor: '#f59e0b',
          clickable: true,
          currencyMode: 'none',
          latestValue: Number.isFinite(state.latestTaoPriceUsd) ? formatUsd(state.latestTaoPriceUsd, 2) : '—',
          rawValue: Number.isFinite(state.latestTaoPriceUsd) ? String(state.latestTaoPriceUsd) : '—',
        };
      }

      function updateNextPollLabel() {
        if (!nextPollLabel) return;
        const nextPollAt = state.nextPollAtIso ? new Date(state.nextPollAtIso) : null;
        if (!nextPollAt || Number.isNaN(nextPollAt.getTime())) {
          nextPollLabel.textContent = 'Next poll: —';
          nextPollLabel.title = 'Poll schedule unavailable';
          nextPollLabel.dataset.nextPollAt = '';
          return;
        }
        nextPollLabel.dataset.nextPollAt = state.nextPollAtIso;
        const localText = nextPollAt.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
        nextPollLabel.textContent = 'Next poll: ' + localText;
        nextPollLabel.title = 'Scheduled for ' + localText;
      }

      function snapshotSignatureFromPayload(latest) {
        if (!latest) return '';
        return [latest.captured_at || '', latest.block_number ?? '', latest.source || ''].join('|');
      }

      function ingestRunIdFromPayload(ingestRun) {
        if (!ingestRun) return '';
        return String(ingestRun.id ?? ingestRun.run_id ?? ingestRun.started_at ?? '');
      }

      function requestDashboardReload() {
        state.pendingLiveReload = true;
        if (document.visibilityState === 'visible' && !modalElements.backdrop.classList.contains('open')) {
          window.location.reload();
        }
      }

      function updateBackfillStatus(message, kind = 'info') {
        if (!backfillStatus) return;
        if (!message) {
          backfillStatus.hidden = true;
          backfillStatus.textContent = '';
          backfillStatus.dataset.status = '';
          return;
        }
        backfillStatus.hidden = false;
        backfillStatus.textContent = message;
        backfillStatus.dataset.status = kind;
      }

      function setProgressVisible(progressElement, visible) {
        if (!progressElement) return;
        progressElement.hidden = !visible;
        if (visible) {
          progressElement.removeAttribute('value');
          progressElement.removeAttribute('max');
          progressElement.max = 100;
        }
      }

      function collectAdminPayloadIssues(value, prefix = '') {
        const issues = [];
        const visit = (node, label = '') => {
          if (!node || typeof node !== 'object') return;
          const add = (message, messagePrefix = '') => {
            if (message === null || message === undefined || message === '') return;
            const text = String(message).trim();
            if (!text) return;
            issues.push((label || prefix || '') + messagePrefix + text);
          };
          add(node.error);
          add(node.reason);
          if (node.detail && typeof node.detail === 'object') {
            add(node.detail.error);
            add(node.detail.taoPriceError, 'TAO price: ');
            add(node.detail.priceError, 'TAO price history: ');
            add(node.detail.flowError, 'TAO flow history: ');
            add(node.detail.alphaHolderError, 'Alpha holders: ');
            add(node.detail.walletStakeHistoryError, 'Wallet stake history: ');
            add(node.detail.walletError, 'Wallet: ');
            if (Array.isArray(node.detail.walletErrors)) {
              node.detail.walletErrors.forEach((walletError) => {
                if (!walletError || typeof walletError !== 'object') return;
                const walletLabel = walletError.name || walletError.ss58 || 'wallet';
                add(walletError.error, walletLabel + ': ');
              });
            }
          }
        };
        visit(value);
        visit(value?.result, 'Result: ');
        visit(value?.backfill, 'Backfill: ');
        visit(value?.live, 'Live refresh: ');
        return Array.from(new Set(issues));
      }

      function adminPayloadErrorMessage(payload, fallback) {
        if (payload?.error) return String(payload.error);
        const issues = collectAdminPayloadIssues(payload);
        if (issues.length) return issues.join(' | ');
        if (payload?.message) return String(payload.message);
        return fallback;
      }

      function readBackfillOptions() {
        return {
          days: Number.parseInt(String(backfillDaysInput?.value || ''), 10),
          frequency: String(backfillFrequencySelect?.value || 'by_hour'),
          overwrite: Boolean(backfillOverwriteInput?.checked),
        };
      }

      function readWalletBackfillOptions() {
        return {
          days: Number.parseInt(String(walletBackfillDaysInput?.value || ''), 10),
        };
      }

      async function runAdminBackfill() {
        if (!backfillButton) return;
        const options = readBackfillOptions();
        if (!Number.isFinite(options.days) || options.days <= 0) {
          updateBackfillStatus('Backfill days must be a positive integer.', 'error');
          return;
        }
        backfillButton.disabled = true;
        setProgressVisible(backfillProgress, true);
        updateBackfillStatus('Backfilling subnet history, TAO price, Tao Flow, wallet history, and alpha-holder snapshots…', 'info');
        try {
          const response = await fetch('/api/subnets/' + netuid + '/backfill', {
            method: 'POST',
            headers: adminFetchHeaders(),
            body: JSON.stringify(options),
          });
          const payload = await response.json().catch(() => ({}));
          if (!response.ok) {
            throw new Error(adminPayloadErrorMessage(payload, 'Backfill failed'));
          }
          const snapshotCount = Number(payload.backfill?.inserted ?? 0);
          const flowCount = Number(payload.backfill?.flowInserted ?? 0);
          const priceCount = Number(payload.backfill?.priceInserted ?? 0);
          const warningList = Array.isArray(payload.warnings) ? payload.warnings.filter(Boolean) : [];
          if (warningList.length) {
            updateBackfillStatus('Backfill complete with warnings: ' + warningList.join(' | '), 'warning');
          } else {
            updateBackfillStatus('Backfill complete: ' + snapshotCount + ' snapshot rows, ' + flowCount + ' flow rows, and ' + priceCount + ' TAO price rows imported.', 'success');
          }
          window.setTimeout(() => window.location.reload(), 1200);
        } catch (error) {
          updateBackfillStatus(error?.message || 'Backfill failed', 'error');
          console.error(error);
        } finally {
          setProgressVisible(backfillProgress, false);
          backfillButton.disabled = false;
        }
      }

      async function runWalletBackfill() {
        if (!walletBackfillButton) return;
        const options = readWalletBackfillOptions();
        if (!Number.isFinite(options.days) || options.days <= 0) {
          if (walletBackfillStatus) {
            walletBackfillStatus.hidden = false;
            walletBackfillStatus.dataset.status = 'error';
            walletBackfillStatus.textContent = 'Wallet backfill days must be a positive integer.';
          }
          return;
        }
        walletBackfillButton.disabled = true;
        setProgressVisible(walletBackfillProgress, true);
        if (walletBackfillStatus) {
          walletBackfillStatus.hidden = false;
          walletBackfillStatus.dataset.status = 'info';
          walletBackfillStatus.textContent = 'Wallet activity backfill is running… this may take a while.';
        }
        try {
          const response = await fetch('/api/subnets/' + netuid + '/wallet-backfill', {
            method: 'POST',
            headers: adminFetchHeaders(),
            body: JSON.stringify(options),
          });
          const payload = await response.json().catch(() => ({}));
          if (!response.ok) {
            throw new Error(payload.error || payload.message || 'Wallet activity backfill failed');
          }
          const results = Array.isArray(payload.walletBackfill?.results) ? payload.walletBackfill.results : [];
          const rowCount = Number(payload.summary?.totalInserted ?? results.reduce((total, result) => total + Number(result?.rowsInserted ?? 0), 0));
          const warningList = results
            .flatMap((result) => [result?.warning, result?.reason])
            .filter(Boolean);
          if (walletBackfillStatus) {
            if (warningList.length) {
              walletBackfillStatus.textContent = 'Wallet activity backfill complete with warnings: ' + warningList.join(' | ');
              walletBackfillStatus.dataset.status = 'warning';
            } else {
              walletBackfillStatus.textContent = 'Wallet activity backfill complete: ' + rowCount + ' wallet activity rows imported.';
              walletBackfillStatus.dataset.status = 'success';
            }
          }
          window.setTimeout(() => window.location.reload(), 1200);
        } catch (error) {
          if (walletBackfillStatus) {
            walletBackfillStatus.hidden = false;
            walletBackfillStatus.dataset.status = 'error';
            walletBackfillStatus.textContent = error?.message || 'Wallet activity backfill failed';
          }
          console.error(error);
        } finally {
          setProgressVisible(walletBackfillProgress, false);
          walletBackfillButton.disabled = false;
        }
      }

      async function syncSchedulerState() {
        try {
          const response = await fetch('/health');
          if (!response.ok) return;
          const payload = await response.json();
          if (Number.isFinite(Number(payload.pollIntervalMinutes))) {
            state.pollIntervalMinutes = Number(payload.pollIntervalMinutes);
            updatePollIntervalButtons();
            updatePollIntervalLabel();
          }
          if (payload.nextPollAtIso) {
            state.nextPollAtIso = payload.nextPollAtIso;
          }
          updateNextPollLabel();
        } catch (error) {
          console.error(error);
        }
      }

      async function syncLiveSnapshotState() {
        if (state.liveRefreshInFlight) return;
        state.liveRefreshInFlight = true;
        try {
          const response = await fetch('/api/subnets/' + netuid + '/latest', { cache: 'no-store' });
          if (!response.ok) return;
          const payload = await response.json().catch(() => ({}));
          const nextSnapshotSignature = snapshotSignatureFromPayload(payload?.latest);
          const nextIngestRunId = ingestRunIdFromPayload(payload?.ingestRun);
          const nextTaoPrice = Number(payload?.taoPrice?.price_usd);
          const signatureChanged = nextSnapshotSignature && nextSnapshotSignature !== state.latestSnapshotSignature;
          const ingestRunChanged = nextIngestRunId && nextIngestRunId !== state.latestIngestRunId;
          const priceChanged = Number.isFinite(nextTaoPrice) && nextTaoPrice !== state.latestTaoPriceUsd;
          if (signatureChanged || ingestRunChanged || priceChanged) {
            state.latestSnapshotSignature = nextSnapshotSignature;
            state.latestIngestRunId = nextIngestRunId;
            requestDashboardReload();
          }
        } catch (error) {
          console.error(error);
        } finally {
          state.liveRefreshInFlight = false;
        }
      }

      function openTaoPriceHistoryModal() {
        openHistoryModal(buildTaoPriceMetric());
      }

      function formatPollIntervalLabel(minutes) {
        const value = Number(minutes);
        if (!Number.isFinite(value) || value <= 0) return '—';
        if (value % 60 === 0) {
          const hours = value / 60;
          return hours + ' hour' + (hours === 1 ? '' : 's');
        }
        return value + ' minute' + (value === 1 ? '' : 's');
      }

      function updatePollIntervalLabel() {
        if (!pollIntervalLabel) return;
        pollIntervalLabel.textContent = formatPollIntervalLabel(state.pollIntervalMinutes);
      }

      function updatePollIntervalButtons() {
        pollButtons.forEach((button) => {
          const minutes = Number(button.dataset.pollInterval);
          const active = minutes === state.pollIntervalMinutes;
          button.classList.toggle('active', active);
          button.setAttribute('aria-pressed', active ? 'true' : 'false');
        });
      }

      async function setPollInterval(minutes) {
        if (!Number.isFinite(minutes)) return;
        if (state.pollIntervalMinutes === minutes) return;
        pollButtons.forEach((button) => {
          button.disabled = true;
        });
        try {
          const response = await fetch('/api/settings/poll-interval', {
            method: 'POST',
            headers: adminFetchHeaders(),
            body: JSON.stringify({ minutes }),
          });
          const payload = await response.json().catch(() => ({}));
          if (!response.ok) {
            throw new Error(payload.error || 'Unable to update poll interval');
          }
          const nextMinutes = Number(payload.pollIntervalMinutes);
          state.pollIntervalMinutes = Number.isFinite(nextMinutes) ? nextMinutes : minutes;
          if (payload.nextPollAtIso) {
            state.nextPollAtIso = payload.nextPollAtIso;
          }
          updatePollIntervalButtons();
          updatePollIntervalLabel();
          updateNextPollLabel();
        } catch (error) {
          console.error(error);
          alert(error?.message || 'Unable to update poll interval');
        } finally {
          pollButtons.forEach((button) => {
            button.disabled = false;
          });
        }
      }

      function openModal() {
        modalElements.backdrop.classList.add('open');
        modalElements.backdrop.setAttribute('aria-hidden', 'false');
        document.body.classList.add('modal-open');
      }

      function closeModal() {
        modalElements.backdrop.classList.remove('open');
        modalElements.backdrop.setAttribute('aria-hidden', 'true');
        document.body.classList.remove('modal-open');
        if (state.modalChart) {
          state.modalChart.destroy();
          state.modalChart = null;
        }
        state.modalMetric = null;
        state.modalStakeHistory = null;
        if (state.pendingLiveReload && document.visibilityState === 'visible') {
          state.pendingLiveReload = false;
          window.location.reload();
        }
      }

      function loadHistory(days = 30, source = 'subnet', id = '') {
        const key = source + ':' + String(id || '') + ':' + String(days);
        if (state.historyCache.has(key)) {
          return Promise.resolve(state.historyCache.get(key));
        }
        if (!state.historyLoading.has(key)) {
          const endpoint = source === 'tao-price'
            ? '/api/tao-price/history?days=' + encodeURIComponent(days)
            : source === 'wallet'
              ? '/api/wallets/' + encodeURIComponent(id) + '/history?days=' + encodeURIComponent(days)
            : source === 'wallet-stake'
              ? '/api/wallets/' + encodeURIComponent(id) + '/stake-history?days=' + encodeURIComponent(days)
            : source === 'tao-flow'
              ? '/api/subnets/' + netuid + '/flow-history?days=' + encodeURIComponent(days)
            : source === 'alpha-holder'
              ? '/api/subnets/' + netuid + '/alpha-holder-history?days=' + encodeURIComponent(days)
              : '/api/subnets/' + netuid + '/history?days=' + encodeURIComponent(days);
          const loading = fetch(endpoint)
            .then((response) => response.json())
            .then((payload) => {
              const history = payload.history || [];
              state.historyCache.set(key, history);
              if (source === 'subnet' && days === 30) {
                state.history = history;
              }
              if (source === 'tao-flow' && days === 30) {
                state.flowHistory = history;
              }
              return history;
            })
            .finally(() => {
              state.historyLoading.delete(key);
            });
          state.historyLoading.set(key, loading);
        }
        return state.historyLoading.get(key);
      }

      function destroyCharts() {
        state.charts.forEach((chart) => chart.destroy());
        state.charts.clear();
      }

      function chartFormatFor(config) {
        if (config.currencyMode === 'tao' && state.displayCurrency === 'usd') {
          if (config.valueFormat === 'signedTao') return 'signedUsd';
          return 'usd';
        }
        return config.valueFormat || 'text';
      }

      function numericMetricValue(value) {
        if (value === null || value === undefined || value === '') return null;
        const num = Number(value);
        return Number.isFinite(num) ? num : null;
      }

      function resolveSentimentValue(row) {
        if (!row) return null;
        const candidates = [
          row.sentiment_index_num,
          row.ssi_num,
          row.sentiment_index_text,
          row.ssi_text,
          row.subnet_sentiment_index_num,
          row.subnet_sentiment_index_text,
          row.sentiment_score_num,
          row.sentiment_score_text,
          row.fear_and_greed_index,
        ];
        for (const candidate of candidates) {
          const num = numericMetricValue(candidate);
          if (num !== null) return num;
        }
        if (row.raw_json) {
          try {
            const payload = JSON.parse(row.raw_json);
            const payloadCandidates = [
              payload?.ssi,
              payload?.sentiment_index,
              payload?.subnet_sentiment_index,
              payload?.sentiment_score,
              payload?.fear_and_greed_index,
            ];
            for (const candidate of payloadCandidates) {
              const num = numericMetricValue(candidate);
              if (num !== null) return num;
            }
          } catch {
            // ignore parse errors and fall back to null
          }
        }
        return null;
      }

      function resolveSentimentSource(row) {
        if (!row) return null;
        const source = String(row.sentiment_index_source_text || '').trim().toLowerCase();
        if (source === 'ssi') return 'SSI';
        if (source === 'fear_and_greed' || source === 'fear-and-greed' || source === 'fear & greed') return 'Fear & Greed';
        if (numericMetricValue(row.sentiment_index_num) !== null || numericMetricValue(row.ssi_num) !== null || numericMetricValue(row.sentiment_index_text) !== null || numericMetricValue(row.ssi_text) !== null || numericMetricValue(row.subnet_sentiment_index_num) !== null || numericMetricValue(row.subnet_sentiment_index_text) !== null || numericMetricValue(row.sentiment_score_num) !== null || numericMetricValue(row.sentiment_score_text) !== null) {
          return 'SSI';
        }
        if (numericMetricValue(row.fear_and_greed_index) !== null) return 'Fear & Greed';
        if (row.raw_json) {
          try {
            const payload = JSON.parse(row.raw_json);
            if (numericMetricValue(payload?.ssi) !== null || numericMetricValue(payload?.sentiment_index) !== null || numericMetricValue(payload?.subnet_sentiment_index) !== null || numericMetricValue(payload?.sentiment_score) !== null) {
              return 'SSI';
            }
            if (numericMetricValue(payload?.fear_and_greed_index) !== null) return 'Fear & Greed';
          } catch {
            // ignore parse errors and fall back to null
          }
        }
        return null;
      }

      function resolveSentimentRawText(row) {
        if (!row) return '—';
        const source = resolveSentimentSource(row);
        const value = resolveSentimentValue(row);
        if (source && value !== null) return source + ' ' + value;
        if (source) return source;
        if (row.sentiment_index_text !== null && row.sentiment_index_text !== undefined) return row.sentiment_index_text;
        if (row.fear_and_greed_index !== null && row.fear_and_greed_index !== undefined) return row.fear_and_greed_index;
        if (row.raw_json) {
          try {
            const payload = JSON.parse(row.raw_json);
            return payload?.ssi ?? payload?.sentiment_index ?? payload?.subnet_sentiment_index ?? payload?.sentiment_score ?? payload?.fear_and_greed_index ?? '—';
          } catch {
            return '—';
          }
        }
        return '—';
      }

      function chartNumericValue(value) {
        if (value === null || value === undefined || value === '') return null;
        if (typeof value === 'number') {
          return Number.isFinite(value) ? value : null;
        }
        const text = String(value).trim();
        if (!text) return null;
        if (text.includes('%')) {
          const pct = Number.parseFloat(text.replace(/,/g, ''));
          return Number.isFinite(pct) ? pct : null;
        }
        const num = Number(text.replace(/,/g, ''));
        return Number.isFinite(num) ? num : null;
      }

      function isPriceMoveMetric(metric) {
        if (!metric) return false;
        const key = String(metric.key || metric.historyField || '');
        return key.startsWith('price_change_') || String(metric.label || '').toLowerCase().includes('price move');
      }

      function isSentimentMetric(metric) {
        if (!metric) return false;
        const key = String(metric.key || metric.historyField || '');
        return key === 'sentiment_index_num' || key === 'fear_and_greed_index' || String(metric.label || '').toLowerCase().includes('sentiment');
      }

      function isTaoFlowMetric(metric) {
        if (!metric) return false;
        const key = String(metric.key || metric.historyField || '');
        return key.startsWith('net_flow_') || String(metric.label || '').toLowerCase().includes('money in/out');
      }

      function isAlphaHolderRankMetric(metric) {
        if (!metric) return false;
        const key = String(metric.key || metric.historyField || '');
        return metric.kind === 'alpha-holder-rank' || key === 'rank_num' || String(metric.label || '').toLowerCase().includes('alpha-holder rank');
      }

      function priceMoveLookbackMs(metric) {
        const key = String(metric?.key || metric?.historyField || '');
        if (key.includes('_1_hour')) return 60 * 60 * 1000;
        if (key.includes('_1_day')) return 24 * 60 * 60 * 1000;
        if (key.includes('_1_week')) return 7 * 24 * 60 * 60 * 1000;
        if (key.includes('_1_month')) return 30 * 24 * 60 * 60 * 1000;
        return null;
      }

      function priceMoveFetchDays(metric, days) {
        const lookbackMs = priceMoveLookbackMs(metric);
        if (!lookbackMs) return days;
        return Math.max(days, days + Math.ceil(lookbackMs / 86400000));
      }

      function modalHistoryFetchDays(metric, days) {
        const baseDays = isPriceMoveMetric(metric) ? priceMoveFetchDays(metric, days) : days;
        return Math.max(baseDays, baseDays + 30);
      }

      function taoFlowLookbackMs(metric) {
        const key = String(metric?.key || metric?.historyField || metric?.field || '');
        if (key.includes('_1_day')) return 24 * 60 * 60 * 1000;
        if (key.includes('_7_days')) return 7 * 24 * 60 * 60 * 1000;
        if (key.includes('_30_days')) return 30 * 24 * 60 * 60 * 1000;
        return null;
      }

      function resolveTaoFlowBalanceValue(row) {
        if (!row) return null;
        const candidates = [
          row.total_tao_num,
          row.total_tao_text,
          row.tao_in_pool_num,
          row.tao_in_pool_text,
          row.raw_json,
        ];
        for (const candidate of candidates) {
          if (candidate === row.raw_json && row.raw_json) {
            try {
              const payload = JSON.parse(row.raw_json);
              const payloadCandidates = [payload?.total_tao, payload?.tao_in_pool];
              for (const payloadCandidate of payloadCandidates) {
                const num = chartNumericValue(payloadCandidate);
                if (Number.isFinite(num)) return num;
              }
            } catch {
              // ignore parse errors
            }
            continue;
          }
          const num = chartNumericValue(candidate);
          if (Number.isFinite(num)) return num;
        }
        return null;
      }

      function buildTaoFlowHistory(history, metric) {
        const lookbackMs = taoFlowLookbackMs(metric);
        if (!lookbackMs) return [];
        const rows = [...history]
          .map((row) => ({
            row,
            time: new Date(row.captured_at).getTime(),
            balanceValue: resolveTaoFlowBalanceValue(row),
            priceUsd: resolveUsdPrice(row.tao_price_usd, state.latestTaoPriceUsd),
          }))
          .filter((entry) => Number.isFinite(entry.time))
          .sort((a, b) => a.time - b.time);
        const points = [];
        const valueScale = Number(metric?.valueScale || 1);
        for (let index = 0; index < rows.length; index += 1) {
          const current = rows[index];
          const cutoff = current.time - lookbackMs;
          let prior = null;
          for (let priorIndex = index - 1; priorIndex >= 0; priorIndex -= 1) {
            const candidate = rows[priorIndex];
            if (candidate.time <= cutoff) {
              prior = candidate;
              break;
            }
          }
          if (!prior) continue;
          if (!Number.isFinite(current.balanceValue) || !Number.isFinite(prior.balanceValue)) continue;
          const deltaRaw = current.balanceValue - prior.balanceValue;
          if (!Number.isFinite(deltaRaw)) continue;
          let y = deltaRaw * valueScale;
          if (metric.currencyMode === 'tao' && state.displayCurrency === 'usd') {
            if (!Number.isFinite(current.priceUsd)) continue;
            y *= current.priceUsd;
          }
          if (!Number.isFinite(y)) continue;
          points.push({ x: current.time, y });
        }
        return points;
      }

      function buildPriceMoveHistory(history, metric) {
        const lookbackMs = priceMoveLookbackMs(metric);
        if (!lookbackMs) return [];
        const rows = [...history]
          .map((row) => ({
            row,
            time: new Date(row.captured_at).getTime(),
            price: chartNumericValue(row.price_num),
          }))
          .filter((entry) => Number.isFinite(entry.time) && Number.isFinite(entry.price))
          .sort((a, b) => a.time - b.time);
        const points = [];
        for (let index = 0; index < rows.length; index += 1) {
          const current = rows[index];
          const cutoff = current.time - lookbackMs;
          let prior = null;
          for (let priorIndex = index - 1; priorIndex >= 0; priorIndex -= 1) {
            const candidate = rows[priorIndex];
            if (candidate.time <= cutoff) {
              prior = candidate;
              break;
            }
          }
          if (!prior || !Number.isFinite(prior.price) || prior.price === 0) continue;
          const pct = ((current.price - prior.price) / prior.price) * 100;
          if (!Number.isFinite(pct)) continue;
          points.push({ x: current.time, y: pct });
        }
        return points;
      }

      function metricHistoryNote(metric, visiblePoints, rangeDays) {
        const subnetLabelText = String(metric?.label || 'This subnet');
        const subnetSubject = subnetLabelText.replace(/\s+alpha-holder rank$/i, '').trim() || subnetLabelText;
        if (isPriceMoveMetric(metric)) {
          return 'Price Move is derived from historical Token Price, so it needs enough earlier price samples to calculate the window.';
        }
        if (metric?.kind === 'wallet') {
          if (!visiblePoints.length) {
            return 'Wallet balances come from Taostats account history for the configured ss58 address. Backfill or a few live samples will make the chart fuller.';
          }
          if (rangeDays === 1 && visiblePoints.length < 3) {
            return 'Wallet balances are sampled over time, so the 24H view may only show a small number of points. 7D usually gives a clearer trend.';
          }
          if (visiblePoints.length < Math.max(5, Math.min(rangeDays, 10))) {
            return 'Wallet balance history can be sparse in short ranges until enough local samples have been stored.';
          }
        }
        if (isTaoFlowMetric(metric)) {
          if (!visiblePoints.length) {
            return 'Money In/Out is derived from the historical subnet snapshots, so older backfilled rows may still be sparse until more samples are stored locally.';
          }
          if (visiblePoints.length < Math.max(5, Math.min(rangeDays, 10))) {
            return 'Money In/Out is derived from the historical subnet snapshots and can look sparse if the local database does not yet have enough earlier samples.';
          }
        }
        if (metric?.kind === 'alpha-holder' || String(metric?.key || '') === 'alpha_holders_num') {
          if (!visiblePoints.length) {
            return 'Alpha-holder history starts at the first locally collected snapshot and grows from there, so the chart may be sparse until collection has run for a while.';
          }
          if (visiblePoints.length < Math.max(5, Math.min(rangeDays, 10))) {
            return 'Alpha-holder history starts when local collection begins, so early windows can be sparse until more snapshots are stored.';
          }
        }
        if (isAlphaHolderRankMetric(metric)) {
          if (!visiblePoints.length) {
            return subnetSubject + ' is computed from local alpha-holder snapshots across all stored subnets, so the chart starts at the first collection point.';
          }
          if (visiblePoints.length < Math.max(5, Math.min(rangeDays, 10))) {
            return subnetSubject + ' starts from the first locally collected alpha-holder snapshot, so the early chart may still be sparse.';
          }
        }
        if (isSentimentMetric(metric)) {
          if (!visiblePoints.length) {
            return 'Subnet Sentiment uses SSI when Taostats provides it, with legacy Fear & Greed as a fallback. Older backfilled rows may still be sparse until more sentiment history is stored locally.';
          }
          if (visiblePoints.length < Math.max(5, Math.min(rangeDays, 10))) {
            return 'Subnet Sentiment can look sparse if older rows only have the legacy Fear & Greed score. Taostats now prefers SSI when available, but backfilled history may not include every sentiment sample yet.';
          }
        }
        return '';
      }

      function historySeriesForMetric(metric, history) {
        const sourceHistory = Array.isArray(history) ? history : [];
        if (isPriceMoveMetric(metric)) {
          return buildPriceMoveHistory(sourceHistory, metric);
        }
        if (isTaoFlowMetric(metric)) {
          return buildTaoFlowHistory(sourceHistory, metric);
        }
        if (isSentimentMetric(metric)) {
          return sourceHistory
            .map((row) => ({
              x: new Date(row.captured_at).getTime(),
              y: resolveSentimentChartValue(row),
            }))
            .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
        }
        return sourceHistory
          .map((row) => ({
            x: new Date(row.captured_at).getTime(),
            y: chartValue(row, {
              field: metric.field || metric.historyField || metric.valueField,
              valueScale: metric.valueScale || 1,
              currencyMode: metric.currencyMode || 'none',
              valueFormat: metric.valueFormat || 'text',
            }),
          }))
          .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
      }

      function resolveSentimentChartValue(row) {
        const value = resolveSentimentValue(row);
        return Number.isFinite(Number(value)) ? Number(value) : null;
      }

      function chartValue(row, config) {
        const raw = chartNumericValue(row?.[config.field]);
        if (raw === null) return null;
        const base = raw * Number(config.valueScale || 1);
        if (!Number.isFinite(base)) return null;
        if (config.currencyMode === 'tao' && state.displayCurrency === 'usd') {
          const priceUsd = resolveUsdPrice(row.tao_price_usd, state.latestTaoPriceUsd);
          if (!Number.isFinite(priceUsd)) return null;
          return base * priceUsd;
        }
        return base;
      }

      function updateChartGapNote(noteId, values) {
        const note = document.getElementById(noteId);
        if (!note) return;
        const hasGap = Array.isArray(values) && values.some((value) => value === null);
        if (!hasGap) {
          note.hidden = true;
          note.textContent = '';
          return;
        }
        note.hidden = false;
        note.textContent = 'Gaps in this chart mean no historical sample was stored for that time.';
      }

      ${formatChartDate.toString()}

      function chartRangeDays(history, fallbackDays = 7) {
        if (!Array.isArray(history) || history.length < 2) return fallbackDays;
        const start = new Date(history[0].captured_at).getTime();
        const end = new Date(history[history.length - 1].captured_at).getTime();
        if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return fallbackDays;
        return Math.max(1, Math.ceil((end - start) / 86400000));
      }

      function historyRangeLabel(days) {
        if (days === 1) return '24H';
        if (days === 7) return '7D';
        if (days === 14) return '14D';
        if (days === 30) return '30D';
        if (days === 60) return '60D';
        return days + 'D';
      }

      function historyRangeSubtitle(days) {
        if (days === 1) return 'Stored historical points in the last 24 hours';
        if (days === 7) return 'Stored historical points in the last 7 days';
        if (days === 14) return 'Stored historical points in the last 14 days';
        if (days === 30) return 'Stored historical points in the last 30 days';
        if (days === 60) return 'Stored historical points in the last 60 days';
        return 'Stored historical points in the last ' + days + ' days';
      }

      function modalWindowDurationMs() {
        return Math.max(1, Number(state.modalHistoryDays || 7)) * 86400000;
      }

      function getModalWindowBounds(metric, history) {
        const sourceHistory = Array.isArray(history) ? history : [];
        const points = historySeriesForMetric(metric, sourceHistory);
        const times = points.map((point) => point.x).filter(Number.isFinite);
        if (!times.length) return null;
        const earliest = Math.min(...times);
        const latest = Math.max(...times);
        const durationMs = modalWindowDurationMs();
        if ((latest - earliest) <= durationMs) {
          return {
            start: earliest,
            end: latest,
            earliest,
            latest,
            durationMs,
            canShiftLeft: false,
            canShiftRight: false,
          };
        }
        const minEnd = earliest + durationMs;
        const maxEnd = latest;
        const preferredEnd = state.modalHistoryAutoFollow || !Number.isFinite(state.modalHistoryWindowEndMs)
          ? latest
          : state.modalHistoryWindowEndMs;
        const end = Math.min(maxEnd, Math.max(minEnd, preferredEnd));
        const start = end - durationMs;
        return {
          start,
          end,
          earliest,
          latest,
          durationMs,
          canShiftLeft: start > earliest,
          canShiftRight: end < latest,
        };
      }

      function formatWindowBoundsLabel(bounds, days) {
        if (!bounds) return 'No historical window available';
        return formatChartDate(bounds.start, days) + ' → ' + formatChartDate(bounds.end, days);
      }

      function updateWindowShiftControls(bounds, days) {
        if (modalElements.windowLabel) {
          modalElements.windowLabel.textContent = bounds
            ? formatWindowBoundsLabel(bounds, days)
            : 'No historical window available';
        }
        if (modalElements.windowPrev) {
          modalElements.windowPrev.disabled = !bounds || !bounds.canShiftLeft;
        }
        if (modalElements.windowNext) {
          modalElements.windowNext.disabled = !bounds || !bounds.canShiftRight;
        }
      }

      function shiftModalHistoryWindow(direction) {
        if (!state.modalMetric || !state.modalHistory) return;
        const bounds = getModalWindowBounds(state.modalMetric, state.modalHistory);
        if (!bounds) return;
        const nextEnd = Number.isFinite(state.modalHistoryWindowEndMs)
          ? state.modalHistoryWindowEndMs + (direction * 86400000)
          : bounds.end + (direction * 86400000);
        const clampedEnd = Math.min(bounds.latest, Math.max(bounds.earliest + bounds.durationMs, nextEnd));
        if (Number.isFinite(bounds.durationMs) && bounds.durationMs >= (bounds.latest - bounds.earliest)) {
          return;
        }
        if (!Number.isFinite(clampedEnd)) return;
        state.modalHistoryAutoFollow = false;
        state.modalHistoryWindowEndMs = clampedEnd;
        renderHistoryChart(state.modalMetric, state.modalHistory);
      }

      function buildWindowedHistoryPoints(metric, history, bounds) {
        const points = historySeriesForMetric(metric, history)
          .sort((a, b) => a.x - b.x);
        if (!points.length) return [];
        const start = bounds ? bounds.start : null;
        const end = bounds ? bounds.end : null;
        let visiblePoints = points.filter((point) => Number.isFinite(start) && Number.isFinite(end) && point.x >= start && point.x <= end);
        if (metric?.kind === 'wallet' && state.modalHistoryDays === 1 && visiblePoints.length < 2) {
          const latest = visiblePoints.length ? visiblePoints[visiblePoints.length - 1] : points[points.length - 1];
          if (latest) {
            const prior = [...points].reverse().find((point) => point.x < latest.x);
            if (prior) {
              visiblePoints = [prior, latest];
            } else if (visiblePoints.length) {
              visiblePoints = [latest];
            }
          }
        }
        return visiblePoints;
      }

      function padWalletChartContext(metric, history, bounds, points) {
        if (!metric || metric.kind !== 'wallet' || !bounds || !Array.isArray(points) || !points.length) {
          return points;
        }
        const allPoints = historySeriesForMetric(metric, history)
          .sort((a, b) => a.x - b.x);
        if (!allPoints.length) return points;

        const padded = [...points];
        const firstPoint = padded[0];
        const lastPoint = padded[padded.length - 1];
        const prior = [...allPoints].reverse().find((point) => point.x < bounds.start);
        const next = allPoints.find((point) => point.x > bounds.end);

        if (prior && (!firstPoint || prior.x !== firstPoint.x)) {
          padded.unshift(prior);
        }
        if (next && (!lastPoint || next.x !== lastPoint.x)) {
          padded.push(next);
        }

        return padded;
      }

      function updateHistoryRangeButtons() {
        rangeButtons.forEach((button) => {
          const days = Number(button.dataset.historyRange);
          const active = days === state.modalHistoryDays;
          button.classList.toggle('active', active);
          button.setAttribute('aria-pressed', active ? 'true' : 'false');
        });
        if (modalElements.samplesNote) {
          modalElements.samplesNote.textContent = historyRangeSubtitle(state.modalHistoryDays);
        }
      }

      async function loadModalHistory(metric, days) {
        const requestId = ++state.modalHistoryRequestId;
        const historySource = metric.historySource || (metric.kind === 'tao-price'
          ? 'tao-price'
          : metric.kind === 'wallet'
            ? 'wallet'
          : isTaoFlowMetric(metric)
            ? 'tao-flow'
            : isAlphaHolderRankMetric(metric)
              ? 'alpha-holder-rank'
            : 'subnet');
        const fetchDays = modalHistoryFetchDays(metric, days);
        let history = [];
        try {
          history = await loadHistory(fetchDays, historySource, metric.historyId || metric.walletAddress || '');
        } catch (error) {
          console.warn('Unable to load history for', metric.label, error);
          history = [];
        }
        if (requestId !== state.modalHistoryRequestId) return null;
        if (state.modalMetric !== metric || state.modalHistoryDays !== days) return null;
        state.modalHistory = history;
        return history;
      }

      async function loadWalletStakeHistory(metric, days) {
        if (!metric || metric.kind !== 'wallet') return [];
        const requestId = state.modalHistoryRequestId;
        const address = metric.historyId || metric.walletAddress || metric.rawValue || metric.sourceText || '';
        if (!address) return [];
        const fetchDays = Math.max(1, Number(days || 30));
        try {
          const history = await loadHistory(fetchDays, 'wallet-stake', address);
          if (requestId !== state.modalHistoryRequestId) return [];
          return history;
        } catch (error) {
          console.warn('Unable to load wallet stake history for', metric.label, error);
          return [];
        }
      }

      function renderLineChart(canvasId, config, history) {
        const canvas = document.getElementById(canvasId);
        if (!canvas || !window.Chart) return;
        const points = historySeriesForMetric(config, history);
        const days = chartRangeDays(history, 7);
        const values = points.map((point) => point.y);
        const pointTimes = points.map((point) => point.x);
        const xMin = pointTimes.length ? Math.min(...pointTimes) : null;
        const xMax = pointTimes.length ? Math.max(...pointTimes) : null;
        const formatKey = chartFormatFor(config);
        const chart = new Chart(canvas, {
          type: 'line',
          data: {
            datasets: [{
              label: config.label,
              data: points,
              parsing: false,
              borderColor: config.color,
              backgroundColor: config.color + '22',
              fill: false,
              pointRadius: 0,
              tension: 0.25,
              spanGaps: false,
            }],
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: {
              legend: { display: false },
              tooltip: {
                mode: 'index',
                intersect: false,
                callbacks: {
                  title(items) {
                    return items.length ? formatChartDate(items[0].parsed.x, days) : '';
                  },
                  label(context) {
                    return ' ' + formatBaseMetric(context.parsed.y, formatKey);
                  },
                },
              },
            },
            scales: {
              x: {
                type: 'linear',
                min: Number.isFinite(xMin) ? xMin : undefined,
                max: Number.isFinite(xMax) ? xMax : undefined,
                ticks: {
                  color: '#8fa3b8',
                  maxTicksLimit: 6,
                  callback(value) {
                    return formatChartDate(value, days);
                  },
                },
                grid: { color: 'rgba(143, 163, 184, 0.12)' },
              },
              y: {
                ticks: {
                  color: '#8fa3b8',
                  callback(value) {
                    return formatBaseMetric(value, formatKey);
                  },
                },
                grid: { color: 'rgba(143, 163, 184, 0.12)' },
              },
            },
          },
        });
        state.charts.set(canvasId, chart);
        updateChartGapNote(canvasId + '-note', values);
      }

      function renderCharts() {
        if (!state.history) return;
        destroyCharts();
        chartConfigs.forEach((config) => renderLineChart(config.id, config, state.history));
        if (state.modalMetric) {
          renderHistoryChart(state.modalMetric, state.modalHistory);
        }
      }

      function renderHistoryChart(metric, history) {
        const canvas = modalElements.canvas;
        const sourceHistory = Array.isArray(history) ? history : state.modalHistory;
        if (!canvas || !window.Chart || !sourceHistory || !metric) return;

        const days = state.modalHistoryDays || chartRangeDays(sourceHistory, 7);
        const bounds = getModalWindowBounds(metric, sourceHistory);
        const rangeStart = bounds ? bounds.start : null;
        const rangeEnd = bounds ? bounds.end : null;
        const formatKey = metric.currencyMode === 'tao' && state.displayCurrency === 'usd'
          ? (metric.valueFormat === 'signedTao' ? 'signedUsd' : 'usd')
          : (metric.valueFormat || 'text');
        const basePoints = buildWindowedHistoryPoints(metric, sourceHistory, bounds);
        const points = padWalletChartContext(metric, sourceHistory, bounds, basePoints);
        const historyValues = points.map((point) => point.y);
        const visibleRows = Array.isArray(sourceHistory)
          ? sourceHistory
            .map((row) => ({ row, time: new Date(row.captured_at).getTime() }))
            .filter((entry) => Number.isFinite(entry.time) && Number.isFinite(rangeStart) && Number.isFinite(rangeEnd) && entry.time >= rangeStart && entry.time <= rangeEnd)
            .sort((a, b) => a.time - b.time)
          : [];

        if (state.modalChart) {
          state.modalChart.destroy();
          state.modalChart = null;
        }

        if (!points.length) {
          modalElements.empty.hidden = false;
          modalElements.empty.textContent = 'No historical values are stored yet for this metric.';
          canvas.hidden = true;
          updateWindowShiftControls(bounds, days);
          updateChartGapNote('history-modal-note', []);
          return;
        }

        modalElements.empty.hidden = true;
        canvas.hidden = false;

        state.modalChart = new Chart(canvas, {
          type: 'line',
          data: {
            datasets: [{
              label: metric.chartLabel || metric.label,
              data: points,
              parsing: false,
              borderColor: metric.chartColor || '#00dbbc',
              backgroundColor: (metric.chartColor || '#00dbbc') + '22',
              fill: metric.kind === 'wallet' ? false : true,
              pointRadius: metric.kind === 'wallet' ? 2 : 0,
              pointHoverRadius: metric.kind === 'wallet' ? 4 : 2,
              tension: metric.kind === 'wallet' ? 0.28 : 0.28,
              stepped: false,
              spanGaps: false,
            }],
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: {
              legend: { display: false },
              tooltip: {
                mode: 'index',
                intersect: false,
                callbacks: {
                  title(items) {
                    return items.length ? formatChartDate(items[0].parsed.x, days) : '';
                  },
                  label(context) {
                    return ' ' + formatBaseMetric(context.parsed.y, formatKey);
                  },
                },
              },
            },
            scales: {
              x: {
                type: 'linear',
                min: Number.isFinite(rangeStart) ? rangeStart : undefined,
                max: Number.isFinite(rangeEnd) ? rangeEnd : undefined,
                ticks: {
                  color: '#8fa3b8',
                  maxTicksLimit: 8,
                  callback(value) {
                    return formatChartDate(value, days);
                  },
                },
                grid: { color: 'rgba(143, 163, 184, 0.12)' },
              },
              y: {
                ticks: {
                  color: '#8fa3b8',
                  callback(value) {
                    return formatBaseMetric(value, formatKey);
                  },
                },
                grid: { color: 'rgba(143, 163, 184, 0.12)' },
              },
            },
          },
        });
        updateWindowShiftControls(bounds, days);
        updateChartGapNote('history-modal-note', historyValues);
      }

      function renderModalMetric(metric) {
        if (!metric) return;
        modalElements.title.textContent = metric.label + ' history';
        modalElements.subtitle.textContent = 'Loading historical view for ' + metric.label + '...';
        modalElements.chartTitle.textContent = metric.label + ' over time';
        state.explanationOpen = true;
        modalElements.info.hidden = !metric.description;
        modalElements.info.textContent = metric.description ? 'i' : '';
        modalElements.info.title = metric.description ? 'Hide metric explanation' : '';
        modalElements.info.setAttribute('aria-label', metric.description ? 'Hide metric explanation' : 'No metric explanation available');
        modalElements.explanation.textContent = metric.description || '';
        modalElements.explanation.hidden = !metric.description;
        modalElements.latestValue.textContent = displayMetricText(metric);
        modalElements.latestRaw.textContent = metric.sourceText
          ? ('Source: ' + metric.sourceText)
          : (metric.rawValue !== null && metric.rawValue !== undefined
            ? ('Raw: ' + metric.rawValue)
            : 'Loading historical field...');
        try {
          renderWalletDetails(metric);
        } catch (error) {
          console.warn('Unable to render wallet details for', metric.label, error);
          if (metric.kind === 'wallet' && modalElements.walletDetails) {
            modalElements.walletDetails.hidden = false;
            modalElements.walletDetails.innerHTML = '<p class="pool-estimator-unavailable">Wallet details could not render.</p>';
          }
        }
        modalElements.samples.textContent = '—';
        if (modalElements.samplesNote) {
          modalElements.samplesNote.textContent = historyRangeSubtitle(state.modalHistoryDays);
        }
        modalElements.captured.textContent = '—';
        modalElements.empty.hidden = true;
      }

      async function refreshModalHistory(metric, days) {
        if (!metric) return;
        updateHistoryRangeButtons();
        modalElements.subtitle.textContent = 'Loading ' + historyRangeLabel(days) + ' history for ' + metric.label + '...';
        modalElements.samples.textContent = '—';
        modalElements.captured.textContent = '—';
        const history = await loadModalHistory(metric, days);
        if (!history) return;
        if (metric.kind === 'wallet') {
          state.modalStakeHistory = [];
          void loadWalletStakeHistory(metric, days).then((stakeHistory) => {
            if (state.modalMetric === metric && state.modalHistoryDays === days) {
              state.modalStakeHistory = Array.isArray(stakeHistory) ? stakeHistory : [];
              try {
                renderWalletDetails(metric);
              } catch (error) {
                console.warn('Unable to update wallet details for', metric.label, error);
              }
            }
          });
        } else {
          state.modalStakeHistory = null;
        }
        const field = metric.historyField || metric.valueField;
        const points = historySeriesForMetric(metric, history);
        const bounds = getModalWindowBounds(metric, history);
        const rangeStart = bounds ? bounds.start : (Date.now() - Math.max(1, days) * 86400000);
        const rangeEnd = bounds ? bounds.end : Date.now();
        const visiblePoints = points.filter((point) => point.x >= rangeStart && point.x <= rangeEnd);
        const visibleRows = Array.isArray(history)
          ? history
            .map((row) => ({ row, time: new Date(row.captured_at).getTime() }))
            .filter((entry) => Number.isFinite(entry.time) && entry.time >= rangeStart && entry.time <= rangeEnd)
            .sort((a, b) => a.time - b.time)
          : [];
        const latestPoint = visibleRows.length ? visibleRows[visibleRows.length - 1].row : null;

        modalElements.subtitle.textContent = 'Historical view for ' + metric.label + ' over the last ' + days + ' day' + (days === 1 ? '' : 's') + ' from the local SQLite database.';
        modalElements.latestValue.textContent = displayMetricText(metric);
        modalElements.latestRaw.textContent = metric.sourceText
          ? ('Source: ' + metric.sourceText)
          : (isPriceMoveMetric(metric)
            ? 'Derived from historical Token Price data'
            : (metric.rawValue !== null && metric.rawValue !== undefined
              ? ('Raw: ' + metric.rawValue)
              : ('Tracked field: ' + field)));
        try {
          renderWalletDetails(metric);
        } catch (error) {
          console.warn('Unable to refresh wallet details after history load for', metric.label, error);
        }
        modalElements.samples.textContent = String(visiblePoints.length);
        if (modalElements.samplesNote) {
          modalElements.samplesNote.textContent = historyRangeSubtitle(days);
        }
        modalElements.note.hidden = true;
        modalElements.captured.textContent = latestPoint
          ? new Date(latestPoint.captured_at).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'medium' })
          : '—';
        const historyNote = metricHistoryNote(metric, visiblePoints, days);
        if (historyNote) {
          modalElements.note.hidden = false;
          modalElements.note.textContent = historyNote;
        }
        modalElements.empty.hidden = true;
        try {
          renderHistoryChart(metric, history);
        } catch (error) {
          console.warn('Unable to render historical chart for', metric.label, error);
          modalElements.subtitle.textContent = 'Historical data loaded, but the chart could not render.';
          modalElements.empty.hidden = false;
          modalElements.empty.textContent = 'The history data loaded, but the chart renderer failed.';
          modalElements.canvas.hidden = true;
        }
      }

      async function openHistoryModal(metricJson) {
        const metric = typeof metricJson === 'string' ? JSON.parse(metricJson) : metricJson;
        state.modalMetric = metric;
        state.modalHistoryDays = 7;
        state.modalHistory = null;
        state.modalStakeHistory = null;
        state.modalHistoryWindowEndMs = null;
        state.modalHistoryAutoFollow = true;
        if (modalElements.walletDetails) {
          modalElements.walletDetails.hidden = true;
          modalElements.walletDetails.innerHTML = '';
        }
        modalElements.latestValue.textContent = '—';
        modalElements.latestRaw.textContent = 'Loading historical field...';
        modalElements.samples.textContent = '—';
        modalElements.captured.textContent = '—';
        modalElements.note.hidden = true;
        modalElements.empty.hidden = true;
        modalElements.canvas.hidden = false;
        openModal();
        try {
          renderModalMetric(metric);
        } catch (error) {
          console.error(error);
          modalElements.subtitle.textContent = 'The metric dialog opened, but wallet details could not render.';
          modalElements.empty.hidden = false;
          modalElements.empty.textContent = 'Unable to render this wallet card.';
          modalElements.canvas.hidden = true;
        }
        try {
          await refreshModalHistory(metric, state.modalHistoryDays);
        } catch (error) {
          modalElements.subtitle.textContent = 'Unable to load history for this metric.';
          modalElements.latestRaw.textContent = error?.message || 'Unknown error';
          modalElements.empty.hidden = false;
          modalElements.empty.textContent = 'Could not load metric history.';
          modalElements.canvas.hidden = true;
          if (metric.description) {
            modalElements.explanation.hidden = false;
          }
        }
      }

      function syncCurrencyMode() {
        updateCurrencyToggleButton();
        updateTaoPriceLabel();
        refreshMetricElements();
        renderCharts();
        initializePoolGrowthEstimator();
        if (state.modalMetric) {
          modalElements.latestValue.textContent = displayMetricText(state.modalMetric);
          renderWalletDetails(state.modalMetric);
          if (state.modalHistory) {
            renderHistoryChart(state.modalMetric, state.modalHistory);
          }
        }
      }

      function bindMetricClicks() {
        document.querySelectorAll('[data-metric]').forEach((button) => {
          let metric = null;
          try {
            metric = JSON.parse(button.dataset.metric || '{}');
          } catch {
            metric = null;
          }
          if (!metric || !metric.clickable) return;
          button.addEventListener('click', (event) => {
            if (metric.kind === 'wallet' && (event.ctrlKey || event.metaKey)) {
              event.preventDefault();
              openWalletTransactionsModal(button.dataset.metric);
              return;
            }
            openHistoryModal(button.dataset.metric);
          });
        });
      }

      const refreshButton = document.getElementById('refresh-btn');
      refreshButton?.addEventListener('click', async () => {
        refreshButton.disabled = true;
        try {
          const response = await fetch('/api/subnets/' + netuid + '/ingest', {
            method: 'POST',
            headers: adminFetchHeaders(null),
          });
          const payload = await response.json().catch(() => ({}));
          if (!response.ok || payload.result?.ok === false) {
            const message = adminPayloadErrorMessage(payload, 'Subnet ingest failed.');
            throw new Error(message);
          }
          window.location.reload();
        } catch (error) {
          console.error(error);
          alert('Subnet refresh failed: ' + (error?.message || 'Unknown error'));
        } finally {
          refreshButton.disabled = false;
        }
      });

      currencyToggle?.addEventListener('click', () => {
        if (currencyToggle.disabled) return;
        state.displayCurrency = state.displayCurrency === 'tao' ? 'usd' : 'tao';
        localStorage.setItem('sn110-display-currency', state.displayCurrency);
        syncCurrencyMode();
      });

      if (adminPanel) {
        adminPanel.open = localStorage.getItem('sn110-admin-panel-open') === 'true';
        adminPanel.addEventListener('toggle', () => {
          localStorage.setItem('sn110-admin-panel-open', adminPanel.open ? 'true' : 'false');
        });
      }

      if (financialPanel) {
        financialPanel.open = localStorage.getItem('sn110-financial-panel-open') === 'true';
        financialPanel.addEventListener('toggle', () => {
          localStorage.setItem('sn110-financial-panel-open', financialPanel.open ? 'true' : 'false');
        });
      }

      backfillButton?.addEventListener('click', () => {
        void runAdminBackfill();
      });

      walletBackfillButton?.addEventListener('click', () => {
        void runWalletBackfill();
      });

      taoPriceLabel?.addEventListener('click', () => {
        openTaoPriceHistoryModal();
      });

      pollButtons.forEach((button) => {
        button.addEventListener('click', () => {
          const minutes = Number(button.dataset.pollInterval);
          if (!Number.isFinite(minutes)) return;
          void setPollInterval(minutes);
        });
      });

      rangeButtons.forEach((button) => {
        button.addEventListener('click', () => {
          const days = Number(button.dataset.historyRange);
          if (!Number.isFinite(days)) return;
          if (state.modalHistoryDays === days && state.modalHistory) return;
          state.modalHistoryDays = days;
          state.modalHistoryWindowEndMs = null;
          state.modalHistoryAutoFollow = true;
          updateHistoryRangeButtons();
          if (state.modalMetric) {
            refreshModalHistory(state.modalMetric, days).catch((error) => console.error(error));
          }
        });
      });

      txRangeButtons.forEach((button) => {
        button.addEventListener('click', () => {
          const days = Number(button.dataset.walletTxRange);
          if (!Number.isFinite(days)) return;
          if (state.modalTransactionsDays === days && state.modalTransactions) return;
          state.modalTransactionsDays = days;
          if (state.modalTransactions) {
            loadWalletTransactions(state.modalTransactions, days).then((payload) => {
              if (state.modalTransactions) {
                renderWalletTransactions(state.modalTransactions, payload || { available: false, rows: [], summary: {} });
              }
            }).catch((error) => console.error(error));
          }
        });
      });

      txFilterButtons.forEach((button) => {
        button.addEventListener('click', () => {
          const filter = String(button.dataset.walletTxFilter || 'all');
          state.modalTransactionsFilter = filter;
          txFilterButtons.forEach((candidate) => {
            const active = String(candidate.dataset.walletTxFilter || 'all') === filter;
            candidate.classList.toggle('active', active);
            candidate.setAttribute('aria-pressed', active ? 'true' : 'false');
          });
          refreshWalletTransactionsView();
        });
      });

      modalElements.windowPrev?.addEventListener('click', () => {
        shiftModalHistoryWindow(-1);
      });

      modalElements.windowNext?.addEventListener('click', () => {
        shiftModalHistoryWindow(1);
      });

      document.addEventListener('keydown', (event) => {
        if (!state.modalMetric || modalElements.backdrop.getAttribute('aria-hidden') === 'true') return;
        const target = event.target;
        if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable)) {
          return;
        }
        if (event.key === 'ArrowLeft') {
          event.preventDefault();
          shiftModalHistoryWindow(-1);
        } else if (event.key === 'ArrowRight') {
          event.preventDefault();
          shiftModalHistoryWindow(1);
        }
      });

      modalElements.close.addEventListener('click', closeModal);
      txModalElements.close?.addEventListener('click', closeWalletTransactionsModal);
      txModalElements.refresh?.addEventListener('click', () => {
        if (!state.modalTransactions) return;
        renderWalletTransactions(state.modalTransactions, { loading: true, available: true, rows: [], summary: {} });
        void loadWalletTransactions(state.modalTransactions, state.modalTransactionsDays, { refresh: true }).then((payload) => {
          if (state.modalTransactions) {
            renderWalletTransactions(state.modalTransactions, payload || { available: false, rows: [], summary: {} });
          }
        });
      });
      modalElements.info.addEventListener('click', () => {
        if (!modalElements.explanation.textContent) return;
        state.explanationOpen = !state.explanationOpen;
        modalElements.explanation.hidden = !state.explanationOpen;
        modalElements.info.title = state.explanationOpen ? 'Hide metric explanation' : 'Show metric explanation';
        modalElements.info.setAttribute('aria-label', state.explanationOpen ? 'Hide metric explanation' : 'Show metric explanation');
      });
      modalElements.backdrop.addEventListener('click', (event) => {
        if (event.target === modalElements.backdrop) {
          closeModal();
        }
      });
      txModalElements.backdrop?.addEventListener('click', (event) => {
        if (event.target === txModalElements.backdrop) {
          closeWalletTransactionsModal();
        }
      });
      document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && (modalElements.backdrop.classList.contains('open') || txModalElements.backdrop?.classList.contains('open'))) {
          if (txModalElements.backdrop?.classList.contains('open')) {
            closeWalletTransactionsModal();
            return;
          }
          closeModal();
        }
      });
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState !== 'visible') return;
        if (!state.pendingLiveReload) return;
        if (modalElements.backdrop.classList.contains('open')) return;
        state.pendingLiveReload = false;
        window.location.reload();
      });

      bindMetricClicks();
      updateCurrencyToggleButton();
      updateTaoPriceLabel();
      updateNextPollLabel();
      updatePollIntervalButtons();
      updatePollIntervalLabel();
      syncSchedulerState();
      syncLiveSnapshotState();
      setInterval(() => {
        syncSchedulerState();
        syncLiveSnapshotState();
      }, 60000);

      Promise.all([
        loadHistory().then((history) => {
          state.history = history;
          return history;
        }),
        loadHistory(30, 'tao-flow').then((history) => {
          state.flowHistory = history;
          return history;
        }),
      ]).then(() => {
        syncCurrencyMode();
      }).catch((error) => console.error(error));
    </script>
`;
}

function renderPage(model) {
  const {
    latest,
    recent,
    ingestRun,
    totalSnapshots,
    totalWalletSnapshots,
    comparisons,
    config,
    netuid,
    latestTaoPriceUsd,
    nextPollAtIso,
    walletEntries,
    walletActivityStatus,
    alphaHolderRows,
    alphaHolderRowCount,
    alphaHolderRankingRows,
    alphaHolderCurrentRankRow,
    alphaHolderRankHistoryStartAt,
    scheduleStatus,
    scheduleQueue,
    alphaHolderBackfillActive,
    alphaHolderBackfillStartedAtIso,
    subnetLabel,
  } = model;
  const latestMetricDefs = getLatestMetricDefs();
  const signal = latest ? buildSignalSummary(latest, comparisons, latestMetricDefs) : null;
  const insight = buildInsightSummary(latest, comparisons, signal);
  const title = `${subnetLabel || `SN${netuid}`} Tracker`;
  const subtitle = latest
    ? `Latest snapshot captured ${formatRelativeIso(latest.captured_at)}`
    : 'No snapshots captured yet';
  const walletActivityText = formatWalletActivityStatusText(walletActivityStatus);
  const taostatsSubnetUrl = buildTaostatsSubnetUrl(netuid, config.taostatsPublicBaseUrl);
  const subnetHeaderLabel = subnetLabel || `SN${netuid}`;
  const subnetHeaderTitle = escapeHtml(title);
  const subnetHeaderLink = taostatsSubnetUrl
    ? `<a class="subnet-header-link" href="${escapeHtml(taostatsSubnetUrl)}" target="_blank" rel="noopener noreferrer" title="Open ${escapeHtml(subnetHeaderLabel)} on Taostats">${escapeHtml(subnetHeaderLabel)}</a>`
    : escapeHtml(subnetHeaderLabel);
  const subnetHeaderTitleLink = taostatsSubnetUrl
    ? `<a class="subnet-title-link" href="${escapeHtml(taostatsSubnetUrl)}" target="_blank" rel="noopener noreferrer" title="Open ${escapeHtml(subnetHeaderLabel)} on Taostats">${subnetHeaderTitle}</a>`
    : subnetHeaderTitle;

  const cards = latest ? renderLatestSnapshotCards(latest, latestMetricDefs) : '';
  const pollIntervalButtons = POLL_INTERVAL_OPTIONS.map((minutes) => {
    const active = Number(config.pollIntervalMinutes) === minutes;
    return `<button class="button poll-button${active ? ' active' : ''}" type="button" data-poll-interval="${minutes}" aria-pressed="${active ? 'true' : 'false'}">${minutes / 60}h</button>`;
  }).join('');
  const taoPriceText = Number.isFinite(Number(latestTaoPriceUsd))
    ? `TAO price used: τ 1 ≈ ${formatUsd(latestTaoPriceUsd, 2)}`
    : 'TAO price used: unavailable';
  const nextPollText = nextPollAtIso ? `Next poll: ${formatPollTime(nextPollAtIso)}` : 'Next poll: —';
  const nextPollTitle = nextPollAtIso ? `Scheduled for ${formatIso(nextPollAtIso)}` : 'Poll schedule unavailable';
  const walletActivityBadge = renderWalletActivityStatusBadge(walletActivityStatus, { id: 'wallet-activity-topbar-badge' });
  const adminSessionAction = config.adminAuthEnabled
    ? (config.adminAuthenticated
      ? `<form class="admin-session-form topbar-admin-session" method="post" action="/admin/logout"><button class="button" type="submit">Admin logout</button></form>`
      : '<a class="button" href="/admin">Admin login</a>')
    : '';

  const latestRunCard = ingestRun
    ? metricCard({
        label: 'Latest ingest',
        value: ingestRun.ok ? 'OK' : 'Failed',
        subtext: `${formatRelativeIso(ingestRun.started_at)} • ${ingestRun.source}${ingestRun.fallback_used ? ' • fallback used' : ''} • ${ingestRun.duration_ms} ms`,
        tone: ingestRun.ok ? 'positive' : 'negative',
      })
    : metricCard({ label: 'Latest ingest', value: '—', subtext: 'No run yet' });

  const latestCard = latest
    ? `
      <section class="hero">
        <div class="hero-copy">
          <div class="eyebrow">Subnet ${subnetHeaderLink}</div>
          <h1>${subnetHeaderTitleLink}</h1>
          <p>${escapeHtml(subtitle)}</p>
        </div>
        <div class="hero-meta">
          <div><strong>Snapshots</strong><span>${totalSnapshots}</span></div>
          <div><strong>Latest block</strong><span>${escapeHtml(latest.block_number ?? '—')}</span></div>
          <div><strong>Remote time</strong><span>${escapeHtml(formatIso(latest.remote_timestamp))}</span></div>
          <div><strong>Source</strong><span>${escapeHtml(latest.source)}</span></div>
        </div>
      </section>
    `
    : `
      <section class="hero">
        <div class="hero-copy">
          <div class="eyebrow">Subnet ${subnetHeaderLink}</div>
          <h1>${subnetHeaderTitleLink}</h1>
          <p>${escapeHtml(subtitle)}</p>
        </div>
        <div class="hero-meta">
          <div><strong>Snapshots</strong><span>${totalSnapshots}</span></div>
          <div><strong>API key</strong><span>${config.taostatsAuthHeader ? 'configured' : 'not configured'}</span></div>
          <div><strong>Poll interval</strong><span>${config.pollIntervalMinutes} min</span></div>
        </div>
      </section>
    `;

  return `<!doctype html>
  <html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    <style>
      :root {
        color-scheme: dark;
        --bg: #0b0f14;
        --panel: #101722;
        --panel-2: #131d2b;
        --border: #223043;
        --text: #e7eef7;
        --muted: #8fa3b8;
        --positive: #1db954;
        --negative: #ff6b6b;
        --accent: #00dbbc;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        background: linear-gradient(180deg, #071019 0%, #0b0f14 100%);
        color: var(--text);
      }
      a { color: var(--accent); }
      .shell { max-width: 1480px; margin: 0 auto; padding: 28px; }
      .topbar {
        display: flex; justify-content: space-between; gap: 16px; align-items: center; flex-wrap: wrap;
        margin-bottom: 24px;
      }
      .topbar .actions { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
      .admin-session-form { margin: 0; }
      .topbar-admin-session { display: inline-flex; }
      .topbar-wallet-status {
        flex-basis: 100%;
        margin-top: -8px;
        font-size: 13px;
        display: flex;
        align-items: center;
        gap: 10px;
        flex-wrap: wrap;
      }
      .wallet-activity-status {
        line-height: 1.4;
      }
      .status-badge {
        display: inline-flex;
        align-items: center;
        padding: 7px 10px;
        border-radius: 999px;
        border: 1px solid transparent;
        font-size: 12px;
        font-weight: 700;
        letter-spacing: .04em;
        line-height: 1;
        text-transform: uppercase;
        white-space: nowrap;
      }
      .status-badge-positive {
        color: #d8ffe7;
        background: rgba(29, 185, 84, 0.16);
        border-color: rgba(29, 185, 84, 0.45);
      }
      .status-badge-accent {
        color: #c8fff7;
        background: rgba(0, 219, 188, 0.14);
        border-color: rgba(0, 219, 188, 0.45);
      }
      .status-badge-neutral {
        color: #d2dae5;
        background: rgba(143, 163, 184, 0.13);
        border-color: rgba(143, 163, 184, 0.34);
      }
      .admin-wallet-activity-status {
        display: flex;
        align-items: center;
        gap: 10px;
        flex-wrap: wrap;
      }
      .poll-switcher {
        display: inline-flex;
        gap: 6px;
        padding: 4px;
        border-radius: 999px;
        border: 1px solid var(--border);
        background: rgba(255, 255, 255, 0.03);
      }
      .poll-switcher .poll-button {
        padding: 9px 12px;
        border-radius: 999px;
        font-size: 12px;
        letter-spacing: .06em;
        text-transform: uppercase;
        min-width: 64px;
      }
      .poll-switcher .poll-button.active {
        background: rgba(0, 219, 188, 0.14);
        border-color: rgba(0, 219, 188, 0.65);
      }
      .price-badge {
        display: inline-flex;
        align-items: center;
        padding: 10px 12px;
        border-radius: 999px;
        border: 1px solid rgba(255, 255, 255, 0.08);
        background: rgba(255, 255, 255, 0.03);
        color: #cbd5e1;
        font-size: 13px;
        line-height: 1;
        white-space: nowrap;
      }
      .price-badge-button {
        appearance: none;
        border: 1px solid rgba(255, 255, 255, 0.08);
        cursor: pointer;
        font: inherit;
      }
      .price-badge-button:hover {
        border-color: var(--accent);
        transform: translateY(-1px);
      }
      .price-badge strong { color: #fff; font-weight: 700; }
      .button {
        appearance: none; border: 1px solid var(--border); background: var(--panel);
        color: var(--text); padding: 10px 14px; border-radius: 12px; cursor: pointer;
      }
      .button:hover { border-color: var(--accent); }
      .button.primary { background: rgba(0, 219, 188, 0.1); border-color: rgba(0, 219, 188, 0.5); }
      .hero {
        background: radial-gradient(circle at top right, rgba(0, 219, 188, 0.12), transparent 32%),
                    linear-gradient(180deg, var(--panel), var(--panel-2));
        border: 1px solid var(--border); border-radius: 24px; padding: 24px;
        display: grid; grid-template-columns: minmax(0, 1.3fr) minmax(360px, 0.7fr); gap: 20px;
      }
      .hero-copy { display: grid; align-content: start; }
      .eyebrow { color: var(--accent); letter-spacing: .18em; text-transform: uppercase; font-size: 12px; margin-bottom: 8px; }
      h1 { margin: 0; font-size: clamp(32px, 4vw, 48px); }
      .hero p { color: var(--muted); margin: 12px 0 0; }
      .subnet-header-link,
      .subnet-title-link {
        color: inherit;
        text-decoration: none;
      }
      .subnet-header-link:hover,
      .subnet-header-link:focus-visible,
      .subnet-title-link:hover,
      .subnet-title-link:focus-visible {
        color: #ffffff;
        text-decoration: underline;
        text-underline-offset: 3px;
      }
      .subnet-header-link:focus-visible,
      .subnet-title-link:focus-visible {
        outline: 2px solid var(--accent);
        outline-offset: 3px;
        border-radius: 6px;
      }
      .hero-meta {
        display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px;
      }
      .hero-meta div, .card {
        background: rgba(6, 10, 16, 0.45);
        border: 1px solid var(--border);
        border-radius: 18px;
        padding: 14px;
      }
      .hero-meta strong, .card-label {
        display: block; color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: .08em;
      }
      .hero-meta span, .card-value {
        display: block; margin-top: 8px; font-size: 18px; font-weight: 700;
      }
      .card-button {
        width: 100%;
        text-align: left;
        cursor: pointer;
        appearance: none;
        position: relative;
        overflow: hidden;
        padding-right: 46px;
      }
      .card-button:hover {
        border-color: rgba(0, 219, 188, 0.7);
        transform: translateY(-1px);
      }
      .card-button:focus-visible,
      .button:focus-visible {
        outline: 2px solid var(--accent);
        outline-offset: 2px;
      }
      .card-subtext { color: var(--muted); margin-top: 6px; font-size: 12px; word-break: break-word; }
      .card-badge {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        margin-top: 8px;
        padding: 4px 9px;
        border-radius: 999px;
        border: 1px solid rgba(0, 219, 188, 0.26);
        background: rgba(0, 219, 188, 0.08);
        color: #bffbf1;
        font-size: 11px;
        font-weight: 600;
        letter-spacing: 0.02em;
        width: fit-content;
        max-width: 100%;
      }
      .card-badge span {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .card-info-badge {
        position: absolute;
        top: 12px;
        right: 12px;
        width: 22px;
        height: 22px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        border-radius: 999px;
        border: 1px solid rgba(143, 163, 184, 0.45);
        background: rgba(0, 0, 0, 0.2);
        color: var(--muted);
        font-size: 11px;
        font-weight: 700;
        pointer-events: auto;
      }
      .positive .card-value { color: var(--positive); }
      .negative .card-value { color: var(--negative); }
      .section { margin-top: 24px; }
      .section h2 { margin: 0 0 12px; font-size: 20px; }
      .grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 14px; }
      .grid.compact { grid-template-columns: repeat(3, minmax(0, 1fr)); }
      .grid.stats { grid-template-columns: repeat(4, minmax(0, 1fr)); }
      .chart-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px; }
      .panel {
        background: rgba(16, 23, 34, 0.88);
        border: 1px solid var(--border);
        border-radius: 20px;
        padding: 16px;
      }
      .panel h3 { margin: 0 0 14px; font-size: 16px; }
      .section-copy {
        margin: 0 0 12px;
      }
      .section-copy p {
        margin: 6px 0 0;
        color: var(--muted);
      }
      .signal-panel {
        display: grid;
        gap: 14px;
        padding: 20px;
      }
      .signal-panel.positive {
        border-color: rgba(29, 185, 84, 0.45);
        background: linear-gradient(180deg, rgba(29, 185, 84, 0.10), rgba(16, 23, 34, 0.92));
      }
      .signal-panel.negative {
        border-color: rgba(255, 107, 107, 0.45);
        background: linear-gradient(180deg, rgba(255, 107, 107, 0.10), rgba(16, 23, 34, 0.92));
      }
      .signal-panel.neutral {
        border-color: rgba(143, 163, 184, 0.28);
        background: linear-gradient(180deg, rgba(0, 219, 188, 0.06), rgba(16, 23, 34, 0.92));
      }
      .signal-panel-head {
        display: flex;
        justify-content: space-between;
        gap: 16px;
        align-items: start;
      }
      .signal-panel h2 { margin: 0; font-size: 26px; }
      .signal-panel p { margin: 8px 0 0; color: var(--muted); }
      .signal-badge {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        padding: 10px 14px;
        border-radius: 999px;
        border: 1px solid rgba(143, 163, 184, 0.22);
        background: rgba(6, 10, 16, 0.45);
        color: var(--text);
        font-weight: 700;
        white-space: nowrap;
      }
      .signal-bullets {
        margin: 0;
        padding-left: 18px;
        color: var(--text);
        display: grid;
        gap: 6px;
      }
      .signal-hint {
        color: var(--muted);
        font-size: 13px;
      }
      .signal-grid {
        margin-top: 14px;
      }
      .watchlist-section {
        margin-top: 16px;
      }
      .wallet-section {
        margin-top: 16px;
      }
      .financial-panel {
        margin-top: 16px;
        border: 1px solid var(--border);
        border-radius: 20px;
        background: rgba(10, 15, 23, 0.72);
        overflow: hidden;
      }
      .financial-panel > summary {
        list-style: none;
        cursor: pointer;
        padding: 16px 18px;
        font-weight: 700;
        color: var(--text);
        border-bottom: 1px solid rgba(143, 163, 184, 0.12);
        display: flex;
        align-items: center;
        gap: 10px;
      }
      .financial-panel > summary::-webkit-details-marker {
        display: none;
      }
      .financial-panel > summary::before {
        content: '▸';
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 16px;
        height: 16px;
        color: var(--accent);
        transition: transform 0.18s ease;
        flex: 0 0 auto;
      }
      .financial-panel[open] > summary::before {
        transform: rotate(90deg);
      }
      .financial-panel[open] > summary {
        border-bottom-color: rgba(143, 163, 184, 0.18);
      }
      .financial-panel-body {
        padding: 16px;
      }
      .chart-frame {
        position: relative;
        width: 100%;
        height: 240px;
      }
      .chart-frame.modal {
        height: 420px;
      }
      .chart-note {
        margin-top: 8px;
        color: var(--muted);
        font-size: 12px;
        line-height: 1.4;
      }
      .range-switcher {
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
      }
      .range-switcher .range-button {
        padding: 8px 12px;
        border-radius: 999px;
        font-size: 12px;
        letter-spacing: .06em;
        text-transform: uppercase;
      }
      .range-switcher .range-button.active {
        background: rgba(0, 219, 188, 0.14);
        border-color: rgba(0, 219, 188, 0.65);
      }
      .window-shift-row {
        display: flex;
        align-items: center;
        gap: 10px;
        margin: 0 0 14px;
      }
      .window-shift-row .window-button {
        min-width: 92px;
        border-radius: 999px;
        font-size: 12px;
        letter-spacing: .06em;
        text-transform: uppercase;
      }
      .window-shift-center {
        flex: 1;
        min-width: 0;
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 6px;
      }
      .window-shift-label {
        text-align: center;
        color: var(--muted);
        font-size: 12px;
        line-height: 1.4;
      }
      .chart-frame canvas {
        display: block;
        width: 100% !important;
        height: 100% !important;
      }
      .table-wrap { overflow-x: auto; border: 1px solid var(--border); border-radius: 16px; }
      table { width: 100%; border-collapse: collapse; min-width: 900px; background: rgba(16, 23, 34, 0.88); }
      table.alpha-holder-table { min-width: 760px; }
      table.alpha-holder-ranking-table { min-width: 860px; }
      th, td { padding: 12px 14px; border-bottom: 1px solid var(--border); text-align: left; }
      th { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: .08em; }
      .empty { color: var(--muted); padding: 16px; }
      .empty[data-status=\"warning\"] { color: #f59e0b; }
      .empty[data-status=\"error\"] { color: #f87171; }
      .empty[data-status=\"success\"] { color: #34d399; }
      .muted { color: var(--muted); }
      .stack { display: grid; gap: 14px; }
      .footer { margin-top: 18px; color: var(--muted); font-size: 13px; display: flex; gap: 18px; flex-wrap: wrap; }
      .modal-backdrop {
        position: fixed;
        inset: 0;
        display: none;
        align-items: center;
        justify-content: center;
        padding: 24px;
        background: rgba(3, 7, 12, 0.78);
        backdrop-filter: blur(8px);
        z-index: 40;
      }
      .modal-backdrop.open { display: flex; }
      .modal-panel {
        width: min(1100px, 100%);
        max-height: min(90vh, 980px);
        overflow: auto;
        border: 1px solid var(--border);
        border-radius: 24px;
        background: linear-gradient(180deg, rgba(16, 23, 34, 0.98), rgba(19, 29, 43, 0.98));
        box-shadow: 0 30px 90px rgba(0, 0, 0, 0.4);
        padding: 20px;
      }
      .modal-header {
        display: flex;
        gap: 16px;
        justify-content: space-between;
        align-items: start;
        margin-bottom: 16px;
      }
      .modal-header h3 {
        margin: 0;
        font-size: 22px;
      }
      .modal-header p {
        margin: 8px 0 0;
        color: var(--muted);
      }
      .modal-title-row {
        display: flex;
        align-items: center;
        gap: 10px;
        flex-wrap: wrap;
      }
      .info-button {
        appearance: none;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 30px;
        height: 30px;
        border-radius: 999px;
        border: 1px solid var(--border);
        background: rgba(0, 219, 188, 0.08);
        color: var(--text);
        cursor: pointer;
        font-weight: 700;
        line-height: 1;
        flex: 0 0 auto;
      }
      .info-button:hover {
        border-color: var(--accent);
      }
      .modal-explanation {
        margin-top: 12px;
        padding: 12px 14px;
        border: 1px solid rgba(0, 219, 188, 0.2);
        border-radius: 16px;
        background: rgba(0, 219, 188, 0.06);
        color: var(--text);
      }
      .modal-explanation[hidden] {
        display: none;
      }
      .modal-wallet-details {
        margin-top: 12px;
        padding: 14px;
        border: 1px solid rgba(143, 163, 184, 0.18);
        border-radius: 16px;
        background: rgba(11, 16, 26, 0.55);
      }
      .modal-wallet-details[hidden] {
        display: none;
      }
      .wallet-details-title {
        margin: 0 0 12px;
        font-size: 15px;
        letter-spacing: 0.02em;
        color: var(--muted);
        text-transform: uppercase;
      }
      .wallet-breakdown-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));
        gap: 12px;
      }
      .wallet-breakdown-card {
        padding: 12px 14px;
        border-radius: 14px;
        border: 1px solid rgba(143, 163, 184, 0.16);
        background: rgba(255, 255, 255, 0.02);
      }
      .wallet-breakdown-card .label {
        font-size: 11px;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: var(--muted);
      }
      .wallet-breakdown-card .value {
        margin-top: 6px;
        font-size: 22px;
        font-weight: 700;
        color: var(--text);
      }
      .wallet-breakdown-card .subtext {
        margin-top: 4px;
        color: var(--muted);
        font-size: 12px;
      }
      .wallet-positions {
        margin-top: 16px;
      }
      .wallet-profile {
        margin-top: 16px;
      }
      .wallet-attribution {
        margin-top: 16px;
      }
      .wallet-hotkeys {
        margin: 0 0 14px;
      }
      .wallet-hotkey-list {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
      }
      .wallet-hotkey-pill {
        display: inline-flex;
        flex-direction: column;
        gap: 2px;
        min-width: 180px;
        padding: 10px 12px;
        border-radius: 12px;
        border: 1px solid rgba(143, 163, 184, 0.16);
        background: rgba(255, 255, 255, 0.03);
      }
      .wallet-hotkey-pill strong {
        font-size: 13px;
        color: var(--text);
        font-weight: 700;
      }
      .wallet-hotkey-pill small {
        font-size: 11px;
        color: var(--muted);
        line-height: 1.35;
      }
      .wallet-positions-scroll {
        max-height: 320px;
        overflow: auto;
        border: 1px solid rgba(143, 163, 184, 0.12);
        border-radius: 14px;
        background: rgba(255, 255, 255, 0.02);
      }
      .wallet-positions-table {
        width: 100%;
        border-collapse: collapse;
      }
      .wallet-positions-table th,
      .wallet-positions-table td {
        padding: 10px 8px;
        text-align: left;
        border-bottom: 1px solid rgba(143, 163, 184, 0.12);
      }
      .wallet-positions-table th {
        font-size: 11px;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: var(--muted);
        position: sticky;
        top: 0;
        background: rgba(11, 16, 26, 0.95);
        backdrop-filter: blur(8px);
        z-index: 1;
      }
      .wallet-positions-table td {
        font-size: 13px;
      }
      .wallet-positions-table tr:last-child td {
        border-bottom: none;
      }
      .wallet-positions-empty {
        color: var(--muted);
        padding: 6px 0 0;
      }
      .wallet-breakdown-row {
        display: flex;
        gap: 12px;
        flex-wrap: nowrap;
        overflow-x: auto;
        padding-bottom: 2px;
      }
      .wallet-breakdown-row .wallet-breakdown-card {
        min-width: 150px;
        flex: 1 0 0;
      }
      .wallet-positions-head {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: 10px;
        flex-wrap: wrap;
      }
      .wallet-current-stake-row {
        display: flex;
        gap: 10px;
        flex-wrap: nowrap;
        overflow-x: auto;
        padding-bottom: 2px;
      }
      .wallet-current-stake-card {
        min-width: 210px;
        flex: 0 0 auto;
        padding: 12px 14px;
        border-radius: 14px;
        border: 1px solid rgba(143, 163, 184, 0.16);
        background: rgba(255, 255, 255, 0.03);
      }
      .wallet-current-stake-card .label {
        font-size: 11px;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: var(--muted);
      }
      .wallet-current-stake-card .value {
        margin-top: 6px;
        font-size: 18px;
        font-weight: 700;
        color: var(--text);
      }
      .wallet-current-stake-card .subtext {
        margin-top: 4px;
        color: var(--muted);
        font-size: 12px;
      }
      .wallet-history-details {
        margin-top: 14px;
        padding: 12px 14px;
        border: 1px solid rgba(143, 163, 184, 0.14);
        border-radius: 14px;
        background: rgba(255, 255, 255, 0.02);
      }
      .wallet-history-details > summary {
        cursor: pointer;
        list-style: none;
        font-size: 13px;
        font-weight: 700;
        color: var(--text);
        text-transform: uppercase;
        letter-spacing: 0.08em;
        display: flex;
        align-items: center;
        gap: 10px;
      }
      .wallet-history-details > summary::-webkit-details-marker {
        display: none;
      }
      .wallet-history-details > summary::before {
        content: '▸';
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 16px;
        height: 16px;
        color: var(--accent);
        transition: transform 0.18s ease;
        flex: 0 0 auto;
      }
      .wallet-history-details[open] > summary::before {
        transform: rotate(90deg);
      }
      .alpha-holder-details {
        margin-top: 14px;
        padding: 12px 14px;
        border: 1px solid rgba(143, 163, 184, 0.14);
        border-radius: 14px;
        background: rgba(255, 255, 255, 0.02);
      }
      .alpha-holder-details > summary {
        cursor: pointer;
        list-style: none;
        font-size: 13px;
        font-weight: 700;
        color: var(--text);
        text-transform: uppercase;
        letter-spacing: 0.08em;
        display: flex;
        align-items: center;
        gap: 10px;
      }
      .alpha-holder-details > summary::-webkit-details-marker {
        display: none;
      }
      .alpha-holder-details > summary::before {
        content: '▸';
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 16px;
        height: 16px;
        color: var(--accent);
        transition: transform 0.18s ease;
        flex: 0 0 auto;
      }
      .alpha-holder-details[open] > summary::before {
        transform: rotate(90deg);
      }
      .alpha-holder-ranking-details {
        margin-top: 14px;
        padding: 12px 14px;
        border: 1px solid rgba(143, 163, 184, 0.14);
        border-radius: 14px;
        background: rgba(255, 255, 255, 0.02);
      }
      .alpha-holder-ranking-details > summary {
        cursor: pointer;
        list-style: none;
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        gap: 4px 14px;
        align-items: center;
      }
      .alpha-holder-ranking-details > summary::-webkit-details-marker {
        display: none;
      }
      .alpha-holder-ranking-details > summary::before {
        content: '▸';
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 16px;
        height: 16px;
        color: var(--accent);
        transition: transform 0.18s ease;
        flex: 0 0 auto;
        grid-column: 2;
        grid-row: 1 / span 2;
        align-self: center;
      }
      .alpha-holder-ranking-details[open] > summary::before {
        transform: rotate(90deg);
      }
      .alpha-holder-ranking-summary-kicker {
        grid-column: 1 / -1;
        font-size: 12px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        color: var(--accent);
      }
      .alpha-holder-ranking-summary-title {
        font-size: 18px;
        font-weight: 700;
        color: var(--text);
      }
      .alpha-holder-ranking-summary-label {
        font-size: 14px;
        font-weight: 700;
        color: #d9fffa;
      }
      .alpha-holder-ranking-summary-value {
        grid-column: 2;
        grid-row: 2 / span 2;
        align-self: center;
        font-size: 34px;
        font-weight: 800;
        line-height: 1;
        color: #fff;
      }
      .alpha-holder-ranking-summary-subtext {
        font-size: 13px;
        line-height: 1.45;
        color: var(--muted);
      }
      .alpha-holder-ranking-panel {
        margin-top: 10px;
        display: grid;
        gap: 10px;
      }
      .alpha-holder-ranking-head {
        display: grid;
        gap: 8px;
        grid-template-columns: minmax(0, 1fr);
        align-items: start;
      }
      .alpha-holder-ranking-head h3 {
        margin: 0;
        font-size: 16px;
        letter-spacing: 0.01em;
      }
      .alpha-holder-ranking-head p {
        margin: 0;
        max-width: 64ch;
        font-size: 13px;
        line-height: 1.45;
      }
      table.alpha-holder-ranking-table {
        min-width: 920px;
      }
      .alpha-holder-ranking-table th,
      .alpha-holder-ranking-table td {
        padding-top: 10px;
        padding-bottom: 10px;
      }
      .alpha-holder-ranking-table thead th {
        font-size: 11px;
        color: #94a9bb;
      }
      .alpha-holder-ranking-table tr.current {
        box-shadow: inset 0 0 0 1px rgba(0, 219, 188, 0.18);
      }
      .alpha-holder-ranking-table tr.current td {
        background: linear-gradient(90deg, rgba(0, 219, 188, 0.10), rgba(0, 219, 188, 0.03));
      }
      .alpha-holder-ranking-table tr.current td:first-child {
        color: #fff;
        font-weight: 700;
      }
      .alpha-holder-ranking-table tr.current td:nth-child(2) {
        font-weight: 700;
      }
      .alpha-holder-ranking-table tbody tr:hover td {
        background: rgba(255, 255, 255, 0.03);
      }
      .alpha-holder-ranking-table td:first-child,
      .alpha-holder-ranking-table th:first-child {
        width: 72px;
        text-align: center;
      }
      .alpha-holder-ranking-table td:nth-child(3),
      .alpha-holder-ranking-table th:nth-child(3) {
        text-align: right;
      }
      .alpha-holder-ranking-table td:nth-child(4),
      .alpha-holder-ranking-table th:nth-child(4) {
        text-align: center;
      }
      .alpha-holder-ranking-table td:nth-child(5),
      .alpha-holder-ranking-table th:nth-child(5) {
        text-align: left;
      }
      .alpha-holder-subnet-link {
        color: #d9fffa;
        text-decoration: none;
        font-weight: 700;
      }
      .alpha-holder-subnet-link:hover,
      .alpha-holder-subnet-link:focus-visible {
        color: #ffffff;
        text-decoration: underline;
        text-underline-offset: 2px;
      }
      .alpha-holder-ranking-change,
      .alpha-holder-ranking-sparkline-cell {
        white-space: nowrap;
      }
      .alpha-holder-ranking-change.positive {
        color: var(--success);
      }
      .alpha-holder-ranking-change.negative {
        color: var(--warning);
      }
      .alpha-holder-ranking-change.neutral {
        color: var(--text);
      }
      .alpha-holder-ranking-sparkline-cell {
        min-width: 128px;
      }
      .alpha-holder-sparkline {
        display: inline-flex;
        align-items: center;
        gap: 6px;
      }
      .alpha-holder-sparkline svg {
        display: block;
        width: 84px;
        height: 24px;
        overflow: visible;
      }
      .alpha-holder-sparkline-line {
        fill: none;
        stroke: rgba(0, 219, 188, 0.88);
        stroke-width: 1.8;
        stroke-linecap: round;
        stroke-linejoin: round;
      }
      .alpha-holder-sparkline-value {
        font-size: 11px;
        font-weight: 700;
        color: rgba(255, 255, 255, 0.82);
      }
      .alpha-holder-sparkline-empty {
        color: var(--muted);
      }
      .alpha-holder-ranking-note {
        margin: 0;
        font-size: 12px;
      }
      .ranking-current-tag {
        display: inline-flex;
        align-items: center;
        margin-left: 6px;
        padding: 1px 7px;
        border-radius: 999px;
        background: rgba(0, 219, 188, 0.12);
        color: #bffbf1;
        font-size: 10px;
        font-weight: 700;
        letter-spacing: 0.06em;
        text-transform: uppercase;
        vertical-align: middle;
      }
      .admin-progress {
        width: 100%;
        height: 10px;
        border: 0;
        border-radius: 999px;
        overflow: hidden;
        background: rgba(143, 163, 184, 0.12);
        margin: 10px 0 8px;
      }
      .admin-progress::-webkit-progress-bar {
        background: rgba(143, 163, 184, 0.12);
        border-radius: 999px;
      }
      .admin-progress::-webkit-progress-value {
        background: linear-gradient(90deg, #00dbbc, #38bdf8);
        border-radius: 999px;
      }
      .admin-progress::-moz-progress-bar {
        background: linear-gradient(90deg, #00dbbc, #38bdf8);
        border-radius: 999px;
      }
      .wallet-attribution-history {
        margin-top: 14px;
      }
      .wallet-attribution-history > summary {
        cursor: pointer;
        list-style: none;
        font-size: 13px;
        font-weight: 700;
        color: var(--text);
        text-transform: uppercase;
        letter-spacing: 0.08em;
        display: flex;
        align-items: center;
        gap: 10px;
      }
      .wallet-attribution-history > summary::-webkit-details-marker {
        display: none;
      }
      .wallet-attribution-history > summary::before {
        content: '▸';
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 16px;
        height: 16px;
        color: var(--accent);
        transition: transform 0.18s ease;
        flex: 0 0 auto;
      }
      .wallet-attribution-history[open] > summary::before {
        transform: rotate(90deg);
      }
      .wallet-history-note {
        margin: 8px 0 10px;
        color: var(--muted);
        font-size: 13px;
      }
      .pool-growth-estimator {
        margin-top: 14px;
        padding: 12px 14px;
        border: 1px solid rgba(143, 163, 184, 0.14);
        border-radius: 14px;
        background: rgba(255, 255, 255, 0.02);
      }
      .pool-growth-estimator > summary {
        cursor: pointer;
        list-style: none;
        font-size: 13px;
        font-weight: 700;
        color: var(--text);
        text-transform: uppercase;
        letter-spacing: 0.08em;
        display: flex;
        align-items: center;
        gap: 10px;
      }
      .pool-growth-estimator > summary::-webkit-details-marker {
        display: none;
      }
      .pool-growth-estimator > summary::before {
        content: '▸';
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 16px;
        height: 16px;
        color: var(--accent);
        transition: transform 0.18s ease;
        flex: 0 0 auto;
      }
      .pool-growth-estimator[open] > summary::before {
        transform: rotate(90deg);
      }
      .pool-growth-estimator-body {
        margin-top: 8px;
      }
      .pool-estimator-layout {
        display: grid;
        grid-template-columns: 1fr;
        gap: 14px;
        align-items: stretch;
        transition: grid-template-columns 0.28s ease, gap 0.28s ease;
      }
      .pool-growth-estimator[data-pool-scenario-open="true"] .pool-estimator-layout {
        grid-template-columns: minmax(0, 1fr) minmax(0, 4fr);
      }
      .pool-estimator-main-column {
        min-width: 0;
        display: grid;
        gap: 12px;
        transition: opacity 0.28s ease, transform 0.28s ease;
      }
      .pool-estimator-scenario-column {
        min-width: 0;
        display: block;
        width: 100%;
        opacity: 1;
        transform: none;
        overflow: visible;
        pointer-events: auto;
        transition: opacity 0.28s ease, transform 0.28s ease;
      }
      .pool-growth-estimator[data-pool-scenario-open="true"] .pool-estimator-main-column {
        opacity: 1;
        transform: none;
      }
      .pool-growth-estimator[data-pool-scenario-open="true"] .pool-estimator-scenario-column {
        opacity: 1;
        transform: none;
      }
      .pool-estimator-controls {
        display: grid;
        gap: 12px;
      }
      .pool-estimator-input-row {
        display: flex;
        flex-wrap: wrap;
        gap: 12px;
        align-items: flex-end;
      }
      .pool-estimator-input-row label {
        display: grid;
        gap: 6px;
        color: var(--text);
        font-size: 13px;
        font-weight: 600;
        min-width: 220px;
      }
      .pool-estimator-input-row input {
        width: 100%;
        padding: 10px 12px;
        border-radius: 12px;
        border: 1px solid rgba(143, 163, 184, 0.18);
        background: rgba(4, 8, 16, 0.65);
        color: var(--text);
        font: inherit;
      }
      .pool-estimator-input-row input:focus {
        outline: 2px solid rgba(0, 219, 188, 0.24);
        outline-offset: 1px;
      }
      .pool-estimator-presets {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
      }
      .pool-estimator-results {
        margin-top: 0;
        grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
        transition: grid-template-columns 0.28s ease, gap 0.28s ease;
      }
      .pool-growth-estimator[data-pool-scenario-open="true"] .pool-estimator-results {
        grid-template-columns: 1fr;
      }
      .pool-estimator-summary {
        margin-top: 2px;
        color: var(--muted);
        font-size: 13px;
      }
      .pool-estimator-chart {
        margin-top: 0;
        display: grid;
        gap: 10px;
      }
      .pool-estimator-chart-row {
        display: grid;
        grid-template-columns: 92px minmax(0, 1fr) auto;
        gap: 10px;
        align-items: center;
      }
      .pool-estimator-chart-label {
        color: var(--muted);
        font-size: 12px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.06em;
      }
      .pool-estimator-chart-track {
        position: relative;
        height: 12px;
        border-radius: 999px;
        overflow: hidden;
        background: rgba(143, 163, 184, 0.16);
      }
      .pool-estimator-chart-fill {
        height: 100%;
        border-radius: inherit;
        transition: width 0.2s ease;
      }
      .pool-estimator-chart-fill.current {
        background: linear-gradient(90deg, rgba(0, 219, 188, 0.72), rgba(0, 219, 188, 0.34));
      }
      .pool-estimator-chart-fill.projected {
        background: linear-gradient(90deg, rgba(108, 140, 255, 0.76), rgba(108, 140, 255, 0.34));
      }
      .pool-estimator-chart-value {
        color: var(--text);
        font-size: 12px;
        font-variant-numeric: tabular-nums;
        text-align: right;
        white-space: nowrap;
      }
      .pool-estimator-chart-caption,
      .pool-estimator-unavailable {
        color: var(--muted);
        font-size: 13px;
      }
      .pool-estimator-scenario {
        margin-top: 0;
        padding: 12px;
        border: 1px solid rgba(143, 163, 184, 0.18);
        border-radius: 16px;
        background: rgba(7, 12, 26, 0.32);
        display: block;
        height: 100%;
        width: 100%;
      }
      .pool-estimator-scenario > .pool-estimator-scenario-summary {
        list-style: none;
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto auto;
        align-items: start;
        gap: 10px;
        min-height: 58px;
        padding: 10px 12px;
        border: 1px solid rgba(143, 163, 184, 0.14);
        border-radius: 14px;
        background: rgba(255, 255, 255, 0.025);
        transition: border-color 0.18s ease, background 0.18s ease, box-shadow 0.18s ease, transform 0.18s ease;
        pointer-events: auto;
      }
      .pool-estimator-scenario-summary-button-column {
        display: flex;
        align-items: center;
        justify-content: flex-end;
      }
      .pool-estimator-scenario > .pool-estimator-scenario-summary:hover {
        border-color: rgba(0, 219, 188, 0.32);
        background: rgba(255, 255, 255, 0.04);
        box-shadow: 0 0 0 1px rgba(0, 219, 188, 0.08) inset;
        transform: translateY(-1px);
      }
      .pool-estimator-scenario > .pool-estimator-scenario-summary::after {
        content: '▸';
        color: var(--accent);
        font-size: 16px;
        line-height: 1;
        margin-top: 0;
        flex: 0 0 auto;
        transition: transform 0.18s ease;
      }
      .pool-estimator-scenario-summary-text {
        min-width: 0;
        display: grid;
        gap: 4px;
        position: relative;
        z-index: 3;
        pointer-events: auto;
      }
      .pool-estimator-scenario-summary-text .pool-estimator-scenario-title {
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .pool-estimator-scenario[data-pool-scenario-open="true"] > .pool-estimator-scenario-summary::after {
        transform: rotate(90deg);
      }
      .pool-estimator-scenario-summary-hint {
        position: relative;
        z-index: 4;
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 8px 12px;
        border-radius: 999px;
        border: 1px solid rgba(0, 219, 188, 0.22);
        background: rgba(0, 219, 188, 0.08);
        color: var(--text);
        font-size: 12px;
        font-weight: 700;
        letter-spacing: 0.05em;
        text-transform: none;
        white-space: nowrap;
        width: fit-content;
        cursor: pointer;
        appearance: none;
        font: inherit;
        pointer-events: auto;
        justify-self: end;
        align-self: start;
      }
      .pool-estimator-scenario-summary-hint:focus-visible {
        outline: 2px solid rgba(0, 219, 188, 0.45);
        outline-offset: 2px;
      }
      .pool-estimator-scenario[data-pool-scenario-open="true"] .pool-estimator-scenario-summary-hint {
        color: var(--text);
      }
      .pool-estimator-scenario-body {
        display: grid;
        gap: 10px;
        padding-top: 10px;
        overflow: hidden;
        max-height: 0;
        opacity: 0;
        transform: translateY(-6px);
        transition: max-height 0.28s ease, opacity 0.24s ease, transform 0.28s ease, padding-top 0.28s ease;
        pointer-events: none;
      }
      .pool-estimator-scenario[data-pool-scenario-open="true"] .pool-estimator-scenario-body {
        max-height: 1200px;
        opacity: 1;
        transform: translateY(0);
        pointer-events: auto;
      }
      .pool-estimator-scenario-head {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 10px;
        flex-wrap: wrap;
      }
      .pool-estimator-scenario-meta-row {
        display: flex;
        justify-content: flex-start;
      }
      .pool-estimator-scenario-meta {
        display: inline-flex;
        align-items: center;
        padding: 6px 10px;
        border-radius: 999px;
        border: 1px solid rgba(143, 163, 184, 0.16);
        background: rgba(255, 255, 255, 0.03);
      }
      .pool-estimator-scenario-plot {
        margin-top: auto;
        width: 100%;
      }
      .pool-estimator-scenario .label {
        font-size: 10px;
        letter-spacing: 0.06em;
      }
      .pool-estimator-scenario-title {
        margin-top: 4px;
        color: var(--text);
        font-size: 12px;
        font-weight: 700;
      }
      .pool-estimator-scenario-meta {
        color: var(--muted);
        font-size: 12px;
        font-weight: 600;
        font-variant-numeric: tabular-nums;
        text-align: left;
      }
      .pool-estimator-scenario-svg {
        width: 100%;
        height: auto;
        overflow: visible;
      }
      .pool-estimator-scenario-plot {
        position: relative;
      }
      .pool-estimator-scenario-axis-line {
        stroke: rgba(143, 163, 184, 0.24);
        stroke-width: 0.45;
      }
      .pool-estimator-scenario-grid-line {
        stroke: rgba(143, 163, 184, 0.1);
        stroke-width: 0.55;
        stroke-dasharray: 2 4;
      }
      .pool-estimator-scenario-grid-label {
        fill: rgba(143, 163, 184, 0.75);
        font-size: 7px;
        font-weight: 600;
        letter-spacing: 0.03em;
      }
      .pool-estimator-scenario-axis-line.dotted,
      .pool-estimator-scenario-crosshair {
        stroke-dasharray: 4 4;
      }
      .pool-estimator-scenario-area {
        fill: url(#pool-growth-scenario-fill);
        stroke: none;
      }
      .pool-estimator-scenario-line {
        fill: none;
        stroke: rgba(0, 219, 188, 0.95);
        stroke-width: 0.9;
        stroke-linecap: round;
        stroke-linejoin: round;
      }
      .pool-estimator-scenario-crosshair {
        stroke: rgba(255, 255, 255, 0.78);
        stroke-width: 0.95;
        pointer-events: none;
      }
      .pool-estimator-scenario-hit-area {
        fill: transparent;
        pointer-events: all;
        cursor: crosshair;
      }
      .pool-estimator-scenario-axis-label {
        fill: var(--muted);
        font-size: 8px;
        font-weight: 600;
        letter-spacing: 0.03em;
      }
      .pool-estimator-scenario-tooltip {
        position: absolute;
        min-width: 140px;
        max-width: 190px;
        padding: 8px 10px;
        border-radius: 14px;
        border: 1px solid rgba(143, 163, 184, 0.22);
        background: rgba(5, 10, 25, 0.96);
        box-shadow: 0 12px 24px rgba(0, 0, 0, 0.24);
        pointer-events: none;
        transform: translate(0, -100%);
      }
      .pool-estimator-scenario-tooltip-title {
        color: var(--muted);
        font-size: 8px;
        font-weight: 700;
        letter-spacing: 0.06em;
        text-transform: uppercase;
      }
      .pool-estimator-scenario-tooltip-value {
        margin-top: 4px;
        color: var(--text);
        font-size: 11px;
        font-weight: 700;
        font-variant-numeric: tabular-nums;
      }
      .pool-estimator-scenario-tooltip-subtext {
        margin-top: 4px;
        color: var(--muted);
        font-size: 9px;
        font-variant-numeric: tabular-nums;
      }
      .pool-estimator-scenario-caption {
        color: var(--muted);
        font-size: 10px;
      }
      .pool-estimator-scenario-unavailable {
        margin-top: 16px;
      }
      .pool-estimator-unavailable {
        margin: 8px 0 0;
      }
      @media (max-width: 1120px) {
        .pool-estimator-layout {
          display: grid;
          grid-template-columns: 1fr;
        }
        .pool-estimator-results {
          grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
        }
        .pool-estimator-main-column,
        .pool-estimator-scenario-column {
          opacity: 1;
          transform: none;
          pointer-events: auto;
          width: 100%;
        }
      }
      .wallet-history-scroll {
        max-height: 280px;
      }
      .wallet-history-delta {
        font-variant-numeric: tabular-nums;
        font-weight: 700;
      }
      .wallet-history-delta.positive {
        color: #34d399;
      }
      .wallet-history-delta.negative {
        color: #f87171;
      }
      .wallet-history-delta.neutral {
        color: var(--muted);
      }
      .modal-grid {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 14px;
        margin-bottom: 16px;
      }
      .modal-chart {
        min-height: 360px;
      }
      .wallet-transactions-panel {
        width: min(1240px, 100%);
      }
      .wallet-transactions-summary {
        margin-bottom: 14px;
      }
      .wallet-transactions-controls {
        align-items: flex-start;
        gap: 12px;
        flex-wrap: wrap;
        margin-bottom: 12px;
      }
      .wallet-tx-filter-row {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        justify-content: flex-end;
        align-items: center;
      }
      .wallet-transactions-note {
        margin: 0 0 12px;
        color: var(--muted);
        font-size: 13px;
      }
      .wallet-transactions-layout {
        display: grid;
        grid-template-columns: minmax(0, 2fr) minmax(320px, 1fr);
        gap: 14px;
        align-items: start;
      }
      .wallet-transactions-table-wrap {
        overflow: auto;
        border: 1px solid var(--border);
        border-radius: 16px;
        background: rgba(7, 12, 22, 0.55);
      }
      .wallet-transactions-table {
        min-width: 1080px;
        background: transparent;
      }
      .wallet-transactions-table tbody tr {
        cursor: pointer;
      }
      .wallet-transactions-table tbody tr:hover {
        background: rgba(0, 219, 188, 0.05);
      }
      .wallet-transactions-table tbody tr.active {
        background: rgba(0, 219, 188, 0.08);
      }
      .wallet-transactions-detail {
        padding: 14px;
        border: 1px solid rgba(143, 163, 184, 0.18);
        border-radius: 16px;
        background: rgba(11, 16, 26, 0.55);
        min-height: 320px;
      }
      .wallet-transactions-detail-empty {
        margin: 0;
        color: var(--muted);
        font-size: 13px;
      }
      .wallet-transactions-detail-pre {
        margin: 0;
        white-space: pre-wrap;
        word-break: break-word;
        color: var(--text);
        font-size: 12px;
        line-height: 1.45;
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      }
      .admin-panel {
        margin-top: 16px;
        border: 1px solid var(--border);
        border-radius: 20px;
        background: rgba(10, 15, 23, 0.72);
        overflow: hidden;
      }
      .admin-panel > summary {
        list-style: none;
        cursor: pointer;
        padding: 16px 18px;
        font-weight: 700;
        color: var(--text);
        border-bottom: 1px solid rgba(143, 163, 184, 0.12);
        display: flex;
        align-items: center;
        gap: 10px;
      }
      .admin-panel > summary::-webkit-details-marker {
        display: none;
      }
      .admin-panel > summary::before {
        content: '▸';
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 16px;
        height: 16px;
        color: var(--accent);
        transition: transform 0.18s ease;
        flex: 0 0 auto;
      }
      .admin-panel[open] > summary::before {
        transform: rotate(90deg);
      }
      .admin-panel[open] > summary {
        border-bottom-color: rgba(143, 163, 184, 0.18);
      }
      .admin-panel-body {
        padding: 16px;
      }
      .admin-actions {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
        margin-bottom: 16px;
      }
      .admin-form {
        display: grid;
        gap: 12px;
        margin-bottom: 16px;
      }
      .admin-form-row {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 12px;
      }
      .admin-form label {
        display: grid;
        gap: 6px;
        color: var(--muted);
        font-size: 13px;
        letter-spacing: 0.06em;
        text-transform: uppercase;
      }
      .admin-form input,
      .admin-form select {
        width: 100%;
        border: 1px solid var(--border);
        border-radius: 14px;
        background: rgba(6, 10, 16, 0.85);
        color: var(--text);
        padding: 10px 12px;
        font: inherit;
      }
      .admin-form .admin-checkbox {
        display: flex;
        align-items: center;
        gap: 10px;
        font-size: 14px;
        letter-spacing: 0;
        text-transform: none;
        color: var(--text);
      }
      .admin-form .admin-checkbox input {
        width: auto;
        margin: 0;
      }
      .admin-helper {
        margin: -4px 0 0;
        color: var(--muted);
        font-size: 12px;
        line-height: 1.45;
      }
      .schedule-paused-note {
        margin: 0 0 12px;
      }
      .schedule-status-table {
        min-width: 780px;
      }
      .schedule-status-table th,
      .schedule-status-table td {
        padding-top: 10px;
        padding-bottom: 10px;
      }
      .schedule-status-table thead th {
        font-size: 11px;
        color: #94a9bb;
        text-transform: uppercase;
        letter-spacing: 0.08em;
      }
      .schedule-row-title {
        font-size: 14px;
        font-weight: 700;
        color: var(--text);
      }
      .schedule-row-subtext {
        margin-top: 3px;
        color: var(--muted);
        font-size: 12px;
        line-height: 1.4;
      }
      .schedule-run-summary {
        color: var(--muted);
        font-size: 12px;
        line-height: 1.45;
      }
      .schedule-queue {
        display: grid;
        gap: 12px;
      }
      .schedule-queue-head {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 12px;
      }
      .schedule-queue-head h3 {
        margin: 0;
      }
      .schedule-queue-hint {
        color: var(--muted);
        font-size: 12px;
        line-height: 1.45;
        text-align: right;
      }
      .schedule-queue-list {
        list-style: none;
        margin: 0;
        padding: 0;
        display: grid;
        gap: 10px;
      }
      .schedule-queue-item {
        border: 1px solid var(--border);
        background: rgba(16, 23, 34, 0.72);
        border-radius: 8px;
        padding: 12px 14px;
      }
      .schedule-queue-item-head {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 12px;
      }
      .schedule-queue-item-kicker {
        color: var(--muted);
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.06em;
      }
      .schedule-queue-item-title {
        margin-top: 2px;
        font-size: 14px;
        font-weight: 700;
        color: var(--text);
      }
      .schedule-queue-item-meta {
        margin-top: 6px;
        color: var(--muted);
        font-size: 12px;
        line-height: 1.45;
      }
      .schedule-queue-empty {
        color: var(--muted);
        font-size: 12px;
        line-height: 1.45;
        padding: 2px 0;
      }
      .admin-grid {
        display: grid;
        gap: 14px;
      }
      body.modal-open {
        overflow: hidden;
      }
      @media (max-width: 900px) {
        .shell { padding: 20px; }
        .topbar {
          flex-direction: column;
          align-items: stretch;
        }
        .topbar .actions {
          width: 100%;
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: 8px;
          align-items: stretch;
        }
        .topbar .actions > * {
          width: 100%;
          min-width: 0;
        }
        #next-poll-label {
          grid-column: 1 / 2;
        }
        #currency-toggle {
          grid-column: 2 / 3;
        }
        #tao-price-label {
          grid-column: 1 / -1;
          white-space: normal;
          text-align: center;
          justify-content: center;
        }
        .hero {
          padding: 20px;
        }
        .signal-panel-head,
        .modal-header,
        .window-shift-row,
        .wallet-positions-head {
          flex-direction: column;
          align-items: stretch;
        }
        .alpha-holder-ranking-head {
          grid-template-columns: 1fr;
        }
        .modal-header .button {
          align-self: flex-start;
        }
        .modal-title-row {
          align-items: flex-start;
        }
        .signal-badge,
        .window-shift-label {
          align-self: flex-start;
        }
        .window-shift-center {
          width: 100%;
        }
        .admin-form-row {
          grid-template-columns: 1fr;
        }
        .admin-grid {
          grid-template-columns: 1fr;
        }
        .admin-controls .admin-actions {
          flex-direction: column;
        }
        .admin-controls .admin-actions > * {
          width: 100%;
        }
        .admin-actions {
          flex-direction: column;
          margin-bottom: 12px;
        }
        .admin-actions > * {
          width: 100%;
        }
        .admin-panel-body {
          padding: 12px;
        }
        .admin-grid .panel {
          padding: 14px;
        }
        .modal-panel {
          padding: 14px;
        }
        .wallet-breakdown-row,
        .wallet-current-stake-row {
          flex-wrap: wrap;
          overflow-x: visible;
        }
        .wallet-breakdown-row .wallet-breakdown-card {
          min-width: 0;
          flex: 1 1 100%;
        }
        .wallet-current-stake-card {
          min-width: 0;
          flex: 1 1 100%;
        }
        .wallet-positions-scroll {
          max-height: 260px;
        }
        .wallet-history-details {
          padding: 10px 12px;
        }
        .wallet-positions-table th,
        .wallet-positions-table td {
          padding: 8px 6px;
        }
        .wallet-hotkey-list {
          flex-direction: column;
        }
        .wallet-hotkey-pill {
          min-width: 0;
          width: 100%;
        }
      }
      @media (max-width: 1100px) {
        .hero, .grid, .grid.stats, .chart-grid, .modal-grid { grid-template-columns: 1fr; }
      }
      @media (max-width: 700px) {
        .shell { padding: 14px; }
        .grid.compact { grid-template-columns: 1fr; }
        .hero-meta {
          grid-template-columns: 1fr;
        }
        .hero h1 {
          font-size: clamp(28px, 8vw, 36px);
        }
        .topbar .actions {
          gap: 8px;
        }
        .topbar .actions > * {
          width: 100%;
          min-width: 0;
        }
        .price-badge {
          font-size: 12px;
          padding: 9px 11px;
        }
        .poll-switcher {
          width: 100%;
          justify-content: space-between;
          overflow-x: auto;
        }
        .poll-switcher .poll-button {
          flex: 1 0 auto;
        }
        .range-switcher {
          width: 100%;
          justify-content: space-between;
        }
        .window-shift-row .window-button {
          min-width: 0;
          flex: 1 1 0;
        }
        .modal-panel {
          padding: 14px;
          max-height: 94vh;
        }
        .modal-grid {
          gap: 10px;
        }
        .chart-frame {
          height: 210px;
        }
        .chart-frame.modal {
          height: 300px;
        }
        .admin-actions {
          flex-direction: column;
        }
        .admin-actions > * {
          width: 100%;
        }
        .admin-panel-body,
        .financial-panel-body {
          padding: 12px;
        }
        .wallet-breakdown-row .wallet-breakdown-card {
          flex-basis: 100%;
        }
        .wallet-positions-scroll,
        .wallet-history-scroll {
          max-height: 240px;
        }
        .wallet-positions-table {
          min-width: 760px;
        }
        .footer {
          flex-direction: column;
          gap: 8px;
        }
      }
    </style>
  </head>
  <body>
    <div class="shell" data-tao-price-usd="${escapeHtml(latestTaoPriceUsd ?? '')}" data-next-poll-at="${escapeHtml(nextPollAtIso ?? '')}" data-latest-snapshot-signature="${escapeHtml(latest?.captured_at ? `${latest.captured_at}|${latest.block_number ?? ''}|${latest.source ?? ''}` : '')}" data-latest-ingest-run-id="${escapeHtml(ingestRun?.id ?? '')}">
      <div class="topbar">
        <div class="muted">Local Taostats tracker for ${escapeHtml(subnetLabel || `SN${netuid}`)}</div>
        <div class="actions">
          <button class="price-badge price-badge-button" id="tao-price-label" type="button" aria-live="polite" title="Click to view TAO price history">${escapeHtml(taoPriceText)}</button>
          <div class="price-badge next-poll-badge" id="next-poll-label" data-next-poll-at="${escapeHtml(nextPollAtIso ?? '')}" title="${escapeHtml(nextPollTitle)}">${escapeHtml(nextPollText)}</div>
          <button class="button" id="currency-toggle" type="button" disabled>Show USD</button>
          ${adminSessionAction}
        </div>
        ${walletActivityBadge ? `<div class="topbar-wallet-status" id="wallet-activity-topbar-status">${walletActivityBadge}<span class="muted">${escapeHtml(walletActivityText)}</span></div>` : ''}
      </div>

      ${latestCard}

      ${renderWalletSection(walletEntries, latest, walletActivityStatus)}

      ${renderPoolGrowthSection(latest)}

      ${renderFinancialPerspectiveSection(signal, insight)}

      <section class="section">
        <h2>Key metrics</h2>
        <div class="grid">${cards}</div>
      </section>

      <section class="section">
        <h2>Subnet stats</h2>
        <div class="grid stats">${latest ? renderSubnetDataCards(latest, subnetLabel) : ''}</div>
      </section>

      ${(alphaHolderRows.length || alphaHolderRankingRows.length) ? renderAlphaHolderSection(alphaHolderRows, {
        latestCaptureAt: alphaHolderRows?.[0]?.captured_at ?? null,
        totalRowCount: alphaHolderRowCount,
        rankingRows: alphaHolderRankingRows,
        currentRankingRow: alphaHolderCurrentRankRow,
        currentNetuid: netuid,
        rankHistoryStartAt: alphaHolderRankHistoryStartAt,
        taostatsPublicBaseUrl: config.taostatsPublicBaseUrl,
      }) : ''}

      <section class="section">
        <h2>What changed in the last 24h</h2>
        ${renderComparisonSection(comparisons)}
      </section>

      <section class="section">
        <h2>Trend charts</h2>
        <div class="chart-grid">
          <div class="panel"><h3>Token Price</h3><div class="chart-frame"><canvas id="price-chart"></canvas></div><div class="chart-note" id="price-chart-note" hidden></div></div>
          <div class="panel"><h3>Money In/Out (1d)</h3><div class="chart-frame"><canvas id="net-flow-1d-chart"></canvas></div><div class="chart-note" id="net-flow-1d-chart-note" hidden></div></div>
          <div class="panel"><h3>Subnet Sentiment (SSI)</h3><div class="chart-frame"><canvas id="sentiment-chart"></canvas></div><div class="chart-note" id="sentiment-chart-note" hidden></div></div>
        </div>
      </section>

      <section class="section">
        <h2>Supporting charts</h2>
        <div class="chart-grid">
          <div class="panel"><h3>Emission Rate</h3><div class="chart-frame"><canvas id="emission-rate-chart"></canvas></div><div class="chart-note" id="emission-rate-chart-note" hidden></div></div>
          <div class="panel"><h3>Subnet Market Cap</h3><div class="chart-frame"><canvas id="market-cap-chart"></canvas></div><div class="chart-note" id="market-cap-chart-note" hidden></div></div>
          <div class="panel"><h3>Pool Liquidity</h3><div class="chart-frame"><canvas id="liquidity-chart"></canvas></div><div class="chart-note" id="liquidity-chart-note" hidden></div></div>
        </div>
      </section>

      ${renderAdminPanel({
        netuid,
        config,
        recent,
        latestRunCard,
        ingestRun,
        pollIntervalButtons,
        walletActivityStatus,
        scheduleStatus,
        scheduleQueue,
        alphaHolderBackfillActive,
        alphaHolderBackfillStartedAtIso,
      })}

      <div class="footer">
        <div>Database snapshots: ${totalSnapshots}</div>
        <div>Wallet snapshots: ${totalWalletSnapshots}</div>
        <div>Poll interval: <span id="poll-interval-label">${escapeHtml(formatPollInterval(config.pollIntervalMinutes))}</span></div>
        <div>API source: ${config.taostatsAuthHeader ? 'enabled' : 'disabled'}</div>
      </div>
    </div>

    <div class="modal-backdrop" id="history-modal" aria-hidden="true">
      <div class="modal-panel" role="dialog" aria-modal="true" aria-labelledby="history-modal-title">
        <div class="modal-header">
          <div>
            <div class="eyebrow">Historical snapshot chart</div>
            <div class="modal-title-row">
              <h3 id="history-modal-title">Select a metric</h3>
              <button class="info-button" type="button" id="history-modal-info" aria-label="Show metric explanation" title="Show metric explanation" hidden>i</button>
            </div>
            <p id="history-modal-subtitle">Click a latest snapshot card to open its historical view.</p>
          </div>
          <button class="button" type="button" id="history-modal-close">Close</button>
        </div>
        <div class="modal-explanation" id="history-modal-explanation" hidden></div>
        <div class="modal-wallet-details" id="history-modal-wallet-details" hidden></div>
        <div class="window-shift-row">
          <button class="button window-button" type="button" id="history-window-prev" aria-label="Show an earlier 24 hour window">← 24H</button>
          <div class="window-shift-center">
            <div class="range-switcher" role="tablist" aria-label="Historical range">
              <button class="button range-button" type="button" data-history-range="1" aria-pressed="false">24H</button>
              <button class="button range-button active" type="button" data-history-range="7" aria-pressed="true">7D</button>
              <button class="button range-button" type="button" data-history-range="14" aria-pressed="false">14D</button>
              <button class="button range-button" type="button" data-history-range="30" aria-pressed="false">30D</button>
              <button class="button range-button" type="button" data-history-range="60" aria-pressed="false">60D</button>
            </div>
            <div class="window-shift-label" id="history-window-label">Use ← / → to move the visible window by 24 hours.</div>
          </div>
          <button class="button window-button" type="button" id="history-window-next" aria-label="Show a later 24 hour window">24H →</button>
        </div>
        <div class="modal-grid">
          <section class="card">
            <div class="card-label">Latest value</div>
            <div class="card-value" id="history-modal-latest-value">—</div>
            <div class="card-subtext" id="history-modal-latest-raw"></div>
          </section>
          <section class="card">
            <div class="card-label">Samples</div>
            <div class="card-value" id="history-modal-samples">—</div>
            <div class="card-subtext" id="history-modal-samples-note">Stored historical points in the selected range</div>
          </section>
          <section class="card">
            <div class="card-label">Latest capture</div>
            <div class="card-value" id="history-modal-captured">—</div>
            <div class="card-subtext">Newest value from the local SQLite history</div>
          </section>
        </div>
        <div class="panel modal-chart">
          <h3 id="history-modal-chart-title">Historical chart</h3>
          <div class="chart-frame modal"><canvas id="history-modal-canvas"></canvas></div>
          <div class="chart-note" id="history-modal-note" hidden></div>
          <p class="empty" id="history-modal-empty" hidden></p>
        </div>
      </div>
    </div>

    <div class="modal-backdrop" id="wallet-transactions-modal" aria-hidden="true">
      <div class="modal-panel wallet-transactions-panel" role="dialog" aria-modal="true" aria-labelledby="wallet-transactions-modal-title">
        <div class="modal-header">
          <div>
            <div class="eyebrow">Wallet transactions</div>
            <div class="modal-title-row">
              <h3 id="wallet-transactions-modal-title">Select a wallet</h3>
              <button class="info-button" type="button" id="wallet-transactions-refresh" aria-label="Refresh wallet activity" title="Refresh wallet activity" hidden>↻</button>
            </div>
            <p id="wallet-transactions-modal-subtitle">Ctrl/Cmd-click a wallet card to inspect its on-chain activity.</p>
          </div>
          <button class="button" type="button" id="wallet-transactions-modal-close">Close</button>
        </div>
        <div class="modal-explanation" id="wallet-transactions-modal-explanation" hidden></div>
        <div class="modal-grid wallet-transactions-summary">
          <section class="card">
            <div class="card-label">Events</div>
            <div class="card-value" id="wallet-transactions-count">—</div>
            <div class="card-subtext" id="wallet-transactions-count-note">All matched rows in the selected range</div>
          </section>
          <section class="card">
            <div class="card-label">Stake actions</div>
            <div class="card-value" id="wallet-transactions-stake-count">—</div>
            <div class="card-subtext">Add / move / swap / unstake / stake deltas</div>
          </section>
          <section class="card">
            <div class="card-label">Transfers</div>
            <div class="card-value" id="wallet-transactions-transfer-count">—</div>
            <div class="card-subtext">Direct coldkey TAO movements</div>
          </section>
        </div>
        <div class="window-shift-row wallet-transactions-controls">
          <div class="window-shift-center">
            <div class="range-switcher" role="tablist" aria-label="Wallet transaction range">
              <button class="button range-button" type="button" data-wallet-tx-range="1" aria-pressed="false">24H</button>
              <button class="button range-button active" type="button" data-wallet-tx-range="7" aria-pressed="true">7D</button>
              <button class="button range-button" type="button" data-wallet-tx-range="30" aria-pressed="false">30D</button>
              <button class="button range-button" type="button" data-wallet-tx-range="60" aria-pressed="false">60D</button>
              <button class="button range-button" type="button" data-wallet-tx-range="0" aria-pressed="false">All</button>
            </div>
            <div class="window-shift-label" id="wallet-transactions-range-label">Use the pills to change the timeline window.</div>
          </div>
          <div class="wallet-tx-filter-row" role="tablist" aria-label="Wallet transaction type filter">
            <button class="button range-button active" type="button" data-wallet-tx-filter="all" aria-pressed="true">All</button>
            <button class="button range-button" type="button" data-wallet-tx-filter="stake" aria-pressed="false">Stake</button>
            <button class="button range-button" type="button" data-wallet-tx-filter="transfer" aria-pressed="false">Transfer</button>
            <button class="button range-button" type="button" data-wallet-tx-filter="other" aria-pressed="false">Other</button>
          </div>
        </div>
        <p class="wallet-transactions-note" id="wallet-transactions-note">No transactions loaded yet.</p>
        <div class="wallet-transactions-layout">
          <div class="wallet-transactions-table-wrap">
            <table class="wallet-transactions-table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Action</th>
                  <th>Hotkey</th>
                  <th>Netuid</th>
                  <th>Amount</th>
                  <th>Counterparty</th>
                  <th>Block</th>
                  <th>Extrinsic / Tx</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody id="wallet-transactions-table-body">
                <tr><td colspan="9" class="empty">Ctrl/Cmd-click a wallet card to load transactions.</td></tr>
              </tbody>
            </table>
          </div>
          <div class="wallet-transactions-detail">
            <h4 class="wallet-details-title">Selected transaction</h4>
            <p class="wallet-transactions-detail-empty" id="wallet-transactions-detail-empty">Select a row to inspect the raw payload.</p>
            <pre class="wallet-transactions-detail-pre" id="wallet-transactions-detail" hidden></pre>
          </div>
        </div>
      </div>
    </div>

      ${renderDashboardClientScript({ netuid, config })}
  </body>
  </html>`;
}

function parseDays(searchParams) {
  const raw = Number.parseInt(searchParams.get('days') || '30', 10);
  if (!Number.isFinite(raw) || raw <= 0) return 30;
  return Math.min(raw, 3650);
}

function parseBackfillFrequency(value, fallback = 'by_hour') {
  const allowed = new Set(['by_hour', 'by_day', 'by_block']);
  const text = String(value || fallback || '').trim();
  return allowed.has(text) ? text : fallback;
}

function parseBackfillOptions(payload, config) {
  const days = parseDays(new URLSearchParams([['days', String(payload?.days ?? config.taostatsBackfillDays ?? 30)]]));
  const frequency = parseBackfillFrequency(payload?.frequency, config.taostatsBackfillFrequency ?? 'by_hour');
  const overwrite = typeof payload?.overwrite === 'boolean' ? payload.overwrite : Boolean(config.taostatsBackfillOverwrite);
  return { days, frequency, overwrite };
}

function parseWalletBackfillOptions(payload, config) {
  const rawDays = Number.parseInt(String(payload?.days ?? config.taostatsWalletActivityBackfillDays ?? 60), 10);
  const days = Number.isFinite(rawDays) && rawDays > 0 ? Math.min(rawDays, 3650) : (config.taostatsWalletActivityBackfillDays ?? 60);
  const rawLimit = Number.parseInt(String(payload?.limit ?? 200), 10);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 1000) : 200;
  return { days, limit };
}

function createDashboardServer({ db, ingestService, config, onPollIntervalChange = null }) {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const match = url.pathname.match(/^\/subnets\/(\d+)$/) || url.pathname.match(/^\/api\/subnets\/(\d+)\/(latest|history|ingest|backfill|wallet-backfill)$/);
      const netuid = match ? Number(match[1]) : config.netuid;

      if (req.method === 'GET' && url.pathname === '/') {
        res.writeHead(302, { Location: `/subnets/${config.netuid}` });
        res.end();
        return;
      }

      if (req.method === 'GET' && url.pathname === '/admin') {
        if (verifyAdminSession(req, config)) {
          res.writeHead(303, { Location: `/subnets/${config.netuid}` });
          res.end();
          return;
        }
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(renderAdminLoginPage({ config }));
        return;
      }

      if (req.method === 'POST' && url.pathname === '/admin/login') {
        const expected = String(config.taostatsAdminApiKey || '').trim();
        if (!expected) {
          res.writeHead(403, { 'content-type': 'text/html; charset=utf-8' });
          res.end(renderAdminLoginPage({ config, error: 'Admin access is disabled.' }));
          return;
        }
        const payload = await readAdminLoginBody(req);
        const provided = String(payload.adminKey || payload.admin_api_key || payload.key || '').trim();
        if (!provided || !timingSafeEqualText(provided, expected)) {
          res.writeHead(401, { 'content-type': 'text/html; charset=utf-8' });
          res.end(renderAdminLoginPage({ config, error: 'Invalid admin key.' }));
          return;
        }
        setAdminSessionCookie(res, config);
        res.writeHead(303, { Location: `/subnets/${config.netuid}` });
        res.end();
        return;
      }

      if (req.method === 'POST' && url.pathname === '/admin/logout') {
        clearAdminSessionCookie(res);
        res.writeHead(303, { Location: `/subnets/${config.netuid}` });
        res.end();
        return;
      }

      if (req.method === 'GET' && url.pathname === `/subnets/${netuid}`) {
        const adminAuthenticated = verifyAdminSession(req, config);
        const pageConfig = {
          ...config,
          adminAuthEnabled: Boolean(String(config.taostatsAdminApiKey || '').trim()),
          adminAuthenticated,
          ingestActive: typeof ingestService.isActive === 'function' ? ingestService.isActive() : false,
          activeIngestJob: typeof ingestService.getActiveJob === 'function' ? ingestService.getActiveJob() : null,
          taostatsAdminApiKey: '',
        };
        const model = buildPageModel({ db, config: pageConfig, netuid });
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(renderPage(model));
        return;
      }

      if (req.method === 'GET' && url.pathname === `/api/subnets/${netuid}/latest`) {
        const latest = getLatestSnapshot(db, netuid);
        const latestTaoPrice = getLatestTaoPrice(db);
        const ingestRun = getLatestIngestRun(db, netuid);
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
          netuid,
          latest: latest
            ? {
                ...latest,
                tao_price_usd: latest.tao_price_usd ?? latestTaoPrice?.price_usd ?? null,
                tao_price_captured_at: latest.tao_price_captured_at ?? latestTaoPrice?.captured_at ?? null,
              }
            : null,
          taoPrice: latestTaoPrice,
          ingestRun,
        }, null, 2));
        return;
      }

      if (req.method === 'GET' && url.pathname === `/api/subnets/${netuid}/history`) {
        const days = parseDays(url.searchParams);
        const sinceIso = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
        const history = attachTaoPrice(getHistory(db, netuid, sinceIso), getTaoPriceHistory(db, sinceIso));
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ netuid, days, history }, null, 2));
        return;
      }

      if (req.method === 'GET' && url.pathname === `/api/subnets/${netuid}/alpha-holder-history`) {
        const days = parseDays(url.searchParams);
        const sinceIso = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
        const history = getAlphaHolderSnapshotHistory(db, netuid, sinceIso);
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
          netuid,
          days,
          history,
          collectionStartedAt: history[0]?.captured_at ?? null,
        }, null, 2));
        return;
      }

      if (req.method === 'GET' && url.pathname === `/api/subnets/${netuid}/alpha-holder-ranking`) {
        const ranking = fetchAlphaHolderCurrentRanking(db, netuid);
        const current = ranking.find((row) => Number(row.netuid) === Number(netuid)) || null;
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
          netuid,
          ranking,
          current,
          currentRank: current?.rank_num ?? null,
          collectionStartedAt: current?.captured_at ?? ranking[0]?.captured_at ?? null,
        }, null, 2));
        return;
      }

      if (req.method === 'GET' && url.pathname === `/api/subnets/${netuid}/alpha-holder-rank-history`) {
        const days = parseDays(url.searchParams);
        const sinceIso = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
        const history = fetchAlphaHolderRankHistory(db, netuid, sinceIso);
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
          netuid,
          days,
          history,
          collectionStartedAt: history[0]?.captured_at ?? null,
        }, null, 2));
        return;
      }

      if (req.method === 'GET' && url.pathname === `/api/subnets/${netuid}/flow-history`) {
        const days = parseDays(url.searchParams);
        const sinceIso = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
        const history = attachTaoPrice(getTaoFlowHistory(db, netuid, sinceIso), getTaoPriceHistory(db, sinceIso));
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ netuid, days, history }, null, 2));
        return;
      }

      const walletMatch = url.pathname.match(/^\/api\/wallets\/([^/]+)\/(latest|history|stake-history)$/);
      if (req.method === 'GET' && walletMatch) {
        const address = decodeURIComponent(walletMatch[1]);
        const action = walletMatch[2];
        if (action === 'latest') {
          const latestWallet = getLatestWalletSnapshot(db, address);
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ address, latest: latestWallet }, null, 2));
          return;
        }
        const days = parseDays(url.searchParams);
        const sinceIso = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
        const history = action === 'stake-history'
          ? getWalletStakePositionsHistory(db, address, sinceIso)
          : getWalletHistory(db, address, sinceIso);
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ address, days, history }, null, 2));
        return;
      }

      const walletTxMatch = url.pathname.match(/^\/api\/wallets\/([^/]+)\/transactions$/);
      if (req.method === 'GET' && walletTxMatch) {
        const address = decodeURIComponent(walletTxMatch[1]);
        const rawDays = Number.parseInt(url.searchParams.get('days') || '7', 10);
        const days = Number.isFinite(rawDays) && rawDays >= 0 ? Math.min(rawDays, 3650) : 7;
        const refresh = String(url.searchParams.get('refresh') || '').trim() === '1' || String(url.searchParams.get('refresh') || '').trim().toLowerCase() === 'true';
      const walletConfig = (config.wallets || []).find((wallet) => String(wallet.ss58 || wallet.coldkey || '') === address)
        || {
          name: address,
          ss58: address,
          coldkey: address,
          network: 'finney',
          hotkeys: [],
        };
        const latestWalletSyncRun = getLatestIngestRunBySource(db, 'wallet-activity');
        const stakePositions = getLatestWalletStakePositions(db, address);
        const sinceIso = days === 0 ? null : new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
        let rows = getWalletTransactions(db, address, sinceIso);
        let transactionTimeline = buildWalletTransactionTimelineFromRows({
          address,
          walletConfig,
          stakePositions,
          rows,
          days,
        });

        if ((refresh || !rows.length) && config.taostatsAuthHeader) {
          const syncDays = days === 0 ? config.taostatsWalletActivitySyncDays : days;
          const syncResult = typeof ingestService.syncWalletActivityForWallet === 'function'
            ? await ingestService.syncWalletActivityForWallet({
                walletConfig,
                address,
                days: syncDays,
                stakePositions,
                forceRefresh: refresh,
              })
              : (typeof ingestService.syncWalletActivity === 'function'
                ? await ingestService.syncWalletActivity({
                    wallets: [walletConfig],
                    days: syncDays,
                    forceRefresh: refresh,
                  })
                : { ok: false, reason: 'Wallet activity sync is unavailable.' });
          rows = getWalletTransactions(db, address, sinceIso);
          if (rows.length) {
            transactionTimeline = buildWalletTransactionTimelineFromRows({
              address,
              walletConfig,
              stakePositions,
              rows,
              days,
              partial: Boolean(syncResult?.partial),
              reason: syncResult?.error || syncResult?.reason || null,
              warning: syncResult?.warning || null,
            });
          } else {
            transactionTimeline = await buildWalletTransactionTimeline({
              address,
              walletConfig,
              stakePositions,
              taostatsBaseUrl: config.taostatsBaseUrl,
              taostatsAuthHeader: config.taostatsAuthHeader,
              rateLimiter: config.taostatsRateLimiter || null,
              days: syncDays,
              limit: 200,
            });
          }
        } else if (!rows.length && !config.taostatsAuthHeader) {
          transactionTimeline = buildWalletTransactionTimelineFromRows({
            address,
            walletConfig,
            stakePositions,
            rows: [],
            days,
            reason: 'Taostats API access is required to load wallet transactions.',
          });
        }
        if (latestWalletSyncRun) {
          transactionTimeline.syncStatus = {
            ok: Boolean(latestWalletSyncRun.ok),
            message: latestWalletSyncRun.message || null,
            startedAtIso: latestWalletSyncRun.started_at || null,
            durationMs: latestWalletSyncRun.duration_ms ?? null,
            error: latestWalletSyncRun.error || null,
            text: `${latestWalletSyncRun.message || 'Wallet activity sync'} • ${formatRelativeIso(latestWalletSyncRun.started_at)}`,
          };
        }
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(transactionTimeline, null, 2));
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/tao-price/history') {
        const days = parseDays(url.searchParams);
        const sinceIso = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
        const history = getTaoPriceHistory(db, sinceIso);
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ days, history }, null, 2));
        return;
      }

      if (req.method === 'POST' && url.pathname === `/api/subnets/${netuid}/ingest`) {
        const authError = requireAdminApiKey(req, config);
        if (authError) {
          res.writeHead(authError.status, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: authError.error }, null, 2));
          return;
        }
        const result = await ingestService.ingestOnce({ netuid });
        const status = statusForAdminResult(result);
        const error = result.ok ? null : summarizeResultFailure('Subnet ingest failed', result);
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ netuid, result, ...(error ? { error } : {}) }, null, 2));
        return;
      }

      if (req.method === 'POST' && url.pathname === `/api/subnets/${netuid}/backfill`) {
        const authError = requireAdminApiKey(req, config);
        if (authError) {
          res.writeHead(authError.status, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: authError.error }, null, 2));
          return;
        }
        const payload = await readJsonBody(req);
        const backfill = await ingestService.backfillHistoricalSnapshots({ netuid, ...parseBackfillOptions(payload, config) });
        const live = backfill.skipped ? null : await ingestService.ingestOnce({ netuid });
        const error = summarizeBackfillOutcome(backfill, live);
        const warnings = summarizeBackfillWarnings(backfill, live);
        const status = backfill.skipped || live?.skipped ? 409 : (backfill.ok && live?.ok ? 200 : 500);
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
          netuid,
          backfill,
          ...(live ? { live } : {}),
          ...(error ? { error } : {}),
          ...(warnings.length ? { warnings } : {}),
        }, null, 2));
        return;
      }

      if (req.method === 'POST' && url.pathname === `/api/subnets/${netuid}/wallet-backfill`) {
        const authError = requireAdminApiKey(req, config);
        if (authError) {
          res.writeHead(authError.status, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: authError.error }, null, 2));
          return;
        }
        const payload = await readJsonBody(req);
        const options = parseWalletBackfillOptions(payload, config);
        const walletBackfill = await ingestService.backfillWalletActivity({
          wallets: config.wallets || [],
          days: options.days,
          limit: options.limit,
        });
        const totalInserted = Array.isArray(walletBackfill?.results)
          ? walletBackfill.results.reduce((total, result) => total + Number(result?.rowsInserted ?? 0), 0)
          : 0;
        const warnings = Array.isArray(walletBackfill?.results)
          ? walletBackfill.results.flatMap((result) => [result?.warning, result?.reason]).filter(Boolean)
          : [];
        const status = walletBackfill?.ok === false ? 500 : 200;
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
          netuid,
          walletBackfill,
          summary: {
            totalInserted,
            walletCount: Array.isArray(walletBackfill?.results) ? walletBackfill.results.length : 0,
          },
          ...(warnings.length ? { warnings } : {}),
        }, null, 2));
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/settings/poll-interval') {
        const authError = requireAdminApiKey(req, config);
        if (authError) {
          res.writeHead(authError.status, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: authError.error }, null, 2));
          return;
        }
        const payload = await readJsonBody(req);
        const minutes = Number.parseInt(String(payload.minutes ?? ''), 10);
        if (!POLL_INTERVAL_OPTIONS.includes(minutes)) {
          res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({
            error: 'Poll interval must be one of: 60, 120, or 240 minutes.',
            allowed: POLL_INTERVAL_OPTIONS,
          }, null, 2));
          return;
        }
        const nextState = typeof onPollIntervalChange === 'function'
          ? await onPollIntervalChange(minutes)
          : { pollIntervalMinutes: minutes, nextPollAtIso: null };
        const nextMinutes = Number(nextState?.pollIntervalMinutes ?? minutes);
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
          ok: true,
          pollIntervalMinutes: Number.isFinite(nextMinutes) ? nextMinutes : minutes,
          nextPollAtIso: nextState?.nextPollAtIso ?? null,
        }, null, 2));
        return;
      }

      if (req.method === 'GET' && url.pathname === '/health') {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
          ok: true,
          netuid: config.netuid,
          pollIntervalMinutes: config.pollIntervalMinutes,
          nextPollAtIso: config.nextPollAtIso ?? null,
          nextWalletActivitySyncAtIso: config.nextWalletActivitySyncAtIso ?? null,
          nextAlphaHolderSnapshotAtIso: config.nextAlphaHolderSnapshotAtIso ?? null,
          ingestActive: typeof ingestService.isActive === 'function' ? ingestService.isActive() : null,
          activeIngestJob: typeof ingestService.getActiveJob === 'function' ? ingestService.getActiveJob() : null,
          alphaHolderBackfillActive: String(getSetting(db, 'alpha_holder_backfill_active') || '').trim() === '1',
        }, null, 2));
        return;
      }

      res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Not found' }, null, 2));
    } catch (error) {
      console.error(error);
      if (res.headersSent) {
        res.destroy(error);
        return;
      }
      res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: error.message }, null, 2));
    }
  });

  return {
    server,
    start(port) {
      return new Promise((resolve) => {
        server.listen(port, () => resolve(server));
      });
    },
    close() {
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

module.exports = {
  createDashboardServer,
  buildPageModel,
  renderPage,
  formatIso,
  formatRelativeIso,
  formatChartDate,
  compact,
  percent,
  signedPercent,
  signedValue,
  formatNumber,
  buildComparisons,
  numericMetricValue,
  buildWalletAttributionSummary,
};
