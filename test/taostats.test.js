'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const {
  extractEscapedJsonObject,
  normalizeSnapshot,
  normalizeTaoPriceSnapshot,
  normalizeTaoFlowSnapshot,
  normalizeAccountSnapshot,
  normalizeStakeBalanceSnapshot,
  pickRecord,
  countAlphaHolders,
  extractSubnetHoldersCountFromHtml,
  createRateLimiter,
  fetchStakeBalanceLatest,
} = require('../src/taostats');
const {
  estimatePoolGrowth,
  buildPoolGrowthEstimatorState,
  buildPoolGrowthScenarioSeries,
} = require('../src/pool-estimator');
const {
  openDatabase,
  insertSnapshot,
  insertTaoPriceSnapshot,
  insertTaoFlowSnapshot,
  insertWalletSnapshot,
  insertWalletStakePosition,
  insertWalletTransaction,
  insertAlphaHolderSnapshot,
  getLatestSnapshot,
  getRecentSnapshots,
  getHistory,
  getLatestTaoPrice,
  getTaoPriceHistory,
  getTaoFlowHistory,
  getLatestWalletSnapshot,
  getLatestWalletStakePositions,
  getLatestAlphaHolderSnapshots,
  getLatestAlphaHolderCount,
  getAlphaHolderSnapshotLatestCapturedAt,
  getAlphaHolderSnapshotHistory,
  getAlphaHolderSnapshotCounts,
  countAlphaHolderSnapshots,
  getWalletHistory,
  getWalletTransactions,
  countWalletTransactions,
  deleteSnapshotsInRange,
  deleteWalletStakePositions,
  getSetting,
  setSetting,
} = require('../src/db');
const {
  buildWalletTransactionDbRecord,
  buildWalletTransactionTimelineFromRows,
} = require('../src/wallet-activity');
const { createIngestService } = require('../src/ingest');
const {
  buildPageModel,
  buildWalletAttributionSummary,
  renderPage,
  numericMetricValue,
  createDashboardServer,
  formatChartDate,
} = require('../src/server');
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

test('sqlite persistence stores and retrieves alpha holder snapshots', () => {
  const db = openDatabase(':memory:');
  const latest = normalizeStakeBalanceSnapshot({
    block_number: 8161001,
    timestamp: '2026-05-01T00:00:00Z',
    netuid: 110,
    subnet_rank: 1,
    subnet_total_holders: 2,
    balance: '2000000000',
    balance_as_tao: '1000000000',
    coldkey: { ss58: '5AlphaHolderOne', hex: '0xholder1' },
    hotkey: { ss58: '5ValOne', hex: '0xval1' },
    hotkey_name: 'Validator One',
  }, { source: 'api', sourceUrl: 'https://example.invalid', capturedAt: '2026-05-01T00:00:00.000Z' });
  const latestDuplicate = normalizeStakeBalanceSnapshot({
    block_number: 8161001,
    timestamp: '2026-05-01T00:00:00Z',
    netuid: 110,
    subnet_rank: 1,
    subnet_total_holders: 2,
    balance: '500000000',
    balance_as_tao: '250000000',
    coldkey: { ss58: '5AlphaHolderOne', hex: '0xholder1' },
    hotkey: { ss58: '5ValThree', hex: '0xval3' },
    hotkey_name: 'Validator Three',
  }, { source: 'api', sourceUrl: 'https://example.invalid', capturedAt: '2026-05-01T00:00:00.000Z' });
  const older = normalizeStakeBalanceSnapshot({
    block_number: 8160001,
    timestamp: '2026-04-30T00:00:00Z',
    netuid: 110,
    subnet_rank: 2,
    subnet_total_holders: 2,
    balance: '1000000000',
    balance_as_tao: '500000000',
    coldkey: { ss58: '5AlphaHolderTwo', hex: '0xholder2' },
    hotkey: { ss58: '5ValTwo', hex: '0xval2' },
    hotkey_name: 'Validator Two',
  }, { source: 'api', sourceUrl: 'https://example.invalid', capturedAt: '2026-04-30T00:00:00.000Z' });

  insertAlphaHolderSnapshot(db, older);
  insertAlphaHolderSnapshot(db, latest);
  insertAlphaHolderSnapshot(db, latestDuplicate);

  const rows = getLatestAlphaHolderSnapshots(db, 110);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].coldkey_ss58, '5AlphaHolderOne');
  assert.equal(rows[1].coldkey_ss58, '5AlphaHolderOne');
  assert.equal(getLatestAlphaHolderCount(db, 110), 2);
  assert.equal(getAlphaHolderSnapshotLatestCapturedAt(db, 110), '2026-05-01T00:00:00.000Z');
  assert.deepEqual(getAlphaHolderSnapshotHistory(db, 110, '2026-04-29T00:00:00.000Z').map((row) => ({
    captured_at: row.captured_at,
    alpha_holders_num: row.alpha_holders_num,
  })), [
    { captured_at: '2026-04-30T00:00:00.000Z', alpha_holders_num: 1 },
    { captured_at: '2026-05-01T00:00:00.000Z', alpha_holders_num: 2 },
  ]);
  assert.deepEqual(getAlphaHolderSnapshotCounts(db, 110, '2026-04-29T00:00:00.000Z').map((row) => ({
    captured_at: row.captured_at,
    alpha_holders_num: row.alpha_holders_num,
  })), [
    { captured_at: '2026-04-30T00:00:00.000Z', alpha_holders_num: 1 },
    { captured_at: '2026-05-01T00:00:00.000Z', alpha_holders_num: 2 },
  ]);
  assert.equal(countAlphaHolderSnapshots(db, 110), 3);

  db.close();
});

test('buildPageModel ranks subnets by the latest local alpha-holder counts', () => {
  const db = openDatabase(':memory:');
  insertSnapshot(db, normalizeSnapshot({
    netuid: 110,
    block_number: 9001,
    timestamp: '2026-05-01T00:00:00Z',
    price: '1.0',
    market_cap: '100',
    liquidity: '50',
    emission: '10',
    projected_emission: '0.1',
    recycled_24_hours: '500000',
    neuron_registration_cost: '500000',
    active_keys: 256,
    max_neurons: 256,
    root_sell: 'NO',
  }, { source: 'scrape', sourceUrl: 'https://example.invalid', netuid: 110 }));

  const captures = [
    { netuid: 110, count: 2 },
    { netuid: 111, count: 5 },
    { netuid: 112, count: 3 },
  ];
  for (const { netuid, count } of captures) {
    for (let index = 0; index < count; index += 1) {
      insertAlphaHolderSnapshot(db, normalizeStakeBalanceSnapshot({
        block_number: 9100000 + netuid,
        timestamp: '2026-05-01T00:00:00Z',
        netuid,
        subnet_rank: index + 1,
        subnet_total_holders: 10,
        balance: String(1_000_000_000 - index),
        balance_as_tao: String(500_000_000 - index),
        coldkey: { ss58: `5Alpha${netuid}${index}`, hex: `0x${netuid}${index}` },
        hotkey: { ss58: `5Val${netuid}${index}`, hex: `0xval${netuid}${index}` },
        hotkey_name: `Validator ${netuid}-${index}`,
      }, { source: 'api', sourceUrl: 'https://example.invalid', capturedAt: '2026-05-01T00:00:00.000Z' }));
    }
  }

  const model = buildPageModel({
    db,
    config: {
      taostatsAuthHeader: '',
      taostatsAdminApiKey: '',
      pollIntervalMinutes: 60,
      wallets: [],
    },
    netuid: 110,
  });

  assert.equal(model.alphaHolderRankingRows.length, 3);
  assert.deepEqual(model.alphaHolderRankingRows.map((row) => row.netuid), [111, 112, 110]);
  assert.deepEqual(model.alphaHolderRankingRows.map((row) => row.rank_num), [1, 2, 3]);
  assert.equal(model.alphaHolderCurrentRankRow?.rank_num, 3);
  assert.equal(model.alphaHolderCurrentRankRow?.alpha_holders_num, 2);
  db.close();
});

