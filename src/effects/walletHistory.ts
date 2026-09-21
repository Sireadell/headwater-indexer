// On-demand, per-wallet history lookups against HyperSync.
//
// WHY THESE EXIST: the live handlers only see events from their
// configured start block onward. The fraud shape this tool exists to
// catch -- fund a wallet quietly, wait, then review with it later --
// specifically defeats a short window, because the funding happens
// BEFORE the wallet reveals itself as a reviewer and becomes worth
// watching.
//
// So rather than widening the window for everyone, which is what blew
// the free-tier event quota once already, each wallet is looked up once
// at the moment it is first seen reviewing. That is rare compared to the
// volume of chain traffic, and results are cached so a wallet is never
// queried twice.
//
// A second effect used to deep-scan each reviewer's AUSD history as
// well. It was removed after measurement: across 4,476 reviewers it
// returned zero rows, because reviewers on this registry do not transact
// in AUSD at all. It was consuming one of two rate-limited deep queries
// per wallet, roughly half of total sync time, for nothing.

import { createEffect, S } from "envio";
import { HypersyncClient, type Query } from "@envio-dev/hypersync-client";

const HYPERSYNC_URL = "https://monad.hypersync.xyz";

// Both lookups below talk to HyperSync, which needs a token. Without one
// there is nothing useful to do, so they return "found nothing" rather
// than throwing or hanging on a request that cannot succeed. This also
// keeps the test suite offline and deterministic: tests run with no token
// and exercise the handler logic without reaching the network.
function hypersyncToken(): string | undefined {
  const token = process.env.ENVIO_API_TOKEN;
  return token && token.length > 0 ? token : undefined;
}

// When a wallet first appeared on chain, and who paid into it.
//
// Both answers come from one scan because they need the same data. A
// separate pass would double the HyperSync cost per wallet for nothing.
//
// WALLET BIRTH: wallets provisioned together by one operator tend to be
// born together, minutes apart, then held until needed. Independent
// reviewers have no reason to share a birthday. "Born" means the
// earliest block the address appears in any transaction, either
// direction: a fresh EOA cannot send before it has been funded for gas,
// so its first appearance is as a recipient.
//
// NATIVE FUNDERS: who sent this wallet its native balance. Two lessons
// carried over from telegraph-sentinel's fundingRelationship.js, both
// of which were caught against live data there:
//
//   1. This path sees NATIVE transfers only. For an ERC-20 transfer the
//      transaction's `to` is the token contract, never the recipient, so
//      token funding is invisible here by construction. The AUSD side is
//      covered separately from getWalletAusdHistory rather than pretended
//      at here.
//
//   2. The earliest funder is often not the real one. A trivial gas
//      top-up arrives first and, if collapsed to a single winner, hides
//      whoever actually capitalised the wallet. So every inbound funder
//      is returned, each marked dust or not, and the caller decides.
//      Threshold is 0.01 native, which comfortably covers real gas
//      funding (typically 0.001-0.01) without needing a price oracle.
const NATIVE_DUST_THRESHOLD_WEI = 10_000_000_000_000_000n;

export interface WalletOrigin {
  firstSeenBlock: number;
  firstSeenTimestamp: number;
  funders: {
    funder: string;
    blockNumber: number;
    timestamp: number;
    valueWei: string;
    isDust: boolean;
  }[];
}

export const getWalletOrigin = createEffect(
  {
    name: "getWalletOrigin",
    input: S.string,
    output: S.nullable(
      S.object((ctx) => ({
        firstSeenBlock: ctx.field("firstSeenBlock", S.number),
        firstSeenTimestamp: ctx.field("firstSeenTimestamp", S.number),
        funders: ctx.field(
          "funders",
          S.array(
            S.object((f) => ({
              funder: f.field("funder", S.string),
              blockNumber: f.field("blockNumber", S.number),
              timestamp: f.field("timestamp", S.number),
              valueWei: f.field("valueWei", S.string),
              isDust: f.field("isDust", S.boolean),
            })),
          ),
        ),
      })),
    ),
    rateLimit: { calls: 3, per: "second" },
    cache: true,
  },
  async ({ input }): Promise<WalletOrigin | null> => {
    const token = hypersyncToken();
    if (token === undefined) return null;

    const wallet = input.toLowerCase();
    const client = new HypersyncClient({ url: HYPERSYNC_URL, apiToken: token });

    const query: Query = {
      fromBlock: 0,
      transactions: [{ from: [wallet] }, { to: [wallet] }],
      fieldSelection: {
        transaction: ["BlockNumber", "From", "To", "Value"],
        block: ["Number", "Timestamp"],
      },
    };

    let fromBlock = 0;
    let firstSeenBlock = Number.MAX_SAFE_INTEGER;
    let firstSeenTimestamp = 0;
    // Deduped by funder, keeping each one's earliest payment: a funder
    // that paid a wallet fifty times is one funding relationship.
    const byFunder = new Map<string, WalletOrigin["funders"][number]>();

    const MAX_PAGES = 50;
    for (let page = 0; page < MAX_PAGES; page++) {
      const res = await client.get({ ...query, fromBlock });

      const timestampByBlock = new Map<number, number>();
      for (const block of res.data.blocks) {
        if (block.number !== undefined && block.timestamp !== undefined) {
          timestampByBlock.set(block.number, block.timestamp);
        }
      }

      for (const tx of res.data.transactions) {
        if (tx.blockNumber === undefined) continue;
        const timestamp = timestampByBlock.get(tx.blockNumber) ?? 0;

        if (tx.blockNumber < firstSeenBlock) {
          firstSeenBlock = tx.blockNumber;
          firstSeenTimestamp = timestamp;
        }

        // Inbound only, and only where value actually moved.
        const to = tx.to?.toLowerCase();
        const from = tx.from?.toLowerCase();
        if (to !== wallet || from === undefined || from === wallet) continue;

        let valueWei: bigint;
        try {
          valueWei = BigInt(tx.value ?? "0");
        } catch {
          continue;
        }
        if (valueWei <= 0n) continue;

        const existing = byFunder.get(from);
        if (existing === undefined || timestamp < existing.timestamp) {
          byFunder.set(from, {
            funder: from,
            blockNumber: tx.blockNumber,
            timestamp,
            valueWei: valueWei.toString(),
            isDust: valueWei < NATIVE_DUST_THRESHOLD_WEI,
          });
        }
      }

      if (res.nextBlock >= (res.archiveHeight ?? res.nextBlock)) break;
      fromBlock = res.nextBlock;
    }

    // No transaction at all. Returning null keeps that distinct from
    // "born at block zero", which would read as the oldest wallet on the
    // chain and cluster falsely with every other unknown.
    if (firstSeenBlock === Number.MAX_SAFE_INTEGER) return null;

    return {
      firstSeenBlock,
      firstSeenTimestamp,
      funders: Array.from(byFunder.values()).sort((a, b) => a.timestamp - b.timestamp),
    };
  },
);
