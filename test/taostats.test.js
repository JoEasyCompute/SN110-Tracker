'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  extractEscapedJsonObject,
  normalizeSnapshot,
  normalizeTaoPriceSnapshot,
  normalizeTaoFlowSnapshot,
  normalizeAccountSnapshot,
  normalizeStakeBalanceSnapshot,
  pickRecord,
  createRateLimiter,
} = require('../src/taostats');
const {
  openDatabase,
  insertSnapshot,
  insertTaoPriceSnapshot,
  insertTaoFlowSnapshot,
  insertWalletSnapshot,
  insertWalletStakePosition,
  getLatestSnapshot,
  getRecentSnapshots,
  getHistory,
  getLatestTaoPrice,
  getTaoPriceHistory,
  getTaoFlowHistory,
  getLatestWalletSnapshot,
  getLatestWalletStakePositions,
  getWalletHistory,
  deleteSnapshotsInRange,
  deleteWalletStakePositions,
  getSetting,
  setSetting,
} = require('../src/db');
const { buildPageModel, renderPage, numericMetricValue, createDashboardServer, formatChartDate } = require('../src/server');
const { loadConfig } = require('../src/config');

test('extractEscapedJsonObject parses the Taostats page payload', () => {
  const html = `before \\"dtaoSubnet\\":{\\"netuid\\":110,\\"name\\":\\"Green Compute\\",\\"price\\":\\"0.005709859\\",\\"market_cap\\":\\"10094190385726.221994149\\",\\"liquidity\\":\\"7326003373188\\",\\"timestamp\\":\\"2026-04-30T09:03:00Z\\"} after`;
  const obj = extractEscapedJsonObject(html, '\\"dtaoSubnet\\":{');
  assert.equal(obj.netuid, 110);
  assert.equal(obj.name, 'Green Compute');
  assert.equal(obj.price, '0.005709859');
});

test('normalizeSnapshot produces a stable DB-ready shape', () => {
  const raw = {
    netuid: 110,
    block_number: 1234,
    timestamp: '2026-04-30T09:03:00Z',
    name: 'Green Compute',
    symbol: 'Ѐ',
    rank: 97,
    price: '0.005709859',
    market_cap: '10094190385726.221994149',
    liquidity: '7326003373188',
    total_tao: '3738214651815',
    root_prop: '0.28069856591017118363',
    emission: '2854905',
    projected_emission: '0.00727172634236777466',
    incentive_burn: '0.12',
    recycled_24_hours: '500000',
    recycled_lifetime: '3308926880',
    recycled_since_registration: '3308926880',
    neuron_registration_cost: '500000',
    active_keys: 256,
    max_neurons: 256,
    net_flow_1_day: '54106208057',
    net_flow_7_days: '-324821553991',
    net_flow_30_days: '567680736182',
    root_sell: 'YES',
    price_change_1_day: '2.680697764041122927',
    ssi: '61.4',
    startup_mode: false,
    swap_v3_initialized: true,
    enabled_user_liquidity: false,
  };

  const snapshot = normalizeSnapshot(raw, { source: 'scrape', sourceUrl: 'https://taostats.io/subnets/110', netuid: 110 });
  assert.equal(snapshot.netuid, 110);
  assert.equal(snapshot.source, 'scrape');
  assert.equal(snapshot.price_text, '0.005709859');
  assert.equal(snapshot.price_num, 0.005709859);
  assert.equal(snapshot.total_tao_num, 3738214651815);
  assert.equal(snapshot.emission_num, 2854905);
  assert.equal(Math.round(snapshot.emission_percent_num * 100) / 100, 0.57);
  assert.equal(Math.round(snapshot.emission_per_day_tao_num * 100) / 100, 41.11);
  assert.equal(Math.round(snapshot.owner_per_day_tao_num * 100) / 100, 7.4);
  assert.equal(Math.round(snapshot.miner_per_day_tao_num * 100) / 100, 16.86);
  assert.equal(Math.round(snapshot.validator_per_day_tao_num * 100) / 100, 16.86);
  assert.equal(snapshot.registration_cost_num, 0.0005);
  assert.equal(snapshot.active_keys_num, 256);
  assert.equal(snapshot.max_neurons_num, 256);
  assert.equal(snapshot.projected_emission_num, 0.00727172634236777466);
  assert.equal(snapshot.net_flow_7_days_num, -324821553991);
  assert.equal(snapshot.root_sell_bool, true);
  assert.equal(snapshot.sentiment_index_num, 61.4);
  assert.equal(snapshot.sentiment_index_source_text, 'ssi');
  assert.equal(snapshot.swap_v3_initialized, true);
  assert.equal(snapshot.raw_json.includes('Green Compute'), true);
});

test('sqlite persistence stores and retrieves snapshot history', () => {
  const db = openDatabase(':memory:');
  const snapshot1 = normalizeSnapshot({
    netuid: 110,
    block_number: 1,
    timestamp: '2026-04-30T00:00:00Z',
    name: 'Green Compute',
    symbol: 'Ѐ',
    price: '1.0',
    market_cap: '100',
    liquidity: '50',
    emission: '10',
    projected_emission: '0.1',
    incentive_burn: '0',
    recycled_24_hours: '500000',
    neuron_registration_cost: '500000',
    active_keys: 256,
    max_neurons: 256,
    net_flow_1_day: '20',
    net_flow_7_days: '30',
    net_flow_30_days: '40',
    fear_and_greed_index: '46.2',
    fear_and_greed_sentiment: 'Neutral',
    root_sell: 'NO',
  }, { source: 'scrape', sourceUrl: 'https://example.invalid', netuid: 110 });
  snapshot1.captured_at = '2026-04-29T00:00:00.000Z';
  insertSnapshot(db, snapshot1);

  const snapshot2 = normalizeSnapshot({
    netuid: 110,
    block_number: 2,
    timestamp: '2026-04-30T01:00:00Z',
    name: 'Green Compute',
    symbol: 'Ѐ',
    price: '2.0',
    market_cap: '200',
    liquidity: '60',
    emission: '11',
    projected_emission: '0.2',
    incentive_burn: '0',
    recycled_24_hours: '500000',
    neuron_registration_cost: '500000',
    active_keys: 256,
    max_neurons: 256,
    net_flow_1_day: '21',
    net_flow_7_days: '31',
    net_flow_30_days: '41',
    root_sell: 'YES',
  }, { source: 'scrape', sourceUrl: 'https://example.invalid', netuid: 110 });
  snapshot2.captured_at = '2026-04-30T00:00:00.000Z';
  insertSnapshot(db, snapshot2);

  const latest = getLatestSnapshot(db, 110);
  assert.equal(latest.price_num, 2);

  const recent = getRecentSnapshots(db, 110, 2);
  assert.equal(recent.length, 2);
  assert.equal(recent[0].price_num, 2);
  assert.equal(recent[1].price_num, 1);
  assert.equal(recent[0].emission_num, 11);
  assert.equal(recent[0].root_sell_bool, 1);

  const history = getHistory(db, 110, '2026-04-29T00:00:00.000Z');
  assert.equal(history.length, 2);
  assert.equal(history[0].price_num, 1);
  assert.equal(history[1].price_num, 2);

  const columns = db.prepare('PRAGMA table_info(snapshots)').all().map((row) => row.name);
  for (const name of ['emission_text', 'emission_percent_text', 'emission_per_day_tao_text', 'registration_cost_text', 'active_keys_text', 'projected_emission_text', 'net_flow_1_day_text', 'sentiment_index_text', 'sentiment_index_source_text', 'root_sell_text', 'total_tao_num']) {
    assert.equal(columns.includes(name), true);
  }

  db.close();
});