test('sqlite persistence stores and retrieves wallet transactions', () => {
  const db = openDatabase(':memory:');
  const walletConfig = { name: 'Alpha Treasury', ss58: '5WalletAlpha123456789ABCDEFGH', network: 'finney', hotkeys: [] };
  insertWalletTransaction(db, buildWalletTransactionDbRecord({
    walletConfig,
    source: 'api-history',
    sourceUrl: 'https://example.invalid',
    row: {
      source_type: 'transfer',
      timestamp: '2026-04-30T00:00:00Z',
      block_number: 123,
      extrinsic_id: '0xaaa',
      transaction_hash: '0xbbb',
      action: 'Transfer',
      action_key: 'transfer',
      amount_tao: 1.25,
      from_ss58: '5WalletAlpha123456789ABCDEFGH',
      to_ss58: '5OtherWallet',
      status: 'success',
      note: 'Coldkey transfer',
      raw: { transfer: true },
    },
  }));

  const rows = getWalletTransactions(db, '5WalletAlpha123456789ABCDEFGH');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].action, 'Transfer');
  assert.equal(rows[0].dedupe_key.includes('transfer:'), true);
  assert.equal(rows[0].raw_json.includes('transfer'), true);

  const timeline = buildWalletTransactionTimelineFromRows({
    address: '5WalletAlpha123456789ABCDEFGH',
    walletConfig,
    rows,
    days: 7,
  });
  assert.equal(timeline.available, true);
  assert.equal(timeline.rows[0].timestamp, '2026-04-30T00:00:00Z');
  assert.equal(timeline.rows[0].raw.transfer, true);

  db.close();
});

test('wallet activity sync deduplicates overlapping backfill windows', async () => {
  const db = openDatabase(':memory:');
  const taostats = {
    fetchExtrinsicsHistory: async () => ([
      {
        id: 'extrinsic-1',
        block_number: 100,
        timestamp: '2026-04-30T00:00:00Z',
        full_name: 'transfer_stake',
        call_args: {
          netuid: 110,
          hotkey: { ss58: '5HotkeyOne' },
          amount: '1000000000',
        },
        hash: '0xabc',
        success: true,
      },
    ]),
    fetchTransferHistory: async () => ([
      {
        transaction_hash: '0xdef',
        timestamp: '2026-04-30T01:00:00Z',
        block_number: 101,
        from: { ss58: '5WalletAlpha123456789ABCDEFGH' },
        to: { ss58: '5OtherWallet' },
        amount: '2000000000',
      },
    ]),
    fetchHistoricalStakeBalance: async ({ hotkey }) => ([
      {
        captured_at: '2026-04-29T00:00:00Z',
        balance_as_tao_num: 10,
        hotkey_address_ss58: hotkey,
      },
      {
        captured_at: '2026-04-30T00:00:00Z',
        balance_as_tao_num: 12,
        hotkey_address_ss58: hotkey,
      },
    ]),
  };

  const config = {
    netuid: 110,
    taostatsBaseUrl: 'https://example.invalid',
    taostatsAuthHeader: 'secret',
    taostatsRateLimiter: null,
    wallets: [{
      name: 'Alpha Treasury',
      ss58: '5WalletAlpha123456789ABCDEFGH',
      coldkey: '5WalletAlpha123456789ABCDEFGH',
      network: 'finney',
      hotkeys: [{ name: 'Miner One', ss58: '5HotkeyOne', netuid: 110, network: 'finney', role: 'validator' }],
    }],
    walletActivitySyncDays: 7,
    walletActivityBackfillDays: 60,
  };
  const service = createIngestService({ db, config, taostats });

  const backfill = await service.backfillWalletActivity({ days: 60 });
  assert.equal(backfill.ok, true);
  assert.equal(countWalletTransactions(db, '5WalletAlpha123456789ABCDEFGH'), 3);

  const sync = await service.syncWalletActivity({ days: 7 });
  assert.equal(sync.ok, true);
  assert.equal(countWalletTransactions(db, '5WalletAlpha123456789ABCDEFGH'), 3);

  const rows = getWalletTransactions(db, '5WalletAlpha123456789ABCDEFGH');
  assert.equal(rows.length, 3);
  assert.equal(new Set(rows.map((row) => row.dedupe_key)).size, 3);

  db.close();
});

test('alpha holder snapshot job stores one daily capture and skips same-day duplicates', async () => {
  const db = openDatabase(':memory:');
  const holderRows = [
    normalizeStakeBalanceSnapshot({
      block_number: 200,
      timestamp: '2026-05-11T00:00:00.000Z',
      netuid: 110,
      subnet_rank: 1,
      subnet_total_holders: 2,
      balance: '1000000000',
      balance_as_tao: '1000000000',
      coldkey: { ss58: '5AlphaHolderOne', hex: '0xholder1' },
      hotkey: { ss58: '5ValOne', hex: '0xval1' },
      hotkey_name: 'Validator One',
    }, { source: 'api', sourceUrl: 'https://example.invalid', capturedAt: '2026-05-11T00:00:00.000Z' }),
    normalizeStakeBalanceSnapshot({
      block_number: 200,
      timestamp: '2026-05-11T00:00:00.000Z',
      netuid: 110,
      subnet_rank: 1,
      subnet_total_holders: 2,
      balance: '2000000000',
      balance_as_tao: '2000000000',
      coldkey: { ss58: '5AlphaHolderTwo', hex: '0xholder2' },
      hotkey: { ss58: '5ValTwo', hex: '0xval2' },
      hotkey_name: 'Validator Two',
    }, { source: 'api', sourceUrl: 'https://example.invalid', capturedAt: '2026-05-11T00:00:00.000Z' }),
  ];
  const taostats = {
    fetchStakeBalanceLatest: async () => holderRows,
  };
  const config = {
    netuid: 110,
    taostatsBaseUrl: 'https://example.invalid',
    taostatsAuthHeader: 'secret',
    taostatsRateLimiter: null,
  };
  const service = createIngestService({ db, config, taostats });

  const first = await service.syncAlphaHolderSnapshot({
    netuid: 110,
    capturedAt: '2026-05-11T00:00:00.000Z',
  });
  const second = await service.syncAlphaHolderSnapshot({
    netuid: 110,
    capturedAt: '2026-05-11T12:00:00.000Z',
  });

  assert.equal(first.ok, true);
  assert.equal(first.inserted, 2);
  assert.equal(second.skipped, true);
  assert.equal(countAlphaHolderSnapshots(db, 110), 2);
  assert.equal(getLatestAlphaHolderCount(db, 110), 2);

  db.close();
});

