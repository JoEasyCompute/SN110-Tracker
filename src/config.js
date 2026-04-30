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
    userAgent: 'sn110-tracker/1.0 (+local dashboard)',
  };
}

module.exports = {
  POLL_INTERVAL_OPTIONS,
  loadConfig,
  loadDotEnvFile,
  parseEnvLine,
  boolOr,
  normalizePollIntervalMinutes,
};
