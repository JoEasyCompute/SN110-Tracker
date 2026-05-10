# Wallet Transaction Modal

This document describes the wallet transaction drill-down modal for wallet activity.
It is intended as a reference for implementation and future maintenance.

## Current implementation

The modal is available behind a **Ctrl-click / Cmd-click** on any configured wallet card.
It opens a timeline that combines:

- Taostats extrinsics
- Taostats transfers
- hotkey stake snapshot deltas

The modal reads from the local SQLite wallet-activity cache first, shows a clear **“Fetching wallet activity…”** loading state while the cache or fallback sync is in progress, and only falls back to Taostats for cache misses or a manual refresh.

## Goal

Add a second wallet modal that focuses on **transaction-level activity** for a configured coldkey.

### Interaction

- **Normal click** on a wallet card opens the existing wallet details modal.
- **Ctrl-click** on Windows/Linux, or **Cmd-click** on macOS, opens the transaction modal.

The transaction modal should help answer:

- Which hotkey changed?
- Was it a stake add, unstake, transfer, or move?
- What extrinsic caused it?
- Is the event likely validator-related, owner-related, or still unclassified?

## Source of truth

The modal should be built from the data already stored locally and from Taostats API history endpoints.
No new protocol data source is required for the first version.

Primary inputs:

- `wallet_stake_positions`
- `wallet_history`
- `extrinsic` history from Taostats
- `transfer` history from Taostats

Important limitation:

- stake history tells us **which hotkey** changed
- it does **not** by itself prove validator vs owner earnings

## Data sources

### 1) Extrinsics

Endpoint:

- `GET /api/extrinsic/v1`

Use this as the primary on-chain activity feed.

Useful fields:

- `timestamp`
- `block_number`
- `hash`
- `id`
- `signer_address`
- `success`
- `error`
- `full_name`
- `call_args`

Likely classifications:

- `SubtensorModule.add_stake` → `stake_add`
- `SubtensorModule.move_stake` → `stake_move`
- `SubtensorModule.swap_stake` → `stake_swap`
- `SubtensorModule.transfer_stake` → `stake_transfer`
- `SubtensorModule.remove_stake` / unstake variants → `unstake`
- other calls → `other`

### 2) Transfers

Endpoint:

- `GET /api/transfer/v1`

Use this for direct TAO movements between coldkeys.

Useful fields:

- `id`
- `from.ss58`
- `to.ss58`
- `network`
- `block_number`
- `timestamp`
- `amount`
- `fee`
- `transaction_hash`
- `extrinsic_id`

Suggested classification:

- `coldkey_transfer`

### 3) Stake history

Endpoint:

- `GET /api/dtao/stake_balance/history/v1`

This is not a transaction ledger; it is a daily stake snapshot.
It is still useful for deriving hotkey-level deltas.

Useful fields:

- `coldkey.ss58`
- `hotkey.ss58`
- `hotkey_name`
- `netuid`
- `timestamp`
- `balance`
- `balance_as_tao`
- `subnet_rank`

Suggested classification:

- `stake_snapshot_delta`

## Proposed fetch helpers

Suggested helper functions in the server layer:

```js
fetchWalletExtrinsics({ coldkey, days, netuid })
fetchWalletTransfers({ coldkey, days })
fetchWalletStakeHistory({ coldkey, hotkey = null, netuid = null, days })
buildWalletTransactionTimeline({ wallet, extrinsics, transfers, stakeHistory })
```

Implementation notes:

- keep helper output normalized before rendering
- avoid mixing API payload shape with UI shape
- keep the modal able to render even if one source fails
- prefer the SQLite cache on open, with live Taostats used only as a fallback path

## Proposed row model

Use a single normalized row format:

```ts
type WalletTxRow = {
  source_type: 'extrinsic' | 'transfer' | 'stake_history';
  timestamp: string;
  block_number: number | null;
  extrinsic_id: string | null;
  transaction_hash: string | null;

  coldkey_ss58: string | null;
  hotkey_ss58: string | null;
  hotkey_name: string | null;
  netuid: number | null;

  action: string;
  action_key: string;
  amount_tao: number | null;
  amount_alpha: number | null;

  from_ss58: string | null;
  to_ss58: string | null;

  status: 'success' | 'failed' | 'unknown';
  note: string | null;
  raw: unknown;
};
```

## Classification rules

Priority order:

1. exact extrinsic match
2. transfer match
3. stake history delta
4. unknown

### Hotkey matching

A row should be associated with the wallet if any of these are true:

- `signer_address === wallet.coldkey`
- `from.ss58 === wallet.coldkey`
- `to.ss58 === wallet.coldkey`
- `call_args.hotkey` matches one of the configured wallet hotkeys
- stake history row matches `coldkey + hotkey + netuid`

### Role handling

Roles should remain conservative:

- `validator` if the hotkey is explicitly tagged or strongly matched
- `owner` only if owner hotkey metadata exists
- `unclassified` otherwise

Do not infer owner earnings from validator-only evidence.

## Proposed modal structure

### Header

- Wallet name
- Coldkey address
- Network
- Hotkey count
- Date range summary
- Transaction totals

### Filters

- Date range: `24H / 7D / 30D / 60D / All`
- Refresh button for manual cache re-sync when the user wants the latest live data
- Type filter: `All / Stake / Unstake / Transfer / Validator / Owner / Other`
- Optional hotkey filter

### Main table

Suggested columns:

- Time
- Action
- Hotkey
- Netuid
- Amount
- Counterparty
- Block
- Extrinsic ID
- Status
- Source

### Detail panel

When a row is selected, show:

- raw extrinsic name
- signer address
- call args
- transaction hash
- linked block
- raw source payload
- inference note

## UX behavior

Recommended controls:

- normal wallet modal remains unchanged
- Ctrl/Cmd-click opens the transaction modal
- the wallet card tooltip can mention: “Ctrl/Cmd-click for transaction timeline”

The transaction modal should fail closed:

- if the extrinsics API is unavailable, show a partial view
- if transfers are unavailable, keep the stake timeline
- if stake history is unavailable, keep extrinsics and transfers

## Why this helps attribution

The transaction modal should improve wallet attribution by giving evidence for:

- hotkey-level stake changes
- direct stake add/remove/move operations
- direct transfers tied to the wallet

It will still not be enough to guarantee validator-vs-owner attribution in every case.
That is why the main wallet modal should continue to label unknowns honestly.

## Future implementation notes

- Keep the modal local-first and read-only.
- Reuse existing wallet lookup and formatting helpers where possible.
- Add regression tests for:
  - Ctrl/Cmd-click opening the transaction modal
  - extrinsic classification
  - transfer classification
  - stake history delta rows
  - unavailable-state fallback