test('alpha holder backfill reports CLI-friendly progress updates with eta fields', async () => {
  const db = openDatabase(':memory:');
  const makeStakeRows = (netuid, capturedAt) => [normalizeStakeBalanceSnapshot({
    block_number: 300 + netuid,
    timestamp: capturedAt,
    netuid,
    subnet_rank: 1,
    subnet_total_holders: 2,
    balance: '1000000000',
    balance_as_tao: '1000000000',
    coldkey: { ss58: `5AlphaHolder${netuid}`, hex: `0xholder${netuid}` },
    hotkey: { ss58: `5Val${netuid}`, hex: `0xval${netuid}` },
    hotkey_name: `Validator ${netuid}`,
  }, { source: 'api', sourceUrl: 'https://example.invalid', capturedAt })];
  const capturedAt = '2026-05-11T00:00:00.000Z';
  const taostats = {
    fetchSubnetLatestCatalog: async () => [{ netuid: 110 }, { netuid: 111 }],
    fetchStakeBalanceLatest: async ({ netuid, capturedAt: rowCapturedAt }) => makeStakeRows(netuid, rowCapturedAt),
    fetchHistoricalStakeBalance: async ({ netuid }) => makeStakeRows(netuid, capturedAt),
  };
  const config = {
    netuid: 110,
    taostatsBaseUrl: 'https://example.invalid',
    taostatsAuthHeader: 'secret',
    taostatsRateLimiter: null,
  };
  const service = createIngestService({ db, config, taostats });

  const syncEvents = [];
  const syncResult = await service.backfillAlphaHolderSnapshots({
    capturedAt,
    onProgress: (event) => syncEvents.push(event),
  });
  const historyEvents = [];
  const historyResult = await service.backfillAlphaHolderHistory({
    days: 7,
    onProgress: (event) => historyEvents.push(event),
  });

  assert.equal(syncResult.ok, true);
  assert.equal(historyResult.ok, true);
  assert.equal(syncEvents[0].phase, 'start');
  assert.equal(syncEvents.at(-1).phase, 'done');
  assert.equal(historyEvents[0].phase, 'start');
  assert.equal(historyEvents.at(-1).phase, 'done');
  assert.equal(syncEvents.some((event) => event.phase === 'item' && event.total === 2), true);
  assert.equal(historyEvents.some((event) => event.phase === 'item' && event.total === 2), true);
  assert.equal(syncEvents.some((event) => Object.prototype.hasOwnProperty.call(event, 'etaIso')), true);
  assert.equal(historyEvents.some((event) => Object.prototype.hasOwnProperty.call(event, 'etaIso')), true);
  assert.equal(syncEvents.some((event) => event.workerId === 1), true);

  db.close();
});

test('alpha holder backfill runs up to three subnet workers in parallel', async () => {
  const db = openDatabase(':memory:');
  const capturedAt = '2026-05-11T00:00:00.000Z';
  const active = new Set();
  let maxActive = 0;
  const progress = [];
  const taostats = {
    fetchSubnetLatestCatalog: async () => [{ netuid: 110 }, { netuid: 111 }, { netuid: 112 }],
    fetchStakeBalanceLatest: async ({ netuid, capturedAt: rowCapturedAt, workerId }) => {
      active.add(netuid);
      maxActive = Math.max(maxActive, active.size);
      assert.equal(workerId >= 1 && workerId <= 3, true);
      await new Promise((resolve) => setTimeout(resolve, 25));
      active.delete(netuid);
      return [normalizeStakeBalanceSnapshot({
        block_number: 500 + netuid,
        timestamp: rowCapturedAt,
        netuid,
        subnet_rank: 1,
        subnet_total_holders: 1,
        balance: '1000000000',
        balance_as_tao: '1000000000',
        coldkey: { ss58: `5AlphaHolder${netuid}`, hex: `0xholder${netuid}` },
        hotkey: { ss58: `5Val${netuid}`, hex: `0xval${netuid}` },
        hotkey_name: `Validator ${netuid}`,
      }, { source: 'api', sourceUrl: 'https://example.invalid', capturedAt: rowCapturedAt })];
    },
  };
  const config = {
    netuid: 110,
    taostatsBaseUrl: 'https://example.invalid',
    taostatsAuthHeader: 'secret',
    taostatsRateLimiter: null,
  };
  const service = createIngestService({ db, config, taostats });

  const result = await service.backfillAlphaHolderSnapshots({
    capturedAt,
    onProgress: (event) => progress.push(event),
  });

  assert.equal(result.ok, true);
  assert.equal(result.netuids, 3);
  assert.equal(maxActive, 3);
  assert.equal(progress.some((event) => event.phase === 'item-start' && event.workerId === 1), true);
  assert.equal(progress.some((event) => event.phase === 'item-start' && event.workerId === 2), true);
  assert.equal(progress.some((event) => event.phase === 'item-start' && event.workerId === 3), true);
  db.close();
});

test('stake-balance latest fetch emits page-level progress updates', async () => {
  const originalFetch = global.fetch;
  const calls = [];
  const progress = [];
  global.fetch = async (url) => {
    calls.push(String(url));
    const page = Number(new URL(url).searchParams.get('page'));
    const rows = page === 1
      ? Array.from({ length: 200 }, (_, index) => ({
        block_number: 501 + index,
        netuid: 110,
        subnet_rank: index + 1,
        subnet_total_holders: 200,
        balance: String(1000000000 - index),
        balance_as_tao: String(1000000000 - index),
        coldkey: { ss58: `5AlphaHolder${index + 1}`, hex: `0xholder${index + 1}` },
        hotkey: { ss58: `5Val${index + 1}`, hex: `0xval${index + 1}` },
        hotkey_name: `Validator ${index + 1}`,
      }))
      : [];
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(rows),
    };
  };

  try {
    const rows = await fetchStakeBalanceLatest({
      netuid: 110,
      taostatsBaseUrl: 'https://example.invalid',
      taostatsAuthHeader: 'secret',
      limit: 1024,
      onProgress: (event) => progress.push(event),
    });

    assert.equal(rows.length, 200);
    assert.equal(calls.length, 2);
    assert.equal(Number(new URL(calls[0]).searchParams.get('limit')), 200);
    assert.equal(progress.filter((event) => event.phase === 'page-start').length, 2);
    assert.equal(progress.filter((event) => event.phase === 'page').length, 2);
    assert.equal(progress.some((event) => event.phase === 'page-start' && event.page === 1), true);
    assert.equal(progress.some((event) => event.phase === 'page' && event.page === 1 && event.pageRows === 200), true);
    assert.equal(progress.some((event) => event.phase === 'page' && event.page === 2 && event.pageRows === 0), true);
  } finally {
    global.fetch = originalFetch;
  }
});

test('stake-balance latest fetch retries 429 once and emits wait prompts', async () => {
  const originalFetch = global.fetch;
  const calls = [];
  const progress = [];
  global.fetch = async (url) => {
    calls.push(String(url));
    if (calls.length === 1) {
      return {
        ok: false,
        status: 429,
        text: async () => JSON.stringify({ error: 'rate limited' }),
      };
    }
    const rows = [{
      block_number: 601,
      netuid: 110,
      subnet_rank: 1,
      subnet_total_holders: 1,
      balance: '1000000000',
      balance_as_tao: '1000000000',
      coldkey: { ss58: '5RetryHolder', hex: '0xretry' },
      hotkey: { ss58: '5RetryHotkey', hex: '0xretryhot' },
      hotkey_name: 'Retry Validator',
    }];
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(rows),
    };
  };

  try {
    const rows = await fetchStakeBalanceLatest({
      netuid: 110,
      taostatsBaseUrl: 'https://example.invalid',
      taostatsAuthHeader: 'secret',
      limit: 200,
      retryDelayMs: 0,
      onProgress: (event) => progress.push(event),
    });

    assert.equal(rows.length, 1);
    assert.equal(calls.length, 2);
    assert.equal(progress.some((event) => event.phase === 'retry-wait' && event.page === 1), true);
    assert.equal(progress.some((event) => event.phase === 'retrying' && event.page === 1), true);
    assert.equal(progress.some((event) => event.phase === 'page' && event.page === 1 && event.pageRows === 1), true);
  } finally {
    global.fetch = originalFetch;
  }
});