test('sqlite persistence stores and retrieves tao price history', () => {
  const db = openDatabase(':memory:');
  const price1 = normalizeTaoPriceSnapshot({
    created_at: '2026-04-29T00:00:00Z',
    last_updated: '2026-04-29T00:00:00Z',
    symbol: 'TAO',
    price: '100.25',
    volume_24h: '200.5',
    market_cap: '300.75',
  }, { source: 'api', sourceUrl: 'https://example.invalid', capturedAt: '2026-04-29T00:00:00.000Z' });
  insertTaoPriceSnapshot(db, price1);

  const price2 = normalizeTaoPriceSnapshot({
    created_at: '2026-04-30T00:00:00Z',
    last_updated: '2026-04-30T00:00:00Z',
    symbol: 'TAO',
    price: '110.25',
    volume_24h: '210.5',
    market_cap: '310.75',
  }, { source: 'api', sourceUrl: 'https://example.invalid', capturedAt: '2026-04-30T00:00:00.000Z' });
  insertTaoPriceSnapshot(db, price2);

  const latest = getLatestTaoPrice(db);
  assert.equal(latest.price_usd, 110.25);

  const history = getTaoPriceHistory(db, '2026-04-29T00:00:00.000Z');
  assert.equal(history.length, 2);
  assert.equal(history[0].price_usd, 100.25);
  assert.equal(history[1].price_usd, 110.25);

  db.close();
});

test('sqlite persistence stores and retrieves tao flow history', () => {
  const db = openDatabase(':memory:');
  const flow1 = normalizeTaoFlowSnapshot({
    block_number: 10,
    timestamp: '2026-04-29T00:00:00Z',
    netuid: 110,
    name: 'Green Compute',
    symbol: 'Ѐ',
    tao_flow: '1000',
  }, { source: 'api-history', sourceUrl: 'https://example.invalid', netuid: 110, capturedAt: '2026-04-29T00:00:00.000Z' });
  insertTaoFlowSnapshot(db, flow1);

  const flow2 = normalizeTaoFlowSnapshot({
    block_number: 11,
    timestamp: '2026-04-30T00:00:00Z',
    netuid: 110,
    name: 'Green Compute',
    symbol: 'Ѐ',
    tao_flow: '1100',
  }, { source: 'api-history', sourceUrl: 'https://example.invalid', netuid: 110, capturedAt: '2026-04-30T00:00:00.000Z' });
  insertTaoFlowSnapshot(db, flow2);

  const history = getTaoFlowHistory(db, 110, '2026-04-29T00:00:00.000Z');
  assert.equal(history.length, 2);
  assert.equal(history[0].tao_flow_num, 1000);
  assert.equal(history[1].tao_flow_num, 1100);

  db.close();
});

test('sqlite persistence stores and retrieves wallet balance history', () => {
  const db = openDatabase(':memory:');
  const wallet1 = normalizeAccountSnapshot({
    address: { ss58: '5WalletAlpha', hex: '0xabc' },
    network: 'finney',
    block_number: 100,
    timestamp: '2026-04-29T00:00:00Z',
    rank: 12,
    balance_free: '1000000000',
    balance_staked: '2000000000',
    balance_staked_alpha_as_tao: '500000000',
    balance_staked_root: '1500000000',
    balance_total: '3000000000',
    balance_total_24hr_ago: '2500000000',
    created_on_date: '2025-01-01',
    created_on_network: 'finney',
  }, { source: 'api-history', sourceUrl: 'https://example.invalid', walletName: 'Alpha', address: '5WalletAlpha', network: 'finney', capturedAt: '2026-04-29T00:00:00.000Z' });
  insertWalletSnapshot(db, wallet1);

  const wallet2 = normalizeAccountSnapshot({
    address: { ss58: '5WalletAlpha', hex: '0xabc' },
    network: 'finney',
    block_number: 101,
    timestamp: '2026-04-30T00:00:00Z',
    rank: 11,
    balance_free: '1200000000',
    balance_staked: '2200000000',
    balance_staked_alpha_as_tao: '700000000',
    balance_staked_root: '1500000000',
    balance_total: '3400000000',
    balance_total_24hr_ago: '3000000000',
    created_on_date: '2025-01-01',
    created_on_network: 'finney',
  }, { source: 'api-history', sourceUrl: 'https://example.invalid', walletName: 'Alpha', address: '5WalletAlpha', network: 'finney', capturedAt: '2026-04-30T00:00:00.000Z' });
  insertWalletSnapshot(db, wallet2);

  const latest = getLatestWalletSnapshot(db, '5WalletAlpha');
  assert.equal(latest.wallet_name, 'Alpha');
  assert.equal(latest.balance_total_num, 3.4);

  const history = getWalletHistory(db, '5WalletAlpha', '2026-04-29T00:00:00.000Z');
  assert.equal(history.length, 2);
  assert.equal(Math.round(history[0].balance_total_num * 100) / 100, 3.0);
  assert.equal(Math.round(history[1].balance_total_num * 100) / 100, 3.4);

  db.close();
});

