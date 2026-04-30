'use strict';

const { URL } = require('node:url');

const TAO_PER_RAO = 1_000_000_000;
// Inferred from the live statistics page: the displayed emission percentage
// matches raw emission divided by 500,000,000.
const EMISSION_PERCENT_DENOMINATOR = 500_000_000;
const TAO_PER_DAY = 7_200;

function nowIso() {
  return new Date().toISOString();
}

function createRateLimiter({ maxRequests = 5, intervalMs = 60_000 } = {}) {
  if (!Number.isFinite(maxRequests) || maxRequests < 1) {
    throw new Error('maxRequests must be a positive number');
  }
  if (!Number.isFinite(intervalMs) || intervalMs < 1) {
    throw new Error('intervalMs must be a positive number');
  }

  const spacingMs = Math.ceil(intervalMs / maxRequests);
  let availableAt = Date.now();
  let tail = Promise.resolve();

  async function waitForSlot() {
    const run = async () => {
      const now = Date.now();
      const startAt = Math.max(now, availableAt);
      availableAt = startAt + spacingMs;
      const waitMs = startAt - now;
      if (waitMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, waitMs));
      }
      return { waitMs, scheduledAt: new Date(startAt).toISOString() };
    };

    const next = tail.then(run, run);
    tail = next.then(() => undefined, () => undefined);
    return next;
  }

  return {
    maxRequests,
    intervalMs,
    spacingMs,
    waitForSlot,
  };
}

function asNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function asInteger(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function asBoolean(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    if (/^(true|1|yes)$/i.test(value)) return true;
    if (/^(false|0|no)$/i.test(value)) return false;
  }
  return Boolean(value);
}

function asText(value) {
  if (value === null || value === undefined) return null;
  return String(value);
}

function raoToTao(value) {
  const num = asNumber(value);
  return num === null ? null : num / TAO_PER_RAO;
}

function pickRecord(payload, netuid) {
  if (!payload) return null;

  const candidates = [];
  if (Array.isArray(payload)) candidates.push(...payload);
  if (Array.isArray(payload?.data)) candidates.push(...payload.data);
  if (Array.isArray(payload?.results)) candidates.push(...payload.results);
  if (Array.isArray(payload?.items)) candidates.push(...payload.items);
  if (Array.isArray(payload?.subnets)) candidates.push(...payload.subnets);

  if (candidates.length > 0) {
    return (
      candidates.find((item) => Number(item?.netuid) === Number(netuid)) ||
      candidates[0]
    );
  }

  if (typeof payload === 'object') {
    if (payload.netuid !== undefined) return payload;
    if (payload.data && typeof payload.data === 'object') return payload.data;
  }

  return payload;
}

function extractRecords(payload) {
  if (!payload) return [];
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload.data)) return payload.data;
  if (Array.isArray(payload.results)) return payload.results;
  if (Array.isArray(payload.items)) return payload.items;
  if (Array.isArray(payload.subnets)) return payload.subnets;
  return [];
}

async function fetchJson(url, { headers = {}, timeoutMs = 20000, rateLimiter = null } = {}) {
  const slot = rateLimiter ? await rateLimiter.waitForSlot() : null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: {
        'user-agent': 'sn110-tracker/1.0 (+local dashboard)',
        accept: 'application/json,text/plain,*/*',
        ...headers,
      },
      signal: controller.signal,
    });
    const text = await response.text();
    let json = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        throw new Error(`Unable to parse JSON from ${url}: ${text.slice(0, 200)}`);
      }
    }
    if (!response.ok) {
      const error = new Error(`HTTP ${response.status} from ${url}`);
      error.status = response.status;
      error.body = json || text;
      throw error;
    }
    return { json, rateLimit: slot };
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchText(url, { headers = {}, timeoutMs = 20000, rateLimiter = null } = {}) {
  const slot = rateLimiter ? await rateLimiter.waitForSlot() : null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: {
        'user-agent': 'sn110-tracker/1.0 (+local dashboard)',
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        ...headers,
      },
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) {
      const error = new Error(`HTTP ${response.status} from ${url}`);
      error.status = response.status;
      error.body = text;
      throw error;
    }
    return { text, rateLimit: slot };
  } finally {
    clearTimeout(timeout);
  }
}