test('alpha holder snapshot backfill does not depend on stake-balance history', async () => {
  const db = openDatabase(':memory:');
  const capturedAt = '2026-05-11T00:00:00.000Z';
  const latestCalls = [];
  const taostats = {
    fetchSubnetLatestCatalog: async () => [{ netuid: 110 }, { netuid: 111 }],
    fetchStakeBalanceLatest: async ({ netuid, capturedAt: rowCapturedAt, limit }) => {
      latestCalls.push({ netuid, limit });
      return [normalizeStakeBalanceSnapshot({
      block_number: 400 + netuid,
      timestamp: rowCapturedAt,
      netuid,
      subnet_rank: 1,
      subnet_total_holders: 1,
      balance: '1000000000',
      balance_as_tao: '1000000000',
      coldkey: { ss58: `5AlphaHolder${netuid}`, hex: `0xholder${netuid}` },
      hotkey: { ss58: `5Val${netuid}`, hex: `0xval${netuid}` },
      hotkey_name: `Validator ${netuid}`,
    }, { source: 'api', sourceUrl: 'https://example.invalid', capturedAt: rowCapturedAt })];
    },
    fetchHistoricalStakeBalance: async () => {
      throw new Error('history endpoint should not be used for alpha-holder snapshot backfill');
    },
  };
  const config = {
    netuid: 110,
    taostatsBaseUrl: 'https://example.invalid',
    taostatsAuthHeader: 'secret',
    taostatsRateLimiter: null,
  };
  const service = createIngestService({ db, config, taostats });

  const result = await service.backfillAlphaHolderSnapshots({
    capturedAt,
    skipIfAlreadyCapturedToday: false,
  });

  assert.equal(result.ok, true);
  assert.equal(result.fetched, 2);
  assert.equal(result.inserted, 2);
  assert.equal(latestCalls.length, 2);
  assert.equal(latestCalls.every((call) => call.limit === 1024), true);
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

test('countAlphaHolders counts unique coldkeys with positive alpha stake', () => {
  const count = countAlphaHolders([
    { coldkey: { ss58: '5AlphaOne' }, alpha_stake: '10' },
    { coldkey: { ss58: '5AlphaOne' }, total_alpha_stake: '5' },
    { coldkey: { ss58: '5AlphaTwo' }, total_alpha_stake: '0' },
    { coldkey: { ss58: '5AlphaThree' }, total_alpha_stake: '3' },
  ]);
  assert.equal(count, 2);
});

test('extractSubnetHoldersCountFromHtml parses the Taostats holders tab count', () => {
  const embedded = '{"holderCount":1364,"id":110}';
  const rendered = '<p>Transactions</p><p>Holders(1,364)</p><p>Rows</p>';
  assert.equal(extractSubnetHoldersCountFromHtml(embedded, 110), 1364);
  assert.equal(extractSubnetHoldersCountFromHtml(rendered, 110), 1364);
});

test('pool growth estimator resolves pool state and projects AMM changes', () => {
  const state = buildPoolGrowthEstimatorState({
    total_tao_num: 100_000_000_000,
    price_num: 0.1,
    market_cap_num: 2_000_000_000,
    alpha_in_pool_text: '1000',
  });
  assert.equal(state.available, true);
  assert.equal(state.currentPool.taoInPool, 100);
  assert.equal(state.currentPool.alphaInPool, 1000);
  assert.equal(state.currentPool.currentPrice, 0.1);
  assert.equal(state.currentPool.marketCap, 2);

  const zero = estimatePoolGrowth({
    taoInPool: state.currentPool.taoInPool,
    alphaInPool: state.currentPool.alphaInPool,
    marketCap: state.currentPool.marketCap,
    taoInjected: 0,
  });
  assert.equal(zero.available, true);
  assert.equal(zero.alphaReceived, 0);
  assert.equal(zero.projectedPrice, 0.1);
  assert.equal(zero.priceChangePct, 0);
  assert.equal(zero.projectedMarketCap, 2);
  assert.equal(zero.marketCapChangePct, 0);
  assert.equal(zero.taoReserveChangeAbsolute, 0);
  assert.equal(zero.taoReserveChangePct, 0);

  const small = estimatePoolGrowth({
    taoInPool: state.currentPool.taoInPool,
    alphaInPool: state.currentPool.alphaInPool,
    marketCap: state.currentPool.marketCap,
    taoInjected: 10,
  });
  assert.equal(small.available, true);
  assert.ok(Math.abs(small.alphaReceived - 90.9090909091) < 1e-9);
  assert.ok(Math.abs(small.projectedPrice - 0.121) < 1e-12);
  assert.ok(Math.abs(small.priceChangePct - 21) < 1e-9);
  assert.ok(Math.abs(small.projectedMarketCap - 2.42) < 1e-12);
  assert.ok(Math.abs(small.marketCapChangePct - 21) < 1e-9);
  assert.ok(Math.abs(small.taoReserveChangeAbsolute - 10) < 1e-12);
  assert.ok(Math.abs(small.taoReserveChangePct - 10) < 1e-12);

  const large = estimatePoolGrowth({
    taoInPool: state.currentPool.taoInPool,
    alphaInPool: state.currentPool.alphaInPool,
    marketCap: state.currentPool.marketCap,
    taoInjected: 100,
  });
  assert.equal(large.available, true);
  assert.ok(Math.abs(large.alphaReceived - 500) < 1e-9);
  assert.ok(Math.abs(large.projectedPrice - 0.4) < 1e-12);
  assert.ok(Math.abs(large.priceChangePct - 300) < 1e-9);
  assert.ok(Math.abs(large.projectedMarketCap - 8) < 1e-12);
  assert.ok(Math.abs(large.marketCapChangePct - 300) < 1e-9);
  assert.ok(Math.abs(large.taoReserveChangeAbsolute - 100) < 1e-12);
  assert.ok(Math.abs(large.taoReserveChangePct - 100) < 1e-12);

  const missing = buildPoolGrowthEstimatorState({});
  assert.equal(missing.available, false);
  assert.equal(missing.reason.includes('missing'), true);
  const optionalMarketCapMissing = estimatePoolGrowth({
    taoInPool: state.currentPool.taoInPool,
    alphaInPool: state.currentPool.alphaInPool,
    taoInjected: 10,
  });
  assert.equal(optionalMarketCapMissing.available, true);
  assert.equal(optionalMarketCapMissing.projectedMarketCap, null);
  assert.equal(optionalMarketCapMissing.marketCapChangePct, null);
});

test('pool growth scenario series builds a monotonic projected price curve', () => {
  const series = buildPoolGrowthScenarioSeries({
    taoInPool: 100,
    alphaInPool: 1000,
    marketCap: 2,
  }, { maxInjected: 50, pointCount: 5 });
  assert.equal(series.available, true);
  assert.equal(series.points.length, 5);
  assert.equal(series.points[0].taoInjected, 0);
  assert.equal(series.points[0].priceChangePct, 0);
  assert.ok(series.points[4].priceChangePct > series.points[1].priceChangePct);
  assert.ok(series.points[4].projectedPrice > series.points[1].projectedPrice);
});

test('wallet attribution keeps unknown stake in residual when only validator metadata is available', () => {
  const attribution = buildWalletAttributionSummary({
    totalChange: 90,
    stakePositions: [
      { hotkey_address_ss58: '5Validator', balance_as_tao_num: 100 },
      { hotkey_address_ss58: '5Unknown', balance_as_tao_num: 200 },
    ],
    configuredHotkeys: [
      { ss58: '5Validator', role: 'validator' },
    ],
  });

  assert.equal(attribution.hasAnySplit, true);
  assert.equal(attribution.validator !== null, true);
  assert.equal(attribution.owner, null);
  assert.equal(attribution.residual !== null, true);
  assert.ok(Math.abs(attribution.validator - 30) < 1e-9);
  assert.ok(Math.abs(attribution.residual - 60) < 1e-9);
  assert.ok(Math.abs(attribution.recognizedCoveragePct - 33.3333333333) < 1e-6);
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
  snapshot.alpha_holders_num = 39;
  snapshot.alpha_holders_text = '39';
  insertSnapshot(db, snapshot);
  insertAlphaHolderSnapshot(db, normalizeStakeBalanceSnapshot({
    block_number: 8161001,
    timestamp: '2026-04-30T00:00:00Z',
    netuid: 110,
    subnet_rank: 1,
    subnet_total_holders: 39,
    balance: '292569440000000',
    balance_as_tao: '1487790000000',
    coldkey: { ss58: '5EbftbTwkQ9r123456789ABCDEFGH', hex: '0xholder1' },
    hotkey: { ss58: '5GreenComputeValidator1234567', hex: '0xval1' },
    hotkey_name: 'Green Compute',
  }, { source: 'api', sourceUrl: 'https://example.invalid', walletName: null, address: null, capturedAt: '2026-04-30T00:00:00.000Z' }));
  insertAlphaHolderSnapshot(db, normalizeStakeBalanceSnapshot({
    block_number: 8161001,
    timestamp: '2026-04-30T00:00:00Z',
    netuid: 110,
    subnet_rank: 2,
    subnet_total_holders: 39,
    balance: '103363080000000',
    balance_as_tao: '525630000000',
    coldkey: { ss58: '5D7NDUmpNX2n123456789ABCDEFGH', hex: '0xholder2' },
    hotkey: { ss58: '5taobotValidator123456789ABCDE', hex: '0xval2' },
    hotkey_name: 'tao.bot',
  }, { source: 'api', sourceUrl: 'https://example.invalid', walletName: null, address: null, capturedAt: '2026-04-30T00:00:00.000Z' }));
  insertAlphaHolderSnapshot(db, normalizeStakeBalanceSnapshot({
    block_number: 8161001,
    timestamp: '2026-04-30T00:00:00Z',
    netuid: 111,
    subnet_rank: 1,
    subnet_total_holders: 39,
    balance: '492569440000000',
    balance_as_tao: '2487790000000',
    coldkey: { ss58: '5OtherSubnetOne123456789ABCDEFG', hex: '0xholder3' },
    hotkey: { ss58: '5OtherSubnetOneVal123456789ABC', hex: '0xval3' },
    hotkey_name: 'Other Validator One',
  }, { source: 'api', sourceUrl: 'https://example.invalid', walletName: null, address: null, capturedAt: '2026-04-30T00:00:00.000Z' }));
  insertAlphaHolderSnapshot(db, normalizeStakeBalanceSnapshot({
    block_number: 8161001,
    timestamp: '2026-04-30T00:00:00Z',
    netuid: 111,
    subnet_rank: 2,
    subnet_total_holders: 39,
    balance: '392569440000000',
    balance_as_tao: '1487790000000',
    coldkey: { ss58: '5OtherSubnetTwo123456789ABCDEFG', hex: '0xholder4' },
    hotkey: { ss58: '5OtherSubnetTwoVal123456789ABC', hex: '0xval4' },
    hotkey_name: 'Other Validator Two',
  }, { source: 'api', sourceUrl: 'https://example.invalid', walletName: null, address: null, capturedAt: '2026-04-30T00:00:00.000Z' }));
  insertAlphaHolderSnapshot(db, normalizeStakeBalanceSnapshot({
    block_number: 8161001,
    timestamp: '2026-04-30T00:00:00Z',
    netuid: 111,
    subnet_rank: 3,
    subnet_total_holders: 39,
    balance: '292569440000000',
    balance_as_tao: '487790000000',
    coldkey: { ss58: '5OtherSubnetThree123456789ABCDEFG', hex: '0xholder5' },
    hotkey: { ss58: '5OtherSubnetThreeVal123456789ABC', hex: '0xval5' },
    hotkey_name: 'Other Validator Three',
  }, { source: 'api', sourceUrl: 'https://example.invalid', walletName: null, address: null, capturedAt: '2026-04-30T00:00:00.000Z' }));
  insertAlphaHolderSnapshot(db, normalizeStakeBalanceSnapshot({
    block_number: 8161001,
    timestamp: '2026-04-30T00:00:00Z',
    netuid: 112,
    subnet_rank: 1,
    subnet_total_holders: 39,
    balance: '192569440000000',
    balance_as_tao: '987790000000',
    coldkey: { ss58: '5ThirdSubnetOne123456789ABCDEFG', hex: '0xholder6' },
    hotkey: { ss58: '5ThirdSubnetOneVal123456789ABCD', hex: '0xval6' },
    hotkey_name: 'Third Validator One',
  }, { source: 'api', sourceUrl: 'https://example.invalid', walletName: null, address: null, capturedAt: '2026-04-30T00:00:00.000Z' }));
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
      wallets: [{ name: 'Alpha Treasury', ss58: '5WalletAlpha123456789ABCDEFGH', network: 'finney', hotkeys: [{ name: 'Miner One', ss58: '5HotkeyOne', netuid: 111, network: 'finney', role: 'validator' }, { name: 'Owner Key', ss58: '5HotkeyTwo', netuid: 112, network: 'finney', role: 'owner' }] }],
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
  assert.equal(html.includes('data-history-range="30"'), true);
  assert.equal(html.includes('data-history-range="7"'), true);
  assert.equal(html.includes('Wallet balances'), true);
  assert.equal(html.includes('Wallet activity cache'), true);
  assert.equal(html.includes('last synced never'), true);
  assert.equal(html.includes('id="wallet-activity-topbar-status"'), true);
  assert.equal(html.includes('id="wallet-activity-admin-status"'), true);
  assert.equal(html.includes('class="alpha-holder-details"'), true);
  assert.equal(html.includes('Alpha Holders'), true);
  assert.equal(html.includes('Alpha holder addresses'), true);
  assert.equal(html.includes('Alpha-holder ranking across subnets'), true);
  assert.equal(html.includes('SN110 alpha-holder rank'), true);
  assert.equal(html.includes('History starts at'), true);
  assert.equal(html.includes('SN111'), true);
  assert.equal(html.includes('SN112'), true);
  assert.equal(html.includes('5Ebftb…CDEFGH'), true);
  assert.equal(html.includes('Green Compute'), true);
  assert.equal(model.latest.alpha_holders_num, 2);
  assert.equal(model.alphaHolderCurrentRankRow?.rank_num, 2);
  const dom = new JSDOM(html);
  const alphaHolderDetails = dom.window.document.querySelector('.alpha-holder-details');
  assert.equal(alphaHolderDetails?.hasAttribute('open'), false);
  const alphaHoldersButton = [...dom.window.document.querySelectorAll('[data-metric]')].find((element) => {
    try {
      return JSON.parse(element.getAttribute('data-metric') || '{}').label === 'Alpha Holders';
    } catch {
      return false;
    }
  });
  assert.equal(alphaHoldersButton?.tagName, 'BUTTON');
  assert.equal(alphaHoldersButton?.querySelector('.card-value')?.textContent?.trim(), '2');
  const rankButton = [...dom.window.document.querySelectorAll('[data-metric]')].find((element) => {
    try {
      return JSON.parse(element.getAttribute('data-metric') || '{}').label === 'SN110 alpha-holder rank';
    } catch {
      return false;
    }
  });
  assert.equal(rankButton?.tagName, 'BUTTON');
  assert.equal(rankButton?.querySelector('.card-value')?.textContent?.trim(), '2');
  assert.equal(html.includes('id="wallet-activity-topbar-badge"'), true);
  assert.equal(html.includes('id="wallet-activity-admin-badge"'), true);
  assert.equal(html.includes('status-badge status-badge-neutral'), true);
  assert.equal(html.includes('Wallet activity idle'), true);
  assert.equal(html.includes('id="pool-growth-estimator"'), true);
  assert.equal(html.includes('data-pool-growth-root="page"'), true);
  assert.equal(html.includes('Alpha Treasury'), true);
  assert.equal(html.includes('5Walle'), true);
  assert.equal(html.includes('Miner One'), true);
  assert.equal(html.includes('Current subnet stake'), true);
  assert.equal(html.includes('Pool growth estimator'), true);
  assert.equal(html.includes('pool-estimator-layout'), true);
  assert.equal(html.includes('data-pool-scenario-open="false"'), true);
  assert.equal(html.includes('transition: grid-template-columns 0.28s ease'), true);
  assert.equal(html.includes('TAO injected'), true);
  assert.equal(html.includes('Estimated alpha received'), true);
  assert.equal(html.includes('Projected alpha price'), true);
  assert.equal(html.includes('Price change %'), true);
  assert.equal(html.includes('Implied subnet market cap'), true);
  assert.equal(html.includes('Projected TAO in pool'), true);
  assert.equal(html.includes('id="pool-growth-projected-market-cap"'), true);
  assert.equal(html.includes('id="pool-growth-market-cap-change"'), true);
  assert.equal(html.includes('id="pool-growth-projected-tao-reserve"'), true);
  assert.equal(html.includes('id="pool-growth-tao-reserve-change"'), true);
  assert.equal(html.includes('data-pool-scenario-chart="true"'), true);
  assert.equal(html.includes('pool-estimator-scenario-details'), true);
  assert.equal(html.includes('Alpha price change curve'), true);
  assert.equal(html.includes('Projected alpha price change vs TAO injected'), true);
  assert.equal(html.includes('pool-estimator-scenario-meta-row'), true);
  assert.equal(html.includes('pool-estimator-scenario-grid-line'), true);
  assert.equal(html.includes('data-pool-scenario-max-tao-injected="2500"'), true);
  assert.equal(html.includes('TAO 1,250'), true);
  assert.equal(html.includes('TAO 2,500'), true);
  assert.equal(html.includes('pool-estimator-scenario-tooltip'), true);
  assert.equal(html.includes('Show chart'), true);
  assert.equal(html.includes('wallet-transactions-modal'), true);
  assert.equal(html.includes('wallet-transactions-refresh'), true);
  assert.equal(html.includes('wallet-transactions-table-body'), true);
  assert.equal(html.includes('data-wallet-tx-range="7"'), true);
  assert.equal(html.includes('data-wallet-tx-filter="stake"'), true);
  assert.equal(html.includes('data-pool-preset='), true);
  assert.equal(html.includes('Wallet profile'), true);
  assert.equal(html.includes('Created'), true);
  assert.equal(html.includes('Rank'), true);
  assert.equal(html.includes('Configured hotkeys'), true);
  assert.equal(html.includes('Income sources'), true);
  assert.equal(html.includes('Validator'), true);
  assert.equal(html.includes('Owner'), true);
  assert.equal(html.includes('Residual'), true);
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
  assert.equal(html.includes('id="backfill-progress"'), true);
  assert.equal(html.includes('id="wallet-backfill-btn"'), true);
  assert.equal(html.includes('id="wallet-backfill-progress"'), true);
  assert.equal(html.includes('history-modal-wallet-details'), true);
  assert.equal(html.includes('data-history-range="1"'), true);
  assert.equal(html.includes('data-history-range="7" aria-pressed="true"'), true);
  assert.equal(html.includes('7D</button>'), true);
  assert.equal(html.includes('data-history-range="30"'), true);
  assert.equal(html.includes('data-history-range="60"'), true);
  assert.ok(html.indexOf('data-history-range="1"') < html.indexOf('data-history-range="7"'));
  assert.ok(html.indexOf('data-history-range="7"') < html.indexOf('data-history-range="14"'));
  assert.ok(html.indexOf('data-history-range="14"') < html.indexOf('data-history-range="30"'));
  assert.ok(html.indexOf('data-history-range="30"') < html.indexOf('data-history-range="60"'));
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
  assert.equal(html.includes('Fetching wallet activity…'), true);
  assert.equal(html.includes('Wallet activity'), true);
  assert.equal(html.includes('Gaps in this chart mean no historical sample was stored for that time.'), true);
  assert.equal(html.includes('displayMetricText(metric)'), true);
  assert.equal(html.includes('Click a latest snapshot card'), true);
  assert.equal(html.includes('"historySource":"subnet"'), true);
  assert.equal(html.includes('/api/subnets/' + model.netuid + '/latest'), true);
  assert.equal(html.includes('syncLiveSnapshotState()'), true);
  assert.equal(model.latest.tao_price_usd, 100);
  db.close();
});

test('pool growth estimator updates projected values and scenario hover tooltip in the browser', async () => {
  const db = openDatabase(':memory:');
  insertSnapshot(db, normalizeSnapshot({
    netuid: 110,
    block_number: 1,
    timestamp: '2026-04-30T00:00:00Z',
    name: 'Green Compute',
    symbol: 'Ѐ',
    price: '0.1',
    market_cap: '2000000000',
    liquidity: '100000000000',
    total_tao: '100000000000',
    alpha_in_pool: '1000',
  }, { source: 'scrape', sourceUrl: 'https://example.invalid', netuid: 110 }));

  const model = buildPageModel({
    db,
    config: {
      taostatsAuthHeader: '',
      taostatsAdminApiKey: '',
      pollIntervalMinutes: 60,
      wallets: [],
    },
    netuid: 110,
  });

  const html = renderPage(model);
  const errors = [];
  const dom = new JSDOM(html, {
    url: 'http://localhost:3003/',
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
    beforeParse(window) {
      window.fetch = async () => ({ ok: true, status: 200, json: async () => ({ history: [] }), text: async () => '[]' });
      window.console.error = (...args) => errors.push(args.join(' '));
      window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
      window.SVGElement.prototype.getBoundingClientRect = () => ({ left: 0, top: 0, width: 500, height: 160, right: 500, bottom: 160 });
      window.HTMLCanvasElement.prototype.getContext = () => ({ clearRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, fill() {}, rect() {}, arc() {}, closePath() {}, save() {}, restore() {}, setLineDash() {}, fillText() {}, measureText() { return { width: 10 }; } });
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 800));

  const input = dom.window.document.querySelector('#pool-growth-tao-injected');
  const projectedPrice = dom.window.document.getElementById('pool-growth-projected-price');
  const projectedMarketCap = dom.window.document.getElementById('pool-growth-projected-market-cap');
  const tooltip = dom.window.document.querySelector('.pool-estimator-scenario-tooltip');
  const points = dom.window.document.querySelectorAll('.pool-estimator-scenario-point');
  const selection = dom.window.document.querySelectorAll('.pool-estimator-scenario-selection');
  const estimatorRoot = dom.window.document.getElementById('pool-growth-estimator');
  const scenarioDetails = dom.window.document.querySelector('.pool-estimator-scenario-details');
  const scenarioToggle = dom.window.document.querySelector('.pool-estimator-scenario-summary-hint');
  assert.ok(input);
  assert.ok(projectedPrice);
  assert.ok(projectedMarketCap);
  assert.ok(tooltip);
  assert.ok(estimatorRoot);
  assert.ok(scenarioDetails);
  assert.ok(scenarioToggle);
  assert.equal(points.length, 0);
  assert.equal(selection.length, 0);
  assert.equal(estimatorRoot.dataset.poolScenarioOpen, 'false');

  assert.equal(projectedPrice.textContent.includes('0.121'), true);
  assert.equal(projectedMarketCap.textContent.includes('2.42'), true);

  scenarioToggle.dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(estimatorRoot.dataset.poolScenarioOpen, 'true');
  assert.equal(scenarioToggle.textContent.includes('Hide chart'), true);

  input.value = '50';
  input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.equal(projectedPrice.textContent.includes('0.225'), true);
  assert.equal(projectedMarketCap.textContent.includes('4.5'), true);
  assert.equal(tooltip.hidden, false);
  assert.equal(tooltip.textContent.includes('TAO injected'), true);
  assert.equal(tooltip.textContent.includes('+125.00%'), true);

  const hitArea = dom.window.document.querySelector('.pool-estimator-scenario-hit-area');
  assert.ok(hitArea);
  hitArea.dispatchEvent(new dom.window.MouseEvent('pointerenter', { bubbles: true, clientX: 100, clientY: 120 }));
  hitArea.dispatchEvent(new dom.window.MouseEvent('pointerdown', { bubbles: true, clientX: 100, clientY: 120, buttons: 1 }));
  hitArea.dispatchEvent(new dom.window.MouseEvent('pointermove', { bubbles: true, clientX: 120, clientY: 120, buttons: 1 }));
  await new Promise((resolve) => setTimeout(resolve, 50));
  const injectedBefore = input.value;
  const projectedBefore = projectedPrice.textContent;
  const leftBefore = tooltip.style.left;
  hitArea.dispatchEvent(new dom.window.MouseEvent('pointermove', { bubbles: true, clientX: 320, clientY: 120, buttons: 1 }));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(tooltip.hidden, false);
  assert.equal(tooltip.textContent.includes('TAO injected'), true);
  assert.notEqual(input.value, injectedBefore);
  assert.notEqual(projectedPrice.textContent, projectedBefore);
  assert.notEqual(tooltip.style.left, leftBefore);

  dom.window.close();
  db.close();
});

test('ctrl-clicking a wallet card opens the transaction modal and renders the timeline', async () => {
  const db = openDatabase(':memory:');
  insertSnapshot(db, normalizeSnapshot({
    netuid: 110,
    block_number: 1,
    timestamp: '2026-04-30T00:00:00Z',
    name: 'Green Compute',
    symbol: 'Ѐ',
    price: '0.1',
    market_cap: '2000000000',
    liquidity: '100000000000',
    total_tao: '100000000000',
    alpha_in_pool: '1000',
  }, { source: 'scrape', sourceUrl: 'https://example.invalid', netuid: 110 }));
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

  const model = buildPageModel({
    db,
    config: {
      taostatsAuthHeader: 'token',
      taostatsAdminApiKey: '',
      pollIntervalMinutes: 60,
      wallets: [{ name: 'Alpha Treasury', ss58: '5WalletAlpha123456789ABCDEFGH', network: 'finney', hotkeys: [{ name: 'Miner One', ss58: '5HotkeyOne', netuid: 111, network: 'finney', role: 'validator' }] }],
    },
    netuid: 110,
  });

  const html = renderPage(model);
  const dom = new JSDOM(html, {
    url: 'http://localhost:3003/',
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
    beforeParse(window) {
      window.fetch = async (url) => {
        const text = String(url);
        if (text.includes('/transactions')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              available: true,
              partial: false,
              reason: null,
              days: 7,
              address: '5WalletAlpha123456789ABCDEFGH',
              walletName: 'Alpha Treasury',
              network: 'finney',
              rows: [
                {
                  source_type: 'transfer',
                  timestamp: '2026-04-30T00:00:00Z',
                  block_number: 42,
                  extrinsic_id: '0xabc',
                  transaction_hash: '0xdef',
                  coldkey_ss58: '5WalletAlpha123456789ABCDEFGH',
                  hotkey_ss58: null,
                  hotkey_name: null,
                  netuid: null,
                  action: 'Transfer',
                  action_key: 'transfer',
                  amount_tao: 1.5,
                  amount_alpha: null,
                  from_ss58: '5WalletAlpha123456789ABCDEFGH',
                  to_ss58: '5WalletBeta',
                  status: 'success',
                  note: 'Coldkey transfer',
                  raw: { type: 'transfer' },
                },
              ],
              summary: { total: 1, extrinsics: 0, transfers: 1, stakeSnapshots: 0, stakeDelta: 0, hotkeysTracked: 1 },
              hotkeys: [{ ss58: '5HotkeyOne', name: 'Miner One', netuid: 111, role: 'validator', network: 'finney', source: 'configured' }],
            }),
            text: async () => '[]',
          };
        }
        return { ok: true, status: 200, json: async () => ({ history: [] }), text: async () => '[]' };
      };
      window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
      window.SVGElement.prototype.getBoundingClientRect = () => ({ left: 0, top: 0, width: 500, height: 160, right: 500, bottom: 160 });
      window.HTMLCanvasElement.prototype.getContext = () => ({ clearRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, fill() {}, rect() {}, arc() {}, closePath() {}, save() {}, restore() {}, setLineDash() {}, fillText() {}, measureText() { return { width: 10 }; } });
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 800));

  const walletButton = Array.from(dom.window.document.querySelectorAll('[data-metric]'))
    .find((button) => {
      const metric = String(button.dataset.metric || '');
      return metric.includes('"kind":"wallet"') && metric.includes('Alpha Treasury');
    });
  assert.ok(walletButton);

  walletButton.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, ctrlKey: true }));
  await new Promise((resolve) => setTimeout(resolve, 150));

  const txModal = dom.window.document.getElementById('wallet-transactions-modal');
  const txTitle = dom.window.document.getElementById('wallet-transactions-modal-title');
  const txBodyRows = dom.window.document.querySelectorAll('#wallet-transactions-table-body tr');
  const txDetail = dom.window.document.getElementById('wallet-transactions-detail');

  assert.ok(txModal.classList.contains('open'));
  assert.equal(txTitle.textContent.includes('Alpha Treasury transactions'), true);
  assert.equal(txBodyRows.length, 1);
  assert.equal(txDetail.hidden, false);
  assert.equal(txDetail.textContent.includes('"source_type": "transfer"'), true);

  dom.window.close();
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

