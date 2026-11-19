// Token Radar's model, radar-2: one snapshot of the protocol universe in, one ranked board out.
//
// The board covers every slug in the snapshot's watchlist (the floor, never a ceiling) and adds
// EVERY rankable pre-token protocol below the watchlist floor: the early radar exists to find them
// before anyone else does. A protocol is pre-token when its record carries no token (no market cap,
// no CoinGecko id, no symbol); the live-token protocols are kept apart and shown with the market's
// own values, never mixed into the ranked board.
//
// Implied value follows only from the snapshot's own figures — TVL, seven-day growth, and how long
// the protocol has run with no token. No protocol name is ever special-cased: one function scores
// every row, and the dashboard states the formula and recomputes each row from the same figures.
//
//   base        = tvl_usd x BASE_MULTIPLE                 (the size of the prize)
//   growth      = clamp(change_7d, -50, 80) per cent       (momentum, weighted hard)
//   growthMult  = 1 + (growth / 100) x GROWTH_WEIGHT
//   spike       = 0.92 when |change_7d| > 50, else 1      (a one-week spike is the least durable signal)
//   maturity    = 0.55 + 0.45 x min(age_days, 730) / 730   (surviving two years with no token is proven)
//   opacity     = 0.95 when change_7d is unreported, else 1 (missing data is a real discount)
//   implied     = max(1, round(base x growthMult x spike x maturity x opacity))
//
// Age unknown means the protocol's first listing is unrecorded, so it is scored at 180 days, not a
// full year: an unproven age is not a mature one. Growth unreported is scored at zero growth and
// discounted for opacity. The constants are the model's, stated in the dashboard.
//
// Worked example, so a reader can check the arithmetic by hand. Take a protocol with
// TVL $100,000,000, seven-day growth +20%, and an age of 365 days, growth reported:
//   base     = 100,000,000 x 0.30 = $30,000,000
//   growth   = clamp(20, -50, 80) = 20, so growthMult = 1 + (20 / 100) x 0.75 = 1.15
//   spike    = 1, because |20| is not over the 50% threshold
//   maturity = 0.55 + 0.45 x min(365, 730) / 730 = 0.55 + 0.45 x 0.5 = 0.775
//   opacity  = 1, because growth was reported
//   implied  = round(30,000,000 x 1.15 x 1 x 0.775 x 1) = $26,737,500
// The same protocol with growth unreported and age unknown would score at zero growth with the
// 0.95 opacity discount and 180 days of maturity, about $9.42M on a $50M TVL: missing data
// costs value twice, once for the growth it cannot show and once for the age it cannot prove.
//
// Reading guide. The file is ordered so the model reads top to bottom: the snapshot's shapes
// first (SnapshotProtocol, Snapshot, ModelConstants, MODEL), then the row shapes the board
// carries (FarmStep, BoardRow, RadarRow, LiveRow, RadarData), then the pure functions in the
// order the pipeline calls them — ageDays, impliedValue, isPreToken, isRankable, buildBoard,
// farmSteps, liveRows, buildRadar, parseSnapshot, boardIssue, dataScript. Nothing here reads
// the network, the clock, or the filesystem: given the same snapshot text, every function
// returns the same answer, which is what lets the dashboard recompute each row from the same
// figures and lets the build verify every row against board.json.

/** The snapshot's protocol entry: exactly the ten fields the sealed input carries. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The whole snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** The model's constants, as the dashboard states them. */
export interface ModelConstants {
  base_multiple: number;
  growth_weight: number;
  growth_floor: number;
  growth_cap: number;
  spike_threshold: number;
  spike_haircut: number;
  maturity_floor: number;
  maturity_range: number;
  maturity_days: number;
  unknown_age_days: number;
  unknown_growth_discount: number;
}

// Why the constants live in one object instead of scattered literals: the dashboard states the
// formula by reading MODEL, and main.ts scores with the same object, so a number can never drift
// between the page's explanation and the board's arithmetic. Change a constant here and both the
// board and the formula panel move together. The names say what each number is for: base_multiple
// is the share of TVL a token is assumed to capture, growth_weight is how hard momentum counts,
// growth_floor and growth_cap bound a single week so one wild print cannot dominate, spike_threshold
// and spike_haircut are the "one-week spike is the least durable signal" rule, maturity_floor and
// maturity_range say a newborn protocol still earns 55% of its maturity credit while two years of
// survival earns the full 100%, maturity_days is the two-year horizon, unknown_age_days is the
// 180-day stand-in for an unrecorded listing, and unknown_growth_discount is the 5% charge for
// missing data.
export const MODEL: ModelConstants = {
  base_multiple: 0.3,
  growth_weight: 0.75,
  growth_floor: -50,
  growth_cap: 80,
  spike_threshold: 50,
  spike_haircut: 0.92,
  maturity_floor: 0.55,
  maturity_range: 0.45,
  maturity_days: 730,
  unknown_age_days: 180,
  unknown_growth_discount: 0.95,
};