function extractEscapedJsonObject(html, marker) {
  const markerIndex = html.indexOf(marker);
  if (markerIndex === -1) {
    throw new Error(`Could not find ${marker} in Taostats HTML`);
  }

  const startIndex = html.indexOf('{', markerIndex);
  if (startIndex === -1) {
    throw new Error(`Could not find object start for ${marker}`);
  }

  let depth = 0;
  let inString = false;
  let escape = false;
  let endIndex = -1;

  for (let i = startIndex; i < html.length; i += 1) {
    const ch = html[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === '\\') {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (!inString) {
      if (ch === '{') depth += 1;
      if (ch === '}') {
        depth -= 1;
        if (depth === 0) {
          endIndex = i + 1;
          break;
        }
      }
    }
  }

  if (endIndex === -1) {
    throw new Error(`Could not parse balanced object for ${marker}`);
  }

  const fragment = html.slice(startIndex, endIndex);
  const jsonText = fragment.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  return JSON.parse(jsonText);
}

function normalizeSnapshot(raw, { source, sourceUrl, netuid, capturedAt = nowIso() }) {
  const payload = pickRecord(raw, netuid) || {};
  const n = (value) => asNumber(value);
  const i = (value) => asInteger(value);
  const b = (value) => asBoolean(value);
  const t = (value) => asText(value);
  const emissionRawNum = n(payload.emission);
  const emissionPercentNum = emissionRawNum === null ? null : (emissionRawNum / EMISSION_PERCENT_DENOMINATOR) * 100;
  const emissionFraction = emissionRawNum === null ? null : emissionRawNum / EMISSION_PERCENT_DENOMINATOR;
  const emissionPerDayTaoNum = emissionFraction === null ? null : emissionFraction * TAO_PER_DAY;
  const ownerPerDayTaoNum = emissionPerDayTaoNum === null ? null : emissionPerDayTaoNum * 0.18;
  const minerPerDayTaoNum = emissionPerDayTaoNum === null ? null : emissionPerDayTaoNum * 0.41;
  const validatorPerDayTaoNum = emissionPerDayTaoNum === null ? null : emissionPerDayTaoNum * 0.41;
  const recycled24HoursTaoNum = raoToTao(payload.recycled_24_hours);
  const recycledLifetimeTaoNum = raoToTao(payload.recycled_lifetime);
  const recycledSinceRegistrationTaoNum = raoToTao(payload.recycled_since_registration);
  const registrationCostTaoNum = raoToTao(payload.neuron_registration_cost ?? payload.registration_cost);
  const activeKeysNum = i(payload.active_keys);
  const maxNeuronsNum = i(payload.max_neurons);
  const incentiveBurnNum = n(payload.incentive_burn);

  const snapshot = {
    netuid: i(payload.netuid) ?? netuid,
    captured_at: capturedAt,
    remote_timestamp: t(payload.timestamp ?? payload.last_updated ?? payload.updated_at ?? null),
    source,
    source_url: sourceUrl,
    block_number: i(payload.block_number),
    name: t(payload.name),
    symbol: t(payload.symbol),
    rank: i(payload.rank),
    price_text: t(payload.price),
    price_num: n(payload.price),
    market_cap_text: t(payload.market_cap),
    market_cap_num: n(payload.market_cap),
    liquidity_text: t(payload.liquidity),
    liquidity_num: n(payload.liquidity),
    total_tao_text: t(payload.total_tao ?? payload.tao_in_pool),
    total_alpha_text: t(payload.total_alpha ?? payload.alpha_in_pool),
    alpha_in_pool_text: t(payload.alpha_in_pool),
    alpha_staked_text: t(payload.alpha_staked),
    root_prop_text: t(payload.root_prop),
    emission_text: t(payload.emission),
    emission_num: emissionRawNum,
    emission_percent_text: emissionPercentNum === null ? null : String(emissionPercentNum),
    emission_percent_num: emissionPercentNum,
    emission_per_day_tao_text: emissionPerDayTaoNum === null ? null : String(emissionPerDayTaoNum),
    emission_per_day_tao_num: emissionPerDayTaoNum,
    owner_per_day_tao_text: ownerPerDayTaoNum === null ? null : String(ownerPerDayTaoNum),
    owner_per_day_tao_num: ownerPerDayTaoNum,
    miner_per_day_tao_text: minerPerDayTaoNum === null ? null : String(minerPerDayTaoNum),
    miner_per_day_tao_num: minerPerDayTaoNum,
    validator_per_day_tao_text: validatorPerDayTaoNum === null ? null : String(validatorPerDayTaoNum),
    validator_per_day_tao_num: validatorPerDayTaoNum,
    projected_emission_text: t(payload.projected_emission),
    projected_emission_num: n(payload.projected_emission),
    incentive_burn_text: t(payload.incentive_burn),
    incentive_burn_num: incentiveBurnNum,
    recycled_24_hours_text: t(payload.recycled_24_hours),
    recycled_24_hours_num: recycled24HoursTaoNum,
    recycled_lifetime_text: t(payload.recycled_lifetime),
    recycled_lifetime_num: recycledLifetimeTaoNum,
    recycled_since_registration_text: t(payload.recycled_since_registration),
    recycled_since_registration_num: recycledSinceRegistrationTaoNum,
    registration_cost_text: t(payload.neuron_registration_cost),
    registration_cost_num: registrationCostTaoNum,
    active_keys_text: t(payload.active_keys),
    active_keys_num: activeKeysNum,
    max_neurons_text: t(payload.max_neurons),
    max_neurons_num: maxNeuronsNum,
    net_flow_1_day_text: t(payload.net_flow_1_day),
    net_flow_1_day_num: n(payload.net_flow_1_day),
    net_flow_7_days_text: t(payload.net_flow_7_days),
    net_flow_7_days_num: n(payload.net_flow_7_days),
    net_flow_30_days_text: t(payload.net_flow_30_days),
    net_flow_30_days_num: n(payload.net_flow_30_days),
    root_sell_text: t(payload.root_sell),
    root_sell_bool: b(payload.root_sell),
    fee_rate_text: t(payload.fee_rate),
    market_cap_change_1_day_text: t(payload.market_cap_change_1_day),
    price_change_1_hour_text: t(payload.price_change_1_hour),
    price_change_1_day_text: t(payload.price_change_1_day),
    price_change_1_week_text: t(payload.price_change_1_week),
    price_change_1_month_text: t(payload.price_change_1_month),
    tao_volume_24_hr_text: t(payload.tao_volume_24_hr ?? payload.volume_24h ?? payload.tao_volume_24h),
    tao_volume_24_hr_num: n(payload.tao_volume_24_hr ?? payload.volume_24h ?? payload.tao_volume_24h),
    tao_volume_24_hr_change_1_day_text: t(payload.tao_volume_24_hr_change_1_day),
    tao_buy_volume_24_hr_text: t(payload.tao_buy_volume_24_hr),
    tao_sell_volume_24_hr_text: t(payload.tao_sell_volume_24_hr),
    alpha_volume_24_hr_text: t(payload.alpha_volume_24_hr),
    alpha_volume_24_hr_num: n(payload.alpha_volume_24_hr),
    alpha_volume_24_hr_change_1_day_text: t(payload.alpha_volume_24_hr_change_1_day),
    fear_and_greed_index: t(payload.fear_and_greed_index),
    fear_and_greed_sentiment: t(payload.fear_and_greed_sentiment),
    startup_mode: b(payload.startup_mode),
    swap_v3_initialized: b(payload.swap_v3_initialized),
    enabled_user_liquidity: b(payload.enabled_user_liquidity),
    current_tick: i(payload.current_tick),
    liquidity_raw: t(payload.liquidity_raw),
    raw_json: JSON.stringify(payload),
  };

  return snapshot;
}

function normalizeTaoPriceSnapshot(raw, { source, sourceUrl, capturedAt = nowIso() }) {
  const payload = pickRecord(raw, null) || {};
  const n = (value) => asNumber(value);
  const t = (value) => asText(value);
  const snapshot = {
    captured_at: capturedAt,
    remote_timestamp: t(payload.last_updated ?? payload.timestamp ?? payload.updated_at ?? payload.created_at ?? null),
    source,
    source_url: sourceUrl,
    asset: t(payload.symbol ?? payload.name),
    name: t(payload.name),
    symbol: t(payload.symbol),
    slug: t(payload.slug),
    circulating_supply: n(payload.circulating_supply),
    max_supply: n(payload.max_supply),
    total_supply: n(payload.total_supply),
    price_usd: n(payload.price),
    volume_24h_usd: n(payload.volume_24h),
    market_cap_usd: n(payload.market_cap),
    fully_diluted_market_cap_usd: n(payload.fully_diluted_market_cap),
    percent_change_1h: n(payload.percent_change_1h),
    percent_change_24h: n(payload.percent_change_24h),
    percent_change_7d: n(payload.percent_change_7d),
    percent_change_30d: n(payload.percent_change_30d),
    percent_change_60d: n(payload.percent_change_60d),
    percent_change_90d: n(payload.percent_change_90d),
    market_cap_dominance: n(payload.market_cap_dominance),
    raw_json: JSON.stringify(payload),
  };

  return snapshot;
}

function historyTimestampToIso(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'string' && value.includes('T')) return value;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  const ms = parsed > 1e12 ? parsed : parsed * 1000;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function mergeHistoryPayloads({ subnetRecord = null, poolRecord = null }) {
  return {
    ...(poolRecord || {}),
    ...(subnetRecord || {}),
  };
}

function combineApiPayloads(primary, secondary) {
  return {
    ...(secondary || {}),
    ...(primary || {}),
  };
}

async function fetchFromApi({ netuid, taostatsBaseUrl, taostatsAuthHeader, rateLimiter = null }) {
  if (!taostatsAuthHeader) {
    return null;
  }

  const headers = { authorization: taostatsAuthHeader };
  const poolUrl = new URL('/api/dtao/pool/latest/v1', taostatsBaseUrl);
  poolUrl.searchParams.set('netuid', String(netuid));

  const subnetUrl = new URL('/api/subnet/latest/v1', taostatsBaseUrl);
  subnetUrl.searchParams.set('netuid', String(netuid));

  const poolResponse = await fetchJson(poolUrl.toString(), { headers, rateLimiter });
  const subnetResponse = await fetchJson(subnetUrl.toString(), { headers, rateLimiter });
  const poolPayload = poolResponse.json;
  const subnetPayload = subnetResponse.json;

  const merged = combineApiPayloads(pickRecord(subnetPayload, netuid), pickRecord(poolPayload, netuid));
  return normalizeSnapshot(merged, {
    source: 'api',
    sourceUrl: poolUrl.toString(),
    netuid,
  });
}

async function fetchFromPublicPage({ netuid, taostatsPublicBaseUrl, rateLimiter = null }) {
  const url = `${taostatsPublicBaseUrl.replace(/\/$/, '')}/subnets/${netuid}`;
  const { text: html } = await fetchText(url, { rateLimiter });
  const payload = extractEscapedJsonObject(html, '\\"dtaoSubnet\\":{');
  return normalizeSnapshot(payload, {
    source: 'scrape',
    sourceUrl: url,
    netuid,
  });
}

async function fetchTaoPriceLatest({ taostatsBaseUrl, taostatsAuthHeader, rateLimiter = null, capturedAt = nowIso() }) {
  if (!taostatsAuthHeader) {
    return null;
  }

  const headers = { authorization: taostatsAuthHeader };
  const url = new URL('/api/price/latest/v1', taostatsBaseUrl);
  url.searchParams.set('asset', 'TAO');
  const { json } = await fetchJson(url.toString(), { headers, rateLimiter });
  return normalizeTaoPriceSnapshot(json, {
    source: 'api',
    sourceUrl: url.toString(),
    capturedAt,
  });
}

async function fetchTaoPriceHistory({
  taostatsBaseUrl,
  taostatsAuthHeader,
  rateLimiter = null,
  days = 30,
  limit = 200,
}) {
  if (!taostatsAuthHeader) {
    return [];
  }

  const now = Date.now();
  const startIso = new Date(now - Math.max(1, days) * 24 * 60 * 60 * 1000).toISOString();
  const timestampStart = Math.floor(new Date(startIso).getTime() / 1000);
  const timestampEnd = Math.floor(now / 1000);
  const headers = { authorization: taostatsAuthHeader };
  const rows = [];

  for (let page = 1; page <= 100; page += 1) {
    const url = new URL('/api/price/history/v1', taostatsBaseUrl);
    url.searchParams.set('asset', 'TAO');
    url.searchParams.set('timestamp_start', String(timestampStart));
    url.searchParams.set('timestamp_end', String(timestampEnd));
    url.searchParams.set('order', 'timestamp_asc');
    url.searchParams.set('limit', String(limit));
    url.searchParams.set('page', String(page));
    const { json } = await fetchJson(url.toString(), { headers, rateLimiter });
    const pageRows = extractRecords(json);
    if (!pageRows.length) break;
    rows.push(...pageRows);
    if (pageRows.length < limit) break;
  }

  return rows.map((row) => normalizeTaoPriceSnapshot(row, {
    source: 'api-history',
    sourceUrl: `${taostatsBaseUrl.replace(/\/$/, '')}/api/price/history/v1`,
    capturedAt: historyTimestampToIso(row.timestamp ?? row.last_updated ?? row.updated_at ?? row.created_at) || nowIso(),
  }));
}

async function fetchHistoricalSnapshots({
  netuid,
  taostatsBaseUrl,
  taostatsAuthHeader,
  rateLimiter = null,
  frequency = 'by_day',
  days = 30,
  limit = 200,
}) {
  if (!taostatsAuthHeader) {
    return [];
  }

  const now = Date.now();
  const startIso = new Date(now - Math.max(1, days) * 24 * 60 * 60 * 1000).toISOString();
  const timestampStart = Math.floor(new Date(startIso).getTime() / 1000);
  const timestampEnd = Math.floor(now / 1000);
  const headers = { authorization: taostatsAuthHeader };
  const endpoints = [
    {
      name: 'subnet',
      path: '/api/subnet/history/v1',
      query: { netuid: String(netuid) },
      supportsFrequency: true,
    },
    {
      name: 'pool',
      path: '/api/dtao/pool/history/v1',
      query: { netuid: String(netuid), subnet: String(netuid) },
      supportsFrequency: true,
    },
    {
      name: 'registrationCost',
      path: '/api/subnet/registration_cost/history/v1',
      query: {},
      supportsFrequency: false,
    },
  ];

  async function fetchAllPages(endpoint) {
    const rows = [];
      for (let page = 1; page <= 50; page += 1) {
        const url = new URL(endpoint.path, taostatsBaseUrl);
        for (const [key, value] of Object.entries(endpoint.query)) {
          url.searchParams.set(key, value);
        }
        if (endpoint.supportsFrequency) {
          url.searchParams.set('frequency', frequency);
        }
        url.searchParams.set('timestamp_start', String(timestampStart));
        url.searchParams.set('timestamp_end', String(timestampEnd));
        url.searchParams.set('order', 'timestamp_asc');
        url.searchParams.set('limit', String(limit));
        url.searchParams.set('page', String(page));
        const { json } = await fetchJson(url.toString(), { headers, rateLimiter });
        const pageRows = extractRecords(json);
        if (!pageRows.length) break;
        rows.push(...pageRows);
        if (pageRows.length < limit) break;
      }
    return rows;
  }

  const [subnetRows, poolRows] = await Promise.all(endpoints.map(fetchAllPages));
  const mergedByKey = new Map();

  const keyFor = (record) => {
    const block = asInteger(record?.block_number);
    if (block !== null) return `block:${block}`;
    const ts = historyTimestampToIso(record?.timestamp ?? record?.last_updated ?? record?.updated_at ?? record?.created_at);
    if (ts) return `timestamp:${ts}`;
    return null;
  };

  const upsertRecord = (record, bucket) => {
    const key = keyFor(record);
    if (!key) return;
    const existing = mergedByKey.get(key) || {};
    const merged = mergeHistoryPayloads({
      subnetRecord: bucket === 'subnet' ? record : existing.subnetRecord,
      poolRecord: bucket === 'pool' ? record : existing.poolRecord,
    });
    mergedByKey.set(key, {
      ...existing,
      [bucket === 'subnet' ? 'subnetRecord' : 'poolRecord']: record,
      merged,
    });
  };

  for (const record of subnetRows) upsertRecord(record, 'subnet');
  for (const record of poolRows) upsertRecord(record, 'pool');

  const snapshots = [];
  const sorted = [...mergedByKey.entries()].sort((a, b) => {
    const left = a[1].merged;
    const right = b[1].merged;
    const leftTime = new Date(historyTimestampToIso(left.timestamp ?? left.last_updated ?? left.updated_at ?? left.created_at) || 0).getTime();
    const rightTime = new Date(historyTimestampToIso(right.timestamp ?? right.last_updated ?? right.updated_at ?? right.created_at) || 0).getTime();
    return leftTime - rightTime;
  });

  for (const [, entry] of sorted) {
    const merged = entry.merged;
    const capturedAt = historyTimestampToIso(merged.timestamp ?? merged.last_updated ?? merged.updated_at ?? merged.created_at) || nowIso();
    snapshots.push(normalizeSnapshot(merged, {
      source: 'api-history',
      sourceUrl: `${taostatsBaseUrl.replace(/\/$/, '')}/api/subnet/history/v1`,
      netuid,
      capturedAt,
    }));
  }

  return snapshots;
}

async function fetchLatestSnapshot(options) {
  const {
    netuid,
    taostatsBaseUrl,
    taostatsPublicBaseUrl,
    taostatsAuthHeader,
    rateLimiter = null,
  } = options;

  let apiError = null;
  if (taostatsAuthHeader) {
    try {
      return {
        snapshot: await fetchFromApi({ netuid, taostatsBaseUrl, taostatsAuthHeader, rateLimiter }),
        source: 'api',
        fallbackUsed: false,
        detail: { source: 'api' },
      };
    } catch (error) {
      apiError = error;
    }
  }

  const snapshot = await fetchFromPublicPage({ netuid, taostatsPublicBaseUrl, rateLimiter });
  return {
    snapshot,
    source: 'scrape',
    fallbackUsed: Boolean(apiError),
    detail: apiError
      ? {
          source: 'scrape',
          fallbackFrom: 'api',
          apiError: apiError.message,
          apiStatus: apiError.status || null,
        }
      : { source: 'scrape' },
  };
}

module.exports = {
  fetchLatestSnapshot,
  fetchFromApi,
  fetchFromPublicPage,
  fetchTaoPriceLatest,
  fetchTaoPriceHistory,
  fetchHistoricalSnapshots,
  extractEscapedJsonObject,
  normalizeSnapshot,
  normalizeTaoPriceSnapshot,
  pickRecord,
  extractRecords,
  asNumber,
  asInteger,
  asBoolean,
  asText,
  createRateLimiter,
};