test('alpha holder history endpoint returns daily holder rows from local snapshots', async () => {
  const db = openDatabase(':memory:');
  insertAlphaHolderSnapshot(db, normalizeStakeBalanceSnapshot({
    block_number: 8160001,
    timestamp: '2026-04-30T00:00:00Z',
    netuid: 110,
    subnet_rank: 2,
    subnet_total_holders: 2,
    balance: '1000000000',
    balance_as_tao: '500000000',
    coldkey: { ss58: '5AlphaHolderOne', hex: '0xholder1' },
    hotkey: { ss58: '5ValOne', hex: '0xval1' },
    hotkey_name: 'Validator One',
  }, { source: 'api', sourceUrl: 'https://example.invalid', capturedAt: '2026-04-30T00:00:00.000Z' }));
  insertAlphaHolderSnapshot(db, normalizeStakeBalanceSnapshot({
    block_number: 8161001,
    timestamp: '2026-05-01T00:00:00Z',
    netuid: 110,
    subnet_rank: 1,
    subnet_total_holders: 2,
    balance: '2000000000',
    balance_as_tao: '1000000000',
    coldkey: { ss58: '5AlphaHolderOne', hex: '0xholder1' },
    hotkey: { ss58: '5ValOne', hex: '0xval1' },
    hotkey_name: 'Validator One',
  }, { source: 'api', sourceUrl: 'https://example.invalid', capturedAt: '2026-05-01T00:00:00.000Z' }));
  insertAlphaHolderSnapshot(db, normalizeStakeBalanceSnapshot({
    block_number: 8161001,
    timestamp: '2026-05-01T00:00:00Z',
    netuid: 110,
    subnet_rank: 1,
    subnet_total_holders: 2,
    balance: '500000000',
    balance_as_tao: '250000000',
    coldkey: { ss58: '5AlphaHolderTwo', hex: '0xholder2' },
    hotkey: { ss58: '5ValTwo', hex: '0xval2' },
    hotkey_name: 'Validator Two',
  }, { source: 'api', sourceUrl: 'https://example.invalid', capturedAt: '2026-05-01T00:00:00.000Z' }));

  const app = createDashboardServer({
    db,
    ingestService: { ingestOnce: async () => ({ ok: true }) },
    config: { netuid: 110, taostatsAuthHeader: '', pollIntervalMinutes: 60, nextPollAtIso: null },
  });
  const server = await app.start(0);
  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}/api/subnets/110/alpha-holder-history?days=30`);
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.days, 30);
  assert.equal(payload.history.length, 2);
  assert.equal(payload.history[0].alpha_holders_num, 1);
  assert.equal(payload.history[1].alpha_holders_num, 2);
  assert.equal(payload.collectionStartedAt, '2026-04-30T00:00:00.000Z');
  await app.close();
  db.close();
});

test('alpha holder rank history endpoint returns local ranks across subnets and starts at first collection', async () => {
  const db = openDatabase(':memory:');
  const day1 = '2026-04-30T00:00:00.000Z';
  const day2 = '2026-05-01T00:00:00.000Z';
  const scenarios = [
    { netuid: 110, day: day1, count: 1 },
    { netuid: 111, day: day1, count: 3 },
    { netuid: 112, day: day1, count: 2 },
    { netuid: 110, day: day2, count: 4 },
    { netuid: 111, day: day2, count: 2 },
    { netuid: 112, day: day2, count: 5 },
  ];

  for (const { netuid, day, count } of scenarios) {
    for (let index = 0; index < count; index += 1) {
      insertAlphaHolderSnapshot(db, normalizeStakeBalanceSnapshot({
        block_number: 8200000 + netuid + (day === day2 ? 1000 : 0),
        timestamp: day,
        netuid,
        subnet_rank: index + 1,
        subnet_total_holders: 10,
        balance: String(1_000_000_000 + index),
        balance_as_tao: String(500_000_000 + index),
        coldkey: { ss58: `5Rank${netuid}${day}${index}`, hex: `0xrank${netuid}${index}` },
        hotkey: { ss58: `5RankVal${netuid}${day}${index}`, hex: `0xrankval${netuid}${index}` },
        hotkey_name: `Validator ${netuid}-${index}`,
      }, { source: 'api', sourceUrl: 'https://example.invalid', capturedAt: day }));
    }
  }

  const app = createDashboardServer({
    db,
    ingestService: { ingestOnce: async () => ({ ok: true }) },
    config: { netuid: 110, taostatsAuthHeader: '', pollIntervalMinutes: 60, nextPollAtIso: null },
  });
  const server = await app.start(0);
  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}/api/subnets/110/alpha-holder-rank-history?days=30`);
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.days, 30);
  assert.equal(payload.collectionStartedAt, day1);
  assert.equal(payload.history.length, 2);
  assert.equal(payload.history[0].alpha_holders_num, 1);
  assert.equal(payload.history[0].rank_num, 3);
  assert.equal(payload.history[1].alpha_holders_num, 4);
  assert.equal(payload.history[1].rank_num, 2);
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