/** The model's version label: the dashboard names it. */
export const MODEL_VERSION = 'radar-2';

/** How many live-token protocols the Live token view carries, by market cap. */
export const LIVE_ROWS = 24;

/** A farm step: the action, what it costs, and how long it takes. */
export interface FarmStep {
  text: string;
  cost: string;
  time: string;
}

/** One row of board.json: the ranked board's row. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: 'pre-token';
  age_days: number | null;
  implied_value_usd: number;
  model: {
    base_multiple: number;
    growth_pct: number;
    growth_multiplier: number;
    spike_multiplier: number;
    maturity_multiplier: number;
    opacity_multiplier: number;
    age_days: number | null;
  };
  farm_steps: string[];
}

/** The dashboard's compact view of one row, with the farm plan generated in the page. */
export interface RadarRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  age_days: number | null;
  implied_value_usd: number;
  growth_multiplier: number;
  spike_multiplier: number;
  maturity_multiplier: number;
  opacity_multiplier: number;
}

/** A live-token protocol: it already trades, so the board shows the market's own value, not a model's. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
}

/** Everything the dashboard needs: the board, the live set, and the model it runs. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model: ModelConstants;
  model_version: string;
  watchlist_size: number;
  watchlist_slugs: string[];
  board_size: number;
  early_size: number;
  live_size: number;
  rows: RadarRow[];
  live: LiveRow[];
}

/** Why the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;

/** A finite number, else `fallback`. */
function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

// Age is whole days, never fractions: the model only needs to know whether a protocol has
// survived months or years, and a fractional day would pretend to a precision the listing dates
// do not have. Both dates are parsed as UTC midnight so a timezone can never shift the count by
// a day, and a negative span (a listing dated after the snapshot) clamps to zero instead of
// scoring a protocol as "younger than newborn". A missing or unparseable date returns null,
// which the model reads as "unknown age", not as zero.
/** A whole day count from `from` to `to`, clamped at zero; null when either date is absent or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

// The scoring, step by step, in the order the code runs it. First the age: ageDays measures
// whole days from the protocol's first listing to the snapshot's date, or null when the listing
// is unrecorded. Then the growth: the raw seven-day change is read as zero when unreported, then
// clamped into [-50, 80] so a single week cannot swing the score more than the model allows, and
// weighted by 0.75 so momentum matters but never overwhelms size. Then the spike haircut: a move
// over 50% in either direction takes 0.92, because a one-week spike is the least durable signal
// in the snapshot. Then maturity: the age (or 180 days when unknown) is capped at 730 days and
// mapped onto 0.55..1.00, so surviving two years with no token is proven and a newborn still
// earns its floor. Then opacity: unreported growth takes 0.95, a real discount for missing data.
// Finally the base, TVL x 0.30, is multiplied by all five and rounded, with a floor of $1 so no
// row ever scores zero or negative. The function returns every intermediate value, not just the
// total, because board.json carries the breakdown and the dashboard shows it per row.
/** The five multipliers and the implied value one protocol gets under `model`. */
export function impliedValue(
  protocol: SnapshotProtocol,
  asOf: string,
  model: ModelConstants,
): { implied: number; growthPct: number; growthMult: number; spikeMult: number; maturityMult: number; opacityMult: number; age: number | null } {
  const age = ageDays(asOf, protocol.listed_at);
  const rawGrowth = finite(protocol.change_7d, 0);
  const growthPct = Math.min(model.growth_cap, Math.max(model.growth_floor, rawGrowth));
  const growthMult = 1 + (growthPct / 100) * model.growth_weight;
  const spikeMult = Math.abs(rawGrowth) > model.spike_threshold ? model.spike_haircut : 1;
  const ageForModel = age ?? model.unknown_age_days;
  const maturityMult =
    model.maturity_floor + (Math.min(Math.max(ageForModel, 0), model.maturity_days) / model.maturity_days) * model.maturity_range;
  const opacityMult = protocol.change_7d === null ? model.unknown_growth_discount : 1;
  const base = protocol.tvl_usd * model.base_multiple;
  const implied = Math.max(1, Math.round(base * growthMult * spikeMult * maturityMult * opacityMult));
  return { implied, growthPct, growthMult, spikeMult, maturityMult, opacityMult, age };
}

