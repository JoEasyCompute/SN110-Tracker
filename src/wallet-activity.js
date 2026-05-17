'use strict';

const { fetchExtrinsicsHistory, fetchTransferHistory, fetchHistoricalStakeBalance } = require('./taostats');

const TAO_PER_RAO = 1_000_000_000;

function nowIso() {
  return new Date().toISOString();
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
    payload.amount_alpha,
    payload.amountAlpha,
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
  const from = payload.from && typeof payload.from === 'object'
    ? payload.from.ss58 ?? payload.from.hex ?? null
    : payload.from ?? null;
  const to = payload.to && typeof payload.to === 'object'
    ? payload.to.ss58 ?? payload.to.hex ?? null
    : payload.to ?? null;
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
      role: hotkey.role ? String(hotkey.role).toLowerCase() : null,
      network: hotkey.network || walletConfig?.network || 'finney',
      source: 'configured',
    });
  }

  for (const position of Array.isArray(stakePositions) ? stakePositions : []) {
    const ss58 = position?.hotkey_address_ss58 ? String(position.hotkey_address_ss58) : '';
    if (!ss58 || hotkeyMap.has(ss58)) continue;
    hotkeyMap.set(ss58, {
      ss58,
      name: position.hotkey_name || ss58.slice(0, 8),
      netuid: position.netuid ?? null,
      role: null,
      network: walletConfig?.network || 'finney',
      source: 'stake',
    });
  }

  return [...hotkeyMap.values()];
}

function walletTransactionDedupeKey(row, walletAddress) {
  const address = String(walletAddress || row.wallet_address_ss58 || row.coldkey_ss58 || '').trim();
  const sourceType = String(row.source_type || '').trim().toLowerCase();
  const timestamp = row.timestamp || row.event_timestamp || row.captured_at || '';
  const actionKey = row.action_key || row.action || '';
  const transactionHash = row.transaction_hash || '';
  const extrinsicId = row.extrinsic_id || '';
  const blockNumber = row.block_number ?? '';
  const hotkey = row.hotkey_ss58 || row.hotkey_name || (row.netuid ?? '');
  const amount = row.amount_tao ?? row.amount_alpha ?? '';
  const from = row.from_ss58 || '';
  const to = row.to_ss58 || '';

  switch (sourceType) {
    case 'extrinsic':
      return ['extrinsic', address, transactionHash || extrinsicId || blockNumber || timestamp || actionKey].join(':');
    case 'transfer':
      return ['transfer', address, transactionHash || extrinsicId || blockNumber || timestamp || from || to || amount].join(':');
    case 'stake_history':
      return ['stake_history', address, hotkey || 'unknown', timestamp || blockNumber || actionKey || amount].join(':');
    default:
      return [sourceType || 'wallet', address, transactionHash || extrinsicId || blockNumber || timestamp || actionKey || amount || 'row'].join(':');
  }
}

function normalizeWalletTimelineRows(rows = []) {
  return [...rows].sort((a, b) => {
    const left = new Date(a.timestamp || a.event_timestamp || a.captured_at || 0).getTime();
    const right = new Date(b.timestamp || b.event_timestamp || b.captured_at || 0).getTime();
    return right - left;
  });
}

function normalizeWalletTransactionRow(row = {}) {
  const raw = row.raw ?? parseJsonPayload(row.raw_json) ?? {};
  const timestamp = row.timestamp || row.event_timestamp || row.captured_at || null;
  return {
    ...row,
    timestamp,
    raw,
  };
}

function summarizeWalletTimelineRows(rows = []) {
  return {
    total: rows.length,
    extrinsics: rows.filter((row) => row.source_type === 'extrinsic').length,
    transfers: rows.filter((row) => row.source_type === 'transfer').length,
    stakeSnapshots: rows.filter((row) => row.source_type === 'stake_history').length,
    stakeDelta: rows.filter((row) => row.source_type === 'stake_history').length,
    hotkeysTracked: 0,
  };
}

function buildWalletTransactionTimelineFromRows({
  address,
  walletConfig = null,
  stakePositions = [],
  rows = [],
  days = 30,
  partial = false,
  reason = null,
  warning = null,
} = {}) {
  const hotkeys = mergeWalletHotkeyTargets(walletConfig, stakePositions);
  const normalizedRows = normalizeWalletTimelineRows(rows).map((row) => normalizeWalletTransactionRow(row));
  const orderedRows = normalizedRows;
  const summary = summarizeWalletTimelineRows(orderedRows);
  summary.hotkeysTracked = hotkeys.length;
  const network = walletConfig?.network || orderedRows.find((row) => row.network)?.network || 'finney';
  const available = orderedRows.length > 0;

  return {
    available,
    partial: Boolean(partial),
    reason: reason || (!available ? (warning || 'No wallet transactions were found for the selected period.') : null),
    warning: warning || null,
    days,
    address,
    walletName: walletConfig?.name || null,
    network,
    rows: orderedRows,
    summary,
    hotkeys,
  };
}