test('sqlite persistence stores and retrieves wallet stake positions', () => {
  const db = openDatabase(':memory:');
  const stake1 = normalizeStakeBalanceSnapshot({
    coldkey: { ss58: '5WalletAlpha', hex: '0xabc' },
    hotkey: { ss58: '5HotkeyOne', hex: '0x111' },
    hotkey_name: 'Miner One',
    netuid: 110,
    subnet_rank: 12,
    subnet_total_holders: 256,
    balance: '1000000000',
    balance_as_tao: '2000000000',
    timestamp: '2026-04-30T00:00:00Z',
  }, { source: 'api', sourceUrl: 'https://example.invalid', walletName: 'Alpha', address: '5WalletAlpha', capturedAt: '2026-04-30T00:00:00.000Z' });
  const stake2 = normalizeStakeBalanceSnapshot({
    coldkey: { ss58: '5WalletAlpha', hex: '0xabc' },
    hotkey: { ss58: '5HotkeyTwo', hex: '0x222' },
    hotkey_name: 'Miner Two',
    netuid: 111,
    subnet_rank: 8,
    subnet_total_holders: 512,
    balance: '1500000000',
    balance_as_tao: '2500000000',
    timestamp: '2026-04-30T00:00:00Z',
  }, { source: 'api', sourceUrl: 'https://example.invalid', walletName: 'Alpha', address: '5WalletAlpha', capturedAt: '2026-04-30T00:00:00.000Z' });
  insertWalletStakePosition(db, stake1);
  insertWalletStakePosition(db, stake2);

  const latest = getLatestWalletStakePositions(db, '5WalletAlpha');
  assert.equal(latest.length, 2);
  assert.equal(latest[0].hotkey_name, 'Miner Two');
  assert.equal(latest[0].balance_as_tao_num, 2.5);
  assert.equal(latest[1].hotkey_name, 'Miner One');
  assert.equal(latest[1].balance_as_tao_num, 2);

  deleteWalletStakePositions(db, '5WalletAlpha');
  assert.equal(getLatestWalletStakePositions(db, '5WalletAlpha').length, 0);

  db.close();
});

test('sqlite app settings persist key/value pairs', () => {
  const db = openDatabase(':memory:');
  assert.equal(getSetting(db, 'poll_interval_minutes'), null);
  assert.equal(setSetting(db, 'poll_interval_minutes', 120), '120');
  assert.equal(getSetting(db, 'poll_interval_minutes'), '120');
  db.close();
});

test('pickRecord supports array-shaped API payloads', () => {
  const payload = [
    { netuid: 109, name: 'Other' },
    { netuid: 110, name: 'Green Compute' },
  ];
  const record = pickRecord(payload, 110);
  assert.equal(record.name, 'Green Compute');
});

test('rate limiter spaces requests to respect the configured cap', async () => {
  const limiter = createRateLimiter({ maxRequests: 5, intervalMs: 1000 });
  const first = await limiter.waitForSlot();
  const second = await limiter.waitForSlot();
  assert.equal(first.waitMs >= 0, true);
  assert.equal(second.waitMs >= 100, true);
  assert.equal(second.scheduledAt > first.scheduledAt, true);
});

