'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

function ensureDirectory(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function openDatabase(filePath) {
  ensureDirectory(filePath);
  const db = new DatabaseSync(filePath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      netuid INTEGER NOT NULL,
      captured_at TEXT NOT NULL,
      remote_timestamp TEXT,
      source TEXT NOT NULL,
      source_url TEXT,
      block_number INTEGER,
      name TEXT,
      symbol TEXT,
      rank INTEGER,
      price_text TEXT,
      price_num REAL,
      market_cap_text TEXT,
      market_cap_num REAL,
      liquidity_text TEXT,
      liquidity_num REAL,
      total_tao_text TEXT,
      total_tao_num REAL,
      total_alpha_text TEXT,
      alpha_in_pool_text TEXT,
      alpha_staked_text TEXT,
      root_prop_text TEXT,
      emission_text TEXT,
      emission_num REAL,
      emission_percent_text TEXT,
      emission_percent_num REAL,
      emission_per_day_tao_text TEXT,
      emission_per_day_tao_num REAL,
      owner_per_day_tao_text TEXT,
      owner_per_day_tao_num REAL,
      miner_per_day_tao_text TEXT,
      miner_per_day_tao_num REAL,
      validator_per_day_tao_text TEXT,
      validator_per_day_tao_num REAL,
      projected_emission_text TEXT,
      projected_emission_num REAL,
      incentive_burn_text TEXT,
      incentive_burn_num REAL,
      recycled_24_hours_text TEXT,
      recycled_24_hours_num REAL,
      chain_buys_1_day_text TEXT,
      chain_buys_1_day_num REAL,
      recycled_lifetime_text TEXT,
      recycled_lifetime_num REAL,
      recycled_since_registration_text TEXT,
      recycled_since_registration_num REAL,
      registration_cost_text TEXT,
      registration_cost_num REAL,
      active_keys_text TEXT,
      active_keys_num INTEGER,
      max_neurons_text TEXT,
      max_neurons_num INTEGER,
      net_flow_1_day_text TEXT,
      net_flow_1_day_num REAL,
      net_flow_7_days_text TEXT,
      net_flow_7_days_num REAL,
      net_flow_30_days_text TEXT,
      net_flow_30_days_num REAL,
      root_sell_text TEXT,
      root_sell_bool INTEGER,
      fee_rate_text TEXT,
      market_cap_change_1_day_text TEXT,
      price_change_1_hour_text TEXT,
      price_change_1_day_text TEXT,
      price_change_1_week_text TEXT,
      price_change_1_month_text TEXT,
      tao_volume_24_hr_text TEXT,
      tao_volume_24_hr_num REAL,
      tao_volume_24_hr_change_1_day_text TEXT,
      tao_buy_volume_24_hr_text TEXT,
      tao_sell_volume_24_hr_text TEXT,
      alpha_volume_24_hr_text TEXT,
      alpha_volume_24_hr_num REAL,
      alpha_volume_24_hr_change_1_day_text TEXT,
      sentiment_index_text TEXT,
      sentiment_index_num REAL,
      sentiment_index_source_text TEXT,
      fear_and_greed_index TEXT,
      fear_and_greed_sentiment TEXT,
      alpha_holders_text TEXT,
      alpha_holders_num INTEGER,
      startup_mode INTEGER,
      swap_v3_initialized INTEGER,
      enabled_user_liquidity INTEGER,
      current_tick INTEGER,
      liquidity_raw TEXT,
      raw_json TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_snapshots_netuid_captured_at
      ON snapshots(netuid, captured_at DESC, id DESC);

    CREATE TABLE IF NOT EXISTS tao_price_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      captured_at TEXT NOT NULL UNIQUE,
      remote_timestamp TEXT,
      source TEXT NOT NULL,
      source_url TEXT,
      asset TEXT,
      name TEXT,
      symbol TEXT,
      slug TEXT,
      circulating_supply REAL,
      max_supply REAL,
      total_supply REAL,
      price_usd REAL,
      volume_24h_usd REAL,
      market_cap_usd REAL,
      fully_diluted_market_cap_usd REAL,
      percent_change_1h REAL,
      percent_change_24h REAL,
      percent_change_7d REAL,
      percent_change_30d REAL,
      percent_change_60d REAL,
      percent_change_90d REAL,
      market_cap_dominance REAL,
      raw_json TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_tao_price_history_captured_at
      ON tao_price_history(captured_at DESC, id DESC);

    CREATE TABLE IF NOT EXISTS tao_flow_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      netuid INTEGER NOT NULL,
      captured_at TEXT NOT NULL,
      remote_timestamp TEXT,
      source TEXT NOT NULL,
      source_url TEXT,
      block_number INTEGER,
      name TEXT,
      symbol TEXT,
      tao_flow_text TEXT,
      tao_flow_num REAL,
      tao_in_pool_text TEXT,
      tao_in_pool_num REAL,
      alpha_in_pool_text TEXT,
      alpha_in_pool_num REAL,
      alpha_rewards_text TEXT,
      alpha_rewards_num REAL,
      raw_json TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_tao_flow_history_netuid_captured_at
      ON tao_flow_history(netuid, captured_at DESC, id DESC);

    CREATE UNIQUE INDEX IF NOT EXISTS idx_tao_flow_history_netuid_block_number
      ON tao_flow_history(netuid, block_number);

    CREATE TABLE IF NOT EXISTS wallet_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      wallet_name TEXT NOT NULL,
      wallet_address_ss58 TEXT NOT NULL,
      wallet_address_hex TEXT,
      network TEXT NOT NULL,
      captured_at TEXT NOT NULL,
      remote_timestamp TEXT,
      source TEXT NOT NULL,
      source_url TEXT,
      block_number INTEGER,
      rank INTEGER,
      balance_free_text TEXT,
      balance_free_num REAL,
      balance_staked_text TEXT,
      balance_staked_num REAL,
      balance_staked_alpha_as_tao_text TEXT,
      balance_staked_alpha_as_tao_num REAL,
      balance_staked_root_text TEXT,
      balance_staked_root_num REAL,
      balance_total_text TEXT,
      balance_total_num REAL,
      balance_free_24hr_ago_text TEXT,
      balance_free_24hr_ago_num REAL,
      balance_staked_24hr_ago_text TEXT,
      balance_staked_24hr_ago_num REAL,
      balance_staked_alpha_as_tao_24hr_ago_text TEXT,
      balance_staked_alpha_as_tao_24hr_ago_num REAL,
      balance_staked_root_24hr_ago_text TEXT,
      balance_staked_root_24hr_ago_num REAL,
      balance_total_24hr_ago_text TEXT,
      balance_total_24hr_ago_num REAL,
      balance_free_change_24hr_text TEXT,
      balance_free_change_24hr_num REAL,
      balance_staked_change_24hr_text TEXT,
      balance_staked_change_24hr_num REAL,
      balance_staked_alpha_as_tao_change_24hr_text TEXT,
      balance_staked_alpha_as_tao_change_24hr_num REAL,
      balance_staked_root_change_24hr_text TEXT,
      balance_staked_root_change_24hr_num REAL,
      balance_total_change_24hr_text TEXT,
      balance_total_change_24hr_num REAL,
      created_on_date TEXT,
      created_on_network TEXT,
      coldkey_swap TEXT,
      raw_json TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_wallet_snapshots_address_captured_at
      ON wallet_snapshots(wallet_address_ss58, captured_at DESC, id DESC);

    CREATE UNIQUE INDEX IF NOT EXISTS idx_wallet_snapshots_address_block_number
      ON wallet_snapshots(wallet_address_ss58, block_number);

    CREATE TABLE IF NOT EXISTS wallet_stake_positions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      wallet_name TEXT NOT NULL,
      wallet_address_ss58 TEXT NOT NULL,
      wallet_address_hex TEXT,
      hotkey_name TEXT,
      hotkey_address_ss58 TEXT,
      hotkey_address_hex TEXT,
      netuid INTEGER,
      subnet_rank INTEGER,
      subnet_total_holders INTEGER,
      balance_text TEXT,
      balance_num REAL,
      balance_as_tao_text TEXT,
      balance_as_tao_num REAL,
      source TEXT NOT NULL,
      source_url TEXT,
      captured_at TEXT NOT NULL,
      remote_timestamp TEXT,
      raw_json TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_wallet_stake_positions_address_balance
      ON wallet_stake_positions(wallet_address_ss58, balance_as_tao_num DESC, netuid ASC, id DESC);

    CREATE INDEX IF NOT EXISTS idx_wallet_stake_positions_address_captured_at
      ON wallet_stake_positions(wallet_address_ss58, captured_at DESC, id DESC);

    DROP INDEX IF EXISTS idx_wallet_stake_positions_address_netuid_hotkey;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_wallet_stake_positions_address_netuid_hotkey
      ON wallet_stake_positions(wallet_address_ss58, netuid, hotkey_address_ss58, captured_at);

    CREATE TABLE IF NOT EXISTS subnet_metadata (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      netuid INTEGER NOT NULL UNIQUE,
      name TEXT,
      symbol TEXT,
      source TEXT NOT NULL,
      source_url TEXT,
      captured_at TEXT NOT NULL,
      raw_json TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_subnet_metadata_name
      ON subnet_metadata(name);

    CREATE TABLE IF NOT EXISTS alpha_holder_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      netuid INTEGER NOT NULL,
      captured_at TEXT NOT NULL,
      remote_timestamp TEXT,
      source TEXT NOT NULL,
      source_url TEXT,
      block_number INTEGER,
      coldkey_ss58 TEXT NOT NULL,
      coldkey_hex TEXT,
      hotkey_name TEXT,
      hotkey_address_ss58 TEXT,
      hotkey_address_hex TEXT,
      subnet_rank INTEGER,
      subnet_total_holders INTEGER,
      balance_text TEXT,
      balance_num REAL,
      balance_as_tao_text TEXT,
      balance_as_tao_num REAL,
      dedupe_key TEXT NOT NULL UNIQUE,
      raw_json TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_alpha_holder_snapshots_netuid_captured_at
      ON alpha_holder_snapshots(netuid, captured_at DESC, balance_as_tao_num DESC, id DESC);

    CREATE INDEX IF NOT EXISTS idx_alpha_holder_snapshots_netuid_holder
      ON alpha_holder_snapshots(netuid, coldkey_ss58, hotkey_address_ss58, captured_at DESC, id DESC);

    CREATE TABLE IF NOT EXISTS wallet_transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      wallet_name TEXT NOT NULL,
      wallet_address_ss58 TEXT NOT NULL,
      wallet_address_hex TEXT,
      network TEXT NOT NULL,
      source_type TEXT NOT NULL,
      action TEXT NOT NULL,
      action_key TEXT NOT NULL,
      dedupe_key TEXT NOT NULL UNIQUE,
      captured_at TEXT NOT NULL,
      event_timestamp TEXT NOT NULL,
      remote_timestamp TEXT,
      source TEXT NOT NULL,
      source_url TEXT,
      block_number INTEGER,
      extrinsic_id TEXT,
      transaction_hash TEXT,
      hotkey_name TEXT,
      hotkey_address_ss58 TEXT,
      hotkey_address_hex TEXT,
      netuid INTEGER,
      amount_tao REAL,
      amount_alpha REAL,
      from_ss58 TEXT,
      to_ss58 TEXT,
      status TEXT,
      note TEXT,
      raw_json TEXT NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_wallet_transactions_dedupe_key
      ON wallet_transactions(dedupe_key);

    CREATE INDEX IF NOT EXISTS idx_wallet_transactions_address_timestamp
      ON wallet_transactions(wallet_address_ss58, event_timestamp DESC, id DESC);

    CREATE INDEX IF NOT EXISTS idx_wallet_transactions_address_captured_at
      ON wallet_transactions(wallet_address_ss58, captured_at DESC, id DESC);

    CREATE TABLE IF NOT EXISTS ingest_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      netuid INTEGER NOT NULL,
      started_at TEXT NOT NULL,
      finished_at TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      source TEXT NOT NULL,
      fallback_used INTEGER NOT NULL DEFAULT 0,
      ok INTEGER NOT NULL,
      snapshot_id INTEGER,
      message TEXT,
      error TEXT,
      detail_json TEXT,
      FOREIGN KEY(snapshot_id) REFERENCES snapshots(id)
    );

    CREATE INDEX IF NOT EXISTS idx_ingest_runs_netuid_started_at
      ON ingest_runs(netuid, started_at DESC, id DESC);

    CREATE INDEX IF NOT EXISTS idx_ingest_runs_netuid_source_started_at
      ON ingest_runs(netuid, source, started_at DESC, id DESC);

    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  ensureSnapshotColumns(db);
  ensureTaoPriceColumns(db);
  ensureTaoFlowColumns(db);
  ensureWalletTransactionColumns(db);
  return db;
}

function ensureSnapshotColumns(db) {
  const columns = new Set(
    db.prepare(`PRAGMA table_info(snapshots)`).all().map((row) => row.name)
  );

  const additions = [
    ['remote_timestamp', 'TEXT'],
    ['source_url', 'TEXT'],
    ['block_number', 'INTEGER'],
    ['name', 'TEXT'],
    ['symbol', 'TEXT'],
    ['rank', 'INTEGER'],
    ['price_text', 'TEXT'],
    ['price_num', 'REAL'],
    ['market_cap_text', 'TEXT'],
    ['market_cap_num', 'REAL'],
    ['liquidity_text', 'TEXT'],
    ['liquidity_num', 'REAL'],
    ['emission_text', 'TEXT'],
    ['emission_num', 'REAL'],
    ['emission_percent_text', 'TEXT'],
    ['emission_percent_num', 'REAL'],
    ['total_tao_text', 'TEXT'],
    ['total_tao_num', 'REAL'],
    ['total_alpha_text', 'TEXT'],
    ['alpha_in_pool_text', 'TEXT'],
    ['alpha_staked_text', 'TEXT'],
    ['root_prop_text', 'TEXT'],
    ['emission_per_day_tao_text', 'TEXT'],
    ['emission_per_day_tao_num', 'REAL'],
    ['owner_per_day_tao_text', 'TEXT'],
    ['owner_per_day_tao_num', 'REAL'],
    ['miner_per_day_tao_text', 'TEXT'],
    ['miner_per_day_tao_num', 'REAL'],
    ['validator_per_day_tao_text', 'TEXT'],
    ['validator_per_day_tao_num', 'REAL'],
    ['projected_emission_text', 'TEXT'],
    ['projected_emission_num', 'REAL'],
    ['incentive_burn_text', 'TEXT'],
    ['incentive_burn_num', 'REAL'],
    ['recycled_24_hours_text', 'TEXT'],
    ['recycled_24_hours_num', 'REAL'],
    ['chain_buys_1_day_text', 'TEXT'],
    ['chain_buys_1_day_num', 'REAL'],
    ['recycled_lifetime_text', 'TEXT'],
    ['recycled_lifetime_num', 'REAL'],
    ['recycled_since_registration_text', 'TEXT'],
    ['recycled_since_registration_num', 'REAL'],
    ['registration_cost_text', 'TEXT'],
    ['registration_cost_num', 'REAL'],
    ['active_keys_text', 'TEXT'],
    ['active_keys_num', 'INTEGER'],
    ['max_neurons_text', 'TEXT'],
    ['max_neurons_num', 'INTEGER'],
    ['net_flow_1_day_text', 'TEXT'],
    ['net_flow_1_day_num', 'REAL'],
    ['net_flow_7_days_text', 'TEXT'],
    ['net_flow_7_days_num', 'REAL'],
    ['net_flow_30_days_text', 'TEXT'],
    ['net_flow_30_days_num', 'REAL'],
    ['sentiment_index_text', 'TEXT'],
    ['sentiment_index_num', 'REAL'],
    ['sentiment_index_source_text', 'TEXT'],
    ['fee_rate_text', 'TEXT'],
    ['market_cap_change_1_day_text', 'TEXT'],
    ['price_change_1_hour_text', 'TEXT'],
    ['price_change_1_day_text', 'TEXT'],
    ['price_change_1_week_text', 'TEXT'],
    ['price_change_1_month_text', 'TEXT'],
    ['tao_volume_24_hr_text', 'TEXT'],
    ['tao_volume_24_hr_num', 'REAL'],
    ['tao_volume_24_hr_change_1_day_text', 'TEXT'],
    ['tao_buy_volume_24_hr_text', 'TEXT'],
    ['tao_sell_volume_24_hr_text', 'TEXT'],
    ['alpha_volume_24_hr_text', 'TEXT'],
    ['alpha_volume_24_hr_num', 'REAL'],
    ['alpha_volume_24_hr_change_1_day_text', 'TEXT'],
    ['fear_and_greed_index', 'TEXT'],
    ['fear_and_greed_sentiment', 'TEXT'],
    ['alpha_holders_text', 'TEXT'],
    ['alpha_holders_num', 'INTEGER'],
    ['startup_mode', 'INTEGER'],
    ['swap_v3_initialized', 'INTEGER'],
    ['enabled_user_liquidity', 'INTEGER'],
    ['current_tick', 'INTEGER'],
    ['liquidity_raw', 'TEXT'],
    ['root_sell_text', 'TEXT'],
    ['root_sell_bool', 'INTEGER'],
    ['raw_json', 'TEXT'],
  ];

  for (const [name, type] of additions) {
    if (!columns.has(name)) {
      db.exec(`ALTER TABLE snapshots ADD COLUMN ${name} ${type}`);
    }
  }
}

function ensureTaoPriceColumns(db) {
  const columns = new Set(
    db.prepare(`PRAGMA table_info(tao_price_history)`).all().map((row) => row.name)
  );

  if (columns.size === 0) {
    return;
  }

  const additions = [
    ['remote_timestamp', 'TEXT'],
    ['source', 'TEXT'],
    ['source_url', 'TEXT'],
    ['asset', 'TEXT'],
    ['name', 'TEXT'],
    ['symbol', 'TEXT'],
    ['slug', 'TEXT'],
    ['circulating_supply', 'REAL'],
    ['max_supply', 'REAL'],
    ['total_supply', 'REAL'],
    ['price_usd', 'REAL'],
    ['volume_24h_usd', 'REAL'],
    ['market_cap_usd', 'REAL'],
    ['fully_diluted_market_cap_usd', 'REAL'],
    ['total_tao_num', 'REAL'],
    ['percent_change_1h', 'REAL'],
    ['percent_change_24h', 'REAL'],
    ['percent_change_7d', 'REAL'],
    ['percent_change_30d', 'REAL'],
    ['percent_change_60d', 'REAL'],
    ['percent_change_90d', 'REAL'],
    ['market_cap_dominance', 'REAL'],
    ['raw_json', 'TEXT'],
  ];

  for (const [name, type] of additions) {
    if (!columns.has(name)) {
      db.exec(`ALTER TABLE tao_price_history ADD COLUMN ${name} ${type}`);
    }
  }
}

function ensureTaoFlowColumns(db) {
  const columns = new Set(
    db.prepare(`PRAGMA table_info(tao_flow_history)`).all().map((row) => row.name)
  );

  if (columns.size === 0) {
    return;
  }

  const additions = [
    ['remote_timestamp', 'TEXT'],
    ['source', 'TEXT'],
    ['source_url', 'TEXT'],
    ['block_number', 'INTEGER'],
    ['name', 'TEXT'],
    ['symbol', 'TEXT'],
    ['tao_flow_text', 'TEXT'],
    ['tao_flow_num', 'REAL'],
    ['tao_in_pool_text', 'TEXT'],
    ['tao_in_pool_num', 'REAL'],
    ['alpha_in_pool_text', 'TEXT'],
    ['alpha_in_pool_num', 'REAL'],
    ['alpha_rewards_text', 'TEXT'],
    ['alpha_rewards_num', 'REAL'],
    ['raw_json', 'TEXT'],
  ];

  for (const [name, type] of additions) {
    if (!columns.has(name)) {
      db.exec(`ALTER TABLE tao_flow_history ADD COLUMN ${name} ${type}`);
    }
  }
}

function ensureWalletTransactionColumns(db) {
  const columns = new Set(
    db.prepare(`PRAGMA table_info(wallet_transactions)`).all().map((row) => row.name)
  );

  if (columns.size === 0) {
    return;
  }

  const additions = [
    ['wallet_name', 'TEXT'],
    ['wallet_address_ss58', 'TEXT'],
    ['wallet_address_hex', 'TEXT'],
    ['network', 'TEXT'],
    ['source_type', 'TEXT'],
    ['action', 'TEXT'],
    ['action_key', 'TEXT'],
    ['dedupe_key', 'TEXT'],
    ['captured_at', 'TEXT'],
    ['event_timestamp', 'TEXT'],
    ['remote_timestamp', 'TEXT'],
    ['source', 'TEXT'],
    ['source_url', 'TEXT'],
    ['block_number', 'INTEGER'],
    ['extrinsic_id', 'TEXT'],
    ['transaction_hash', 'TEXT'],
    ['hotkey_name', 'TEXT'],
    ['hotkey_address_ss58', 'TEXT'],
    ['hotkey_address_hex', 'TEXT'],
    ['netuid', 'INTEGER'],
    ['amount_tao', 'REAL'],
    ['amount_alpha', 'REAL'],
    ['from_ss58', 'TEXT'],
    ['to_ss58', 'TEXT'],
    ['status', 'TEXT'],
    ['note', 'TEXT'],
    ['raw_json', 'TEXT'],
  ];

  for (const [name, type] of additions) {
    if (!columns.has(name)) {
      db.exec(`ALTER TABLE wallet_transactions ADD COLUMN ${name} ${type}`);
    }
  }
}

function toDbValue(value) {
  if (value === undefined) return null;
  return value;
}

function insertSnapshot(db, snapshot) {
  const stmt = db.prepare(`
    INSERT INTO snapshots (
      netuid, captured_at, remote_timestamp, source, source_url, block_number,
      name, symbol, rank,
      price_text, price_num,
      market_cap_text, market_cap_num,
      liquidity_text, liquidity_num,
      total_tao_text, total_tao_num, total_alpha_text, alpha_in_pool_text, alpha_staked_text,
      root_prop_text, emission_text, emission_num, emission_percent_text, emission_percent_num, emission_per_day_tao_text, emission_per_day_tao_num,
      owner_per_day_tao_text, owner_per_day_tao_num, miner_per_day_tao_text, miner_per_day_tao_num, validator_per_day_tao_text, validator_per_day_tao_num,
      projected_emission_text, projected_emission_num, incentive_burn_text, incentive_burn_num,
      recycled_24_hours_text, recycled_24_hours_num, chain_buys_1_day_text, chain_buys_1_day_num, recycled_lifetime_text, recycled_lifetime_num, recycled_since_registration_text, recycled_since_registration_num,
      registration_cost_text, registration_cost_num, active_keys_text, active_keys_num, max_neurons_text, max_neurons_num,
      net_flow_1_day_text, net_flow_1_day_num, net_flow_7_days_text, net_flow_7_days_num, net_flow_30_days_text, net_flow_30_days_num,
      root_sell_text, root_sell_bool, fee_rate_text,
      market_cap_change_1_day_text,
      price_change_1_hour_text, price_change_1_day_text, price_change_1_week_text, price_change_1_month_text,
      tao_volume_24_hr_text, tao_volume_24_hr_num, tao_volume_24_hr_change_1_day_text,
      tao_buy_volume_24_hr_text, tao_sell_volume_24_hr_text,
      alpha_volume_24_hr_text, alpha_volume_24_hr_num, alpha_volume_24_hr_change_1_day_text,
      sentiment_index_text, sentiment_index_num, sentiment_index_source_text,
      fear_and_greed_index, fear_and_greed_sentiment,
      alpha_holders_text, alpha_holders_num,
      startup_mode, swap_v3_initialized, enabled_user_liquidity, current_tick, liquidity_raw,
      raw_json
    ) VALUES (
      @netuid, @captured_at, @remote_timestamp, @source, @source_url, @block_number,
      @name, @symbol, @rank,
      @price_text, @price_num,
      @market_cap_text, @market_cap_num,
      @liquidity_text, @liquidity_num,
      @total_tao_text, @total_tao_num, @total_alpha_text, @alpha_in_pool_text, @alpha_staked_text,
      @root_prop_text, @emission_text, @emission_num, @emission_percent_text, @emission_percent_num, @emission_per_day_tao_text, @emission_per_day_tao_num,
      @owner_per_day_tao_text, @owner_per_day_tao_num, @miner_per_day_tao_text, @miner_per_day_tao_num, @validator_per_day_tao_text, @validator_per_day_tao_num,
      @projected_emission_text, @projected_emission_num, @incentive_burn_text, @incentive_burn_num,
      @recycled_24_hours_text, @recycled_24_hours_num, @chain_buys_1_day_text, @chain_buys_1_day_num, @recycled_lifetime_text, @recycled_lifetime_num, @recycled_since_registration_text, @recycled_since_registration_num,
      @registration_cost_text, @registration_cost_num, @active_keys_text, @active_keys_num, @max_neurons_text, @max_neurons_num,
      @net_flow_1_day_text, @net_flow_1_day_num, @net_flow_7_days_text, @net_flow_7_days_num, @net_flow_30_days_text, @net_flow_30_days_num,
      @root_sell_text, @root_sell_bool, @fee_rate_text,
      @market_cap_change_1_day_text,
      @price_change_1_hour_text, @price_change_1_day_text, @price_change_1_week_text, @price_change_1_month_text,
      @tao_volume_24_hr_text, @tao_volume_24_hr_num, @tao_volume_24_hr_change_1_day_text,
      @tao_buy_volume_24_hr_text, @tao_sell_volume_24_hr_text,
      @alpha_volume_24_hr_text, @alpha_volume_24_hr_num, @alpha_volume_24_hr_change_1_day_text,
      @sentiment_index_text, @sentiment_index_num, @sentiment_index_source_text,
      @fear_and_greed_index, @fear_and_greed_sentiment,
      @alpha_holders_text, @alpha_holders_num,
      @startup_mode, @swap_v3_initialized, @enabled_user_liquidity, @current_tick, @liquidity_raw,
      @raw_json
    )
  `);

  const info = stmt.run({
    netuid: snapshot.netuid,
    captured_at: snapshot.captured_at,
    remote_timestamp: toDbValue(snapshot.remote_timestamp),
    source: snapshot.source,
    source_url: toDbValue(snapshot.source_url),
    block_number: toDbValue(snapshot.block_number),
    name: toDbValue(snapshot.name),
    symbol: toDbValue(snapshot.symbol),
    rank: toDbValue(snapshot.rank),
    price_text: toDbValue(snapshot.price_text),
    price_num: toDbValue(snapshot.price_num),
    market_cap_text: toDbValue(snapshot.market_cap_text),
    market_cap_num: toDbValue(snapshot.market_cap_num),
    liquidity_text: toDbValue(snapshot.liquidity_text),
    liquidity_num: toDbValue(snapshot.liquidity_num),
    total_tao_text: toDbValue(snapshot.total_tao_text),
    total_tao_num: toDbValue(snapshot.total_tao_num),
    total_alpha_text: toDbValue(snapshot.total_alpha_text),
    alpha_in_pool_text: toDbValue(snapshot.alpha_in_pool_text),
    alpha_staked_text: toDbValue(snapshot.alpha_staked_text),
    root_prop_text: toDbValue(snapshot.root_prop_text),
    emission_text: toDbValue(snapshot.emission_text),
    emission_num: toDbValue(snapshot.emission_num),
    emission_percent_text: toDbValue(snapshot.emission_percent_text),
    emission_percent_num: toDbValue(snapshot.emission_percent_num),
    emission_per_day_tao_text: toDbValue(snapshot.emission_per_day_tao_text),
    emission_per_day_tao_num: toDbValue(snapshot.emission_per_day_tao_num),
    owner_per_day_tao_text: toDbValue(snapshot.owner_per_day_tao_text),
    owner_per_day_tao_num: toDbValue(snapshot.owner_per_day_tao_num),
    miner_per_day_tao_text: toDbValue(snapshot.miner_per_day_tao_text),
    miner_per_day_tao_num: toDbValue(snapshot.miner_per_day_tao_num),
    validator_per_day_tao_text: toDbValue(snapshot.validator_per_day_tao_text),
    validator_per_day_tao_num: toDbValue(snapshot.validator_per_day_tao_num),
    projected_emission_text: toDbValue(snapshot.projected_emission_text),
    projected_emission_num: toDbValue(snapshot.projected_emission_num),
    incentive_burn_text: toDbValue(snapshot.incentive_burn_text),
    incentive_burn_num: toDbValue(snapshot.incentive_burn_num),
    recycled_24_hours_text: toDbValue(snapshot.recycled_24_hours_text),
    recycled_24_hours_num: toDbValue(snapshot.recycled_24_hours_num),
    chain_buys_1_day_text: toDbValue(snapshot.chain_buys_1_day_text),
    chain_buys_1_day_num: toDbValue(snapshot.chain_buys_1_day_num),
    recycled_lifetime_text: toDbValue(snapshot.recycled_lifetime_text),
    recycled_lifetime_num: toDbValue(snapshot.recycled_lifetime_num),
    recycled_since_registration_text: toDbValue(snapshot.recycled_since_registration_text),
    recycled_since_registration_num: toDbValue(snapshot.recycled_since_registration_num),
    registration_cost_text: toDbValue(snapshot.registration_cost_text),
    registration_cost_num: toDbValue(snapshot.registration_cost_num),
    active_keys_text: toDbValue(snapshot.active_keys_text),
    active_keys_num: toDbValue(snapshot.active_keys_num),
    max_neurons_text: toDbValue(snapshot.max_neurons_text),
    max_neurons_num: toDbValue(snapshot.max_neurons_num),
    net_flow_1_day_text: toDbValue(snapshot.net_flow_1_day_text),
    net_flow_1_day_num: toDbValue(snapshot.net_flow_1_day_num),
    net_flow_7_days_text: toDbValue(snapshot.net_flow_7_days_text),
    net_flow_7_days_num: toDbValue(snapshot.net_flow_7_days_num),
    net_flow_30_days_text: toDbValue(snapshot.net_flow_30_days_text),
    net_flow_30_days_num: toDbValue(snapshot.net_flow_30_days_num),
    root_sell_text: toDbValue(snapshot.root_sell_text),
    root_sell_bool: snapshot.root_sell_bool === null || snapshot.root_sell_bool === undefined ? null : (snapshot.root_sell_bool ? 1 : 0),
    fee_rate_text: toDbValue(snapshot.fee_rate_text),
    market_cap_change_1_day_text: toDbValue(snapshot.market_cap_change_1_day_text),
    price_change_1_hour_text: toDbValue(snapshot.price_change_1_hour_text),
    price_change_1_day_text: toDbValue(snapshot.price_change_1_day_text),
    price_change_1_week_text: toDbValue(snapshot.price_change_1_week_text),
    price_change_1_month_text: toDbValue(snapshot.price_change_1_month_text),
    tao_volume_24_hr_text: toDbValue(snapshot.tao_volume_24_hr_text),
    tao_volume_24_hr_num: toDbValue(snapshot.tao_volume_24_hr_num),
    tao_volume_24_hr_change_1_day_text: toDbValue(snapshot.tao_volume_24_hr_change_1_day_text),
    tao_buy_volume_24_hr_text: toDbValue(snapshot.tao_buy_volume_24_hr_text),
    tao_sell_volume_24_hr_text: toDbValue(snapshot.tao_sell_volume_24_hr_text),
    alpha_volume_24_hr_text: toDbValue(snapshot.alpha_volume_24_hr_text),
    alpha_volume_24_hr_num: toDbValue(snapshot.alpha_volume_24_hr_num),
    alpha_volume_24_hr_change_1_day_text: toDbValue(snapshot.alpha_volume_24_hr_change_1_day_text),
    sentiment_index_text: toDbValue(snapshot.sentiment_index_text),
    sentiment_index_num: toDbValue(snapshot.sentiment_index_num),
    sentiment_index_source_text: toDbValue(snapshot.sentiment_index_source_text),
    fear_and_greed_index: toDbValue(snapshot.fear_and_greed_index),
    fear_and_greed_sentiment: toDbValue(snapshot.fear_and_greed_sentiment),
    alpha_holders_text: toDbValue(snapshot.alpha_holders_text),
    alpha_holders_num: toDbValue(snapshot.alpha_holders_num),
    startup_mode: snapshot.startup_mode ? 1 : 0,
    swap_v3_initialized: snapshot.swap_v3_initialized ? 1 : 0,
    enabled_user_liquidity: snapshot.enabled_user_liquidity ? 1 : 0,
    current_tick: toDbValue(snapshot.current_tick),
    liquidity_raw: toDbValue(snapshot.liquidity_raw),
    raw_json: snapshot.raw_json,
  });

  return Number(info.lastInsertRowid);
}

function upsertSubnetMetadata(db, metadata) {
  const name = toDbValue(metadata.name);
  if (!name) {
    return null;
  }

  const stmt = db.prepare(`
    INSERT INTO subnet_metadata (
      netuid, name, symbol, source, source_url, captured_at, raw_json
    ) VALUES (
      @netuid, @name, @symbol, @source, @source_url, @captured_at, @raw_json
    )
    ON CONFLICT(netuid) DO UPDATE SET
      name = excluded.name,
      symbol = excluded.symbol,
      source = excluded.source,
      source_url = excluded.source_url,
      captured_at = excluded.captured_at,
      raw_json = excluded.raw_json
  `);

  const info = stmt.run({
    netuid: toDbValue(metadata.netuid),
    name,
    symbol: toDbValue(metadata.symbol),
    source: toDbValue(metadata.source) || 'api',
    source_url: toDbValue(metadata.source_url),
    captured_at: metadata.captured_at || new Date().toISOString(),
    raw_json: metadata.raw_json || JSON.stringify(metadata),
  });

  return Number(info.lastInsertRowid || 0);
}

function insertTaoPriceSnapshot(db, snapshot) {
  const stmt = db.prepare(`
    INSERT INTO tao_price_history (
      captured_at, remote_timestamp, source, source_url,
      asset, name, symbol, slug,
      circulating_supply, max_supply, total_supply,
      price_usd, volume_24h_usd, market_cap_usd, fully_diluted_market_cap_usd,
      percent_change_1h, percent_change_24h, percent_change_7d, percent_change_30d, percent_change_60d, percent_change_90d,
      market_cap_dominance, raw_json
    ) VALUES (
      @captured_at, @remote_timestamp, @source, @source_url,
      @asset, @name, @symbol, @slug,
      @circulating_supply, @max_supply, @total_supply,
      @price_usd, @volume_24h_usd, @market_cap_usd, @fully_diluted_market_cap_usd,
      @percent_change_1h, @percent_change_24h, @percent_change_7d, @percent_change_30d, @percent_change_60d, @percent_change_90d,
      @market_cap_dominance, @raw_json
    )
    ON CONFLICT(captured_at) DO UPDATE SET
      remote_timestamp = excluded.remote_timestamp,
      source = excluded.source,
      source_url = excluded.source_url,
      asset = excluded.asset,
      name = excluded.name,
      symbol = excluded.symbol,
      slug = excluded.slug,
      circulating_supply = excluded.circulating_supply,
      max_supply = excluded.max_supply,
      total_supply = excluded.total_supply,
      price_usd = excluded.price_usd,
      volume_24h_usd = excluded.volume_24h_usd,
      market_cap_usd = excluded.market_cap_usd,
      fully_diluted_market_cap_usd = excluded.fully_diluted_market_cap_usd,
      percent_change_1h = excluded.percent_change_1h,
      percent_change_24h = excluded.percent_change_24h,
      percent_change_7d = excluded.percent_change_7d,
      percent_change_30d = excluded.percent_change_30d,
      percent_change_60d = excluded.percent_change_60d,
      percent_change_90d = excluded.percent_change_90d,
      market_cap_dominance = excluded.market_cap_dominance,
      raw_json = excluded.raw_json
  `);

  const info = stmt.run({
    captured_at: snapshot.captured_at,
    remote_timestamp: toDbValue(snapshot.remote_timestamp),
    source: snapshot.source,
    source_url: toDbValue(snapshot.source_url),
    asset: toDbValue(snapshot.asset),
    name: toDbValue(snapshot.name),
    symbol: toDbValue(snapshot.symbol),
    slug: toDbValue(snapshot.slug),
    circulating_supply: toDbValue(snapshot.circulating_supply),
    max_supply: toDbValue(snapshot.max_supply),
    total_supply: toDbValue(snapshot.total_supply),
    price_usd: toDbValue(snapshot.price_usd),
    volume_24h_usd: toDbValue(snapshot.volume_24h_usd),
    market_cap_usd: toDbValue(snapshot.market_cap_usd),
    fully_diluted_market_cap_usd: toDbValue(snapshot.fully_diluted_market_cap_usd),
    percent_change_1h: toDbValue(snapshot.percent_change_1h),
    percent_change_24h: toDbValue(snapshot.percent_change_24h),
    percent_change_7d: toDbValue(snapshot.percent_change_7d),
    percent_change_30d: toDbValue(snapshot.percent_change_30d),
    percent_change_60d: toDbValue(snapshot.percent_change_60d),
    percent_change_90d: toDbValue(snapshot.percent_change_90d),
    market_cap_dominance: toDbValue(snapshot.market_cap_dominance),
    raw_json: snapshot.raw_json,
  });

  return Number(info.lastInsertRowid);
}

function insertTaoFlowSnapshot(db, snapshot) {
  const stmt = db.prepare(`
    INSERT INTO tao_flow_history (
      netuid, captured_at, remote_timestamp, source, source_url, block_number,
      name, symbol,
      tao_flow_text, tao_flow_num,
      tao_in_pool_text, tao_in_pool_num,
      alpha_in_pool_text, alpha_in_pool_num,
      alpha_rewards_text, alpha_rewards_num,
      raw_json
    ) VALUES (
      @netuid, @captured_at, @remote_timestamp, @source, @source_url, @block_number,
      @name, @symbol,
      @tao_flow_text, @tao_flow_num,
      @tao_in_pool_text, @tao_in_pool_num,
      @alpha_in_pool_text, @alpha_in_pool_num,
      @alpha_rewards_text, @alpha_rewards_num,
      @raw_json
    )
    ON CONFLICT(netuid, block_number) DO UPDATE SET
      captured_at = excluded.captured_at,
      remote_timestamp = excluded.remote_timestamp,
      source = excluded.source,
      source_url = excluded.source_url,
      name = excluded.name,
      symbol = excluded.symbol,
      tao_in_pool_text = excluded.tao_in_pool_text,
      tao_in_pool_num = excluded.tao_in_pool_num,
      alpha_in_pool_text = excluded.alpha_in_pool_text,
      alpha_in_pool_num = excluded.alpha_in_pool_num,
      alpha_rewards_text = excluded.alpha_rewards_text,
      alpha_rewards_num = excluded.alpha_rewards_num,
      raw_json = excluded.raw_json
  `);

  const info = stmt.run({
    netuid: snapshot.netuid,
    captured_at: snapshot.captured_at,
    remote_timestamp: toDbValue(snapshot.remote_timestamp),
    source: snapshot.source,
    source_url: toDbValue(snapshot.source_url),
    block_number: toDbValue(snapshot.block_number),
    name: toDbValue(snapshot.name),
    symbol: toDbValue(snapshot.symbol),
    tao_flow_text: toDbValue(snapshot.tao_flow_text),
    tao_flow_num: toDbValue(snapshot.tao_flow_num),
    tao_in_pool_text: toDbValue(snapshot.tao_in_pool_text),
    tao_in_pool_num: toDbValue(snapshot.tao_in_pool_num),
    alpha_in_pool_text: toDbValue(snapshot.alpha_in_pool_text),
    alpha_in_pool_num: toDbValue(snapshot.alpha_in_pool_num),
    alpha_rewards_text: toDbValue(snapshot.alpha_rewards_text),
    alpha_rewards_num: toDbValue(snapshot.alpha_rewards_num),
    raw_json: snapshot.raw_json,
  });

  return Number(info.lastInsertRowid);
}

function insertWalletSnapshot(db, snapshot) {
  const stmt = db.prepare(`
    INSERT INTO wallet_snapshots (
      wallet_name, wallet_address_ss58, wallet_address_hex, network,
      captured_at, remote_timestamp, source, source_url, block_number, rank,
      balance_free_text, balance_free_num,
      balance_staked_text, balance_staked_num,
      balance_staked_alpha_as_tao_text, balance_staked_alpha_as_tao_num,
      balance_staked_root_text, balance_staked_root_num,
      balance_total_text, balance_total_num,
      balance_free_24hr_ago_text, balance_free_24hr_ago_num,
      balance_staked_24hr_ago_text, balance_staked_24hr_ago_num,
      balance_staked_alpha_as_tao_24hr_ago_text, balance_staked_alpha_as_tao_24hr_ago_num,
      balance_staked_root_24hr_ago_text, balance_staked_root_24hr_ago_num,
      balance_total_24hr_ago_text, balance_total_24hr_ago_num,
      balance_free_change_24hr_text, balance_free_change_24hr_num,
      balance_staked_change_24hr_text, balance_staked_change_24hr_num,
      balance_staked_alpha_as_tao_change_24hr_text, balance_staked_alpha_as_tao_change_24hr_num,
      balance_staked_root_change_24hr_text, balance_staked_root_change_24hr_num,
      balance_total_change_24hr_text, balance_total_change_24hr_num,
      created_on_date, created_on_network, coldkey_swap, raw_json
    ) VALUES (
      @wallet_name, @wallet_address_ss58, @wallet_address_hex, @network,
      @captured_at, @remote_timestamp, @source, @source_url, @block_number, @rank,
      @balance_free_text, @balance_free_num,
      @balance_staked_text, @balance_staked_num,
      @balance_staked_alpha_as_tao_text, @balance_staked_alpha_as_tao_num,
      @balance_staked_root_text, @balance_staked_root_num,
      @balance_total_text, @balance_total_num,
      @balance_free_24hr_ago_text, @balance_free_24hr_ago_num,
      @balance_staked_24hr_ago_text, @balance_staked_24hr_ago_num,
      @balance_staked_alpha_as_tao_24hr_ago_text, @balance_staked_alpha_as_tao_24hr_ago_num,
      @balance_staked_root_24hr_ago_text, @balance_staked_root_24hr_ago_num,
      @balance_total_24hr_ago_text, @balance_total_24hr_ago_num,
      @balance_free_change_24hr_text, @balance_free_change_24hr_num,
      @balance_staked_change_24hr_text, @balance_staked_change_24hr_num,
      @balance_staked_alpha_as_tao_change_24hr_text, @balance_staked_alpha_as_tao_change_24hr_num,
      @balance_staked_root_change_24hr_text, @balance_staked_root_change_24hr_num,
      @balance_total_change_24hr_text, @balance_total_change_24hr_num,
      @created_on_date, @created_on_network, @coldkey_swap, @raw_json
    )
    ON CONFLICT(wallet_address_ss58, block_number) DO UPDATE SET
      wallet_name = excluded.wallet_name,
      wallet_address_hex = excluded.wallet_address_hex,
      network = excluded.network,
      captured_at = excluded.captured_at,
      remote_timestamp = excluded.remote_timestamp,
      source = excluded.source,
      source_url = excluded.source_url,
      rank = excluded.rank,
      balance_free_text = excluded.balance_free_text,
      balance_free_num = excluded.balance_free_num,
      balance_staked_text = excluded.balance_staked_text,
      balance_staked_num = excluded.balance_staked_num,
      balance_staked_alpha_as_tao_text = excluded.balance_staked_alpha_as_tao_text,
      balance_staked_alpha_as_tao_num = excluded.balance_staked_alpha_as_tao_num,
      balance_staked_root_text = excluded.balance_staked_root_text,
      balance_staked_root_num = excluded.balance_staked_root_num,
      balance_total_text = excluded.balance_total_text,
      balance_total_num = excluded.balance_total_num,
      balance_free_24hr_ago_text = excluded.balance_free_24hr_ago_text,
      balance_free_24hr_ago_num = excluded.balance_free_24hr_ago_num,
      balance_staked_24hr_ago_text = excluded.balance_staked_24hr_ago_text,
      balance_staked_24hr_ago_num = excluded.balance_staked_24hr_ago_num,
      balance_staked_alpha_as_tao_24hr_ago_text = excluded.balance_staked_alpha_as_tao_24hr_ago_text,
      balance_staked_alpha_as_tao_24hr_ago_num = excluded.balance_staked_alpha_as_tao_24hr_ago_num,
      balance_staked_root_24hr_ago_text = excluded.balance_staked_root_24hr_ago_text,
      balance_staked_root_24hr_ago_num = excluded.balance_staked_root_24hr_ago_num,
      balance_total_24hr_ago_text = excluded.balance_total_24hr_ago_text,
      balance_total_24hr_ago_num = excluded.balance_total_24hr_ago_num,
      balance_free_change_24hr_text = excluded.balance_free_change_24hr_text,
      balance_free_change_24hr_num = excluded.balance_free_change_24hr_num,
      balance_staked_change_24hr_text = excluded.balance_staked_change_24hr_text,
      balance_staked_change_24hr_num = excluded.balance_staked_change_24hr_num,
      balance_staked_alpha_as_tao_change_24hr_text = excluded.balance_staked_alpha_as_tao_change_24hr_text,
      balance_staked_alpha_as_tao_change_24hr_num = excluded.balance_staked_alpha_as_tao_change_24hr_num,
      balance_staked_root_change_24hr_text = excluded.balance_staked_root_change_24hr_text,
      balance_staked_root_change_24hr_num = excluded.balance_staked_root_change_24hr_num,
      balance_total_change_24hr_text = excluded.balance_total_change_24hr_text,
      balance_total_change_24hr_num = excluded.balance_total_change_24hr_num,
      created_on_date = excluded.created_on_date,
      created_on_network = excluded.created_on_network,
      coldkey_swap = excluded.coldkey_swap,
      raw_json = excluded.raw_json
  `);

  const info = stmt.run({
    wallet_name: snapshot.wallet_name,
    wallet_address_ss58: snapshot.wallet_address_ss58,
    wallet_address_hex: toDbValue(snapshot.wallet_address_hex),
    network: snapshot.network,
    captured_at: snapshot.captured_at,
    remote_timestamp: toDbValue(snapshot.remote_timestamp),
    source: snapshot.source,
    source_url: toDbValue(snapshot.source_url),
    block_number: toDbValue(snapshot.block_number),
    rank: toDbValue(snapshot.rank),
    balance_free_text: toDbValue(snapshot.balance_free_text),
    balance_free_num: toDbValue(snapshot.balance_free_num),
    balance_staked_text: toDbValue(snapshot.balance_staked_text),
    balance_staked_num: toDbValue(snapshot.balance_staked_num),
    balance_staked_alpha_as_tao_text: toDbValue(snapshot.balance_staked_alpha_as_tao_text),
    balance_staked_alpha_as_tao_num: toDbValue(snapshot.balance_staked_alpha_as_tao_num),
    balance_staked_root_text: toDbValue(snapshot.balance_staked_root_text),
    balance_staked_root_num: toDbValue(snapshot.balance_staked_root_num),
    balance_total_text: toDbValue(snapshot.balance_total_text),
    balance_total_num: toDbValue(snapshot.balance_total_num),
    balance_free_24hr_ago_text: toDbValue(snapshot.balance_free_24hr_ago_text),
    balance_free_24hr_ago_num: toDbValue(snapshot.balance_free_24hr_ago_num),
    balance_staked_24hr_ago_text: toDbValue(snapshot.balance_staked_24hr_ago_text),
    balance_staked_24hr_ago_num: toDbValue(snapshot.balance_staked_24hr_ago_num),
    balance_staked_alpha_as_tao_24hr_ago_text: toDbValue(snapshot.balance_staked_alpha_as_tao_24hr_ago_text),
    balance_staked_alpha_as_tao_24hr_ago_num: toDbValue(snapshot.balance_staked_alpha_as_tao_24hr_ago_num),
    balance_staked_root_24hr_ago_text: toDbValue(snapshot.balance_staked_root_24hr_ago_text),
    balance_staked_root_24hr_ago_num: toDbValue(snapshot.balance_staked_root_24hr_ago_num),
    balance_total_24hr_ago_text: toDbValue(snapshot.balance_total_24hr_ago_text),
    balance_total_24hr_ago_num: toDbValue(snapshot.balance_total_24hr_ago_num),
    balance_free_change_24hr_text: toDbValue(snapshot.balance_free_change_24hr_text),
    balance_free_change_24hr_num: toDbValue(snapshot.balance_free_change_24hr_num),
    balance_staked_change_24hr_text: toDbValue(snapshot.balance_staked_change_24hr_text),
    balance_staked_change_24hr_num: toDbValue(snapshot.balance_staked_change_24hr_num),
    balance_staked_alpha_as_tao_change_24hr_text: toDbValue(snapshot.balance_staked_alpha_as_tao_change_24hr_text),
    balance_staked_alpha_as_tao_change_24hr_num: toDbValue(snapshot.balance_staked_alpha_as_tao_change_24hr_num),
    balance_staked_root_change_24hr_text: toDbValue(snapshot.balance_staked_root_change_24hr_text),
    balance_staked_root_change_24hr_num: toDbValue(snapshot.balance_staked_root_change_24hr_num),
    balance_total_change_24hr_text: toDbValue(snapshot.balance_total_change_24hr_text),
    balance_total_change_24hr_num: toDbValue(snapshot.balance_total_change_24hr_num),
    created_on_date: toDbValue(snapshot.created_on_date),
    created_on_network: toDbValue(snapshot.created_on_network),
    coldkey_swap: toDbValue(snapshot.coldkey_swap),
    raw_json: snapshot.raw_json,
  });

  return Number(info.lastInsertRowid);
}

function insertWalletStakePosition(db, snapshot) {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO wallet_stake_positions (
      wallet_name, wallet_address_ss58, wallet_address_hex,
      hotkey_name, hotkey_address_ss58, hotkey_address_hex,
      netuid, subnet_rank, subnet_total_holders,
      balance_text, balance_num, balance_as_tao_text, balance_as_tao_num,
      source, source_url, captured_at, remote_timestamp, raw_json
    ) VALUES (
      @wallet_name, @wallet_address_ss58, @wallet_address_hex,
      @hotkey_name, @hotkey_address_ss58, @hotkey_address_hex,
      @netuid, @subnet_rank, @subnet_total_holders,
      @balance_text, @balance_num, @balance_as_tao_text, @balance_as_tao_num,
      @source, @source_url, @captured_at, @remote_timestamp, @raw_json
    )
  `);

  const info = stmt.run({
    wallet_name: snapshot.wallet_name,
    wallet_address_ss58: snapshot.wallet_address_ss58,
    wallet_address_hex: toDbValue(snapshot.wallet_address_hex),
    hotkey_name: toDbValue(snapshot.hotkey_name),
    hotkey_address_ss58: toDbValue(snapshot.hotkey_address_ss58),
    hotkey_address_hex: toDbValue(snapshot.hotkey_address_hex),
    netuid: toDbValue(snapshot.netuid),
    subnet_rank: toDbValue(snapshot.subnet_rank),
    subnet_total_holders: toDbValue(snapshot.subnet_total_holders),
    balance_text: toDbValue(snapshot.balance_text),
    balance_num: toDbValue(snapshot.balance_num),
    balance_as_tao_text: toDbValue(snapshot.balance_as_tao_text),
    balance_as_tao_num: toDbValue(snapshot.balance_as_tao_num),
    source: snapshot.source,
    source_url: toDbValue(snapshot.source_url),
    captured_at: snapshot.captured_at,
    remote_timestamp: toDbValue(snapshot.remote_timestamp),
    raw_json: snapshot.raw_json,
  });

  return Number(info.lastInsertRowid);
}

function insertAlphaHolderSnapshot(db, snapshot) {
  const dedupeKey = String(snapshot.dedupe_key || [
    snapshot.netuid ?? 'unknown',
    snapshot.block_number ?? snapshot.remote_timestamp ?? snapshot.captured_at ?? 'unknown',
    snapshot.coldkey_ss58 ?? snapshot.wallet_address_ss58 ?? 'unknown',
    snapshot.hotkey_address_ss58 ?? 'unknown',
  ].join(':'));
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO alpha_holder_snapshots (
      netuid, captured_at, remote_timestamp, source, source_url, block_number,
      coldkey_ss58, coldkey_hex, hotkey_name, hotkey_address_ss58, hotkey_address_hex,
      subnet_rank, subnet_total_holders, balance_text, balance_num, balance_as_tao_text,
      balance_as_tao_num, dedupe_key, raw_json
    ) VALUES (
      @netuid, @captured_at, @remote_timestamp, @source, @source_url, @block_number,
      @coldkey_ss58, @coldkey_hex, @hotkey_name, @hotkey_address_ss58, @hotkey_address_hex,
      @subnet_rank, @subnet_total_holders, @balance_text, @balance_num, @balance_as_tao_text,
      @balance_as_tao_num, @dedupe_key, @raw_json
    )
  `);

  const info = stmt.run({
    netuid: toDbValue(snapshot.netuid),
    captured_at: snapshot.captured_at,
    remote_timestamp: toDbValue(snapshot.remote_timestamp),
    source: snapshot.source,
    source_url: toDbValue(snapshot.source_url),
    block_number: toDbValue(snapshot.block_number),
    coldkey_ss58: toDbValue(snapshot.wallet_address_ss58 ?? snapshot.coldkey_ss58),
    coldkey_hex: toDbValue(snapshot.wallet_address_hex ?? snapshot.coldkey_hex),
    hotkey_name: toDbValue(snapshot.hotkey_name),
    hotkey_address_ss58: toDbValue(snapshot.hotkey_address_ss58),
    hotkey_address_hex: toDbValue(snapshot.hotkey_address_hex),
    subnet_rank: toDbValue(snapshot.subnet_rank),
    subnet_total_holders: toDbValue(snapshot.subnet_total_holders),
    balance_text: toDbValue(snapshot.balance_text),
    balance_num: toDbValue(snapshot.balance_num),
    balance_as_tao_text: toDbValue(snapshot.balance_as_tao_text),
    balance_as_tao_num: toDbValue(snapshot.balance_as_tao_num),
    dedupe_key: dedupeKey,
    raw_json: snapshot.raw_json,
  });

  return Number(info.lastInsertRowid);
}

function insertWalletTransaction(db, transaction) {
  const stmt = db.prepare(`
    INSERT INTO wallet_transactions (
      wallet_name, wallet_address_ss58, wallet_address_hex, network,
      source_type, action, action_key, dedupe_key, captured_at, event_timestamp,
      remote_timestamp, source, source_url, block_number, extrinsic_id, transaction_hash,
      hotkey_name, hotkey_address_ss58, hotkey_address_hex, netuid,
      amount_tao, amount_alpha, from_ss58, to_ss58, status, note, raw_json
    ) VALUES (
      @wallet_name, @wallet_address_ss58, @wallet_address_hex, @network,
      @source_type, @action, @action_key, @dedupe_key, @captured_at, @event_timestamp,
      @remote_timestamp, @source, @source_url, @block_number, @extrinsic_id, @transaction_hash,
      @hotkey_name, @hotkey_address_ss58, @hotkey_address_hex, @netuid,
      @amount_tao, @amount_alpha, @from_ss58, @to_ss58, @status, @note, @raw_json
    )
    ON CONFLICT(dedupe_key) DO UPDATE SET
      wallet_name = excluded.wallet_name,
      wallet_address_ss58 = excluded.wallet_address_ss58,
      wallet_address_hex = excluded.wallet_address_hex,
      network = excluded.network,
      source_type = excluded.source_type,
      action = excluded.action,
      action_key = excluded.action_key,
      captured_at = excluded.captured_at,
      event_timestamp = excluded.event_timestamp,
      remote_timestamp = excluded.remote_timestamp,
      source = excluded.source,
      source_url = excluded.source_url,
      block_number = excluded.block_number,
      extrinsic_id = excluded.extrinsic_id,
      transaction_hash = excluded.transaction_hash,
      hotkey_name = excluded.hotkey_name,
      hotkey_address_ss58 = excluded.hotkey_address_ss58,
      hotkey_address_hex = excluded.hotkey_address_hex,
      netuid = excluded.netuid,
      amount_tao = excluded.amount_tao,
      amount_alpha = excluded.amount_alpha,
      from_ss58 = excluded.from_ss58,
      to_ss58 = excluded.to_ss58,
      status = excluded.status,
      note = excluded.note,
      raw_json = excluded.raw_json
  `);

  const info = stmt.run({
    wallet_name: transaction.wallet_name,
    wallet_address_ss58: transaction.wallet_address_ss58,
    wallet_address_hex: toDbValue(transaction.wallet_address_hex),
    network: transaction.network,
    source_type: transaction.source_type,
    action: transaction.action,
    action_key: transaction.action_key,
    dedupe_key: transaction.dedupe_key,
    captured_at: transaction.captured_at,
    event_timestamp: transaction.event_timestamp,
    remote_timestamp: toDbValue(transaction.remote_timestamp),
    source: transaction.source,
    source_url: toDbValue(transaction.source_url),
    block_number: toDbValue(transaction.block_number),
    extrinsic_id: toDbValue(transaction.extrinsic_id),
    transaction_hash: toDbValue(transaction.transaction_hash),
    hotkey_name: toDbValue(transaction.hotkey_name),
    hotkey_address_ss58: toDbValue(transaction.hotkey_address_ss58),
    hotkey_address_hex: toDbValue(transaction.hotkey_address_hex),
    netuid: toDbValue(transaction.netuid),
    amount_tao: toDbValue(transaction.amount_tao),
    amount_alpha: toDbValue(transaction.amount_alpha),
    from_ss58: toDbValue(transaction.from_ss58),
    to_ss58: toDbValue(transaction.to_ss58),
    status: toDbValue(transaction.status),
    note: toDbValue(transaction.note),
    raw_json: transaction.raw_json,
  });

  return Number(info.lastInsertRowid);
}

function insertIngestRun(db, run) {
  const stmt = db.prepare(`
    INSERT INTO ingest_runs (
      netuid, started_at, finished_at, duration_ms, source, fallback_used, ok,
      snapshot_id, message, error, detail_json
    ) VALUES (
      @netuid, @started_at, @finished_at, @duration_ms, @source, @fallback_used, @ok,
      @snapshot_id, @message, @error, @detail_json
    )
  `);

  const info = stmt.run({
    netuid: run.netuid,
    started_at: run.started_at,
    finished_at: run.finished_at,
    duration_ms: run.duration_ms,
    source: run.source,
    fallback_used: run.fallback_used ? 1 : 0,
    ok: run.ok ? 1 : 0,
    snapshot_id: toDbValue(run.snapshot_id),
    message: toDbValue(run.message),
    error: toDbValue(run.error),
    detail_json: toDbValue(run.detail_json),
  });

  return Number(info.lastInsertRowid);
}

function getLatestSnapshot(db, netuid) {
  const stmt = db.prepare(`
    SELECT *
    FROM snapshots
    WHERE netuid = ?
    ORDER BY captured_at DESC, id DESC
    LIMIT 1
  `);
  return stmt.get(netuid) || null;
}

function getRecentSnapshots(db, netuid, limit = 20) {
  const stmt = db.prepare(`
    SELECT *
    FROM snapshots
    WHERE netuid = ?
    ORDER BY captured_at DESC, id DESC
    LIMIT ?
  `);
  return stmt.all(netuid, limit);
}

function getHistory(db, netuid, sinceIso) {
  const stmt = db.prepare(`
    SELECT *
    FROM snapshots
    WHERE netuid = ? AND captured_at >= ?
    ORDER BY captured_at ASC, id ASC
  `);
  return stmt.all(netuid, sinceIso);
}

function getLatestTaoPrice(db) {
  const stmt = db.prepare(`
    SELECT *
    FROM tao_price_history
    ORDER BY captured_at DESC, id DESC
    LIMIT 1
  `);
  return stmt.get() || null;
}

function getTaoPriceHistory(db, sinceIso) {
  const stmt = db.prepare(`
    SELECT *
    FROM tao_price_history
    WHERE captured_at >= ?
    ORDER BY captured_at ASC, id ASC
  `);
  return stmt.all(sinceIso);
}

function getTaoFlowHistory(db, netuid, sinceIso) {
  const stmt = db.prepare(`
    SELECT *
    FROM tao_flow_history
    WHERE netuid = ? AND captured_at >= ?
    ORDER BY captured_at ASC, id ASC
  `);
  return stmt.all(netuid, sinceIso);
}

function getLatestWalletSnapshot(db, address) {
  const stmt = db.prepare(`
    SELECT *
    FROM wallet_snapshots
    WHERE wallet_address_ss58 = ?
    ORDER BY captured_at DESC, id DESC
    LIMIT 1
  `);
  return stmt.get(address) || null;
}

function getLatestWalletStakePositions(db, address) {
  const stmt = db.prepare(`
    SELECT *
    FROM wallet_stake_positions
    WHERE wallet_address_ss58 = ?
      AND captured_at = (
        SELECT MAX(captured_at)
        FROM wallet_stake_positions
        WHERE wallet_address_ss58 = ?
      )
    ORDER BY balance_as_tao_num DESC, netuid ASC, hotkey_address_ss58 ASC, id DESC
  `);
  return stmt.all(address, address);
}

function getSubnetMetadata(db, netuid) {
  const stmt = db.prepare(`
    SELECT *
    FROM subnet_metadata
    WHERE netuid = ?
    ORDER BY captured_at DESC, id DESC
    LIMIT 1
  `);
  return stmt.get(netuid) || null;
}

function getLatestAlphaHolderSnapshots(db, netuid, limit = 25) {
  const stmt = db.prepare(`
    SELECT *
    FROM alpha_holder_snapshots
    WHERE netuid = ?
      AND captured_at = (
        SELECT MAX(captured_at)
        FROM alpha_holder_snapshots
        WHERE netuid = ?
      )
    ORDER BY balance_as_tao_num DESC, coldkey_ss58 ASC, hotkey_address_ss58 ASC, id DESC
    LIMIT ?
  `);
  return stmt.all(netuid, netuid, limit);
}

function getLatestAlphaHolderCount(db, netuid) {
  const stmt = db.prepare(`
    SELECT COUNT(*) AS count
    FROM alpha_holder_snapshots
    WHERE netuid = ?
      AND captured_at = (
        SELECT MAX(captured_at)
        FROM alpha_holder_snapshots
        WHERE netuid = ?
      )
      AND COALESCE(balance_as_tao_num, 0) > 0
  `);
  const row = stmt.get(netuid, netuid);
  return Number(row?.count ?? 0);
}

function getLatestAlphaHolderCountsBySubnet(db) {
  const rows = db.prepare(`
    WITH latest_capture AS (
      SELECT netuid, MAX(captured_at) AS captured_at
      FROM alpha_holder_snapshots
      GROUP BY netuid
    )
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
    ORDER BY alpha_holders_num DESC, l.captured_at DESC, a.netuid ASC
  `).all();

  return rows.map((row) => ({
    netuid: Number(row.netuid),
    captured_at: row.captured_at ?? null,
    alpha_holders_num: Number(row.alpha_holders_num ?? 0),
  }));
}

function getAlphaHolderLatestRanking(db, limit = 100) {
  const rows = db.prepare(`
    WITH latest_capture AS (
      SELECT
        netuid,
        MAX(captured_at) AS captured_at
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
    latest_names AS (
      SELECT
        sm.netuid,
        sm.name
      FROM subnet_metadata sm
    )
    SELECT
      lc.netuid,
      lc.captured_at,
      lc.alpha_holders_num,
      ln.name AS subnet_name
    FROM latest_counts lc
    LEFT JOIN latest_names ln
      ON ln.netuid = lc.netuid
    ORDER BY lc.alpha_holders_num DESC, lc.netuid ASC
    LIMIT ?
  `).all(limit).map((row) => ({
    netuid: Number(row.netuid),
    captured_at: row.captured_at ?? null,
    alpha_holders_num: Number(row.alpha_holders_num ?? 0),
    subnet_name: row.subnet_name ?? null,
  }));

  let previousCount = null;
  let previousRank = 0;
  return rows.map((row, index) => {
    const count = Number(row.alpha_holders_num ?? 0);
    const rankNum = count !== previousCount ? index + 1 : previousRank;
    previousCount = count;
    previousRank = rankNum;
    return {
      ...row,
      rank_num: rankNum,
    };
  });
}

function getAlphaHolderRankSeries(db, netuid, sinceIso = null) {
  const stmt = db.prepare(sinceIso ? `
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
  ` : `
    WITH daily_latest AS (
      SELECT
        netuid,
        substr(captured_at, 1, 10) AS day,
        MAX(captured_at) AS captured_at
      FROM alpha_holder_snapshots
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
  `);
  const rows = sinceIso ? stmt.all(sinceIso) : stmt.all();

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
      const rankNum = count !== previousCount ? index + 1 : previousRank;
      previousCount = count;
      previousRank = rankNum;
      if (Number(row.netuid) !== Number(netuid)) continue;
      history.push({
        netuid: Number(row.netuid),
        captured_at: row.captured_at || `${day}T00:00:00.000Z`,
        alpha_holders_num: count,
        rank_num: rankNum,
        subnet_count_num: sortedRows.length,
      });
      break;
    }
  }

  return history;
}