function buildWalletTransactionDbRecord({ walletConfig = null, row, sourceUrl = null, source = 'api-history' }) {
  const walletAddress = String(walletConfig?.ss58 || walletConfig?.coldkey || row.coldkey_ss58 || row.wallet_address_ss58 || '').trim();
  const walletName = walletConfig?.name || row.wallet_name || walletAddress || 'Wallet';
  const network = walletConfig?.network || row.network || 'finney';
  const eventTimestamp = walletTransactionTimestamp(row.timestamp || row.event_timestamp || row.captured_at) || nowIso();
  const capturedAt = row.captured_at || eventTimestamp;
  const payload = row.raw ?? row;

  return {
    wallet_name: walletName,
    wallet_address_ss58: walletAddress,
    wallet_address_hex: row.wallet_address_hex ?? null,
    network,
    source_type: row.source_type,
    action: row.action,
    action_key: row.action_key,
    dedupe_key: walletTransactionDedupeKey(row, walletAddress),
    captured_at: capturedAt,
    event_timestamp: eventTimestamp,
    remote_timestamp: row.remote_timestamp || row.timestamp || null,
    source: row.source || source,
    source_url: row.source_url || sourceUrl,
    block_number: row.block_number ?? null,
    extrinsic_id: row.extrinsic_id ?? null,
    transaction_hash: row.transaction_hash ?? null,
    hotkey_name: row.hotkey_name ?? null,
    hotkey_address_ss58: row.hotkey_ss58 ?? null,
    hotkey_address_hex: row.hotkey_address_hex ?? null,
    netuid: row.netuid ?? null,
    amount_tao: row.amount_tao ?? null,
    amount_alpha: row.amount_alpha ?? null,
    from_ss58: row.from_ss58 ?? null,
    to_ss58: row.to_ss58 ?? null,
    status: row.status ?? null,
    note: row.note ?? null,
    raw_json: JSON.stringify(payload),
  };
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
  fetchers = {},
} = {}) {
  const result = buildWalletTransactionTimelineFromRows({
    address,
    walletConfig,
    stakePositions,
    rows: [],
    days,
  });
  const network = walletConfig?.network || 'finney';

  if (!taostatsAuthHeader) {
    result.reason = 'Taostats API access is required to load wallet transactions.';
    return result;
  }

  const fetchExtrinsics = fetchers.fetchExtrinsicsHistory || fetchExtrinsicsHistory;
  const fetchTransfers = fetchers.fetchTransferHistory || fetchTransferHistory;
  const fetchStakeHistory = fetchers.fetchHistoricalStakeBalance || fetchHistoricalStakeBalance;
  const hotkeys = result.hotkeys;
  const fetchOptions = {
    taostatsBaseUrl,
    taostatsAuthHeader,
    rateLimiter,
    days,
    limit,
  };

  let partial = false;
  let warning = null;
  let reason = null;

  let extrinsicsRaw = [];
  try {
    extrinsicsRaw = await fetchExtrinsics({
      signerAddress: address,
      ...fetchOptions,
    });
  } catch (error) {
    partial = true;
    reason = reason || `Extrinsics unavailable: ${error.message}`;
  }

  let transfersRaw = [];
  try {
    transfersRaw = await fetchTransfers({
      address,
      network,
      ...fetchOptions,
    });
  } catch (error) {
    partial = true;
    reason = reason || `Transfers unavailable: ${error.message}`;
  }

  const rows = [];
  const hotkeyLookup = new Map(hotkeys.map((hotkey) => [String(hotkey.ss58), hotkey]));
  const stakeSnapshotsRaw = [];

  for (const hotkey of hotkeys) {
    try {
      const rowsForHotkey = await fetchStakeHistory({
        coldkey: address,
        hotkey: hotkey.ss58,
        netuid: hotkey.netuid ?? null,
        ...fetchOptions,
      });
      stakeSnapshotsRaw.push({ hotkey, rows: rowsForHotkey });
    } catch (error) {
      partial = true;
      if (Number(error?.status) === 429) {
        warning = warning || 'Stake history is temporarily rate-limited by Taostats; showing extrinsics and transfers only.';
      } else {
        reason = reason || `Stake history unavailable: ${error.message}`;
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
            note: `Derived from stake snapshot delta for ${hotkey.name || hotkey.ss58}`,
            raw: row,
          });
        }
      }
      previous = Number.isFinite(balance) ? balance : previous;
    }
  }

  const timeline = buildWalletTransactionTimelineFromRows({
    address,
    walletConfig,
    stakePositions,
    rows,
    days,
    partial,
    reason,
    warning,
  });
  timeline.summary.hotkeysTracked = hotkeys.length;
  return timeline;
}

module.exports = {
  TAO_PER_RAO,
  parseJsonPayload,
  walletTransactionTimestamp,
  walletTransactionAmountTao,
  readTransactionAmount,
  normalizeWalletTxAction,
  extractWalletTransactionAddresses,
  mergeWalletHotkeyTargets,
  walletTransactionDedupeKey,
  normalizeWalletTimelineRows,
  normalizeWalletTransactionRow,
  summarizeWalletTimelineRows,
  buildWalletTransactionTimelineFromRows,
  buildWalletTransactionDbRecord,
  buildWalletTransactionTimeline,
};