test('renderPage includes clickable latest metrics and modal markup', () => {
  const db = openDatabase(':memory:');
  const snapshot = normalizeSnapshot({
    netuid: 110,
    block_number: 1,
    timestamp: '2026-04-30T00:00:00Z',
    name: 'Green Compute',
    symbol: 'Ѐ',
    price: '1.0',
    market_cap: '100',
    liquidity: '50',
    emission: '10',
    projected_emission: '0.1',
    incentive_burn: '0',
    recycled_24_hours: '500000',
    neuron_registration_cost: '500000',
    active_keys: 256,
    max_neurons: 256,
    net_flow_1_day: '20',
    net_flow_7_days: '30',
    net_flow_30_days: '40',
    root_prop: '0.25',
    root_sell: 'YES',
    fear_and_greed_index: '46.2',
    fear_and_greed_sentiment: 'Neutral',
  }, { source: 'scrape', sourceUrl: 'https://example.invalid', netuid: 110 });
  insertSnapshot(db, snapshot);
  insertWalletSnapshot(db, normalizeAccountSnapshot({
    address: { ss58: '5WalletAlpha123456789ABCDEFGH', hex: '0xabc' },
    network: 'finney',
    block_number: 2,
    timestamp: '2026-04-30T00:00:00Z',
    rank: 12,
    balance_free: '1000000000',
    balance_staked: '2000000000',
    balance_staked_alpha_as_tao: '500000000',
    balance_staked_root: '1500000000',
    balance_total: '3000000000',
    balance_total_24hr_ago: '2500000000',
    created_on_date: '2025-01-01',
    created_on_network: 'finney',
  }, { source: 'api-history', sourceUrl: 'https://example.invalid', walletName: 'Alpha Treasury', address: '5WalletAlpha123456789ABCDEFGH', network: 'finney', capturedAt: '2026-04-30T00:00:00.000Z' }));
  insertWalletStakePosition(db, normalizeStakeBalanceSnapshot({
    coldkey: { ss58: '5WalletAlpha123456789ABCDEFGH', hex: '0xabc' },
    hotkey: { ss58: '5HotkeyOne', hex: '0x111' },
    hotkey_name: 'Miner One',
    netuid: 111,
    subnet_rank: 8,
    subnet_total_holders: 256,
    balance: '1500000000',
    balance_as_tao: '2500000000',
    timestamp: '2026-04-30T00:00:00Z',
  }, { source: 'api', sourceUrl: 'https://example.invalid', walletName: 'Alpha Treasury', address: '5WalletAlpha123456789ABCDEFGH', capturedAt: '2026-04-30T00:00:00.000Z' }));
  insertTaoPriceSnapshot(db, normalizeTaoPriceSnapshot({
    created_at: '2026-04-30T00:00:00Z',
    last_updated: '2026-04-30T00:00:00Z',
    symbol: 'TAO',
    price: '100.0',
    volume_24h: '1000',
    market_cap: '2000',
  }, { source: 'api', sourceUrl: 'https://example.invalid', capturedAt: '2026-04-30T00:00:00.000Z' }));
  const model = buildPageModel({
    db,
    config: {
      taostatsAuthHeader: '',
      taostatsAdminApiKey: 'admin-secret',
      pollIntervalMinutes: 15,
      wallets: [{ name: 'Alpha Treasury', ss58: '5WalletAlpha123456789ABCDEFGH', network: 'finney', hotkeys: [{ name: 'Miner One', ss58: '5HotkeyOne', netuid: 111, network: 'finney' }] }],
    },
    netuid: 110,
  });
  const html = renderPage(model);
  assert.equal(html.includes('id="history-modal"'), true);
  assert.equal(html.includes('history-modal-info'), true);
  assert.equal(html.includes('history-modal-explanation'), true);
  assert.equal(html.includes('history-window-prev'), true);
  assert.equal(html.includes('history-window-next'), true);
  assert.equal(html.includes('history-window-label'), true);
  assert.equal(html.includes('14D'), true);
  assert.equal(html.includes('Wallet balances'), true);
  assert.equal(html.includes('Alpha Treasury'), true);
  assert.equal(html.includes('5Walle'), true);
  assert.equal(html.includes('Hotkey Miner One'), true);
  assert.equal(html.includes('Current subnet stake'), true);
  assert.equal(html.includes('Wallet profile'), true);
  assert.equal(html.includes('Created'), true);
  assert.equal(html.includes('Rank'), true);
  assert.equal(html.includes('Configured hotkeys'), true);
  assert.equal(html.includes('Hotkey history'), true);
  assert.equal(html.includes('Change'), true);
  assert.equal(html.includes('Miner One'), true);
  assert.equal(html.includes('wallet-positions-table'), true);
  assert.equal(html.includes('Financial perspective'), true);
  assert.equal(html.includes('Signal now'), true);
  assert.equal(html.includes('Why this signal?'), true);
  assert.equal(html.includes('What matters most today'), true);
  assert.equal(html.includes('Quick read'), true);
  assert.equal(html.includes('Watchlist'), true);
  assert.equal(html.includes('Keep watching'), true);
  assert.equal(html.includes('Price vs flow'), true);
  assert.equal(html.includes('Sentiment watch'), true);
  assert.equal(html.includes('Price + flow'), true);
  assert.equal(html.includes('Supply pressure'), true);
  assert.equal(html.includes('Price momentum'), true);
  assert.equal(html.includes('Money flow'), true);
  assert.equal(html.includes('Market mood'), true);
  assert.equal(html.includes('Supply pressure'), true);
  assert.equal(html.includes('Admin panel'), true);
  assert.equal(html.includes('id="refresh-btn"'), true);
  assert.equal(html.includes('id="backfill-days"'), true);
  assert.equal(html.includes('id="backfill-frequency"'), true);
  assert.equal(html.includes('id="backfill-overwrite"'), true);
  assert.equal(html.includes('id="backfill-btn"'), true);
  assert.equal(html.includes('history-modal-wallet-details'), true);
  assert.equal(html.includes('data-history-range="1"'), true);
  assert.equal(html.includes('data-history-range="7"'), true);
  assert.equal(html.includes('data-history-range="30"'), true);
  assert.equal(html.includes('data-history-range="60"'), true);
  assert.equal(html.includes('history-modal-samples-note'), true);
  assert.equal(html.includes('id="currency-toggle"'), true);
  assert.equal(html.includes('id="tao-price-label"'), true);
  assert.equal(html.includes('title="Click to view TAO price history"'), true);
  assert.equal(html.includes('data-latest-snapshot-signature='), true);
  assert.equal(html.includes('data-latest-ingest-run-id='), true);
  assert.equal(html.includes('@media (max-width: 900px)'), true);
  assert.equal(html.includes('.topbar .actions {'), true);
  assert.equal(html.includes('grid-template-columns: repeat(2, minmax(0, 1fr));'), true);
  assert.equal(html.includes('#tao-price-label {'), true);
  assert.equal(html.includes('.modal-header .button {'), true);
  assert.equal(html.includes('.wallet-history-details {'), true);
  assert.equal(html.includes('.admin-grid {'), true);
  assert.equal(html.includes('admin-controls'), true);
  assert.equal(html.includes('tao-flow'), true);
  assert.equal(html.includes('data-poll-interval="60"'), true);
  assert.equal(html.includes('data-poll-interval="120"'), true);
  assert.equal(html.includes('data-poll-interval="240"'), true);
  assert.equal(html.includes('id="poll-interval-label"'), true);
  assert.equal(html.includes('id="next-poll-label"'), true);
  assert.equal(html.includes('id="tao-price-label"'), true);
  assert.equal(html.includes('Next poll: '), true);
  assert.equal(html.includes('title="Percentage value"'), true);
  assert.equal(html.includes('title="Percentage of the whole pool"'), true);
  assert.equal(html.includes('title="Percentage change"'), true);
  assert.equal(html.includes('chart-note'), true);
  assert.equal(html.includes('Latest JSON'), true);
  assert.equal(html.includes('What changed in the last 24h'), true);
  assert.equal(html.includes('History JSON'), true);
  assert.equal(html.includes('sn110-financial-panel-open'), true);
  assert.equal(html.includes('sn110-admin-panel-open'), true);
  assert.equal(html.includes('data-metric='), true);
  assert.equal(html.includes('card-info-badge'), true);
  assert.equal(html.includes('Key metrics'), true);
  assert.equal(html.includes('Subnet stats'), true);
  assert.equal(html.includes('New TAO / Day'), true);
  assert.equal(html.includes('UIDs'), true);
  assert.equal(html.includes('Token Price'), true);
  assert.equal(html.includes('Trend charts'), true);
  assert.equal(html.includes('Supporting charts'), true);
  assert.equal(html.includes('Subnet Sentiment (SSI)'), true);
  assert.equal(html.includes('Source: Fear &amp; Greed'), true);
  assert.equal(html.includes('Emission Rate'), true);
  assert.equal(html.includes('TAO price used:'), true);
  assert.equal(html.includes('Gaps in this chart mean no historical sample was stored for that time.'), true);
  assert.equal(html.includes('displayMetricText(metric)'), true);
  assert.equal(html.includes('Click a latest snapshot card'), true);
  assert.equal(html.includes('"historySource":"subnet"'), true);
  assert.equal(html.includes('/api/subnets/' + model.netuid + '/latest'), true);
  assert.equal(html.includes('syncLiveSnapshotState()'), true);
  assert.equal(model.latest.tao_price_usd, 100);
  db.close();
});

test('renderPage hides admin tools when no admin api key is configured', () => {
  const db = openDatabase(':memory:');
  const model = buildPageModel({
    db,
    config: {
      taostatsAuthHeader: '',
      pollIntervalMinutes: 15,
      wallets: [],
    },
    netuid: 110,
  });
  const html = renderPage(model);
  assert.equal(html.includes('Admin panel'), false);
  assert.equal(html.includes('id="refresh-btn"'), false);
  assert.equal(html.includes('data-poll-interval="60"'), false);
  db.close();
});

