'use strict';

const fs = require('node:fs');
const path = require('node:path');

const POLL_INTERVAL_OPTIONS = [60, 120, 240];

function intOr(defaultValue, value) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) ? parsed : defaultValue;
}

function boolOr(defaultValue, value) {
  if (value === undefined || value === null || value === '') return defaultValue;
  if (typeof value === 'boolean') return value;
  if (/^(true|1|yes|on)$/i.test(String(value))) return true;
  if (/^(false|0|no|off)$/i.test(String(value))) return false;
  return defaultValue;
}

function normalizePollIntervalMinutes(value, fallback = 60) {
  const parsed = intOr(fallback, value);
  return POLL_INTERVAL_OPTIONS.includes(parsed) ? parsed : fallback;
}

function parseWalletHotkeys(env = process.env, walletPrefix = '', fallbackNetwork = 'finney') {
  const hotkeys = [];
  const maxHotkeys = 20;

  for (let index = 1; index <= maxHotkeys; index += 1) {
    const prefix = `${walletPrefix}HOTKEY_${index}_`;
    const ss58 = String(env[`${prefix}SS58`] || env[`${prefix}ADDRESS`] || '').trim();
    const name = String(env[`${prefix}NAME`] || '').trim();
    const network = String(env[`${prefix}NETWORK`] || fallbackNetwork || 'finney').trim() || (fallbackNetwork || 'finney');
    const netuid = intOr(null, env[`${prefix}NETUID`]);

    if (!ss58 && !name && netuid === null && !env[`${prefix}NETWORK`]) {
      continue;
    }
    if (!ss58) {
      continue;
    }

    hotkeys.push({
      name: name || ss58,
      ss58,
      network,
      netuid,
    });
  }

  return hotkeys;
}

function parseWalletConfigs(env = process.env) {
  const wallets = [];
  const maxWallets = 20;

  for (let index = 1; index <= maxWallets; index += 1) {
    const prefix = `TAOSTATS_WALLET_${index}_`;
    const name = String(env[`${prefix}NAME`] || '').trim();
    const coldkey = String(env[`${prefix}COLDKEY`] || env[`${prefix}SS58`] || env[`${prefix}ADDRESS`] || '').trim();
    const network = String(env[`${prefix}NETWORK`] || 'finney').trim() || 'finney';

    if (!name && !coldkey && !env[`${prefix}NETWORK`]) {
      continue;
    }
    if (!name || !coldkey) {
      continue;
    }

    const hotkeys = parseWalletHotkeys(env, prefix, network);
    wallets.push({
      name,
      coldkey,
      ss58: coldkey,
      network,
      hotkeys,
    });
  }

  return wallets;
}

function parseEnvLine(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;

  const equalsIndex = trimmed.indexOf('=');
  if (equalsIndex === -1) return null;

  const key = trimmed.slice(0, equalsIndex).trim();
  if (!key) return null;

  let value = trimmed.slice(equalsIndex + 1).trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }

  return [key, value];
}

function loadDotEnvFile(dotenvPath = path.join(process.cwd(), '.env')) {
  if (!fs.existsSync(dotenvPath)) return false;

  const content = fs.readFileSync(dotenvPath, 'utf8');
  for (const line of content.split(/\r?\n/)) {
    const parsed = parseEnvLine(line);
    if (!parsed) continue;
    const [key, value] = parsed;
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
  return true;
}

function loadConfig() {
  loadDotEnvFile();

  const netuid = intOr(110, process.env.TAOSTATS_NETUID);
  const port = intOr(3000, process.env.PORT);
  const pollIntervalMinutes = normalizePollIntervalMinutes(process.env.POLL_INTERVAL_MINUTES);
  const dbPath = process.env.DB_PATH || path.join(process.cwd(), 'data', 'sn110-tracker.sqlite');
  const taostatsApiKey = process.env.TAOSTATS_API_KEY || '';
  const taostatsAuthHeader = process.env.TAOSTATS_AUTH_HEADER || taostatsApiKey;
  const taostatsBaseUrl = process.env.TAOSTATS_BASE_URL || 'https://api.taostats.io';
  const taostatsPublicBaseUrl = process.env.TAOSTATS_PUBLIC_BASE_URL || 'https://taostats.io';
  const taostatsApiMaxRequestsPerMinute = intOr(5, process.env.TAOSTATS_API_MAX_REQUESTS_PER_MINUTE);
  const taostatsBackfillDays = intOr(0, process.env.TAOSTATS_BACKFILL_DAYS);
  const taostatsBackfillFrequency = process.env.TAOSTATS_BACKFILL_FREQUENCY || 'by_hour';
  const taostatsBackfillOnStartup = boolOr(false, process.env.TAOSTATS_BACKFILL_ON_STARTUP);
  const taostatsBackfillOverwrite = boolOr(true, process.env.TAOSTATS_BACKFILL_OVERWRITE);
  const wallets = parseWalletConfigs(process.env);

  return {
    netuid,
    port,
    dbPath,
    pollIntervalMinutes,
    pollIntervalMs: pollIntervalMinutes * 60 * 1000,
    taostatsApiKey,
    taostatsAuthHeader,
    taostatsBaseUrl,
    taostatsPublicBaseUrl,
    taostatsApiMaxRequestsPerMinute,
    taostatsBackfillDays,
    taostatsBackfillFrequency,
    taostatsBackfillOnStartup,
    taostatsBackfillOverwrite,
    wallets,
    userAgent: 'sn110-tracker/1.0 (+local dashboard)',
  };
}

module.exports = {
  POLL_INTERVAL_OPTIONS,
  loadConfig,
  loadDotEnvFile,
  parseEnvLine,
  parseWalletHotkeys,
  parseWalletConfigs,
  boolOr,
  normalizePollIntervalMinutes,
};
