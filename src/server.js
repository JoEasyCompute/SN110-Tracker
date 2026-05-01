'use strict';

const http = require('node:http');

const {
  getLatestSnapshot,
  getRecentSnapshots,
  getHistory,
  getLatestTaoPrice,
  getTaoPriceHistory,
  getTaoFlowHistory,
  getLatestIngestRun,
  countSnapshots,
} = require('./db');
const { POLL_INTERVAL_OPTIONS } = require('./config');

const TAO_PER_RAO = 1_000_000_000;

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
  return date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function readJsonBody(req) {
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
      if (!body) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(new Error('Request body must be valid JSON'));
      }
    });
    req.on('error', reject);
  });
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

function getSubnetDataMetricDefs() {
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
        ? formatSignedPercent(priceComparison.pct, 2)
        : '—',
      subtext: priceComparison && Number.isFinite(priceComparison.pct)
        ? 'Token Price change over the last 24 hours'
        : 'Not enough history yet for a 24h price read',
      tone: priceComparison && Number.isFinite(priceComparison.pct)
        ? (priceComparison.pct >= 0 ? 'positive' : 'negative')
        : 'neutral',
      metricData: priceDef ? { ...buildMetricCardModel(latest, priceDef).metricData, displayValue: priceComparison && Number.isFinite(priceComparison.pct) ? formatSignedPercent(priceComparison.pct, 2) : '—' } : null,
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

function renderSubnetDataCards(latest) {
  return renderMetricCards(latest, getSubnetDataMetricDefs(), { defaultSubtext: false });
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

function buildPageModel({ db, config, netuid }) {
  const latest = getLatestSnapshot(db, netuid);
  const recent = getRecentSnapshots(db, netuid, 12);
  const ingestRun = getLatestIngestRun(db, netuid);
  const totalSnapshots = countSnapshots(db, netuid);
  const sinceIso = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const historyRaw = latest ? getHistory(db, netuid, sinceIso) : [];
  const taoPriceHistory = latest ? getTaoPriceHistory(db, sinceIso) : [];
  const latestTaoPrice = getLatestTaoPrice(db);
  const history = attachTaoPrice(historyRaw, taoPriceHistory);
  const recentWithPrice = attachTaoPrice(recent.slice().reverse(), taoPriceHistory).reverse();
  const latestWithPrice = latest
    ? {
        ...latest,
        tao_price_usd: latest.tao_price_usd ?? latestTaoPrice?.price_usd ?? null,
        tao_price_captured_at: latest.tao_price_captured_at ?? latestTaoPrice?.captured_at ?? null,
      }
    : null;
  const comparisons = latestWithPrice ? buildComparisons(history, latestWithPrice) : [];

  return {
    config,
    netuid,
    latest: latestWithPrice,
    recent: recentWithPrice,
    ingestRun,
    totalSnapshots,
    history,
    comparisons,
    latestTaoPrice,
    latestTaoPriceUsd: latestWithPrice?.tao_price_usd ?? latestTaoPrice?.price_usd ?? null,
    nextPollAtIso: config.nextPollAtIso ?? null,
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
  const metricAttr = metricDataAttribute(metricData);
  const attrs = clickable
    ? `type="button" class="card card-button ${tone}"${metricAttr}${unitHint ? ` title="${escapeHtml(unitHint)}"` : ''}`
    : `class="card ${tone}"${metricAttr}${unitHint ? ` title="${escapeHtml(unitHint)}"` : ''}`;
  const tag = clickable ? 'button' : 'section';
  return `
    <${tag} ${attrs}>
      ${description ? `<span class="card-info-badge" title="${escapeHtml(description)}" aria-label="${escapeHtml(description)}" aria-hidden="true">i</span>` : ''}
      <div class="card-label">${escapeHtml(label)}</div>
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

function renderAdminPanel({ netuid, config, recent, latestRunCard, ingestRun }) {
  return `
      <details class="admin-panel">
        <summary>Admin panel</summary>
        <div class="admin-panel-body">
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
              <p class="empty" id="backfill-status" hidden></p>
            </div>
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

function renderPage(model) {
  const { latest, recent, ingestRun, totalSnapshots, comparisons, config, netuid, latestTaoPriceUsd, nextPollAtIso } = model;
  const latestMetricDefs = getLatestMetricDefs();
  const signal = latest ? buildSignalSummary(latest, comparisons, latestMetricDefs) : null;
  const title = `SN${netuid} Tracker`;
  const subtitle = latest
    ? `Latest snapshot captured ${formatRelativeIso(latest.captured_at)}`
    : 'No snapshots captured yet';

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
        <div>
          <div class="eyebrow">Subnet SN${netuid}</div>
          <h1>${escapeHtml(title)}</h1>
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
        <div>
          <div class="eyebrow">Subnet SN${netuid}</div>
          <h1>${escapeHtml(title)}</h1>
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
        display: flex; justify-content: space-between; gap: 16px; align-items: center;
        margin-bottom: 24px;
      }
      .topbar .actions { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
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
      .eyebrow { color: var(--accent); letter-spacing: .18em; text-transform: uppercase; font-size: 12px; margin-bottom: 8px; }
      h1 { margin: 0; font-size: clamp(32px, 4vw, 48px); }
      .hero p { color: var(--muted); margin: 12px 0 0; }
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
        pointer-events: none;
      }
      .positive .card-value { color: var(--positive); }
      .negative .card-value { color: var(--negative); }
      .section { margin-top: 24px; }
      .section h2 { margin: 0 0 12px; font-size: 20px; }
      .grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 14px; }
      .grid.compact { grid-template-columns: repeat(3, minmax(0, 1fr)); }
      .grid.stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
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
        margin: 10px 0 14px;
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
      .chart-frame canvas {
        display: block;
        width: 100% !important;
        height: 100% !important;
      }
      .table-wrap { overflow-x: auto; border: 1px solid var(--border); border-radius: 16px; }
      table { width: 100%; border-collapse: collapse; min-width: 900px; background: rgba(16, 23, 34, 0.88); }
      th, td { padding: 12px 14px; border-bottom: 1px solid var(--border); text-align: left; }
      th { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: .08em; }
      .empty { color: var(--muted); padding: 16px; }
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
      .modal-grid {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 14px;
        margin-bottom: 16px;
      }
      .modal-chart {
        min-height: 360px;
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
      }
      .admin-panel > summary::-webkit-details-marker {
        display: none;
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
      .admin-grid {
        display: grid;
        gap: 14px;
      }
      body.modal-open {
        overflow: hidden;
      }
      @media (max-width: 1100px) {
        .hero, .grid, .grid.stats, .chart-grid, .modal-grid { grid-template-columns: 1fr; }
      }
      @media (max-width: 700px) {
        .shell { padding: 16px; }
        .grid.compact { grid-template-columns: 1fr; }
      }
    </style>
  </head>
  <body>
    <div class="shell" data-tao-price-usd="${escapeHtml(latestTaoPriceUsd ?? '')}" data-next-poll-at="${escapeHtml(nextPollAtIso ?? '')}">
      <div class="topbar">
        <div class="muted">Local Taostats tracker for SN${netuid}</div>
        <div class="actions">
          <button class="price-badge price-badge-button" id="tao-price-label" type="button" aria-live="polite" title="Click to view TAO price history">${escapeHtml(taoPriceText)}</button>
          <div class="price-badge next-poll-badge" id="next-poll-label" data-next-poll-at="${escapeHtml(nextPollAtIso ?? '')}" title="${escapeHtml(nextPollTitle)}">${escapeHtml(nextPollText)}</div>
          <button class="button" id="currency-toggle" type="button" disabled>Show USD</button>
          <div class="poll-switcher" role="tablist" aria-label="Polling interval">
            ${pollIntervalButtons}
          </div>
          <button class="button primary" id="refresh-btn">Refresh now</button>
        </div>
      </div>

      ${latestCard}

      ${renderSignalSection(signal)}

      <section class="section">
        <h2>Key metrics</h2>
        <div class="grid">${cards}</div>
      </section>

      <section class="section">
        <h2>Subnet stats</h2>
        <div class="grid stats">${latest ? renderSubnetDataCards(latest) : ''}</div>
      </section>

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

      ${renderAdminPanel({ netuid, config, recent, latestRunCard, ingestRun })}

      <div class="footer">
        <div>Database snapshots: ${totalSnapshots}</div>
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
        <div class="range-switcher" role="tablist" aria-label="Historical range">
          <button class="button range-button" type="button" data-history-range="1" aria-pressed="false">24H</button>
          <button class="button range-button" type="button" data-history-range="7" aria-pressed="false">7D</button>
          <button class="button range-button active" type="button" data-history-range="30" aria-pressed="true">30D</button>
          <button class="button range-button" type="button" data-history-range="60" aria-pressed="false">60D</button>
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

    <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.3/dist/chart.umd.min.js"></script>
    <script>
      const netuid = ${JSON.stringify(netuid)};
      const shell = document.querySelector('.shell');
      const state = {
        displayCurrency: localStorage.getItem('sn110-display-currency') === 'usd' ? 'usd' : 'tao',
        latestTaoPriceUsd: Number(shell?.dataset.taoPriceUsd || ''),
        nextPollAtIso: shell?.dataset.nextPollAt || null,
        pollIntervalMinutes: ${JSON.stringify(config.pollIntervalMinutes)},
        history: null,
        flowHistory: null,
        loading: null,
        historyCache: new Map(),
        historyLoading: new Map(),
        charts: new Map(),
        modalChart: null,
        modalMetric: null,
        modalHistory: null,
        modalHistoryDays: 30,
        modalHistoryRequestId: 0,
        explanationOpen: true,
      };

      if (!Number.isFinite(state.latestTaoPriceUsd)) {
        state.latestTaoPriceUsd = null;
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
        canvas: document.getElementById('history-modal-canvas'),
        empty: document.getElementById('history-modal-empty'),
        note: document.getElementById('history-modal-note'),
        close: document.getElementById('history-modal-close'),
      };

      const rangeButtons = Array.from(document.querySelectorAll('[data-history-range]'));
      const pollButtons = Array.from(document.querySelectorAll('[data-poll-interval]'));

      const currencyToggle = document.getElementById('currency-toggle');
      const taoPriceLabel = document.getElementById('tao-price-label');
      const pollIntervalLabel = document.getElementById('poll-interval-label');
      const nextPollLabel = document.getElementById('next-poll-label');
      const adminPanel = document.querySelector('.admin-panel');
      const backfillDaysInput = document.getElementById('backfill-days');
      const backfillFrequencySelect = document.getElementById('backfill-frequency');
      const backfillOverwriteInput = document.getElementById('backfill-overwrite');
      const backfillButton = document.getElementById('backfill-btn');
      const backfillStatus = document.getElementById('backfill-status');

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
        if (Number.isFinite(price)) return price;
        const fallbackPrice = Number(fallback);
        return Number.isFinite(fallbackPrice) ? fallbackPrice : null;
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

      function formatNextPollCountdown(target) {
        const targetTime = target instanceof Date ? target.getTime() : Number(target);
        if (!Number.isFinite(targetTime)) return '—';
        const diffMs = targetTime - Date.now();
        if (Math.abs(diffMs) < 30000) return 'now';
        const absMs = Math.abs(diffMs);
        const minutes = Math.floor(absMs / 60000);
        const hours = Math.floor(minutes / 60);
        const days = Math.floor(hours / 24);
        const remainderHours = hours % 24;
        const remainderMinutes = minutes % 60;
        const parts = [];
        if (days) parts.push(days + 'd');
        if (remainderHours && parts.length < 2) parts.push(remainderHours + 'h');
        if (remainderMinutes && parts.length < 2) parts.push(remainderMinutes + 'm');
        if (!parts.length) parts.push('1m');
        return diffMs > 0 ? 'in ' + parts.join(' ') : parts.join(' ') + ' ago';
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
        nextPollLabel.textContent = 'Next poll: ' + formatNextPollCountdown(nextPollAt);
        nextPollLabel.title = 'Scheduled for ' + nextPollAt.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
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

      function readBackfillOptions() {
        return {
          days: Number.parseInt(String(backfillDaysInput?.value || ''), 10),
          frequency: String(backfillFrequencySelect?.value || 'by_hour'),
          overwrite: Boolean(backfillOverwriteInput?.checked),
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
        updateBackfillStatus('Backfill is running… this may take a while.', 'info');
        try {
          const response = await fetch('/api/subnets/' + netuid + '/backfill', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(options),
          });
          const payload = await response.json().catch(() => ({}));
          if (!response.ok) {
            throw new Error(payload.error || 'Backfill failed');
          }
          const snapshotCount = Number(payload.backfill?.inserted ?? 0);
          const flowCount = Number(payload.backfill?.flowInserted ?? 0);
          const priceCount = Number(payload.backfill?.priceInserted ?? 0);
          updateBackfillStatus('Backfill complete: ' + snapshotCount + ' snapshot rows, ' + flowCount + ' flow rows, and ' + priceCount + ' TAO price rows imported.', 'success');
          window.location.reload();
        } catch (error) {
          updateBackfillStatus(error?.message || 'Backfill failed', 'error');
          console.error(error);
        } finally {
          backfillButton.disabled = false;
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
            headers: { 'content-type': 'application/json' },
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
      }

      function loadHistory(days = 30, source = 'subnet') {
        const key = source + ':' + String(days);
        if (state.historyCache.has(key)) {
          return Promise.resolve(state.historyCache.get(key));
        }
        if (!state.historyLoading.has(key)) {
          const endpoint = source === 'tao-price'
            ? '/api/tao-price/history?days=' + encodeURIComponent(days)
            : source === 'tao-flow'
              ? '/api/subnets/' + netuid + '/flow-history?days=' + encodeURIComponent(days)
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
        if (isPriceMoveMetric(metric)) {
          return 'Price Move is derived from historical Token Price, so it needs enough earlier price samples to calculate the window.';
        }
        if (isTaoFlowMetric(metric)) {
          if (!visiblePoints.length) {
            return 'Money In/Out is derived from the historical subnet snapshots, so older backfilled rows may still be sparse until more samples are stored locally.';
          }
          if (visiblePoints.length < Math.max(5, Math.min(rangeDays, 10))) {
            return 'Money In/Out is derived from the historical subnet snapshots and can look sparse if the local database does not yet have enough earlier samples.';
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

      function chartRangeDays(history, fallbackDays = 30) {
        if (!Array.isArray(history) || history.length < 2) return fallbackDays;
        const start = new Date(history[0].captured_at).getTime();
        const end = new Date(history[history.length - 1].captured_at).getTime();
        if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return fallbackDays;
        return Math.max(1, Math.ceil((end - start) / 86400000));
      }

      function historyRangeLabel(days) {
        if (days === 1) return '24H';
        if (days === 7) return '7D';
        if (days === 30) return '30D';
        if (days === 60) return '60D';
        return days + 'D';
      }

      function historyRangeSubtitle(days) {
        if (days === 1) return 'Stored historical points in the last 24 hours';
        if (days === 7) return 'Stored historical points in the last 7 days';
        if (days === 30) return 'Stored historical points in the last 30 days';
        if (days === 60) return 'Stored historical points in the last 60 days';
        return 'Stored historical points in the last ' + days + ' days';
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
          : isTaoFlowMetric(metric)
            ? 'tao-flow'
            : 'subnet');
        const fetchDays = isPriceMoveMetric(metric) ? priceMoveFetchDays(metric, days) : days;
        const history = await loadHistory(fetchDays, historySource);
        if (requestId !== state.modalHistoryRequestId) return null;
        if (state.modalMetric !== metric || state.modalHistoryDays !== days) return null;
        state.modalHistory = history;
        return history;
      }

      function renderLineChart(canvasId, config, history) {
        const canvas = document.getElementById(canvasId);
        if (!canvas || !window.Chart) return;
        const points = historySeriesForMetric(config, history);
        const days = chartRangeDays(history, 30);
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

        const days = state.modalHistoryDays || chartRangeDays(sourceHistory, 30);
        const rangeEnd = Date.now();
        const rangeStart = rangeEnd - Math.max(1, days) * 86400000;
        const formatKey = metric.currencyMode === 'tao' && state.displayCurrency === 'usd'
          ? (metric.valueFormat === 'signedTao' ? 'signedUsd' : 'usd')
          : (metric.valueFormat || 'text');
        const points = historySeriesForMetric(metric, sourceHistory)
          .filter((point) => point.x >= rangeStart && point.x <= rangeEnd);
        const historyValues = points.map((point) => point.y);

        if (state.modalChart) {
          state.modalChart.destroy();
          state.modalChart = null;
        }

        if (!points.length) {
          modalElements.empty.hidden = false;
          modalElements.empty.textContent = 'No historical values are stored yet for this metric.';
          canvas.hidden = true;
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
              fill: true,
              pointRadius: 0,
              tension: 0.28,
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
                min: rangeStart,
                max: rangeEnd,
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
        const field = metric.historyField || metric.valueField;
        const points = historySeriesForMetric(metric, history);
        const rangeStart = Date.now() - Math.max(1, days) * 86400000;
        const rangeEnd = Date.now();
        const visiblePoints = points.filter((point) => point.x >= rangeStart && point.x <= rangeEnd);
        const latestPoint = visiblePoints.length ? visiblePoints[visiblePoints.length - 1] : null;

        modalElements.subtitle.textContent = 'Historical view for ' + metric.label + ' over the last ' + days + ' day' + (days === 1 ? '' : 's') + ' from the local SQLite database.';
        modalElements.latestValue.textContent = displayMetricText(metric);
        modalElements.latestRaw.textContent = metric.sourceText
          ? ('Source: ' + metric.sourceText)
          : (isPriceMoveMetric(metric)
            ? 'Derived from historical Token Price data'
            : (metric.rawValue !== null && metric.rawValue !== undefined
              ? ('Raw: ' + metric.rawValue)
              : ('Tracked field: ' + field)));
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
        renderHistoryChart(metric, history);
      }

      async function openHistoryModal(metricJson) {
        const metric = typeof metricJson === 'string' ? JSON.parse(metricJson) : metricJson;
        state.modalMetric = metric;
        state.modalHistoryDays = 30;
        state.modalHistory = null;
        renderModalMetric(metric);
        openModal();
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
        if (state.modalMetric) {
          modalElements.latestValue.textContent = displayMetricText(state.modalMetric);
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
          button.addEventListener('click', () => {
            openHistoryModal(button.dataset.metric);
          });
        });
      }

      document.getElementById('refresh-btn').addEventListener('click', async () => {
        const response = await fetch('/api/subnets/' + netuid + '/ingest', { method: 'POST' });
        if (!response.ok) {
          alert('Ingest failed');
          return;
        }
        window.location.reload();
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

      backfillButton?.addEventListener('click', () => {
        void runAdminBackfill();
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
          updateHistoryRangeButtons();
          if (state.modalMetric) {
            refreshModalHistory(state.modalMetric, days).catch((error) => console.error(error));
          }
        });
      });

      modalElements.close.addEventListener('click', closeModal);
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
      document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && modalElements.backdrop.classList.contains('open')) {
          closeModal();
        }
      });

      bindMetricClicks();
      updateCurrencyToggleButton();
      updateTaoPriceLabel();
      updateNextPollLabel();
      updatePollIntervalButtons();
      updatePollIntervalLabel();
      syncSchedulerState();
      setInterval(() => {
        syncSchedulerState();
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

function createDashboardServer({ db, ingestService, config, onPollIntervalChange = null }) {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const match = url.pathname.match(/^\/subnets\/(\d+)$/) || url.pathname.match(/^\/api\/subnets\/(\d+)\/(latest|history|ingest|backfill)$/);
      const netuid = match ? Number(match[1]) : config.netuid;

      if (req.method === 'GET' && url.pathname === '/') {
        res.writeHead(302, { Location: `/subnets/${config.netuid}` });
        res.end();
        return;
      }

      if (req.method === 'GET' && url.pathname === `/subnets/${netuid}`) {
        const model = buildPageModel({ db, config, netuid });
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

      if (req.method === 'GET' && url.pathname === `/api/subnets/${netuid}/flow-history`) {
        const days = parseDays(url.searchParams);
        const sinceIso = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
        const history = attachTaoPrice(getTaoFlowHistory(db, netuid, sinceIso), getTaoPriceHistory(db, sinceIso));
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ netuid, days, history }, null, 2));
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
        const result = await ingestService.ingestOnce({ netuid });
        const status = result.ok ? 200 : 500;
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ netuid, result }, null, 2));
        return;
      }

      if (req.method === 'POST' && url.pathname === `/api/subnets/${netuid}/backfill`) {
        const payload = await readJsonBody(req);
        const backfill = await ingestService.backfillHistoricalSnapshots({ netuid, ...parseBackfillOptions(payload, config) });
        const live = await ingestService.ingestOnce({ netuid });
        const status = backfill.ok && live.ok ? 200 : 500;
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ netuid, backfill, live }, null, 2));
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/settings/poll-interval') {
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
        }, null, 2));
        return;
      }

      res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Not found' }, null, 2));
    } catch (error) {
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
};