test('dashboard route renders without throwing', async () => {
  const db = openDatabase(':memory:');
  const snapshot = normalizeSnapshot({
    netuid: 110,
    block_number: 1,
    timestamp: '2026-04-30T00:00:00Z',
    name: 'Green Compute',
    symbol: 'Ѐ',
    price: '1.0',
    market_cap: '100',
    liquidity: '50',
    emission: '10',
    projected_emission: '0.1',
    incentive_burn: '0',
    recycled_24_hours: '500000',
    neuron_registration_cost: '500000',
    active_keys: 256,
    max_neurons: 256,
    net_flow_1_day: '20',
    net_flow_7_days: '30',
    net_flow_30_days: '40',
    root_prop: '0.25',
    root_sell: 'YES',
    fear_and_greed_index: '46.2',
    fear_and_greed_sentiment: 'Neutral',
  }, { source: 'scrape', sourceUrl: 'https://example.invalid', netuid: 110 });
  insertSnapshot(db, snapshot);
  insertTaoPriceSnapshot(db, normalizeTaoPriceSnapshot({
    created_at: '2026-04-30T00:00:00Z',
    last_updated: '2026-04-30T00:00:00Z',
    symbol: 'TAO',
    price: '100.0',
    volume_24h: '1000',
    market_cap: '2000',
  }, { source: 'api', sourceUrl: 'https://example.invalid', capturedAt: '2026-04-30T00:00:00.000Z' }));

  const app = createDashboardServer({
    db,
    ingestService: { ingestOnce: async () => ({ ok: true }) },
    config: { netuid: 110, taostatsAuthHeader: '', pollIntervalMinutes: 60, nextPollAtIso: null },
  });
  const server = await app.start(0);
  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}/subnets/110`);
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.equal(html.includes('Signal now'), true);
  await app.close();
  db.close();
});

test('tao price history endpoint returns stored price history', async () => {
  const db = openDatabase(':memory:');
  insertTaoPriceSnapshot(db, normalizeTaoPriceSnapshot({
    created_at: '2026-04-29T00:00:00Z',
    last_updated: '2026-04-29T00:00:00Z',
    symbol: 'TAO',
    price: '100.25',
    volume_24h: '200.5',
    market_cap: '300.75',
  }, { source: 'api', sourceUrl: 'https://example.invalid', capturedAt: '2026-04-29T00:00:00.000Z' }));
  insertTaoPriceSnapshot(db, normalizeTaoPriceSnapshot({
    created_at: '2026-04-30T00:00:00Z',
    last_updated: '2026-04-30T00:00:00Z',
    symbol: 'TAO',
    price: '110.25',
    volume_24h: '210.5',
    market_cap: '310.75',
  }, { source: 'api', sourceUrl: 'https://example.invalid', capturedAt: '2026-04-30T00:00:00.000Z' }));

  const app = createDashboardServer({
    db,
    ingestService: { ingestOnce: async () => ({ ok: true }) },
    config: { netuid: 110, taostatsAuthHeader: '', pollIntervalMinutes: 60, nextPollAtIso: null },
  });
  const server = await app.start(0);
  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}/api/tao-price/history?days=30`);
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.days, 30);
  assert.equal(payload.history.length, 2);
  assert.equal(payload.history[0].price_usd, 100.25);
  assert.equal(payload.history[1].price_usd, 110.25);
  await app.close();
  db.close();
});

test('tao flow history endpoint returns stored flow history', async () => {
  const db = openDatabase(':memory:');
  insertTaoFlowSnapshot(db, normalizeTaoFlowSnapshot({
    block_number: 1,
    timestamp: '2026-04-29T00:00:00Z',
    netuid: 110,
    name: 'Green Compute',
    symbol: 'Ѐ',
    tao_flow: '1000',
  }, { source: 'api-history', sourceUrl: 'https://example.invalid', capturedAt: '2026-04-29T00:00:00.000Z', netuid: 110 }));
  insertTaoFlowSnapshot(db, normalizeTaoFlowSnapshot({
    block_number: 2,
    timestamp: '2026-04-30T00:00:00Z',
    netuid: 110,
    name: 'Green Compute',
    symbol: 'Ѐ',
    tao_flow: '1100',
  }, { source: 'api-history', sourceUrl: 'https://example.invalid', capturedAt: '2026-04-30T00:00:00.000Z', netuid: 110 }));

  const app = createDashboardServer({
    db,
    ingestService: { ingestOnce: async () => ({ ok: true }) },
    config: { netuid: 110, taostatsAuthHeader: '', pollIntervalMinutes: 60, nextPollAtIso: null },
  });
  const server = await app.start(0);
  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}/api/subnets/110/flow-history?days=30`);
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.days, 30);
  assert.equal(payload.history.length, 2);
  assert.equal(payload.history[0].tao_flow_num, 1000);
  assert.equal(payload.history[1].tao_flow_num, 1100);
  await app.close();
  db.close();
});

test('wallet history endpoint returns stored wallet history', async () => {
  const db = openDatabase(':memory:');
  insertWalletSnapshot(db, normalizeAccountSnapshot({
    address: { ss58: '5WalletAlpha123456789ABCDEFGH', hex: '0xabc' },
    network: 'finney',
    block_number: 100,
    timestamp: '2026-04-29T00:00:00Z',
    rank: 12,
    balance_free: '1000000000',
    balance_staked: '2000000000',
    balance_staked_alpha_as_tao: '500000000',
    balance_staked_root: '1500000000',
    balance_total: '3000000000',
    balance_total_24hr_ago: '2500000000',
    created_on_date: '2025-01-01',
    created_on_network: 'finney',
  }, { source: 'api-history', sourceUrl: 'https://example.invalid', walletName: 'Alpha Treasury', address: '5WalletAlpha123456789ABCDEFGH', network: 'finney', capturedAt: '2026-04-29T00:00:00.000Z' }));
  insertWalletSnapshot(db, normalizeAccountSnapshot({
    address: { ss58: '5WalletAlpha123456789ABCDEFGH', hex: '0xabc' },
    network: 'finney',
    block_number: 101,
    timestamp: '2026-04-30T00:00:00Z',
    rank: 11,
    balance_free: '1200000000',
    balance_staked: '2200000000',
    balance_staked_alpha_as_tao: '700000000',
    balance_staked_root: '1500000000',
    balance_total: '3400000000',
    balance_total_24hr_ago: '3000000000',
    created_on_date: '2025-01-01',
    created_on_network: 'finney',
  }, { source: 'api-history', sourceUrl: 'https://example.invalid', walletName: 'Alpha Treasury', address: '5WalletAlpha123456789ABCDEFGH', network: 'finney', capturedAt: '2026-04-30T00:00:00.000Z' }));

  const app = createDashboardServer({
    db,
    ingestService: { ingestOnce: async () => ({ ok: true }) },
    config: { netuid: 110, taostatsAuthHeader: '', pollIntervalMinutes: 60, nextPollAtIso: null },
  });
  const server = await app.start(0);
  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}/api/wallets/5WalletAlpha123456789ABCDEFGH/history?days=30`);
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.days, 30);
  assert.equal(payload.history.length, 2);
  assert.equal(Math.round(payload.history[1].balance_total_num * 100) / 100, 3.4);
  await app.close();
  db.close();
});

