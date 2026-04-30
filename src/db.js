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
      fear_and_greed_index TEXT,
      fear_and_greed_sentiment TEXT,
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

    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  ensureSnapshotColumns(db);
  ensureTaoPriceColumns(db);
  return db;
}

function ensureSnapshotColumns(db) {
  const columns = new Set(
    db.prepare(`PRAGMA table_info(snapshots)`).all().map((row) => row.name)
  );

  const additions = [
    ['emission_text', 'TEXT'],
    ['emission_num', 'REAL'],
    ['emission_percent_text', 'TEXT'],
    ['emission_percent_num', 'REAL'],
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
    ['root_sell_text', 'TEXT'],
    ['root_sell_bool', 'INTEGER'],
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
      total_tao_text, total_alpha_text, alpha_in_pool_text, alpha_staked_text,
      root_prop_text, emission_text, emission_num, emission_percent_text, emission_percent_num, emission_per_day_tao_text, emission_per_day_tao_num,
      owner_per_day_tao_text, owner_per_day_tao_num, miner_per_day_tao_text, miner_per_day_tao_num, validator_per_day_tao_text, validator_per_day_tao_num,
      projected_emission_text, projected_emission_num, incentive_burn_text, incentive_burn_num,
      recycled_24_hours_text, recycled_24_hours_num, recycled_lifetime_text, recycled_lifetime_num, recycled_since_registration_text, recycled_since_registration_num,
      registration_cost_text, registration_cost_num, active_keys_text, active_keys_num, max_neurons_text, max_neurons_num,
      net_flow_1_day_text, net_flow_1_day_num, net_flow_7_days_text, net_flow_7_days_num, net_flow_30_days_text, net_flow_30_days_num,
      root_sell_text, root_sell_bool, fee_rate_text,
      market_cap_change_1_day_text,
      price_change_1_hour_text, price_change_1_day_text, price_change_1_week_text, price_change_1_month_text,
      tao_volume_24_hr_text, tao_volume_24_hr_num, tao_volume_24_hr_change_1_day_text,
      tao_buy_volume_24_hr_text, tao_sell_volume_24_hr_text,
      alpha_volume_24_hr_text, alpha_volume_24_hr_num, alpha_volume_24_hr_change_1_day_text,
      fear_and_greed_index, fear_and_greed_sentiment,
      startup_mode, swap_v3_initialized, enabled_user_liquidity, current_tick, liquidity_raw,
      raw_json
    ) VALUES (
      @netuid, @captured_at, @remote_timestamp, @source, @source_url, @block_number,
      @name, @symbol, @rank,
      @price_text, @price_num,
      @market_cap_text, @market_cap_num,
      @liquidity_text, @liquidity_num,
      @total_tao_text, @total_alpha_text, @alpha_in_pool_text, @alpha_staked_text,
      @root_prop_text, @emission_text, @emission_num, @emission_percent_text, @emission_percent_num, @emission_per_day_tao_text, @emission_per_day_tao_num,
      @owner_per_day_tao_text, @owner_per_day_tao_num, @miner_per_day_tao_text, @miner_per_day_tao_num, @validator_per_day_tao_text, @validator_per_day_tao_num,
      @projected_emission_text, @projected_emission_num, @incentive_burn_text, @incentive_burn_num,
      @recycled_24_hours_text, @recycled_24_hours_num, @recycled_lifetime_text, @recycled_lifetime_num, @recycled_since_registration_text, @recycled_since_registration_num,
      @registration_cost_text, @registration_cost_num, @active_keys_text, @active_keys_num, @max_neurons_text, @max_neurons_num,
      @net_flow_1_day_text, @net_flow_1_day_num, @net_flow_7_days_text, @net_flow_7_days_num, @net_flow_30_days_text, @net_flow_30_days_num,
      @root_sell_text, @root_sell_bool, @fee_rate_text,
      @market_cap_change_1_day_text,
      @price_change_1_hour_text, @price_change_1_day_text, @price_change_1_week_text, @price_change_1_month_text,
      @tao_volume_24_hr_text, @tao_volume_24_hr_num, @tao_volume_24_hr_change_1_day_text,
      @tao_buy_volume_24_hr_text, @tao_sell_volume_24_hr_text,
      @alpha_volume_24_hr_text, @alpha_volume_24_hr_num, @alpha_volume_24_hr_change_1_day_text,
      @fear_and_greed_index, @fear_and_greed_sentiment,
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
    fear_and_greed_index: toDbValue(snapshot.fear_and_greed_index),
    fear_and_greed_sentiment: toDbValue(snapshot.fear_and_greed_sentiment),
    startup_mode: snapshot.startup_mode ? 1 : 0,
    swap_v3_initialized: snapshot.swap_v3_initialized ? 1 : 0,
    enabled_user_liquidity: snapshot.enabled_user_liquidity ? 1 : 0,
    current_tick: toDbValue(snapshot.current_tick),
    liquidity_raw: toDbValue(snapshot.liquidity_raw),
    raw_json: snapshot.raw_json,
  });

  return Number(info.lastInsertRowid);
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
  insertTaoPriceSnapshot,
  insertIngestRun,
  getLatestSnapshot,
  getRecentSnapshots,
  getHistory,
  getLatestTaoPrice,
  getTaoPriceHistory,
  getLatestIngestRun,
  countSnapshots,
  snapshotExists,
  deleteSnapshotsInRange,
  deleteTaoPriceHistoryInRange,
  getSetting,
  setSetting,
};
