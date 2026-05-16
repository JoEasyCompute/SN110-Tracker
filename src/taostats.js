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

function waitMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

function formatDurationShort(ms) {
  const value = Math.max(0, Math.round(Number(ms) || 0));
  const seconds = Math.floor(value / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${seconds}s`;
}

function parseRetryAfterHeader(value) {
  if (value === null || value === undefined || value === '') return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1000);
  }
  const dateMs = Date.parse(String(value));
  if (Number.isFinite(dateMs)) {
    return Math.max(0, dateMs - Date.now());
  }
  return null;
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

function resolveSentimentSnapshot(payload) {
  const candidates = [
    { source: 'ssi', value: payload?.ssi ?? payload?.sentiment_index ?? payload?.subnet_sentiment_index ?? payload?.sentiment_score },
    { source: 'fear_and_greed', value: payload?.fear_and_greed_index },
  ];

  for (const candidate of candidates) {
    const num = asNumber(candidate.value);
    if (num !== null) {
      return {
        text: asText(candidate.value),
        num,
        source: candidate.source,
      };
    }
  }

  return {
    text: null,
    num: null,
    source: null,
  };
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
      if (response.status === 429) {
        const retryAfterMs = parseRetryAfterHeader(response.headers?.get?.('retry-after'));
        if (Number.isFinite(retryAfterMs) && retryAfterMs !== null) {
          error.retryAfterMs = retryAfterMs;
        }
      }
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
  const sentiment = resolveSentimentSnapshot(payload);

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
    total_tao_num: n(payload.total_tao ?? payload.tao_in_pool),
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
    sentiment_index_text: sentiment.text,
    sentiment_index_num: sentiment.num,
    sentiment_index_source_text: sentiment.source,
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

function normalizeTaoFlowSnapshot(raw, { source, sourceUrl, netuid, capturedAt = nowIso() }) {
  const payload = pickRecord(raw, netuid) || {};
  const n = (value) => asNumber(value);
  const t = (value) => asText(value);
  return {
    netuid: asInteger(payload.netuid) ?? netuid,
    captured_at: capturedAt,
    remote_timestamp: t(payload.timestamp ?? payload.last_updated ?? payload.updated_at ?? payload.created_at ?? null),
    source,
    source_url: sourceUrl,
    block_number: asInteger(payload.block_number),
    name: t(payload.name),
    symbol: t(payload.symbol),
    tao_flow_text: t(payload.tao_flow),
    tao_flow_num: n(payload.tao_flow),
    tao_in_pool_text: t(payload.tao_in_pool),
    tao_in_pool_num: n(payload.tao_in_pool),
    alpha_in_pool_text: t(payload.alpha_in_pool),
    alpha_in_pool_num: n(payload.alpha_in_pool),
    alpha_rewards_text: t(payload.alpha_rewards),
    alpha_rewards_num: n(payload.alpha_rewards),
    raw_json: JSON.stringify(payload),
  };
}

function normalizeAccountSnapshot(raw, { source, sourceUrl, walletName, address, network = 'finney', capturedAt = nowIso() }) {
  const payload = pickRecord(raw, null) || {};
  const n = (value) => asNumber(value);
  const r = (value) => raoToTao(value);
  const t = (value) => asText(value);
  const addressPayload = payload.address || {};
  const balanceFree = r(payload.balance_free);
  const balanceStaked = r(payload.balance_staked);
  const balanceStakedAlpha = r(payload.balance_staked_alpha_as_tao);
  const balanceStakedRoot = r(payload.balance_staked_root);
  const balanceTotal = r(payload.balance_total);
  const balanceFree24hAgo = r(payload.balance_free_24hr_ago);
  const balanceStaked24hAgo = r(payload.balance_staked_24hr_ago);
  const balanceStakedAlpha24hAgo = r(payload.balance_staked_alpha_as_tao_24hr_ago);
  const balanceStakedRoot24hAgo = r(payload.balance_staked_root_24hr_ago);
  const balanceTotal24hAgo = r(payload.balance_total_24hr_ago);
  const delta = (current, prior) => (Number.isFinite(current) && Number.isFinite(prior) ? current - prior : null);

  return {
    wallet_name: walletName,
    wallet_address_ss58: t(addressPayload.ss58 ?? address),
    wallet_address_hex: t(addressPayload.hex ?? null),
    network: t(payload.network ?? network),
    captured_at: capturedAt,
    remote_timestamp: t(payload.timestamp ?? payload.last_updated ?? payload.updated_at ?? payload.created_at ?? null),
    source,
    source_url: sourceUrl,
    block_number: asInteger(payload.block_number),
    rank: asInteger(payload.rank),
    balance_free_text: t(payload.balance_free),
    balance_free_num: balanceFree,
    balance_staked_text: t(payload.balance_staked),
    balance_staked_num: balanceStaked,
    balance_staked_alpha_as_tao_text: t(payload.balance_staked_alpha_as_tao),
    balance_staked_alpha_as_tao_num: balanceStakedAlpha,
    balance_staked_root_text: t(payload.balance_staked_root),
    balance_staked_root_num: balanceStakedRoot,
    balance_total_text: t(payload.balance_total),
    balance_total_num: balanceTotal,
    balance_free_24hr_ago_text: t(payload.balance_free_24hr_ago),
    balance_free_24hr_ago_num: balanceFree24hAgo,
    balance_staked_24hr_ago_text: t(payload.balance_staked_24hr_ago),
    balance_staked_24hr_ago_num: balanceStaked24hAgo,
    balance_staked_alpha_as_tao_24hr_ago_text: t(payload.balance_staked_alpha_as_tao_24hr_ago),
    balance_staked_alpha_as_tao_24hr_ago_num: balanceStakedAlpha24hAgo,
    balance_staked_root_24hr_ago_text: t(payload.balance_staked_root_24hr_ago),
    balance_staked_root_24hr_ago_num: balanceStakedRoot24hAgo,
    balance_total_24hr_ago_text: t(payload.balance_total_24hr_ago),
    balance_total_24hr_ago_num: balanceTotal24hAgo,
    balance_free_change_24hr_text: delta(balanceFree, balanceFree24hAgo) === null ? null : String(delta(balanceFree, balanceFree24hAgo)),
    balance_free_change_24hr_num: delta(balanceFree, balanceFree24hAgo),
    balance_staked_change_24hr_text: delta(balanceStaked, balanceStaked24hAgo) === null ? null : String(delta(balanceStaked, balanceStaked24hAgo)),
    balance_staked_change_24hr_num: delta(balanceStaked, balanceStaked24hAgo),
    balance_staked_alpha_as_tao_change_24hr_text: delta(balanceStakedAlpha, balanceStakedAlpha24hAgo) === null ? null : String(delta(balanceStakedAlpha, balanceStakedAlpha24hAgo)),
    balance_staked_alpha_as_tao_change_24hr_num: delta(balanceStakedAlpha, balanceStakedAlpha24hAgo),
    balance_staked_root_change_24hr_text: delta(balanceStakedRoot, balanceStakedRoot24hAgo) === null ? null : String(delta(balanceStakedRoot, balanceStakedRoot24hAgo)),
    balance_staked_root_change_24hr_num: delta(balanceStakedRoot, balanceStakedRoot24hAgo),
    balance_total_change_24hr_text: delta(balanceTotal, balanceTotal24hAgo) === null ? null : String(delta(balanceTotal, balanceTotal24hAgo)),
    balance_total_change_24hr_num: delta(balanceTotal, balanceTotal24hAgo),
    created_on_date: t(payload.created_on_date),
    created_on_network: t(payload.created_on_network),
    coldkey_swap: t(payload.coldkey_swap),
    raw_json: JSON.stringify(payload),
  };
}

function normalizeStakeBalanceSnapshot(raw, { source, sourceUrl, walletName, address, capturedAt = nowIso() }) {
  const payload = pickRecord(raw, null) || {};
  const coldkeyPayload = payload.coldkey || {};
  const hotkeyPayload = payload.hotkey || {};
  const t = (value) => asText(value);
  const n = (value) => asNumber(value);
  const r = (value) => raoToTao(value);

  return {
    block_number: asInteger(payload.block_number),
    wallet_name: walletName,
    wallet_address_ss58: t(coldkeyPayload.ss58 ?? address),
    wallet_address_hex: t(coldkeyPayload.hex ?? null),
    hotkey_name: t(payload.hotkey_name ?? null),
    hotkey_address_ss58: t(hotkeyPayload.ss58 ?? null),
    hotkey_address_hex: t(hotkeyPayload.hex ?? null),
    netuid: asInteger(payload.netuid),
    subnet_rank: asInteger(payload.subnet_rank),
    subnet_total_holders: asInteger(payload.subnet_total_holders),
    balance_text: t(payload.balance),
    balance_num: n(payload.balance),
    balance_as_tao_text: t(payload.balance_as_tao ?? payload.balance),
    balance_as_tao_num: r(payload.balance_as_tao ?? payload.balance),
    source,
    source_url: sourceUrl,
    captured_at: capturedAt,
    remote_timestamp: t(payload.timestamp ?? payload.last_updated ?? payload.updated_at ?? payload.created_at ?? null),
    raw_json: JSON.stringify(payload),
  };
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

function countAlphaHolders(records) {
  const uniqueColdkeys = new Set();
  for (const row of Array.isArray(records) ? records : []) {
    const coldkey = row?.coldkey?.ss58 ?? row?.coldkey ?? row?.coldkey_address?.ss58 ?? row?.coldkey_address ?? null;
    const alphaStake = asNumber(row?.total_alpha_stake ?? row?.alpha_stake ?? null);
    if (coldkey && Number.isFinite(alphaStake) && alphaStake > 0) {
      uniqueColdkeys.add(String(coldkey));
    }
  }
  return uniqueColdkeys.size;
}

function extractSubnetHoldersCountFromHtml(html, netuid) {
  const text = String(html || '');
  const embeddedMatch = text.match(/"holderCount"\s*:\s*(\d+)/i);
  if (embeddedMatch) {
    return Number(embeddedMatch[1]);
  }
  const match = text.match(/Holders\(([\d,]+)\)/i);
  if (!match) {
    throw new Error(`Could not find holders count in Taostats chart page for SN${netuid}`);
  }
  return Number(match[1].replace(/,/g, ''));
}

async function fetchSubnetHoldersCount({ netuid, taostatsPublicBaseUrl, rateLimiter = null }) {
  const url = `${taostatsPublicBaseUrl.replace(/\/$/, '')}/subnets/${netuid}/chart`;
  const { text: html } = await fetchText(url, { rateLimiter });
  return {
    sourceUrl: url,
    holderCount: extractSubnetHoldersCountFromHtml(html, netuid),
  };
}

async function fetchLatestSubnets({
  taostatsBaseUrl,
  taostatsAuthHeader,
  rateLimiter = null,
  limit = 1024,
} = {}) {
  if (!taostatsAuthHeader) {
    return [];
  }

  const headers = { authorization: taostatsAuthHeader };
  const rows = [];

  for (let page = 1; page <= 100; page += 1) {
    const url = new URL('/api/subnet/latest/v1', taostatsBaseUrl);
    url.searchParams.set('order', 'netuid_asc');
    url.searchParams.set('limit', String(limit));
    url.searchParams.set('page', String(page));
    const { json } = await fetchJson(url.toString(), { headers, rateLimiter });
    const pageRows = extractRecords(json);
    if (!pageRows.length) break;
    rows.push(...pageRows);
    if (pageRows.length < pageSize) break;
  }

  return rows.map((row) => normalizeSnapshot(row, {
    source: 'api',
    sourceUrl: `${taostatsBaseUrl.replace(/\/$/, '')}/api/subnet/latest/v1`,
    netuid: asInteger(row.netuid),
  })).filter((row) => Number.isFinite(Number(row.netuid)) && Number(row.netuid) > 0);
}

async function fetchMetagraphLatest({ netuid, taostatsBaseUrl, taostatsAuthHeader, rateLimiter = null }) {
  if (!taostatsAuthHeader) {
    return null;
  }

  const headers = { authorization: taostatsAuthHeader };
  const url = new URL('/api/metagraph/latest/v1', taostatsBaseUrl);
  url.searchParams.set('netuid', String(netuid));
  const { json } = await fetchJson(url.toString(), { headers, rateLimiter });
  const records = extractRecords(json);
  return {
    sourceUrl: url.toString(),
    holderCount: countAlphaHolders(records),
    rowCount: records.length,
  };
}

async function fetchFromApi({ netuid, taostatsBaseUrl, taostatsPublicBaseUrl, taostatsAuthHeader, rateLimiter = null }) {
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
  const snapshot = normalizeSnapshot(merged, {
    source: 'api',
    sourceUrl: poolUrl.toString(),
    netuid,
  });
  try {
    const holders = await fetchSubnetHoldersCount({ netuid, taostatsPublicBaseUrl, rateLimiter });
    snapshot.alpha_holders_text = holders.holderCount === null ? null : String(holders.holderCount);
    snapshot.alpha_holders_num = holders.holderCount;
  } catch {
    try {
      const metagraph = await fetchMetagraphLatest({ netuid, taostatsBaseUrl, taostatsAuthHeader, rateLimiter });
      if (metagraph) {
        snapshot.alpha_holders_text = metagraph.holderCount === null ? null : String(metagraph.holderCount);
        snapshot.alpha_holders_num = metagraph.holderCount;
      }
    } catch {
      // Non-fatal enrichment: keep the core subnet snapshot even if both holder-count sources fail.
    }
  }
  return snapshot;
}

async function fetchFromPublicPage({ netuid, taostatsPublicBaseUrl, rateLimiter = null }) {
  const url = `${taostatsPublicBaseUrl.replace(/\/$/, '')}/subnets/${netuid}`;
  const { text: html } = await fetchText(url, { rateLimiter });
  const payload = extractEscapedJsonObject(html, '\\"dtaoSubnet\\":{');
  const snapshot = normalizeSnapshot(payload, {
    source: 'scrape',
    sourceUrl: url,
    netuid,
  });
  try {
    const holders = await fetchSubnetHoldersCount({ netuid, taostatsPublicBaseUrl, rateLimiter });
    snapshot.alpha_holders_text = holders.holderCount === null ? null : String(holders.holderCount);
    snapshot.alpha_holders_num = holders.holderCount;
  } catch {
    // Non-fatal enrichment: keep the subnet snapshot even if the holders count page fails.
  }
  return snapshot;
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
    if (pageRows.length < pageSize) break;
  }

  return rows.map((row) => normalizeTaoPriceSnapshot(row, {
    source: 'api-history',
    sourceUrl: `${taostatsBaseUrl.replace(/\/$/, '')}/api/price/history/v1`,
    capturedAt: historyTimestampToIso(row.timestamp ?? row.last_updated ?? row.updated_at ?? row.created_at) || nowIso(),
  }));
}

async function fetchTaoFlowHistory({
  netuid,
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
    const url = new URL('/api/dtao/tao_flow/v1', taostatsBaseUrl);
    url.searchParams.set('netuid', String(netuid));
    url.searchParams.set('timestamp_start', String(timestampStart));
    url.searchParams.set('timestamp_end', String(timestampEnd));
    url.searchParams.set('order', 'timestamp_asc');
    url.searchParams.set('limit', String(limit));
    url.searchParams.set('page', String(page));
    const { json } = await fetchJson(url.toString(), { headers, rateLimiter });
    const pageRows = extractRecords(json);
    if (!pageRows.length) break;
    rows.push(...pageRows);
    if (pageRows.length < pageSize) break;
  }

  return rows.map((row) => normalizeTaoFlowSnapshot(row, {
    source: 'api-history',
    sourceUrl: `${taostatsBaseUrl.replace(/\/$/, '')}/api/dtao/tao_flow/v1`,
    netuid,
    capturedAt: historyTimestampToIso(row.timestamp ?? row.last_updated ?? row.updated_at ?? row.created_at) || nowIso(),
  }));
}

async function fetchAccountLatest({
  address,
  network = 'finney',
  taostatsBaseUrl,
  taostatsAuthHeader,
  rateLimiter = null,
  capturedAt = nowIso(),
}) {
  if (!taostatsAuthHeader) {
    return null;
  }

  const headers = { authorization: taostatsAuthHeader };
  const url = new URL('/api/account/latest/v1', taostatsBaseUrl);
  url.searchParams.set('address', address);
  url.searchParams.set('network', network);
  const { json } = await fetchJson(url.toString(), { headers, rateLimiter });
  return normalizeAccountSnapshot(json, {
    source: 'api',
    sourceUrl: url.toString(),
    walletName: null,
    address,
    network,
    capturedAt,
  });
}

async function fetchAccountHistory({
  address,
  network = 'finney',
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
    const url = new URL('/api/account/history/v1', taostatsBaseUrl);
    url.searchParams.set('address', address);
    url.searchParams.set('network', network);
    url.searchParams.set('timestamp_start', String(timestampStart));
    url.searchParams.set('timestamp_end', String(timestampEnd));
    url.searchParams.set('order', 'timestamp_asc');
    url.searchParams.set('limit', String(limit));
    url.searchParams.set('page', String(page));
    const { json } = await fetchJson(url.toString(), { headers, rateLimiter });
    const pageRows = extractRecords(json);
    if (!pageRows.length) break;
    rows.push(...pageRows);
    if (pageRows.length < pageSize) break;
  }

  return rows.map((row) => normalizeAccountSnapshot(row, {
    source: 'api-history',
    sourceUrl: `${taostatsBaseUrl.replace(/\/$/, '')}/api/account/history/v1`,
    walletName: null,
    address,
    network,
    capturedAt: historyTimestampToIso(row.timestamp ?? row.last_updated ?? row.updated_at ?? row.created_at) || nowIso(),
  }));
}

async function fetchExtrinsicsHistory({
  signerAddress = null,
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
    const url = new URL('/api/extrinsic/v1', taostatsBaseUrl);
    if (signerAddress) url.searchParams.set('signer_address', signerAddress);
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

async function fetchTransferHistory({
  address = null,
  network = 'finney',
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
    const url = new URL('/api/transfer/v1', taostatsBaseUrl);
    if (address) {
      url.searchParams.set('address', address);
    }
    if (network) {
      url.searchParams.set('network', network);
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

async function fetchStakeBalanceLatest({
  coldkey,
  hotkey = null,
  netuid = null,
  taostatsBaseUrl,
  taostatsAuthHeader,
  rateLimiter = null,
  capturedAt = nowIso(),
  limit = 200,
  onProgress = null,
  retryDelayMs = 60_000,
  maxRetries = 1,
  workerId = null,
}) {
  if (!taostatsAuthHeader) {
    return [];
  }

  const headers = { authorization: taostatsAuthHeader };
  const rows = [];
  const pageSize = Math.max(1, Math.min(Number.isFinite(Number(limit)) ? Number(limit) : 200, 200));
  const emitProgress = (payload) => {
    if (typeof onProgress === 'function') {
      onProgress(payload);
    }
  };

  for (let page = 1; page <= 100; page += 1) {
    const url = new URL('/api/dtao/stake_balance/latest/v1', taostatsBaseUrl);
    if (coldkey) url.searchParams.set('coldkey', coldkey);
    if (hotkey) url.searchParams.set('hotkey', hotkey);
    if (netuid !== null && netuid !== undefined) url.searchParams.set('netuid', String(netuid));
    url.searchParams.set('order', 'balance_as_tao_desc');
    url.searchParams.set('limit', String(pageSize));
    url.searchParams.set('page', String(page));
    emitProgress({
      phase: 'page-start',
      operation: 'stake-balance-latest',
      page,
      pageSize,
      netuid: netuid ?? null,
      coldkey: coldkey ?? null,
      hotkey: hotkey ?? null,
      workerId,
      fetched: rows.length,
      rowsFetched: rows.length,
      ok: true,
      message: `fetching page ${page}`,
    });
    let pageRows = [];
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      try {
        const { json } = await fetchJson(url.toString(), { headers, rateLimiter });
        pageRows = extractRecords(json);
        break;
      } catch (error) {
        if (Number(error?.status) === 429 && attempt < maxRetries) {
          const retryAfterMs = Number(error?.retryAfterMs);
          const baseDelayMs = Number.isFinite(retryAfterMs) && retryAfterMs > 0
            ? retryAfterMs
            : Math.max(0, Number(retryDelayMs) || 0);
          const delayMs = Math.max(0, Math.round(baseDelayMs * (attempt + 1)));
          emitProgress({
            phase: 'retry-wait',
            operation: 'stake-balance-latest',
          page,
          pageSize,
          netuid: netuid ?? null,
          coldkey: coldkey ?? null,
          hotkey: hotkey ?? null,
          workerId,
          retryAfterMs: delayMs,
          attempt: attempt + 1,
          ok: false,
          message: `rate limited on page ${page}; sleeping ${formatDurationShort(delayMs)} before retry`,
        });
          await waitMs(delayMs);
          emitProgress({
            phase: 'retrying',
            operation: 'stake-balance-latest',
          page,
          pageSize,
          netuid: netuid ?? null,
          coldkey: coldkey ?? null,
          hotkey: hotkey ?? null,
          workerId,
          retryAfterMs: delayMs,
          attempt: attempt + 1,
          ok: true,
          message: `retrying page ${page} after ${formatDurationShort(delayMs)}`,
        });
          continue;
        }
        throw error;
      }
    }
    emitProgress({
      phase: 'page',
      operation: 'stake-balance-latest',
      page,
      pageSize,
      pageRows: pageRows.length,
      fetched: rows.length + pageRows.length,
      rowsFetched: rows.length + pageRows.length,
      netuid: netuid ?? null,
      coldkey: coldkey ?? null,
      hotkey: hotkey ?? null,
      workerId,
      ok: true,
      message: `page ${page} fetched ${pageRows.length} rows`,
    });
    if (!pageRows.length) break;
    rows.push(...pageRows);
    if (pageRows.length < pageSize) break;
  }

  return rows.map((row) => normalizeStakeBalanceSnapshot(row, {
    source: 'api',
    sourceUrl: `${taostatsBaseUrl.replace(/\/$/, '')}/api/dtao/stake_balance/latest/v1`,
    walletName: null,
    address: coldkey || null,
    capturedAt,
  }));
}

async function fetchHistoricalStakeBalance({
  coldkey,
  hotkey = null,
  netuid = null,
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
    const url = new URL('/api/dtao/stake_balance/history/v1', taostatsBaseUrl);
    if (coldkey) url.searchParams.set('coldkey', coldkey);
    if (hotkey) url.searchParams.set('hotkey', hotkey);
    if (netuid !== null && netuid !== undefined) url.searchParams.set('netuid', String(netuid));
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

  return rows.map((row) => normalizeStakeBalanceSnapshot(row, {
    source: 'api-history',
    sourceUrl: `${taostatsBaseUrl.replace(/\/$/, '')}/api/dtao/stake_balance/history/v1`,
    walletName: null,
    address: coldkey || null,
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

async function fetchSubnetLatestCatalog({
  taostatsBaseUrl,
  taostatsAuthHeader,
  rateLimiter = null,
  limit = 1024,
}) {
  if (!taostatsAuthHeader) {
    return [];
  }

  const headers = { authorization: taostatsAuthHeader };
  const rows = [];
  const seenNetuids = new Set();
  const pageSize = Math.max(1, Math.min(Number.isFinite(Number(limit)) ? Number(limit) : 1024, 200));

  for (let page = 1; page <= 100; page += 1) {
    const url = new URL('/api/subnet/latest/v1', taostatsBaseUrl);
    url.searchParams.set('order', 'netuid_asc');
    url.searchParams.set('limit', String(pageSize));
    url.searchParams.set('page', String(page));
    const { json } = await fetchJson(url.toString(), { headers, rateLimiter });
    const pageRows = extractRecords(json);
    if (!pageRows.length) break;
    rows.push(...pageRows);
    if (pageRows.length < pageSize) break;
  }

  const catalog = [];
  for (const row of rows) {
    const netuid = asInteger(row?.netuid);
    if (netuid === null || seenNetuids.has(netuid)) {
      continue;
    }
    seenNetuids.add(netuid);
    catalog.push(row);
  }

  return catalog;
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
        snapshot: await fetchFromApi({ netuid, taostatsBaseUrl, taostatsPublicBaseUrl, taostatsAuthHeader, rateLimiter }),
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
  fetchSubnetHoldersCount,
  fetchLatestSubnets,
  extractSubnetHoldersCountFromHtml,
  fetchMetagraphLatest,
  fetchTaoPriceLatest,
  fetchTaoPriceHistory,
  fetchTaoFlowHistory,
  fetchAccountLatest,
  fetchAccountHistory,
  fetchExtrinsicsHistory,
  fetchTransferHistory,
  fetchStakeBalanceLatest,
  fetchHistoricalStakeBalance,
  fetchHistoricalSnapshots,
  fetchSubnetLatestCatalog,
  extractEscapedJsonObject,
  normalizeSnapshot,
  normalizeTaoPriceSnapshot,
  normalizeTaoFlowSnapshot,
  normalizeAccountSnapshot,
  normalizeStakeBalanceSnapshot,
  pickRecord,
  extractRecords,
  countAlphaHolders,
  asNumber,
  asInteger,
  asBoolean,
  asText,
  createRateLimiter,
};