/** DefiLlama's version-marker rule: a name ending in a release is a pool of another protocol. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** Whether a protocol records no token at all. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

// What the board refuses to rank, and why each refusal is there. A protocol is rankable only
// when it is pre-token (no market cap, no CoinGecko id, no symbol — isPreToken checks all three,
// because any one of them proves a token already trades), not a centralised exchange (a CEX is a
// company with a token, not a protocol to farm), and not a versioned pool (a name ending in V2,
// v3 or 1.5 is one pool of another protocol, and ranking it would double-count the same TVL).
// The VERSIONED pattern catches all three spellings — "V2", "v2" and "1.5" — at the end of the
// name, so "Lend V2" is refused while "V2 Finance" (a name that merely starts with it) is not.
/** Whether a protocol is one the board may rank: pre-token, not an exchange, not a versioned pool. */
export function isRankable(p: SnapshotProtocol): boolean {
  return isPreToken(p) && p.category !== 'CEX' && !VERSIONED.test(p.name);
}

/** The snapshot's protocol by slug. */
function bySlug(protocols: SnapshotProtocol[]): Map<string, SnapshotProtocol> {
  return new Map(protocols.map((p) => [p.slug, p]));
}

// How the board is chosen, in two phases that never overlap. Phase one is the watchlist: every
// slug the snapshot names, in the snapshot's order, as long as the snapshot still carries it —
// the watchlist is the floor, and a watchlist protocol is chosen even when its TVL sits below
// the floor, because the floor is a minimum for discovery, not a bar for the watched. Phase two
// is the early radar: every rankable pre-token protocol below the watchlist floor, taken in TVL
// order with the slug as the tie-break, and added only if phase one did not already choose it.
// There is no cap on the early radar: a board that stops at an arbitrary number is a board that
// chose not to look. Scoring then sorts by implied value descending, again with the slug as the
// tie-break so the order is deterministic, and assigns ranks 1..n in that order. A protocol's
// farm plan is derived at the same time, from the same record, so the plan and the rank can never
// disagree about which protocol they describe.
/** The protocols the board ranks, strongest first, with ranks 1..n. */
export function buildBoard(snapshot: Snapshot, model: ModelConstants = MODEL): BoardRow[] {
  const index = bySlug(snapshot.protocols);
  const chosen = new Map<string, SnapshotProtocol>();
  // The watchlist is the floor: every slug, even one the snapshot no longer carries (it cannot, but
  // the board's coverage is the gate's row and is never gambled on a missing record).
  for (const slug of snapshot.watchlist) {
    const p = index.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }
  // The early radar: EVERY rankable pre-token protocol below the watchlist floor, by TVL. No cap:
  // the radar exists to find the early ones, and a board that stops at an arbitrary number is a
  // board that chose not to look. A chosen protocol stays chosen.
  const early = snapshot.protocols
    .filter((p) => !chosen.has(p.slug) && isRankable(p) && p.tvl_usd < snapshot.floor_usd)
    .sort((a, b) => b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  for (const p of early) chosen.set(p.slug, p);

  const scored = [...chosen.values()].map((p) => {
    const v = impliedValue(p, snapshot.as_of, model);
    return { p, ...v };
  });
  scored.sort((a, b) => b.implied - a.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  return scored.map((s, i) => ({
    rank: i + 1,
    slug: s.p.slug,
    name: s.p.name,
    category: s.p.category,
    chains: s.p.chains,
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    mcap_usd: s.p.mcap_usd,
    listed_at: s.p.listed_at,
    gecko_id: s.p.gecko_id,
    symbol: s.p.symbol,
    token_status: 'pre-token',
    age_days: s.age,
    implied_value_usd: s.implied,
    model: {
      base_multiple: model.base_multiple,
      growth_pct: s.growthPct,
      growth_multiplier: round4(s.growthMult),
      spike_multiplier: s.spikeMult,
      maturity_multiplier: round4(s.maturityMult),
      opacity_multiplier: s.opacityMult,
      age_days: s.age,
    },
    farm_steps: farmSteps(s.p, s.age).map(stepText),
  }));
}

const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

// A step is one string because the board carries farm plans as strings, not objects: the gate
// reads each step's length, and the dashboard splits it back into action, cost and time on the
// " Cost: " marker. The 600-character trim keeps a long category name or a long chain name from
// pushing a step over the gate, and the 20-character pad keeps a terse step from falling under
// it. Both guards are in stepText rather than in farmSteps so the same rule covers every step,
// whichever function built it.
/** A step as one string: its action, then its cost and time, within the gate's 20..600 characters. */
export function stepText(step: FarmStep): string {
  let s = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Hold the position and check the protocol's own page.`;
  return s;
}

// The chain helpers are small because the snapshot's chains are a plain list: the first chain
// is where the main position goes, the second (when there is one) is where the second position
// goes, and a protocol with no chains at all still gets a plan that reads naturally ("its main
// chain") instead of an empty slot. The dashboard's app.js carries the same two helpers, so the
// page's plan and the board's plan choose the same chains.
/** The first chain a protocol names, or a neutral phrase. */
function chainOf(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/** The second chain a protocol names, or null. */
function secondChainOf(p: SnapshotProtocol): string | null {
  return p.chains.length > 1 ? p.chains[1]! : null;
}

// The capital tiers are sized to this snapshot's range, not to an abstract idea of "a lot".
// The board's largest TVL is $2.75B, so the top tier ($250 at $2B and above) is one a real row
// reaches, and the bottom tier ($50 below $100M) is one the smallest early rows can afford. A
// tier no row can reach would never differentiate a plan; a tier every row reaches would never
// differentiate either. The tiers are $250 / $150 / $100 / $50, and the second position is
// always half the first, floored at $25, so the two positions stay proportional.
/** How much capital one farm position needs, from the protocol's own TVL. The tiers sit inside
 *  this snapshot's range (the board's largest TVL is $2.75B), so the top tier is one a real row
 *  reaches: a tier no row can reach is a tier that never differentiates a plan. */
function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 2_000_000_000) return 250;
  if (p.tvl_usd >= 500_000_000) return 150;
  if (p.tvl_usd >= 100_000_000) return 100;
  return 50;
}

// The hold is longer for younger protocols, because a young protocol's qualifying window is
// the thing its airdrop will measure: under 180 days old means 60 days, under a year means 45,
// a year or more means 30, and an unknown age means 45 — the middle value, not the longest,
// because an unproven age is not a young one either.
/** How long to hold, from the protocol's age: younger protocols get a longer qualifying window. */
function holdDaysFor(age: number | null): number {
  if (age === null) return 45;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

// The category dispatch is a chain of substring matches on the lower-cased category, in the
// order the categories are most likely to collide: lending first (it also catches CDP and
// collateral, which are lending by another name), then DEX/swap, yield and leveraged farming,
// bridges, staking and restaking, perpetuals and derivatives, prediction markets, curators and
// allocators, stables, real-world assets, insurance, and payments. The fallthrough is a plain
// deposit, so a category the model has never seen still gets a sensible action instead of an
// error. The matching is on substrings, not exact names, because the snapshot's categories are
// free text ("Lending", "Leveraged Farming", "Cross Chain Bridge") and an exact match would
// miss most of them. The same dispatch, with the same order, lives in the dashboard's app.js,
// so the page's farm plan and the board's farm plan are the same derivation.
/** The category's one main action, in the words a farmer can follow. */
function actionFor(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return `Supply $${capital} of USDC to ${name} on ${chain} and keep the position open.`;
  if (c.includes('dex') || c.includes('swap')) return `Provide $${capital} of liquidity to ${name}'s main pool on ${chain} and keep the position open.`;
  if (c.includes('yield') || c.includes('leveraged farm')) return `Deposit $${capital} of USDC into ${name}'s highest-yield vault on ${chain} and keep the shares.`;
  if (c.includes('bridge') || c.includes('canonical')) return `Bridge $${capital} of USDC to ${chain} through ${name} and use the bridged funds in its app.`;
  if (c.includes('staking') || c.includes('restak')) return `Stake $${capital} of the chain's staking asset through ${name} and keep the receipt token.`;
  if (c.includes('perpetual') || c.includes('perp') || c.includes('derivative') || c.includes('option')) return `Deposit $${capital} of USDC as margin on ${name} and open one small hedge.`;
  if (c.includes('prediction')) return `Fund $${capital} and place one market position on ${name}.`;
  if (c.includes('curator') || c.includes('allocator')) return `Deposit $${capital} into a ${name} vault on ${chain} and keep the shares.`;
  if (c.includes('stable')) return `Mint or deposit $${capital} of the stable asset through ${name} on ${chain}.`;
  if (c.includes('rwa')) return `Mint $${capital} of the protocol's yield-bearing asset on ${chain} and hold it.`;
  if (c.includes('insurance')) return `Buy $${capital} of cover from ${name} on ${chain} and keep the policy.`;
  if (c.includes('payment')) return `Route $${capital} of payments through ${name} on ${chain} and keep the account active.`;
  return `Deposit $${capital} of USDC into ${name} on ${chain} and keep the position open.`;
}

// The weekly action is deliberately small — $5 or $10, never new capital — because its job is
// to keep the wallet active, not to grow the position. A farmer who must add capital every week
// is a farmer being farmed. The amounts are fixed per category so the plan stays comparable
// across rows: the board's reader can see at a glance that every protocol costs about $2 of gas
// a week to stay active.
/** The category's weekly qualifying action: one small, repeatable move that keeps the wallet active. */
function weeklyActionFor(p: SnapshotProtocol, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return `Borrow $10 against the deposit on ${name} and repay it the same week.`;
  if (c.includes('dex') || c.includes('swap')) return `Swap $5 through ${name}'s main pool on ${chain}.`;
  if (c.includes('yield') || c.includes('leveraged farm')) return `Claim or restake the vault's yield on ${name}.`;
  if (c.includes('bridge') || c.includes('canonical')) return `Bridge $5 back and forth through ${name} so the route stays active.`;
  if (c.includes('staking') || c.includes('restak')) return `Stake another $10 through ${name} and keep the new receipt.`;
  if (c.includes('perpetual') || c.includes('perp') || c.includes('derivative') || c.includes('option')) return `Open and close one $5 hedge on ${name}.`;
  if (c.includes('prediction')) return `Place one $5 position on a new ${name} market.`;
  if (c.includes('curator') || c.includes('allocator')) return `Rebalance $10 between two ${name} vaults on ${chain}.`;
  if (c.includes('stable')) return `Mint or redeem $5 of the stable asset through ${name}.`;
  if (c.includes('rwa')) return `Buy another $10 of the yield asset on ${name}.`;
  if (c.includes('insurance')) return `Renew or top up $5 of cover on ${name}.`;
  if (c.includes('payment')) return `Send one $5 payment through ${name} on ${chain}.`;
  return `Make one small deposit, swap or vote on ${name}.`;
}

// The seven steps, and the order they are meant to be followed in. Step one is hygiene: a fresh
// wallet that holds only farm funds, seed phrase offline, so a compromised farm never touches the
// reader's main holdings. Step two is the main position, sized by capitalFor and shaped by the
// category (a lender gets a supply, a DEX gets liquidity, a bridge gets a bridge). Step three is
// the weekly qualifying action, one small repeatable move that keeps the wallet active without
// new capital. Step four is the second position, on the protocol's second chain when it has one
// and in a different pool when it does not, so the wallet shows two distinct actions. Step five
// is the hold, sized by holdDaysFor, because activity must span more than one snapshot to count.
// Step six is the claim warning: only from the link the protocol itself publishes, and never pay
// to claim. Step seven is the farm log, then unwinding in stages instead of all at once. Every
// step carries its own cost and time, and stepText appends them in the same "Cost: ... Time: ..."
// shape the gate reads, trimming to 600 characters and padding to 20, so no step is ever too
// long or too short for the board.
/**
 * A protocol's farm plan: seven steps, each an action with a cost and a time. The plan is derived
 * from the protocol's own record (category, chains, TVL, age), never from a hand-written list of names.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null): FarmStep[] {
  const chain = chainOf(p);
  const second = secondChainOf(p);
  const capital = capitalFor(p);
  const hold = holdDaysFor(age);
  const secondCapital = Math.max(25, Math.round(capital / 2));
  return [
    {
      text: `Use a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline.`,
      cost: 'under $3 of gas for the first transaction',
      time: '5 minutes',
    },
    {
      text: actionFor(p, capital, chain),
      cost: `$${capital} of capital and about $${capital >= 150 ? 8 : 4} of gas`,
      time: '15 minutes to set up',
    },
    {
      text: weeklyActionFor(p, chain),
      cost: 'about $2 of gas a week',
      time: '10 minutes a week',
    },
    {
      text:
        second !== null
          ? `Open a second, smaller position of $${secondCapital} on ${second}, the protocol's second chain, so the wallet is active on two chains.`
          : `Open a second, smaller position of $${secondCapital} in a different pool on ${chain}, so the wallet shows two distinct actions.`,
      cost: `$${secondCapital} of capital and about $4 of gas`,
      time: '10 minutes',
    },
    {
      text: `Hold the positions for at least ${hold} days so the activity is counted in more than one snapshot.`,
      cost: `the $${capital} stays in the position`,
      time: `${hold} days`,
    },
    {
      text: `Before you withdraw, open the protocol's own points or rewards page and claim only from the link it publishes.`,
      cost: 'no fee to check, and never pay to claim',
      time: '10 minutes',
    },
    {
      text: `Write the wallet, the dates and every transaction hash in a farm log, then unwind in stages instead of all at once.`,
      cost: 'nothing but the log',
      time: '5 minutes',
    },
  ];
}

// The live set is the board's complement: every protocol that is NOT pre-token (it carries a
// market cap, a CoinGecko id or a symbol) and is not a CEX, sorted by market cap descending with
// TVL as the tie-break, and cut to LIVE_ROWS (24). The cut is a display choice, not a ranking:
// the live view exists to show the reader what "already trades" looks like, and 24 rows is
// enough to make the point without drowning the pre-token board it sits beside. A live protocol
// is never scored by the model — its market cap is a fact, not an estimate, and mixing the two
// would rank a guess against a price.
/** The live-token protocols, by market cap, for the dashboard's Live token view. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .slice(0, LIVE_ROWS)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
    }));
}

// radarRow is a projection, not a copy: it drops the fields the page does not need (the token
// fields, the full model breakdown, the farm steps as strings) and keeps the multipliers the
// detail drawer shows, so data.js stays compact. The farm plan is deliberately NOT carried
// here — the page regenerates it from the same derivation, which is what proves the page and
// the board are the same arithmetic instead of two copies that could drift.
/** A board row's compact form for data.js, with the farm plan generated in the page. */
export function radarRow(row: BoardRow): RadarRow {
  return {
    rank: row.rank,
    slug: row.slug,
    name: row.name,
    category: row.category,
    chains: row.chains,
    tvl_usd: row.tvl_usd,
    change_7d: row.change_7d,
    mcap_usd: row.mcap_usd,
    listed_at: row.listed_at,
    age_days: row.age_days,
    implied_value_usd: row.implied_value_usd,
    growth_multiplier: row.model.growth_multiplier,
    spike_multiplier: row.model.spike_multiplier,
    maturity_multiplier: row.model.maturity_multiplier,
    opacity_multiplier: row.model.opacity_multiplier,
  };
}

// buildRadar is the one call main.ts makes to get everything the output needs: the ranked board
// (board.json) and the dashboard's dataset (data.js). It counts the early rows — the board rows
// whose slug is not on the watchlist — because the dashboard's lede states that number, and it
// copies the watchlist slugs into the data so the page can mark watchlist rows without asking
// the snapshot again. The RadarData object is deliberately flat and JSON-shaped: it is written
// out as window.RADAR with no further transformation, so what main.ts writes is exactly what
// the page reads.
/** Everything the dashboard renders, from the snapshot. */
export function buildRadar(snapshot: Snapshot, model: ModelConstants = MODEL): { board: BoardRow[]; radar: RadarData } {
  const board = buildBoard(snapshot, model);
  const live = liveRows(snapshot);
  const early = board.filter((r) => !snapshot.watchlist.includes(r.slug)).length;
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model,
    model_version: MODEL_VERSION,
    watchlist_size: snapshot.watchlist.length,
    watchlist_slugs: [...snapshot.watchlist],
    board_size: board.length,
    early_size: early,
    live_size: live.length,
    rows: board.map(radarRow),
    live,
  };
  return { board, radar };
}

// parseSnapshot is strict on purpose: a snapshot that is not the shape the model scores is
// refused here, with a named error, instead of being scored badly downstream. The shape it
// demands is the sealed input's shape — as_of as a YYYY-MM-DD date, source as a string,
// floor_usd as a positive safe integer, protocols as an array, watchlist as an array of strings.
// Each protocol must carry a slug, a name and a finite TVL; everything else is optional and is
// read as null (or an empty chain list) when it is absent or the wrong type, because a missing
// growth figure or listing date is a scoring input (zero growth, 180 days), not a reason to
// refuse the whole snapshot. A protocol that is not an object, or a snapshot that is not JSON,
// is refused outright.
/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return {
    as_of: o.as_of,
    source: o.source,
    floor_usd: o.floor_usd,
    protocols,
    watchlist: o.watchlist as string[],
  };
}

