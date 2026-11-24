// pumpbot-24h-01: a dip-buying mean-reversion paper-trading bot for pump.fun
// bonding curves, built for make.fun's "Pump.fun Replay Sprint — Paper Bot,
// Real Ranking" bounty (competition u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122).
//
// Protocol: agent-fun/replay/v2 over stdio, one JSON object per line.
//   hello  -> the run's seed, capital, caps, latency and fees.
//   batch  -> this slot's events, marks, fills and account; we answer with one
//             reply line carrying our orders (at most 16).
//   done   -> final account; no reply.
//
// Strategy (designed from scratch, tuned on the kit's dev window):
//   Track every mint's price (virtual SOL reserves / virtual token reserves).
//   Enter when a mint has pulled back 16-35% from its trailing high over the
//   last 32 trades, the high is a few trades old, the pullback is not a total
//   collapse, the price has already bounced 3% off its recent low, and sell
//   pressure is fading. Only deep curves (real reserves >= 18 SOL) qualify:
//   the dev-window study showed shallow dips and thin curves keep grinding
//   down, while 16-35% pullbacks on deep curves revert. Exit on a +9%
//   take-profit, a -10% stop-loss, or a 60-trade staleness timeout. Buys are
//   0.30 SOL (capped at 85% of the harness's 1%-of-real-reserve rule), at
//   most five open positions, one entry per batch, rotating across many mints
//   to clear the 20-mint guardrail, with a 100-trade re-entry cooldown.
//
// Determinism: every decision is a pure function of the messages received.
// No Math.random(), no Date.now(), no environment reads in trading logic.
// Fees, slippage and the per-order size cap are respected by construction.
//
// Runs with Node 22 type stripping: erasable TypeScript only (no enums,
// namespaces or parameter properties), node builtins only, zero dependencies.

import { createInterface } from "node:readline";

// ---------------------------------------------------------------------------
// Configuration: thresholds chosen from the dev-window backtest (see README).
// ---------------------------------------------------------------------------

const CONFIG = {
  // Entry: pullback from the trailing high over WINDOW_TRADES trades.
  // The dev-window study found the mean-reversion edge lives in 16-35%
  // pullbacks on deep curves (real reserves >= 18 SOL): shallower dips and
  // thin curves keep grinding down, deeper dips are usually rugs.
  dipBps: 1600, // 16% pullback
  maxDipBps: 3500, // ignore pullbacks deeper than 35% (collapse regime)
  bounceBps: 300, // enter only once the price has bounced 3% off its recent low
  bounceWindowTrades: 8, // window for the recent low the bounce is measured from
  windowTrades: 32, // trailing-high window, in trades
  minTrades: 12, // history needed before a mint is tradable
  minHighAgeTrades: 3, // the high must be at least this many trades old
  minRealSolLamports: 18_000_000_000n, // 18 SOL of real reserves (deep curves only)
  // Sizing: fixed small buys, capped by the harness's 1%-of-real-reserve rule.
  baseBuyLamports: 300_000_000n, // 0.30 SOL (capped by 85% of the 1% rule)
  minBuyLamports: 20_000_000n, // 0.02 SOL (guardrail needs >= 0.01 SOL buys)
  maxPositions: 5,
  maxBuysPerBatch: 1, // spread entries across batches
  // Exits.
  takeProfitBps: 900, // +9% from entry price
  stopLossBps: 1000, // -10% from entry price
  maxHoldTrades: 60, // stale exit: this many mint trades after entry
  maxHoldSlots: 120_000, // stale exit: this many slots after entry
  cooldownTrades: 100, // do not re-enter a mint this soon after an exit
  buySlippageBps: 500, // 5% tolerance on buy fills (2-slot latency)
  sellSlippageBps: 2000, // 20%: in a fast drop, take the first exit rather than chase the crash down with rejected retries
};

const LAMPORTS_PER_SOL = 1_000_000_000n;
const BPS = 10_000n;
const PUBKEY_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const U64_RE = /^(0|[1-9][0-9]{0,19})$/;
const CLIENT_ID_RE = /^[A-Za-z0-9-][A-Za-z0-9_-]{0,63}$/;
const MAX_ORDERS_PER_BATCH = 16;

// ---------------------------------------------------------------------------
// Small helpers.
// ---------------------------------------------------------------------------

