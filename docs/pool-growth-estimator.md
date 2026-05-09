# Pool Growth Estimator

The Pool growth estimator is a local, read-only what-if simulator for subnet pool behavior.
It lets you ask a simple question: “If someone injects this much TAO into the current pool, what happens to alpha?”

## Source of truth

The estimator uses the current subnet snapshot already loaded into the dashboard.
No new API route is required for the first release.

It reads:
- `total_tao_num` or `liquidity_num` for the TAO reserve
- `alpha_in_pool_num` or `total_alpha_num` for the alpha reserve
- `price_num` for the current alpha price

If the snapshot is missing one of those fields, the estimator shows an unavailable state instead of guessing.

## How it works

The math is a deterministic constant-product-style approximation:

1. Take the current pool reserves.
2. Add the injected TAO amount to the TAO reserve.
3. Estimate how much alpha leaves the pool so the reserve ratio stays consistent.
4. Derive the new alpha price from the updated reserves.
5. Compare the projected price with the current price to show price impact and slippage.

The implementation lives in:
- `src/pool-estimator.js`

The UI lives in:
- `src/server.js`

## What the UI shows

The estimator presents:
- estimated alpha received
- projected alpha price
- price change %
- a small before/after projection bar

It also includes quick presets so you can compare common injection sizes without typing them manually.

## What to be aware of

- This is a simulator, not a transaction ledger.
- It is only as accurate as the latest local pool snapshot.
- Live chain activity, fees, and future emissions can move the real pool after the snapshot is captured.
- The result is an estimate, not an execution quote.
- Large injections will show more visible slippage because the estimator uses the current reserve ratio.
- If the pool data is incomplete, the UI intentionally fails closed and shows an unavailable state.

## Practical interpretation

Use the estimator to answer questions like:
- “How much alpha would a small TAO injection buy right now?”
- “How much does a larger injection move the pool price?”
- “Is the price impact small enough to be worth considering?”

Do not use it as a guarantee of execution price.

## Maintenance notes

When changing the estimator:
- keep the helper deterministic and local
- keep the unavailable state when reserve data is missing
- update the README and project memory if the placement or behavior changes
- add or adjust unit tests in `test/taostats.test.js`