test('wallet stake history endpoint returns stored hotkey history', async () => {
  const db = openDatabase(':memory:');
  insertWalletStakePosition(db, normalizeStakeBalanceSnapshot({
    coldkey: { ss58: '5WalletAlpha123456789ABCDEFGH', hex: '0xabc' },
    hotkey: { ss58: '5HotkeyOne', hex: '0x111' },
    hotkey_name: 'Miner One',
    netuid: 111,
    subnet_rank: 9,
    subnet_total_holders: 256,
    balance: '1500000000',
    balance_as_tao: '2500000000',
    timestamp: '2026-04-29T00:00:00Z',
  }, { source: 'api-history', sourceUrl: 'https://example.invalid', walletName: 'Alpha Treasury', address: '5WalletAlpha123456789ABCDEFGH', capturedAt: '2026-04-29T00:00:00.000Z' }));
  insertWalletStakePosition(db, normalizeStakeBalanceSnapshot({
    coldkey: { ss58: '5WalletAlpha123456789ABCDEFGH', hex: '0xabc' },
    hotkey: { ss58: '5HotkeyOne', hex: '0x111' },
    hotkey_name: 'Miner One',
    netuid: 111,
    subnet_rank: 8,
    subnet_total_holders: 256,
    balance: '1700000000',
    balance_as_tao: '2700000000',
    timestamp: '2026-04-30T00:00:00Z',
  }, { source: 'api-history', sourceUrl: 'https://example.invalid', walletName: 'Alpha Treasury', address: '5WalletAlpha123456789ABCDEFGH', capturedAt: '2026-04-30T00:00:00.000Z' }));

  const app = createDashboardServer({
    db,
    ingestService: { ingestOnce: async () => ({ ok: true }) },
    config: { netuid: 110, taostatsAuthHeader: '', pollIntervalMinutes: 60, nextPollAtIso: null },
  });
  const server = await app.start(0);
  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}/api/wallets/5WalletAlpha123456789ABCDEFGH/stake-history?days=30`);
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.days, 30);
  assert.equal(payload.history.length, 2);
  assert.equal(payload.history[0].hotkey_name, 'Miner One');
  assert.equal(payload.history[1].subnet_rank, 8);
  await app.close();
  db.close();
});

test('poll interval selector endpoint updates the interval setting', async () => {
  const db = openDatabase(':memory:');
  let observedMinutes = null;
  const app = createDashboardServer({
    db,
    ingestService: {
      ingestOnce: async () => ({ ok: true }),
    },
    config: {
      netuid: 110,
      taostatsAuthHeader: '',
      taostatsAdminApiKey: 'admin-secret',
      pollIntervalMinutes: 60,
    },
    onPollIntervalChange: async (minutes) => {
      observedMinutes = minutes;
      setSetting(db, 'poll_interval_minutes', minutes);
      return {
        pollIntervalMinutes: minutes,
        nextPollAtIso: new Date(Date.now() + minutes * 60 * 1000).toISOString(),
      };
    },
  });

  const server = await app.start(0);
  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}/api/settings/poll-interval`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-admin-api-key': 'admin-secret' },
    body: JSON.stringify({ minutes: 120 }),
  });
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.pollIntervalMinutes, 120);
  assert.equal(typeof payload.nextPollAtIso, 'string');
  assert.equal(observedMinutes, 120);
  assert.equal(getSetting(db, 'poll_interval_minutes'), '120');
  await app.close();
  db.close();
});

test('admin routes reject missing admin api key when configured', async () => {
  const db = openDatabase(':memory:');
  const app = createDashboardServer({
    db,
    ingestService: {
      ingestOnce: async () => ({ ok: true }),
      backfillHistoricalSnapshots: async () => ({ ok: true }),
    },
    config: {
      netuid: 110,
      taostatsAuthHeader: '',
      taostatsAdminApiKey: 'admin-secret',
      pollIntervalMinutes: 60,
    },
    onPollIntervalChange: async (minutes) => ({
      pollIntervalMinutes: minutes,
      nextPollAtIso: new Date(Date.now() + minutes * 60 * 1000).toISOString(),
    }),
  });

  const server = await app.start(0);
  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}/api/settings/poll-interval`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ minutes: 120 }),
  });
  const payload = await response.json();
  assert.equal(response.status, 403);
  assert.equal(payload.error, 'Admin API key required.');
  await app.close();
  db.close();
});

test('admin backfill endpoint runs backfill and live ingest', async () => {
  const db = openDatabase(':memory:');
  let backfillArgs = null;
  let liveArgs = null;
  const app = createDashboardServer({
    db,
    ingestService: {
      backfillHistoricalSnapshots: async (args) => {
        backfillArgs = args;
        return { ok: true, inserted: 2, flowInserted: 3, priceInserted: 4 };
      },
      ingestOnce: async (args) => {
        liveArgs = args;
        return { ok: true, source: 'api' };
      },
    },
    config: {
      netuid: 110,
      taostatsAuthHeader: '',
      taostatsAdminApiKey: 'admin-secret',
      pollIntervalMinutes: 60,
      taostatsBackfillDays: 30,
      taostatsBackfillFrequency: 'by_hour',
      taostatsBackfillOverwrite: true,
    },
  });

  const server = await app.start(0);
  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}/api/subnets/110/backfill`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-admin-api-key': 'admin-secret' },
    body: JSON.stringify({ days: 60, frequency: 'by_day', overwrite: false }),
  });
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(backfillArgs, { netuid: 110, days: 60, frequency: 'by_day', overwrite: false });
  assert.deepEqual(liveArgs, { netuid: 110 });
  assert.equal(payload.backfill.ok, true);
  assert.equal(payload.live.ok, true);
  await app.close();
  db.close();
});