function log(...args: unknown[]): void {
  console.error("[pumpbot]", ...args);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function toBig(v: unknown, what: string): bigint {
  if (typeof v === "bigint") return v;
  if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
  if (typeof v === "string" && U64_RE.test(v)) return BigInt(v);
  throw new Error(`${what} is not a u64: ${String(v).slice(0, 80)}`);
}

function priceOf(vq: bigint, vt: bigint): number {
  if (vt <= 0n || vq <= 0n) return 0;
  return Number(vq) / Number(vt);
}

// ---------------------------------------------------------------------------
// Per-mint state.
// ---------------------------------------------------------------------------

interface MintTrack {
  mint: string;
  createdSlot: number | null;
  vq: bigint;
  vt: bigint;
  rq: bigint;
  rt: bigint;
  slot: number;
  complete: boolean;
  trades: number;
  // Ring buffer of the last WINDOW_TRADES trade prices (SOL per token unit).
  prices: number[];
  priceNext: number;
  priceCount: number;
  lastPrice: number;
  prevPrice: number;
  // Last few trades, for the fading-sell-pressure check.
  recentBuys: bigint; // quote volume of buys among the last RECENT_N trades
  recentSells: bigint; // quote volume of sells among the last RECENT_N trades
  recent: Array<{ isBuy: boolean; q: bigint }>;
  lastExitTrades: number; // mint trade count when we last exited it
}

const RECENT_N = 5;

function newTrack(mint: string, slot: number): MintTrack {
  return {
    mint,
    createdSlot: null,
    vq: 0n,
    vt: 0n,
    rq: 0n,
    rt: 0n,
    slot,
    complete: false,
    trades: 0,
    prices: new Array<number>(CONFIG.windowTrades).fill(0),
    priceNext: 0,
    priceCount: 0,
    lastPrice: 0,
    prevPrice: 0,
    recentBuys: 0n,
    recentSells: 0n,
    recent: [],
    lastExitTrades: -1_000_000,
  };
}

function trailingHigh(t: MintTrack): { high: number; ageTrades: number } {
  let high = 0;
  let highIdx = -1;
  for (let i = 0; i < t.priceCount; i++) {
    const p = t.prices[i]!;
    if (p > high) {
      high = p;
      highIdx = i;
    }
  }
  // Age of the high in trades: the newest price sits at priceNext - 1 (or at
  // priceCount - 1 while the ring is still filling); count back from there.
  let age = 0;
  if (highIdx >= 0) {
    const newest =
      t.priceCount < CONFIG.windowTrades
        ? t.priceCount - 1
        : (t.priceNext - 1 + CONFIG.windowTrades) % CONFIG.windowTrades;
    age = (newest - highIdx + CONFIG.windowTrades) % CONFIG.windowTrades;
  }
  return { high, ageTrades: age };
}

// Lowest price over the last `n` recorded trades (n <= windowTrades).
function recentLow(t: MintTrack, n: number): number {
  let low = Infinity;
  const count = Math.min(n, t.priceCount);
  for (let k = 0; k < count; k++) {
    const idx = (t.priceNext - 1 - k + CONFIG.windowTrades) % CONFIG.windowTrades;
    const p = t.prices[idx]!;
    if (p < low) low = p;
  }
  return low === Infinity ? 0 : low;
}

function recordTrade(
  t: MintTrack,
  price: number,
  isBuy: boolean,
  quoteLamports: bigint,
): void {
  t.prevPrice = t.lastPrice;
  t.lastPrice = price;
  t.prices[t.priceNext] = price;
  t.priceNext = (t.priceNext + 1) % CONFIG.windowTrades;
  if (t.priceCount < CONFIG.windowTrades) t.priceCount++;
  t.trades++;
  t.recent.push({ isBuy, q: quoteLamports });
  if (isBuy) t.recentBuys += quoteLamports;
  else t.recentSells += quoteLamports;
  if (t.recent.length > RECENT_N) {
    const old = t.recent.shift()!;
    if (old.isBuy) t.recentBuys -= old.q;
    else t.recentSells -= old.q;
  }
}

// ---------------------------------------------------------------------------
// Position book (entry reference prices, kept from our own fills).
// ---------------------------------------------------------------------------

interface Held {
  mint: string;
  entryPrice: number;
  entrySlot: number;
  entryTrades: number;
  tokens: bigint;
}

interface PendingBuy {
  mint: string;
  price: number;
  slot: number;
  trades: number;
}

// ---------------------------------------------------------------------------
// Orders.
// ---------------------------------------------------------------------------

type Order =
  | {
      side: "buy";
      client_id: string;
      mint: string;
      quote_lamports: string;
      max_slippage_bps: number;
    }
  | {
      side: "sell";
      client_id: string;
      mint: string;
      token_amount: string;
      max_slippage_bps: number;
    };

function validateOrder(o: Order): void {
  if (!PUBKEY_RE.test(o.mint)) throw new Error(`bad mint ${o.mint}`);
  if (!CLIENT_ID_RE.test(o.client_id)) throw new Error(`bad client_id ${o.client_id}`);
  if (!Number.isInteger(o.max_slippage_bps) || o.max_slippage_bps < 0 || o.max_slippage_bps > 10_000) {
    throw new Error(`bad max_slippage_bps ${o.max_slippage_bps}`);
  }
  const amount = o.side === "buy" ? o.quote_lamports : o.token_amount;
  if (!U64_RE.test(amount) || BigInt(amount) === 0n) throw new Error(`bad amount ${amount}`);
}

// ---------------------------------------------------------------------------
// Bot state.
// ---------------------------------------------------------------------------

interface Hello {
  seed: string;
  capitalLamports: bigint;
  maxOpenPositions: number;
  maxOrderBps: number;
  maxOrdersPerBatch: number;
  latencySlots: number;
  protocolFeeBps: number;
  creatorFeeBps: number;
  baseFeeLamports: bigint;
  priorityFeeLamports: bigint;
}

const state = {
  hello: null as Hello | null,
  curves: new Map<string, MintTrack>(),
  cash: 0n,
  positions: new Map<string, bigint>(), // mint -> tokens held (from account)
  held: new Map<string, Held>(), // mint -> entry reference
  pending: new Map<string, { order: Order; decidedSlot: number }>(),
  pendingBuys: new Map<string, PendingBuy>(),
  nextClientId: 1,
  batches: 0,
  buys: 0,
  sells: 0,
  fillsSeen: 0,
};

function clientId(): string {
  return `o${state.nextClientId++}`;
}

function track(mint: string, slot: number): MintTrack {
  let t = state.curves.get(mint);
  if (t === undefined) {
    t = newTrack(mint, slot);
    state.curves.set(mint, t);
  }
  return t;
}

function txFee(): bigint {
  const h = state.hello!;
  return h.baseFeeLamports + h.priorityFeeLamports;
}

function freeCash(): bigint {
  let free = state.cash;
  for (const p of state.pending.values()) {
    free -= txFee();
    if (p.order.side === "buy") free -= BigInt(p.order.quote_lamports);
  }
  return free;
}

function committedPositions(): number {
  const mints = new Set<string>(state.positions.keys());
  for (const m of state.pendingBuys.keys()) mints.add(m);
  return mints.size;
}

// ---------------------------------------------------------------------------
// Strategy.
// ---------------------------------------------------------------------------

function fadingSellPressure(t: MintTrack): boolean {
  // Sell pressure is fading when recent flow is net buying, or the latest
  // trade ticked the price up after a sell-heavy stretch.
  if (t.recentBuys >= t.recentSells) return true;
  if (t.lastPrice > 0 && t.prevPrice > 0 && t.lastPrice >= t.prevPrice) return true;
  return false;
}

function entrySignal(t: MintTrack): boolean {
  if (t.complete || t.createdSlot === null) return false;
  if (t.trades < CONFIG.minTrades) return false;
  if (t.rq < CONFIG.minRealSolLamports) return false;
  if (t.trades - t.lastExitTrades < CONFIG.cooldownTrades) return false;
  if (state.positions.has(t.mint) || state.pendingBuys.has(t.mint)) return false;
  const price = t.lastPrice;
  if (price <= 0) return false;
  const { high, ageTrades } = trailingHigh(t);
  if (high <= 0 || ageTrades < CONFIG.minHighAgeTrades) return false;
  // Pullback from the trailing high, in bps.
  const dipBps = Math.floor(((high - price) / high) * 10_000);
  if (dipBps < CONFIG.dipBps) return false;
  if (dipBps > CONFIG.maxDipBps) return false;
  // Bounce confirmation: the price must already be recovering off its
  // recent low, so we buy the turn, not the falling knife.
  const low = recentLow(t, CONFIG.bounceWindowTrades);
  if (low <= 0) return false;
  const bounceBps = Math.floor(((price - low) / low) * 10_000);
  if (bounceBps < CONFIG.bounceBps) return false;
  if (!fadingSellPressure(t)) return false;
  return true;
}

function buySize(t: MintTrack): bigint {
  // Harness cap: buys on one mint in one reply may spend at most
  // maxOrderBps of the mint's real SOL reserve.
  const h = state.hello!;
  const cap = (t.rq * BigInt(h.maxOrderBps)) / BPS;
  let size = CONFIG.baseBuyLamports;
  const capHeadroom = (cap * 85n) / 100n;
  if (size > capHeadroom) size = capHeadroom;
  if (size < CONFIG.minBuyLamports) return 0n;
  // Keep a small cash buffer so exits can always pay their tx fees.
  const free = freeCash();
  const maxSpend = free - 1_000_000n; // keep 0.001 SOL spare
  if (size > maxSpend) size = maxSpend;
  if (size < CONFIG.minBuyLamports) return 0n;
  return size;
}

function decideExits(slot: number): Order[] {
  const orders: Order[] = [];
  for (const [mint, tokens] of state.positions) {
    if (tokens <= 0n) continue;
    const t = state.curves.get(mint);
    const h = state.held.get(mint);
    if (t === undefined || h === undefined) continue;
    if (state.pendingBuys.has(mint)) continue;
    // Do not stack a second sell while one is already pending.
    let sellPending = false;
    for (const p of state.pending.values()) {
      if (p.order.side === "sell" && p.order.mint === mint) {
        sellPending = true;
        break;
      }
    }
    if (sellPending) continue;
    const price = t.lastPrice;
    if (price <= 0 || h.entryPrice <= 0) continue;
    const moveBps = Math.floor(((price - h.entryPrice) / h.entryPrice) * 10_000);
    const stale =
      t.trades - h.entryTrades >= CONFIG.maxHoldTrades ||
      slot - h.entrySlot >= CONFIG.maxHoldSlots;
    if (moveBps >= CONFIG.takeProfitBps || moveBps <= -CONFIG.stopLossBps || stale) {
      orders.push({
        side: "sell",
        client_id: clientId(),
        mint,
        token_amount: tokens.toString(),
        max_slippage_bps: CONFIG.sellSlippageBps,
      });
    }
  }
  return orders;
}

function decideEntries(batchEvents: Array<Record<string, unknown>>, slot: number): Order[] {
  const orders: Order[] = [];
  if (committedPositions() >= CONFIG.maxPositions) return orders;
  for (const e of batchEvents) {
    if (orders.length >= CONFIG.maxBuysPerBatch) break;
    if (committedPositions() >= CONFIG.maxPositions) break;
    if (e.event !== "TradeEvent") continue;
    const mint = e.mint as string;
    const t = state.curves.get(mint);
    if (t === undefined) continue;
    if (!entrySignal(t)) continue;
    const size = buySize(t);
    if (size <= 0n) continue;
    const order: Order = {
      side: "buy",
      client_id: clientId(),
      mint,
      quote_lamports: size.toString(),
      max_slippage_bps: CONFIG.buySlippageBps,
    };
    orders.push(order);
    state.pendingBuys.set(mint, {
      mint,
      price: t.lastPrice,
      slot,
      trades: t.trades,
    });
  }
  return orders;
}

// ---------------------------------------------------------------------------
// Message handling.
// ---------------------------------------------------------------------------

function applyHello(msg: Record<string, unknown>): void {
  if (msg.protocol !== "agent-fun/replay/v2") {
    throw new Error(`unsupported protocol ${String(msg.protocol)}`);
  }
  const caps = msg.caps as Record<string, unknown>;
  const fees = msg.fees as Record<string, unknown>;
  const capital = msg.capital as Record<string, unknown>;
  if (!isRecord(caps) || !isRecord(fees) || !isRecord(capital)) {
    throw new Error("hello is missing caps, fees or capital");
  }
  state.hello = {
    seed: String(msg.seed),
    capitalLamports: toBig(capital.lamports, "capital.lamports"),
    maxOpenPositions: Number(caps.max_open_positions),
    maxOrderBps: Number(caps.max_order_bps_of_real_reserve),
    maxOrdersPerBatch: Number(caps.max_orders_per_batch),
    latencySlots: Number(msg.latency_slots),
    protocolFeeBps: Number(fees.protocol_bps_fallback),
    creatorFeeBps: Number(fees.creator_bps_fallback),
    baseFeeLamports: toBig(fees.base_fee_lamports, "fees.base_fee_lamports"),
    priorityFeeLamports: toBig(fees.priority_fee_lamports, "fees.priority_fee_lamports"),
  };
  state.cash = state.hello.capitalLamports;
  log(
    `hello seed=${state.hello.seed} capital=${state.hello.capitalLamports} ` +
      `maxPositions=${state.hello.maxOpenPositions} maxOrderBps=${state.hello.maxOrderBps} ` +
      `latency=${state.hello.latencySlots} fees=${state.hello.protocolFeeBps}+${state.hello.creatorFeeBps}bps`,
  );
}

function applyBatch(msg: Record<string, unknown>): Order[] {
  const seq = msg.seq;
  const slot = msg.slot;
  if (!Number.isSafeInteger(seq) || !Number.isSafeInteger(slot)) {
    throw new Error(`malformed batch seq/slot: ${String(seq)}/${String(slot)}`);
  }
  const events = msg.events as Array<Record<string, unknown>>;
  const marks = msg.marks as Array<Record<string, unknown>>;
  const fills = msg.fills as Array<Record<string, unknown>>;
  const account = msg.account as Record<string, unknown>;
  if (!Array.isArray(events) || !Array.isArray(marks) || !Array.isArray(fills) || !isRecord(account)) {
    throw new Error(`malformed batch ${String(seq)}`);
  }
  const slotNum = slot as number;

  // 1. Fills: fold our own resolutions into the position book.
  for (const f of fills) {
    state.fillsSeen++;
    const cid = String(f.client_id);
    const mint = String(f.mint);
    const status = String(f.status);
    const pending = state.pending.get(cid);
    if (pending !== undefined) state.pending.delete(cid);
    if (status !== "filled") {
      if (pending !== undefined && pending.order.side === "buy") state.pendingBuys.delete(mint);
      continue;
    }
    if (f.side === "buy") {
      const pb = state.pendingBuys.get(mint);
      state.pendingBuys.delete(mint);
      const t = state.curves.get(mint);
      state.held.set(mint, {
        mint,
        entryPrice: pb !== undefined ? pb.price : t !== undefined ? t.lastPrice : 0,
        entrySlot: pb !== undefined ? pb.slot : slotNum,
        entryTrades: pb !== undefined ? pb.trades : t !== undefined ? t.trades : 0,
        tokens: toBig(f.token_amount, "fill.token_amount"),
      });
      state.buys++;
    } else if (f.side === "sell") {
      const t = state.curves.get(mint);
      if (t !== undefined) t.lastExitTrades = t.trades;
      state.held.delete(mint);
      state.sells++;
    }
  }

  // 2. Account: authoritative cash and positions.
  state.cash = toBig(account.cash_lamports, "account.cash_lamports");
  state.positions.clear();
  const positions = account.positions as Array<Record<string, unknown>>;
  if (!Array.isArray(positions)) throw new Error(`malformed account positions in batch ${String(seq)}`);
  for (const p of positions) {
    const tokens = toBig(p.token_amount, "position.token_amount");
    if (tokens > 0n) state.positions.set(String(p.mint), tokens);
  }
  // A held mint the account no longer lists (harness close) leaves the book.
  for (const mint of [...state.held.keys()]) {
    if (!state.positions.has(mint)) {
      const t = state.curves.get(mint);
      if (t !== undefined) t.lastExitTrades = t.trades;
      state.held.delete(mint);
    }
  }

  // 3. Marks: latest reserves for held / pending mints.
  for (const m of marks) {
    const mint = String(m.mint);
    const t = track(mint, slotNum);
    const mSlot = Number(m.slot);
    if (mSlot < t.slot && t.vq !== 0n) continue;
    t.vq = toBig(m.virtual_quote_reserves, "mark.virtual_quote_reserves");
    t.vt = toBig(m.virtual_token_reserves, "mark.virtual_token_reserves");
    t.rq = toBig(m.real_quote_reserves, "mark.real_quote_reserves");
    t.rt = toBig(m.real_token_reserves, "mark.real_token_reserves");
    t.slot = mSlot;
    t.lastPrice = priceOf(t.vq, t.vt);
  }

  // 4. Events: keep every curve current and evaluate entries on trades.
  for (const e of events) {
    const mint = String(e.mint);
    const t = track(mint, slotNum);
    if (e.event === "CreateEvent") {
      t.createdSlot = Number(e.slot);
      t.vq = toBig(e.virtual_quote_reserves, "create.virtual_quote_reserves");
      t.vt = toBig(e.virtual_token_reserves, "create.virtual_token_reserves");
      t.rq = 0n;
      t.rt = toBig(e.real_token_reserves, "create.real_token_reserves");
      t.slot = Number(e.slot);
      t.lastPrice = priceOf(t.vq, t.vt);
    } else if (e.event === "TradeEvent") {
      t.vq = toBig(e.virtual_quote_reserves, "trade.virtual_quote_reserves");
      t.vt = toBig(e.virtual_token_reserves, "trade.virtual_token_reserves");
      t.rq = toBig(e.real_quote_reserves, "trade.real_quote_reserves");
      t.rt = toBig(e.real_token_reserves, "trade.real_token_reserves");
      t.slot = Number(e.slot);
      const price = priceOf(t.vq, t.vt);
      recordTrade(t, price, e.is_buy === true, toBig(e.quote_amount, "trade.quote_amount"));
    } else if (e.event === "CompleteEvent") {
      t.complete = true;
      t.slot = Number(e.slot);
    }
  }

  state.batches++;
  const exits = decideExits(slotNum);
  const entries = decideEntries(events, slotNum);
  const orders = [...exits, ...entries];
  if (orders.length > MAX_ORDERS_PER_BATCH) {
    throw new Error(`batch ${String(seq)}: ${orders.length} orders over the cap`);
  }
  for (const o of orders) validateOrder(o);
  return orders;
}

function applyDone(msg: Record<string, unknown>): void {
  const account = msg.account as Record<string, unknown>;
  const cash = isRecord(account) ? toBig(account.cash_lamports, "done.cash_lamports") : 0n;
  const pnl = cash - (state.hello?.capitalLamports ?? 0n);
  log(
    `done reason=${String(msg.reason)} batches=${state.batches} ` +
      `buys=${state.buys} sells=${state.sells} fills=${state.fillsSeen} ` +
      `finalCash=${cash} pnlLamports=${pnl} pnlSol=${Number(pnl) / Number(LAMPORTS_PER_SOL)}`,
  );
}

// ---------------------------------------------------------------------------
// Main loop: one JSON line in, exactly one reply line out per batch.
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  let sawDone = false;
  for await (const line of rl) {
    if (line.trim() === "") continue;
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      throw new Error(`input line is not JSON: ${line.slice(0, 120)}`);
    }
    if (!isRecord(msg) || typeof msg.type !== "string") {
      throw new Error("input line is not a harness message object");
    }
    if (msg.type === "hello") {
      if (state.hello !== null) throw new Error("a second hello");
      applyHello(msg);
    } else if (msg.type === "batch") {
      if (state.hello === null) throw new Error("a batch before hello");
      const orders = applyBatch(msg);
      const reply = { type: "reply", seq: msg.seq, orders };
      const text = JSON.stringify(reply);
      if (Buffer.byteLength(text, "utf8") > 65_536) {
        throw new Error(`batch ${String(msg.seq)}: reply over 64 KiB`);
      }
      for (const o of orders) {
        state.pending.set(o.client_id, { order: o, decidedSlot: Number(msg.slot) });
      }
      process.stdout.write(`${text}\n`);
    } else if (msg.type === "done") {
      if (state.hello === null) throw new Error("done before hello");
      applyDone(msg);
      sawDone = true;
      break;
    } else {
      throw new Error(`unknown message type ${msg.type}`);
    }
  }
  if (!sawDone) {
    log("input ended before done");
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err: unknown) => {
  console.error("[pumpbot] fatal:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