function getAlphaHolderSnapshotLatestCapturedAt(db, netuid) {
  const stmt = db.prepare(`
    SELECT MAX(captured_at) AS captured_at
    FROM alpha_holder_snapshots
    WHERE netuid = ?
  `);
  const row = stmt.get(netuid);
  return row?.captured_at ?? null;
}

function getAlphaHolderSnapshotHistory(db, netuid, sinceIso) {
  const stmt = db.prepare(`
    WITH daily_latest AS (
      SELECT
        substr(captured_at, 1, 10) AS day,
        MAX(captured_at) AS captured_at
      FROM alpha_holder_snapshots
      WHERE netuid = ?
        AND captured_at >= ?
      GROUP BY substr(captured_at, 1, 10)
    )
    SELECT
      l.captured_at,
      COUNT(*) AS alpha_holders_num
    FROM alpha_holder_snapshots a
    JOIN daily_latest l
      ON substr(a.captured_at, 1, 10) = l.day
     AND a.captured_at = l.captured_at
    WHERE a.netuid = ?
      AND COALESCE(a.balance_as_tao_num, 0) > 0
    GROUP BY l.captured_at
    ORDER BY l.captured_at ASC
  `);
  return stmt.all(netuid, sinceIso, netuid);
}

function getAlphaHolderSnapshotCounts(db, netuid, sinceIso) {
  const stmt = db.prepare(`
    SELECT
      captured_at,
      COUNT(*) AS alpha_holders_num
    FROM alpha_holder_snapshots
    WHERE netuid = ?
      AND captured_at >= ?
      AND COALESCE(balance_as_tao_num, 0) > 0
    GROUP BY captured_at
    ORDER BY captured_at ASC
  `);
  return stmt.all(netuid, sinceIso);
}