test('admin backfill endpoint surfaces detailed failures', async () => {
  const db = openDatabase(':memory:');
  const app = createDashboardServer({
    db,
    ingestService: {
      backfillHistoricalSnapshots: async () => ({
        ok: false,
        error: 'Taostats account latest returned 401 Unauthorized',
        detail: {
          walletErrors: [
            {
              name: 'Treasury',
              ss58: '5WalletAlpha123456789ABCDEFGH',
              error: '401 Unauthorized',
            },
          ],
        },
      }),
      ingestOnce: async () => ({ ok: true, source: 'api' }),
    },
    config: {
      netuid: 110,
      taostatsAuthHeader: '',
      taostatsAdminApiKey: 'admin-secret',
      pollIntervalMinutes: 60,
    },
  });

  const server = await app.start(0);
  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}/api/subnets/110/backfill`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-admin-api-key': 'admin-secret' },
    body: JSON.stringify({ days: 30, frequency: 'by_hour', overwrite: true }),
  });
  const payload = await response.json();
  assert.equal(response.status, 500);
  assert.equal(typeof payload.error, 'string');
  assert.equal(payload.error.includes('401 Unauthorized'), true);
  assert.equal(payload.error.includes('Treasury'), true);
  await app.close();
  db.close();
});

test('percent metrics render with enough precision for small values', () => {
  const db = openDatabase(':memory:');
  const snapshot = normalizeSnapshot({
    netuid: 110,
    block_number: 1,
    timestamp: '2026-04-30T00:00:00Z',
    name: 'Green Compute',
    symbol: 'Ѐ',
    price: '1.0',
    market_cap: '100',
    liquidity: '50',
    emission: '2850744',
    projected_emission: '0.1',
    incentive_burn: '0.0042',
    recycled_24_hours: '500000',
    neuron_registration_cost: '500000',
    active_keys: 256,
    max_neurons: 256,
    net_flow_1_day: '20',
    net_flow_7_days: '30',
    net_flow_30_days: '40',
    root_prop: '0.28069856591017118363',
    root_sell: 'YES',
  }, { source: 'scrape', sourceUrl: 'https://example.invalid', netuid: 110 });
  insertSnapshot(db, snapshot);
  insertTaoPriceSnapshot(db, normalizeTaoPriceSnapshot({
    created_at: '2026-04-30T00:00:00Z',
    last_updated: '2026-04-30T00:00:00Z',
    symbol: 'TAO',
    price: '100.0',
    volume_24h: '1000',
    market_cap: '2000',
  }, { source: 'api', sourceUrl: 'https://example.invalid', capturedAt: '2026-04-30T00:00:00.000Z' }));

  const model = buildPageModel({ db, config: { taostatsAuthHeader: '', pollIntervalMinutes: 15 }, netuid: 110 });
  const html = renderPage(model);
  assert.equal(html.includes('0.570%'), true);
  assert.equal(html.includes('0.004%'), true);
  assert.equal(html.includes('28.07%'), true);
  db.close();
});

test('formatChartDate includes time for one-day charts', () => {
  const label = formatChartDate('2026-04-30T15:14:29.000Z', 1);
  assert.match(label, /^\d{1,2} [A-Za-z]{3} \d{2}:\d{2}$/);
  assert.equal(label.includes(':'), true);
});

test('numericMetricValue keeps missing values as null instead of zero', () => {
  assert.equal(numericMetricValue(null), null);
  assert.equal(numericMetricValue(undefined), null);
  assert.equal(numericMetricValue(''), null);
  assert.equal(numericMetricValue('0'), 0);
  assert.equal(numericMetricValue(12.5), 12.5);
});

test('rendered history table keeps missing tao values as gaps instead of zero', () => {
  const db = openDatabase(':memory:');
  const snapshot = normalizeSnapshot({
    netuid: 110,
    block_number: 1,
    timestamp: '2026-04-30T00:00:00Z',
    name: 'Green Compute',
    symbol: 'Ѐ',
    price: null,
    market_cap: null,
    liquidity: null,
    emission: '2800000',
    projected_emission: '0.1',
    incentive_burn: '0',
    recycled_24_hours: null,
    neuron_registration_cost: null,
    active_keys: 256,
    max_neurons: 256,
    net_flow_1_day: null,
    net_flow_7_days: null,
    net_flow_30_days: null,
    root_prop: '0.25',
    root_sell: 'YES',
  }, { source: 'scrape', sourceUrl: 'https://example.invalid', netuid: 110 });
  insertSnapshot(db, snapshot);
  const model = buildPageModel({ db, config: { taostatsAuthHeader: '', pollIntervalMinutes: 15 }, netuid: 110 });
  const html = renderPage(model);
  assert.equal(html.includes('τ 0</td>'), false);
  db.close();
});

test('loadConfig reads environment values from a local .env file', () => {
  const cwd = process.cwd();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sn110-env-'));
  const envPath = path.join(tempDir, '.env');
  fs.writeFileSync(envPath, [
    'PORT=4567',
    'TAOSTATS_NETUID=110',
    'TAOSTATS_API_KEY=test-api-key',
    'TAOSTATS_ADMIN_API_KEY=test-admin-key',
    'POLL_INTERVAL_MINUTES=120',
    'TAOSTATS_PUBLIC_BASE_URL=https://example.invalid',
    'TAOSTATS_BACKFILL_DAYS=14',
    'TAOSTATS_BACKFILL_FREQUENCY=by_day',
    'TAOSTATS_BACKFILL_ON_STARTUP=true',
    'TAOSTATS_BACKFILL_OVERWRITE=true',
    'TAOSTATS_WALLET_1_NAME=Treasury',
    'TAOSTATS_WALLET_1_COLDKEY=5WalletAlpha123456789ABCDEFGH',
    'TAOSTATS_WALLET_1_SS58=5WalletAlpha123456789ABCDEFGH',
    'TAOSTATS_WALLET_1_NETWORK=finney',
    'TAOSTATS_WALLET_1_HOTKEY_1_NAME=SN110 Miner',
    'TAOSTATS_WALLET_1_HOTKEY_1_SS58=5HotkeyAlpha123456789ABCDEFGH',
    'TAOSTATS_WALLET_1_HOTKEY_1_NETUID=110',
    'TAOSTATS_WALLET_2_NAME=Ops',
    'TAOSTATS_WALLET_2_COLDKEY=5WalletBeta123456789ABCDEFGH',
  ].join('\n'));

  const envKeys = ['PORT', 'TAOSTATS_NETUID', 'TAOSTATS_API_KEY', 'TAOSTATS_ADMIN_API_KEY', 'TAOSTATS_AUTH_HEADER', 'POLL_INTERVAL_MINUTES', 'TAOSTATS_PUBLIC_BASE_URL', 'TAOSTATS_BACKFILL_DAYS', 'TAOSTATS_BACKFILL_FREQUENCY', 'TAOSTATS_BACKFILL_ON_STARTUP', 'TAOSTATS_BACKFILL_OVERWRITE', 'TAOSTATS_WALLET_1_NAME', 'TAOSTATS_WALLET_1_COLDKEY', 'TAOSTATS_WALLET_1_SS58', 'TAOSTATS_WALLET_1_NETWORK', 'TAOSTATS_WALLET_1_HOTKEY_1_NAME', 'TAOSTATS_WALLET_1_HOTKEY_1_SS58', 'TAOSTATS_WALLET_1_HOTKEY_1_NETUID', 'TAOSTATS_WALLET_2_NAME', 'TAOSTATS_WALLET_2_COLDKEY', 'TAOSTATS_WALLET_2_SS58'];
  const backup = Object.fromEntries(envKeys.map((key) => [key, Object.prototype.hasOwnProperty.call(process.env, key) ? process.env[key] : undefined]));

  try {
    for (const key of envKeys) {
      delete process.env[key];
    }
    process.chdir(tempDir);

    const config = loadConfig();
    assert.equal(config.port, 4567);
    assert.equal(config.netuid, 110);
    assert.equal(config.taostatsApiKey, 'test-api-key');
    assert.equal(config.taostatsAdminApiKey, 'test-admin-key');
    assert.equal(config.taostatsAuthHeader, 'test-api-key');
    assert.equal(config.pollIntervalMinutes, 120);
    assert.equal(config.taostatsPublicBaseUrl, 'https://example.invalid');
    assert.equal(config.taostatsBackfillDays, 14);
    assert.equal(config.taostatsBackfillFrequency, 'by_day');
    assert.equal(config.taostatsBackfillOnStartup, true);
    assert.equal(config.taostatsBackfillOverwrite, true);
    assert.equal(config.wallets.length, 2);
    assert.equal(config.wallets[0].name, 'Treasury');
    assert.equal(config.wallets[0].coldkey, '5WalletAlpha123456789ABCDEFGH');
    assert.equal(config.wallets[0].ss58, '5WalletAlpha123456789ABCDEFGH');
    assert.equal(config.wallets[0].hotkeys.length, 1);
    assert.equal(config.wallets[0].hotkeys[0].name, 'SN110 Miner');
    assert.equal(config.wallets[0].hotkeys[0].ss58, '5HotkeyAlpha123456789ABCDEFGH');
    assert.equal(config.wallets[0].hotkeys[0].netuid, 110);
    assert.equal(config.wallets[1].name, 'Ops');
    assert.equal(config.wallets[1].coldkey, '5WalletBeta123456789ABCDEFGH');
  } finally {
    process.chdir(cwd);
    for (const [key, value] of Object.entries(backup)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});

test('deleteSnapshotsInRange removes overlapping historical rows', () => {
  const db = openDatabase(':memory:');
  const base = normalizeSnapshot({
    netuid: 110,
    block_number: 1,
    timestamp: '2026-04-29T00:00:00Z',
    price: '1.0',
    market_cap: '100',
    liquidity: '50',
    emission: '10',
    projected_emission: '0.1',
    root_sell: 'NO',
  }, { source: 'scrape', sourceUrl: 'https://example.invalid', netuid: 110 });
  base.captured_at = '2026-04-29T00:00:00.000Z';
  insertSnapshot(db, base);

  const overlapping = normalizeSnapshot({
    netuid: 110,
    block_number: 2,
    timestamp: '2026-04-30T00:00:00Z',
    price: '2.0',
    market_cap: '200',
    liquidity: '60',
    emission: '11',
    projected_emission: '0.2',
    root_sell: 'YES',
  }, { source: 'scrape', sourceUrl: 'https://example.invalid', netuid: 110 });
  overlapping.captured_at = '2026-04-30T00:00:00.000Z';
  insertSnapshot(db, overlapping);

  const deleted = deleteSnapshotsInRange(db, 110, '2026-04-29T12:00:00.000Z', '2026-04-30T12:00:00.000Z');
  assert.equal(deleted, 1);
  assert.equal(getRecentSnapshots(db, 110, 10).length, 1);
  db.close();
});

test('openDatabase migrates legacy snapshots tables missing newer columns', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sn110-legacy-db-'));
  const dbPath = path.join(tempDir, 'legacy.sqlite');
  const legacyDb = new DatabaseSync(dbPath);
  legacyDb.exec(`
    CREATE TABLE snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      netuid INTEGER NOT NULL,
      captured_at TEXT NOT NULL,
      source TEXT NOT NULL,
      raw_json TEXT NOT NULL
    );
  `);
  legacyDb.close();

  const db = openDatabase(dbPath);
  const columns = db.prepare('PRAGMA table_info(snapshots)').all().map((row) => row.name);
  assert.equal(columns.includes('total_tao_num'), true);
  assert.equal(columns.includes('market_cap_change_1_day_text'), true);
  assert.equal(columns.includes('raw_json'), true);

  const snapshot = normalizeSnapshot({
    netuid: 110,
    block_number: 1234,
    timestamp: '2026-04-30T09:03:00Z',
    name: 'Green Compute',
    symbol: 'Ѐ',
    price: '0.005709859',
    market_cap: '10094190385726.221994149',
    liquidity: '7326003373188',
    total_tao: '3738214651815',
    root_prop: '0.28069856591017118363',
    emission: '2854905',
    projected_emission: '0.00727172634236777466',
    recycled_24_hours: '500000',
    neuron_registration_cost: '500000',
    active_keys: 256,
    max_neurons: 256,
    net_flow_1_day: '54106208057',
    net_flow_7_days: '-324821553991',
    net_flow_30_days: '567680736182',
    root_sell: 'YES',
  }, { source: 'scrape', sourceUrl: 'https://taostats.io/subnets/110', netuid: 110 });
  snapshot.captured_at = '2026-04-30T09:03:00.000Z';
  const inserted = insertSnapshot(db, snapshot);
  assert.equal(Number.isFinite(inserted), true);

  db.close();
});
