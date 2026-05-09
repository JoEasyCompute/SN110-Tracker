'use strict';

const TAO_PER_RAO = 1_000_000_000;

function asNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function asPositiveNumber(value) {
  const parsed = asNumber(value);
  return parsed !== null && parsed > 0 ? parsed : null;
}

function taoFromRao(value) {
  const parsed = asNumber(value);
  return parsed === null ? null : parsed / TAO_PER_RAO;
}

function firstPositiveNumber(...values) {
  for (const value of values) {
    const parsed = asPositiveNumber(value);
    if (parsed !== null) return parsed;
  }
  return null;
}

function resolvePoolSnapshot(snapshot = null) {
  const taoInPool = taoFromRao(firstPositiveNumber(
    snapshot?.total_tao_num,
    snapshot?.liquidity_num,
    snapshot?.total_tao_text,
    snapshot?.liquidity_text,
  ));
  const alphaInPoolRaw = firstPositiveNumber(
    snapshot?.alpha_in_pool_num,
    snapshot?.total_alpha_num,
    snapshot?.alpha_in_pool_text,
    snapshot?.total_alpha_text,
  );
  const currentPrice = firstPositiveNumber(snapshot?.price_num);

  const resolvedTaoInPool = Number.isFinite(taoInPool) ? taoInPool : null;
  const resolvedAlphaInPool = Number.isFinite(alphaInPoolRaw) ? alphaInPoolRaw : null;
  const resolvedPrice = Number.isFinite(currentPrice) ? currentPrice : null;

  let taoSource = Number.isFinite(taoInPool) ? 'snapshot' : null;
  let alphaSource = resolvedAlphaInPool !== null ? 'snapshot' : null;
  let priceSource = Number.isFinite(currentPrice) ? 'snapshot' : null;

  let derivedTaoInPool = false;
  let derivedAlphaInPool = false;
  let derivedCurrentPrice = false;

  let finalTaoInPool = resolvedTaoInPool;
  let finalAlphaInPool = resolvedAlphaInPool;
  let finalCurrentPrice = resolvedPrice;

  if (finalTaoInPool !== null && finalCurrentPrice !== null && finalCurrentPrice > 0) {
    finalAlphaInPool = finalTaoInPool / finalCurrentPrice;
    alphaSource = 'derived';
    derivedAlphaInPool = true;
  } else if (finalAlphaInPool !== null) {
    finalAlphaInPool = finalAlphaInPool / TAO_PER_RAO;
    alphaSource = 'snapshot';
  }

  if (finalTaoInPool === null && finalAlphaInPool !== null && finalCurrentPrice !== null) {
    finalTaoInPool = finalAlphaInPool * finalCurrentPrice;
    taoSource = 'derived';
    derivedTaoInPool = true;
  }

  if (finalCurrentPrice === null && finalTaoInPool !== null && finalAlphaInPool !== null && finalAlphaInPool > 0) {
    finalCurrentPrice = finalTaoInPool / finalAlphaInPool;
    priceSource = 'derived';
    derivedCurrentPrice = true;
  }

  const available = [finalTaoInPool, finalAlphaInPool, finalCurrentPrice].every((value) => Number.isFinite(value) && value > 0);

  return {
    available,
    reason: available ? null : 'Latest pool snapshot is missing TAO reserve, alpha reserve, or current price.',
    taoInPool: available ? finalTaoInPool : null,
    alphaInPool: available ? finalAlphaInPool : null,
    currentPrice: available ? finalCurrentPrice : null,
    taoSource: available ? taoSource : null,
    alphaSource: available ? alphaSource : null,
    priceSource: available ? priceSource : null,
    derivedTaoInPool,
    derivedAlphaInPool,
    derivedCurrentPrice,
  };
}

function estimatePoolGrowth({ taoInPool, alphaInPool, taoInjected }) {
  const poolTao = asPositiveNumber(taoInPool);
  const poolAlpha = asPositiveNumber(alphaInPool);
  const injectedTao = asNumber(taoInjected);

  if (poolTao === null || poolAlpha === null || injectedTao === null || injectedTao < 0) {
    return {
      available: false,
      reason: 'TAO injection and pool reserves must be finite, non-negative numbers.',
    };
  }

  const currentPrice = poolTao / poolAlpha;
  const taoInjectedSafe = Math.max(0, injectedTao);
  const projectedTaoInPool = poolTao + taoInjectedSafe;
  const alphaReceived = taoInjectedSafe === 0
    ? 0
    : (poolAlpha * taoInjectedSafe) / projectedTaoInPool;
  const projectedAlphaInPool = poolAlpha - alphaReceived;
  const projectedPrice = projectedTaoInPool / projectedAlphaInPool;
  const idealAlphaReceived = taoInjectedSafe === 0 ? 0 : taoInjectedSafe / currentPrice;
  const alphaShortfall = idealAlphaReceived - alphaReceived;
  const slippagePct = idealAlphaReceived > 0 ? (alphaShortfall / idealAlphaReceived) * 100 : 0;
  const priceChangePct = currentPrice > 0 ? ((projectedPrice - currentPrice) / currentPrice) * 100 : null;

  return {
    available: true,
    taoInPool: poolTao,
    alphaInPool: poolAlpha,
    taoInjected: taoInjectedSafe,
    currentPrice,
    projectedTaoInPool,
    projectedAlphaInPool,
    projectedPrice,
    alphaReceived,
    idealAlphaReceived,
    alphaShortfall,
    slippagePct,
    priceChangePct,
  };
}

function buildPoolGrowthEstimatorState(snapshot = null, { defaultTaoInjected = 10, presets = [1, 10, 50] } = {}) {
  const currentPool = resolvePoolSnapshot(snapshot);
  return {
    available: currentPool.available,
    reason: currentPool.reason,
    currentPool,
    defaultTaoInjected,
    presets,
  };
}

module.exports = {
  TAO_PER_RAO,
  buildPoolGrowthEstimatorState,
  estimatePoolGrowth,
  resolvePoolSnapshot,
};