function getSubnetMetadataMap(db, netuids = []) {
  const ids = [...new Set((Array.isArray(netuids) ? netuids : []).map((value) => Number(value)).filter((value) => Number.isFinite(value) && value > 0))];
  if (!ids.length) return new Map();
  const placeholders = ids.map(() => '?').join(', ');
  const rows = db.prepare(`
    SELECT *
    FROM subnet_metadata
    WHERE netuid IN (${placeholders})
    ORDER BY captured_at DESC, id DESC
  `).all(...ids);
  const map = new Map();
  for (const row of rows) {
    const netuid = Number(row.netuid);
    if (!map.has(netuid)) {
      map.set(netuid, row);
    }
  }
  return map;
}

function countAlphaHolderSnapshots(db, netuid = null) {
  const stmt = netuid !== null && netuid !== undefined
    ? db.prepare(`
      SELECT COUNT(*) AS count
      FROM alpha_holder_snapshots
      WHERE netuid = ?
    `)
    : db.prepare(`
      SELECT COUNT(*) AS count
      FROM alpha_holder_snapshots
    `);
  return netuid !== null && netuid !== undefined ? stmt.get(netuid).count : stmt.get().count;
}

function deleteAlphaHolderSnapshotsInRange(db, netuid, startIso, endIso) {
  const rows = db.prepare(`
    SELECT id
    FROM alpha_holder_snapshots
    WHERE netuid = ?
      AND captured_at >= ?
      AND captured_at <= ?
  `).all(netuid, startIso, endIso);

  if (!rows.length) return 0;

  const ids = rows.map((row) => row.id);
  const placeholders = ids.map(() => '?').join(', ');

  db.exec('BEGIN');
  try {
    const info = db.prepare(`
      DELETE FROM alpha_holder_snapshots
      WHERE id IN (${placeholders})
    `).run(...ids);
    db.exec('COMMIT');
    return Number(info.changes || 0);
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function getWalletStakePositionsHistory(db, address, sinceIso) {
  const stmt = db.prepare(`
    SELECT *
    FROM wallet_stake_positions
    WHERE wallet_address_ss58 = ? AND captured_at >= ?
    ORDER BY captured_at ASC, netuid ASC, hotkey_address_ss58 ASC, id ASC
  `);
  return stmt.all(address, sinceIso);
}

function getWalletStakePositionsInRange(db, { startIso = null, endIso = null } = {}) {
  const clauses = [];
  const params = [];

  if (startIso) {
    clauses.push('captured_at >= ?');
    params.push(startIso);
  }
  if (endIso) {
    clauses.push('captured_at <= ?');
    params.push(endIso);
  }

  const whereClause = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const stmt = db.prepare(`
    SELECT *
    FROM wallet_stake_positions
    ${whereClause}
    ORDER BY wallet_address_ss58 ASC, captured_at ASC, netuid ASC, hotkey_address_ss58 ASC, id ASC
  `);
  return stmt.all(...params);
}

function getWalletTransactions(db, address, sinceIso = null) {
  if (sinceIso) {
    const stmt = db.prepare(`
      SELECT *
      FROM wallet_transactions
      WHERE wallet_address_ss58 = ? AND event_timestamp >= ?
      ORDER BY event_timestamp DESC, id DESC
    `);
    return stmt.all(address, sinceIso);
  }

  const stmt = db.prepare(`
    SELECT *
    FROM wallet_transactions
    WHERE wallet_address_ss58 = ?
    ORDER BY event_timestamp DESC, id DESC
  `);
  return stmt.all(address);
}

function countWalletTransactions(db, address = null) {
  const stmt = address
    ? db.prepare(`
      SELECT COUNT(*) AS count
      FROM wallet_transactions
      WHERE wallet_address_ss58 = ?
    `)
    : db.prepare(`
      SELECT COUNT(*) AS count
      FROM wallet_transactions
    `);
  return address ? stmt.get(address).count : stmt.get().count;
}

function getWalletHistory(db, address, sinceIso) {
  const stmt = db.prepare(`
    SELECT *
    FROM wallet_snapshots
    WHERE wallet_address_ss58 = ? AND captured_at >= ?
    ORDER BY captured_at ASC, id ASC
  `);
  return stmt.all(address, sinceIso);
}

function countWalletSnapshots(db, address = null) {
  const stmt = address
    ? db.prepare(`
      SELECT COUNT(*) AS count
      FROM wallet_snapshots
      WHERE wallet_address_ss58 = ?
    `)
    : db.prepare(`
      SELECT COUNT(*) AS count
      FROM wallet_snapshots
    `);
  return address ? stmt.get(address).count : stmt.get().count;
}

function deleteWalletStakePositions(db, address) {
  const stmt = db.prepare(`
    DELETE FROM wallet_stake_positions
    WHERE wallet_address_ss58 = ?
  `);
  const info = stmt.run(address);
  return Number(info.changes || 0);
}

function deleteWalletStakePositionsInRange(db, address, startIso, endIso) {
  const rows = db.prepare(`
    SELECT id
    FROM wallet_stake_positions
    WHERE wallet_address_ss58 = ?
      AND captured_at >= ?
      AND captured_at <= ?
  `).all(address, startIso, endIso);

  if (!rows.length) return 0;

  const ids = rows.map((row) => row.id);
  const placeholders = ids.map(() => '?').join(', ');

  db.exec('BEGIN');
  try {
    const info = db.prepare(`
      DELETE FROM wallet_stake_positions
      WHERE id IN (${placeholders})
    `).run(...ids);
    db.exec('COMMIT');
    return Number(info.changes || 0);
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function walletStakePositionExists(db, address, netuid, hotkeyAddress, capturedAt) {
  const stmt = db.prepare(`
    SELECT 1
    FROM wallet_stake_positions
    WHERE wallet_address_ss58 = ?
      AND netuid IS ?
      AND hotkey_address_ss58 IS ?
      AND captured_at = ?
    LIMIT 1
  `);
  return Boolean(stmt.get(address, netuid ?? null, hotkeyAddress ?? null, capturedAt));
}

function walletSnapshotExists(db, address, blockNumber) {
  if (blockNumber === null || blockNumber === undefined) return false;
  const stmt = db.prepare(`
    SELECT 1
    FROM wallet_snapshots
    WHERE wallet_address_ss58 = ? AND block_number = ?
    LIMIT 1
  `);
  return Boolean(stmt.get(address, blockNumber));
}

function getLatestIngestRun(db, netuid) {
  const stmt = db.prepare(`
    SELECT *
    FROM ingest_runs
    WHERE netuid = ?
    ORDER BY started_at DESC, id DESC
    LIMIT 1
  `);
  return stmt.get(netuid) || null;
}

function getLatestIngestRunBySource(db, source) {
  const stmt = db.prepare(`
    SELECT *
    FROM ingest_runs
    WHERE source = ?
    ORDER BY started_at DESC, id DESC
    LIMIT 1
  `);
  return stmt.get(source) || null;
}

function getLatestIngestRunBySources(db, netuid, sources = []) {
  const sourceList = Array.isArray(sources)
    ? sources.map((source) => String(source || '').trim()).filter(Boolean)
    : [];
  if (!sourceList.length) return null;
  const placeholders = sourceList.map(() => '?').join(', ');
  const stmt = db.prepare(`
    SELECT *
    FROM ingest_runs
    WHERE netuid = ? AND source IN (${placeholders})
    ORDER BY started_at DESC, id DESC
    LIMIT 1
  `);
  return stmt.get(netuid, ...sourceList) || null;
}

function countSnapshots(db, netuid) {
  const stmt = db.prepare(`
    SELECT COUNT(*) AS count
    FROM snapshots
    WHERE netuid = ?
  `);
  return stmt.get(netuid).count;
}

function snapshotExists(db, netuid, blockNumber) {
  if (blockNumber === null || blockNumber === undefined) return false;
  const stmt = db.prepare(`
    SELECT 1
    FROM snapshots
    WHERE netuid = ? AND block_number = ?
    LIMIT 1
  `);
  return Boolean(stmt.get(netuid, blockNumber));
}

function taoFlowSnapshotExists(db, netuid, blockNumber) {
  if (blockNumber === null || blockNumber === undefined) return false;
  const stmt = db.prepare(`
    SELECT 1
    FROM tao_flow_history
    WHERE netuid = ? AND block_number = ?
    LIMIT 1
  `);
  return Boolean(stmt.get(netuid, blockNumber));
}

function deleteSnapshotsInRange(db, netuid, startIso, endIso) {
  const rows = db.prepare(`
    SELECT id
    FROM snapshots
    WHERE netuid = ?
      AND captured_at >= ?
      AND captured_at <= ?
  `).all(netuid, startIso, endIso);

  if (!rows.length) return 0;

  const ids = rows.map((row) => row.id);
  const placeholders = ids.map(() => '?').join(', ');

  db.exec('BEGIN');
  try {
    db.prepare(`DELETE FROM ingest_runs WHERE snapshot_id IN (${placeholders})`).run(...ids);
    const info = db.prepare(`
      DELETE FROM snapshots
      WHERE id IN (${placeholders})
    `).run(...ids);
    db.exec('COMMIT');
    return Number(info.changes || 0);
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function deleteTaoPriceHistoryInRange(db, startIso, endIso) {
  const rows = db.prepare(`
    SELECT id
    FROM tao_price_history
    WHERE captured_at >= ?
      AND captured_at <= ?
  `).all(startIso, endIso);

  if (!rows.length) return 0;

  const ids = rows.map((row) => row.id);
  const placeholders = ids.map(() => '?').join(', ');

  db.exec('BEGIN');
  try {
    const info = db.prepare(`
      DELETE FROM tao_price_history
      WHERE id IN (${placeholders})
    `).run(...ids);
    db.exec('COMMIT');
    return Number(info.changes || 0);
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function deleteTaoFlowHistoryInRange(db, netuid, startIso, endIso) {
  const rows = db.prepare(`
    SELECT id
    FROM tao_flow_history
    WHERE netuid = ?
      AND captured_at >= ?
      AND captured_at <= ?
  `).all(netuid, startIso, endIso);

  if (!rows.length) return 0;

  const ids = rows.map((row) => row.id);
  const placeholders = ids.map(() => '?').join(', ');

  db.exec('BEGIN');
  try {
    const info = db.prepare(`
      DELETE FROM tao_flow_history
      WHERE id IN (${placeholders})
    `).run(...ids);
    db.exec('COMMIT');
    return Number(info.changes || 0);
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function deleteWalletSnapshotsInRange(db, address, startIso, endIso) {
  const rows = db.prepare(`
    SELECT id
    FROM wallet_snapshots
    WHERE wallet_address_ss58 = ?
      AND captured_at >= ?
      AND captured_at <= ?
  `).all(address, startIso, endIso);

  if (!rows.length) return 0;

  const ids = rows.map((row) => row.id);
  const placeholders = ids.map(() => '?').join(', ');

  db.exec('BEGIN');
  try {
    const info = db.prepare(`
      DELETE FROM wallet_snapshots
      WHERE id IN (${placeholders})
    `).run(...ids);
    db.exec('COMMIT');
    return Number(info.changes || 0);
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function getSetting(db, key) {
  const stmt = db.prepare(`
    SELECT value
    FROM app_settings
    WHERE key = ?
    LIMIT 1
  `);
  const row = stmt.get(key);
  return row ? row.value : null;
}

function setSetting(db, key, value) {
  const stmt = db.prepare(`
    INSERT INTO app_settings (key, value, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      updated_at = CURRENT_TIMESTAMP
  `);
  stmt.run(key, String(value));
  return String(value);
}

module.exports = {
  openDatabase,
  insertSnapshot,
  upsertSubnetMetadata,
  insertTaoPriceSnapshot,
  insertTaoFlowSnapshot,
  insertWalletSnapshot,
  insertWalletStakePosition,
  insertAlphaHolderSnapshot,
  insertWalletTransaction,
  insertIngestRun,
  getLatestSnapshot,
  getRecentSnapshots,
  getHistory,
  getLatestTaoPrice,
  getTaoPriceHistory,
  getTaoFlowHistory,
  getLatestWalletSnapshot,
  getLatestWalletStakePositions,
  getSubnetMetadata,
  getSubnetMetadataMap,
  getLatestAlphaHolderSnapshots,
  getLatestAlphaHolderCount,
  getLatestAlphaHolderCountsBySubnet,
  getAlphaHolderLatestRanking,
  getAlphaHolderSnapshotLatestCapturedAt,
  getAlphaHolderRankSeries,
  getAlphaHolderSnapshotHistory,
  getAlphaHolderSnapshotCounts,
  getWalletStakePositionsHistory,
  getWalletStakePositionsInRange,
  getWalletTransactions,
  getWalletHistory,
  getLatestIngestRun,
  getLatestIngestRunBySource,
  getLatestIngestRunBySources,
  countSnapshots,
  countWalletSnapshots,
  countWalletTransactions,
  countAlphaHolderSnapshots,
  snapshotExists,
  taoFlowSnapshotExists,
  walletSnapshotExists,
  walletStakePositionExists,
  deleteWalletStakePositions,
  deleteWalletStakePositionsInRange,
  deleteAlphaHolderSnapshotsInRange,
  deleteSnapshotsInRange,
  deleteTaoPriceHistoryInRange,
  deleteTaoFlowHistoryInRange,
  deleteWalletSnapshotsInRange,
  getSetting,
  setSetting,
};