// validateBoard is the strict sibling of boardIssue. Where boardIssue returns the first
// problem it finds as a single string (or null when the board is clean), validateBoard collects
// EVERY problem into a list, so a caller that wants to fix a board sees all of it at once instead
// of fixing one failure, re-running, and finding the next. The checks are the same invariants
// the gate reads — watchlist coverage, ranks exactly 1..N, implied values non-increasing and not
// all equal, farm steps 3..12 with each step 20..600 characters, implied values positive safe
// integers — plus two boardIssue does not check: duplicate slugs (a board that ranks the same
// protocol twice is a board that counted it twice) and a rank that does not match the row's
// position in the array (the board is stored strongest-first, so row i must carry rank i + 1).
// An empty list means the board is clean. main.ts calls this after scoring and refuses to write
// an output when the list is not empty, so a bad board can never reach the dossier.
/** Every problem with a board, as a list (empty when the board is clean). Unlike boardIssue, which stops at the first failure, this collects all of them. */
export function validateBoard(rows: BoardRow[], watchlist: string[]): string[] {
  const problems: string[] = [];
  const slugs = new Set<string>();
  for (const row of rows) {
    if (slugs.has(row.slug)) problems.push(`${row.slug} appears twice on the board`);
    slugs.add(row.slug);
  }
  const missing = watchlist.filter((s) => !slugs.has(s));
  for (const s of missing) problems.push(`the board misses watchlist slug ${s}`);
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    if (row.rank !== i + 1) problems.push(`${row.slug} sits at position ${i + 1} but carries rank ${row.rank}`);
  }
  const ranks = rows.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) {
    if (ranks[i] !== i + 1) problems.push(`rank ${i + 1} is ${ranks[i]}`);
  }
  for (let i = 1; i < rows.length; i++) {
    if (rows[i]!.implied_value_usd > rows[i - 1]!.implied_value_usd) {
      problems.push(`row ${i + 1} (${rows[i]!.slug}) outranks row ${i} on implied value`);
    }
  }
  if (rows.length >= 2 && rows[0]!.implied_value_usd === rows[rows.length - 1]!.implied_value_usd) {
    problems.push(`all ${rows.length} rows share the same implied value $${rows[0]!.implied_value_usd}: a board that ranks nothing by value is not a ranking`);
  }
  for (const row of rows) {
    if (row.farm_steps.length < 3 || row.farm_steps.length > 12) {
      problems.push(`${row.slug} has ${row.farm_steps.length} farm steps`);
    }
    for (const step of row.farm_steps) {
      if (step.length < 20 || step.length > 600) {
        problems.push(`${row.slug} has a farm step of ${step.length} characters`);
      }
    }
    if (!Number.isSafeInteger(row.implied_value_usd) || row.implied_value_usd <= 0) {
      problems.push(`${row.slug} has implied value ${row.implied_value_usd}`);
    }
  }
  return problems;
}

/** Why a board is not one the gate will take, or null: coverage, ranks, order, one shared implied value, and farm steps. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value $${board[0]!.implied_value_usd}: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    const steps = r.farm_steps;
    if (steps.length < 3 || steps.length > 12) return `${r.slug} has ${steps.length} farm steps`;
    for (const s of steps) if (s.length < 20 || s.length > 600) return `${r.slug} has a farm step of ${s.length} characters`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
  }
  return null;
}

// data.js is one line: the whole RadarData object assigned to window.RADAR, plus a trailing
// newline. There is no fetch and no network because the dashboard must render from the files
// beside it — the page, the data and the screenshots are all copied into /output together, and
// a page that fetched its data would have nothing to fetch in the grader's container.
/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