test('wallet transactions endpoint downgrades stake history 429 to a warning', async () => {
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

  const originalFetch = global.fetch;
  const app = createDashboardServer({
    db,
    ingestService: { ingestOnce: async () => ({ ok: true }) },
    config: {
      netuid: 110,
      taostatsAuthHeader: 'token',
      taostatsBaseUrl: 'https://api.taostats.io',
      pollIntervalMinutes: 60,
      nextPollAtIso: null,
      wallets: [
        {
          name: 'Alpha Treasury',
          ss58: '5WalletAlpha123456789ABCDEFGH',
          network: 'finney',
          hotkeys: [{ name: 'Miner One', ss58: '5HotkeyOne', netuid: 111, network: 'finney', role: 'validator' }],
        },
      ],
    },
  });

  try {
    global.fetch = async (url) => {
      const text = String(url);
      if (text.startsWith('http://127.0.0.1:') || text.startsWith('http://localhost:') || text.startsWith('https://127.0.0.1:')) {
        return originalFetch(url);
      }
      if (text.includes('/api/extrinsic/v1')) {
        const body = JSON.stringify([
          {
            id: 'ext-1',
            full_name: 'SubtensorModule.add_stake',
            signer_address: '5WalletAlpha123456789ABCDEFGH',
            timestamp: '2026-04-30T00:00:00Z',
            block_number: 42,
            call_args: { hotkey: { ss58: '5HotkeyOne' }, netuid: 111, amount: '1000000000' },
            success: true,
          },
        ]);
        return {
          ok: true,
          status: 200,
          json: async () => JSON.parse(body),
          text: async () => body,
        };
      }
      if (text.includes('/api/transfer/v1')) {
        const body = JSON.stringify([
          {
            id: 'transfer-1',
            from: '5WalletAlpha123456789ABCDEFGH',
            to: '5WalletBeta',
            timestamp: '2026-04-30T01:00:00Z',
            block_number: 43,
            amount: '2000000000',
          },
        ]);
        return {
          ok: true,
          status: 200,
          json: async () => JSON.parse(body),
          text: async () => body,
        };
      }
      if (text.includes('/api/dtao/stake_balance/history/v1')) {
        return {
          ok: false,
          status: 429,
          json: async () => ({ error: 'rate limited' }),
          text: async () => JSON.stringify({ error: 'rate limited' }),
        };
      }
      throw new Error(`unexpected fetch ${text}`);
    };

    const server = await app.start(0);
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}/api/wallets/5WalletAlpha123456789ABCDEFGH/transactions?days=7`);
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(payload.available, true);
    assert.equal(payload.warning.includes('rate-limited'), true);
    assert.equal(payload.reason, null);
    assert.equal(payload.rows.some((row) => row.source_type === 'extrinsic'), true);
    assert.equal(payload.rows.some((row) => row.source_type === 'transfer'), true);
    assert.equal(payload.rows.some((row) => row.source_type === 'stake_history'), false);
  } finally {
    global.fetch = originalFetch;
    await app.close();
    db.close();
  }
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
    'TAOSTATS_WALLET_1_HOTKEY_1_ROLE=validator',
    'TAOSTATS_WALLET_2_NAME=Ops',
    'TAOSTATS_WALLET_2_COLDKEY=5WalletBeta123456789ABCDEFGH',
  ].join('\n'));

  const envKeys = ['PORT', 'TAOSTATS_NETUID', 'TAOSTATS_API_KEY', 'TAOSTATS_ADMIN_API_KEY', 'TAOSTATS_AUTH_HEADER', 'POLL_INTERVAL_MINUTES', 'TAOSTATS_PUBLIC_BASE_URL', 'TAOSTATS_BACKFILL_DAYS', 'TAOSTATS_BACKFILL_FREQUENCY', 'TAOSTATS_BACKFILL_ON_STARTUP', 'TAOSTATS_BACKFILL_OVERWRITE', 'TAOSTATS_WALLET_1_NAME', 'TAOSTATS_WALLET_1_COLDKEY', 'TAOSTATS_WALLET_1_SS58', 'TAOSTATS_WALLET_1_NETWORK', 'TAOSTATS_WALLET_1_HOTKEY_1_NAME', 'TAOSTATS_WALLET_1_HOTKEY_1_SS58', 'TAOSTATS_WALLET_1_HOTKEY_1_NETUID', 'TAOSTATS_WALLET_1_HOTKEY_1_ROLE', 'TAOSTATS_WALLET_2_NAME', 'TAOSTATS_WALLET_2_COLDKEY', 'TAOSTATS_WALLET_2_SS58'];
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
    assert.equal(config.wallets[0].hotkeys[0].role, 'validator');
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
  assert.equal(columns.includes('alpha_holders_num'), true);
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
