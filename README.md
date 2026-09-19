# Headwater Indexer

Envio HyperIndex indexer for [Headwater](https://github.com/Sireadell/headwater),
an independent funding-provenance audit for ERC-8004 agent reputation on
Monad, built for the Monad Metropolis hackathon.

This repo exists because Headwater's own direct RPC scan
(`headwater/src/core/rpc/monadClient.js`) is bounded to roughly 22 minutes
of chain history per wallet -- a real limit disclosed in
`headwater/HONESTY.md`. This indexer removes that bound for AUSD funding
data and adds two detection signals that need full history to work at all.

## What it indexes (Monad mainnet, chain 143)

| Source | Events | Range |
|---|---|---|
| ERC-8004 Identity Registry (`0x8004A169...`) | `Registered` | full history from block 0 |
| ERC-8004 Reputation Registry (`0x8004BAa1...`) | `NewFeedback`, `FeedbackRevoked` | full history from block 0 |
| AUSD token (`0x00000000eFE...`) | `Transfer` | last ~5.2M blocks (`start_block: 101000000`), not genesis -- see `config.yaml` for why |

Identity and Reputation are small, low-volume contracts, so indexing their
full history is cheap. AUSD settles activity across all of Monad, not just
agent wallets -- indexing it from block 0 crashed a local test run (out of
memory), so it's deliberately bounded. That bound is still ~100x deeper
than Headwater's own default 50,000-block (~4.2 hour) lookback cap.

## What it computes, not just stores

- **`CrossAgentOverlap`** -- a reviewer wallet that has left feedback on
  more than one agent, maintained incrementally as reviews arrive.
- **`CircularFunding`** -- wallet A funds wallet B, and B has independently
  sent AUSD back to A. Ported from
  `headwater/src/core/signals/circularFunding.js`, same detection logic,
  now an O(1) lookup against an indexed reverse-edge table instead of a
  per-request RPC scan. Skips pairs where either side is a
  Nansen-confirmed legitimate actor (exchange, market-maker, liquidity
  pool, institutional).
- **`FunderFanOut`** -- a funder paying out to 15+ distinct recipients
  over 25+ hours, the same thresholds as
  `headwater/src/core/signals/fanOut.js`. Circumstantial only, matching
  the original signal's own constraint that this is never sufficient
  alone to call something risky.
- **`WalletLabel`** -- Nansen wallet-reputation data, checked at three
  points: when a new agent registers (screens the owner wallet), when a
  reviewer triggers a cross-agent overlap, and on funding transfers not
  already known-legitimate. Cached through the indexed table so the same
  wallet isn't re-queried against Nansen on every repeat transfer.

## Running it

```bash
npm install
npx envio codegen   # must run before tsc or tests -- generates types from config.yaml/schema.graphql
npx envio dev        # local run, needs Docker (Postgres + Hasura)
```

**Windows note:** the `envio` CLI ships no native Windows binary (only
linux/darwin), so this only runs under WSL or a Linux environment (a
GitHub Codespace works well) -- not natively in PowerShell or Git Bash.

Set `NANSEN_API_KEY` in `.env` (see `.env.example`) to enable the Nansen
cross-checks; without it, those lookups no-op and return null rather than
failing.

## Live deployment

Deployed to Envio Cloud (free Development tier -- 30-day max lifespan per
deployment, redeploy if it lapses before judging). Live GraphQL endpoint:
_TODO -- add once confirmed live and queryable, see the org's Envio
dashboard._

## Honesty notes

- AUSD coverage is bounded (~5.2M blocks), not full chain history -- see
  above.
- Native MON transfers are not indexed, only the AUSD token. A funder
  paying in native MON is currently invisible to this indexer.
- `npm test` currently has no tests for this repo specifically; the
  detection logic it ports (`circularFunding.js`, `fanOut.js`) is tested
  in `headwater/`'s own 106-test suite.
