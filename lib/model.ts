// Scoring and farm-plan generation for pre-token protocols
import { readFileSync } from 'node:fs';

export interface Protocol {
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

export interface ScoredRow {
  slug: string;
  name: string;
  rank: number;
  implied_value_usd: number;
  farm_steps: string[];
  // extra fields for dashboard detail
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  score: number;
  // factor breakdown
  tvl_score: number;
  growth_score: number;
  age_score: number;
  chain_score: number;
  category_score: number;
}

// ---- scoring ----

const AS_OF = new Date('2026-11-14');

// Category bonus map — categories that typically launch valuable tokens
const CATEGORY_WEIGHT: Record<string, number> = {
  'Dexs': 1.2,
  'Lending': 1.15,
  'Derivatives': 1.1,
  'Liquid Staking': 1.05,
  'Yield Aggregator': 1.05,
  'Bridge': 0.9,
  'Canonical Bridge': 0.85,
  'Cross Chain Bridge': 0.9,
  'Launchpad': 1.1,
  'Liquidity Manager': 1.0,
  'Yield': 0.95,
  'Synthetics': 1.1,
  'RWA': 1.15,
  'Basis Trading': 1.0,
  'Farm': 0.9,
  'Leveraged Farming': 0.95,
  'Risk Curators': 1.0,
  'Onchain Capital Allocator': 1.05,
  'Collateral Management': 1.0,
  'Anchor BTC': 1.0,
  'Staking Pool': 0.85,
  'Chain': 1.3,
  'Restaking': 1.1,
  'Liquid Restaking': 1.05,
  'Insurance': 1.0,
  'Services': 0.9,
  'Yield Vault': 0.95,
  'CDP': 1.05,
};

const DEFAULT_CATEGORY_WEIGHT = 0.95;

// Major chains that signal broader adoption
const MAJOR_CHAINS = new Set([
  'Ethereum', 'Solana', 'Arbitrum', 'Base', 'Optimism',
  'Polygon', 'Avalanche', 'Binance', 'zkSync Era', 'Scroll',
  'Linea', 'Sui', 'Mantle', 'Fantom', 'Celo',
]);

function logScale(x: number, base: number = 10): number {
  return x > 0 ? Math.log(x) / Math.log(base) : 0;
}

function scoreTVL(tvl_usd: number): number {
  // Log-scale TVL, normalized to 0-1 range for typical DeFi TVL ($1M - $100B)
  const logTVL = logScale(tvl_usd, 10);
  // $1M (log10=6) -> 0, $100B (log10=11) -> 1
  return Math.max(0, Math.min(1, (logTVL - 6) / 5));
}

function scoreGrowth(change_7d: number | null): number {
  if (change_7d === null) return 0.3; // neutral for unknown
  // Sigmoid-like mapping: -50% -> 0, 0% -> 0.5, +50% -> 0.85, +100% -> 0.95
  return 1 / (1 + Math.exp(-0.05 * change_7d));
}

function scoreAge(listed_at: string | null): number {
  if (!listed_at) return 0.3;
  const listed = new Date(listed_at);
  const days = Math.max(0, (AS_OF.getTime() - listed.getTime()) / (1000 * 60 * 60 * 24));
  // 0 days -> 0, 365 -> 0.5, 1095 (3yr) -> 0.85, 1825 (5yr) -> 0.95
  return Math.min(0.95, 1 - Math.exp(-days / 730));
}

function scoreChains(chains: string[]): number {
  if (chains.length === 0) return 0;
  const count = Math.min(chains.length, 10);
  const countScore = 1 - Math.exp(-0.3 * count); // 0->0, 3->0.59, 7->0.88, 10->0.95
  const majorCount = chains.filter(c => MAJOR_CHAINS.has(c)).length;
  const diversity = chains.length > 0 ? majorCount / chains.length : 0;
  return 0.6 * countScore + 0.4 * diversity;
}

function scoreCategory(category: string | null | undefined): number {
  const w = category ? (CATEGORY_WEIGHT[category] ?? DEFAULT_CATEGORY_WEIGHT) : DEFAULT_CATEGORY_WEIGHT;
  return Math.min(1, w);
}

// Weights for the composite score
const W_TVL = 0.35;
const W_GROWTH = 0.15;
const W_AGE = 0.25;
const W_CHAINS = 0.15;
const W_CATEGORY = 0.10;

function computeScore(p: Protocol): { total: number; tvl: number; growth: number; age: number; chain: number; catScore: number } {
  const tvl = scoreTVL(p.tvl_usd);
  const growth = scoreGrowth(p.change_7d);
  const age = scoreAge(p.listed_at);
  const chain = scoreChains(p.chains);
  const category = scoreCategory(p.category);
  const total = W_TVL * tvl + W_GROWTH * growth + W_AGE * age + W_CHAINS * chain + W_CATEGORY * category;
  return { total, tvl, growth, age, chain, catScore: category };
}

// ---- non-farmable exclusion (Fix 1) ----

// Categories that are not farmable on-chain
const NON_FARMABLE_CATEGORIES = new Set([
  'CEX',
  'Bridge',
  'Canonical Bridge',
  'Cross Chain Bridge',
  'Liquid Staking',
  'Liquid Restaking',
  'Restaked BTC',
]);

// Exchange name prefixes — well-known CEX brands
const EXCHANGE_PREFIXES = [
  'Binance', 'Coinbase', 'Bybit', 'Kraken', 'Bitget', 'OKX', 'Bitfinex', 'Gemini',
];

// Name patterns indicating wrapped/staked products
const WRAPPED_RE = /\b(wrapped|staked|staking)\b/i;

function isFarmable(p: Protocol): boolean {
  // Must be pre-token
  if (p.gecko_id !== null || p.symbol !== null) return false;
  // Exclude non-farmable categories
  if (p.category && NON_FARMABLE_CATEGORIES.has(p.category)) return false;
  // Exclude wrapped/staked/staking products by name
  if (p.name && WRAPPED_RE.test(p.name)) return false;
  // Exclude protocols named after known exchanges
  if (p.name && EXCHANGE_PREFIXES.some(prefix => p.name.startsWith(prefix))) return false;
  return true;
}

// ---- implied value from TVL and score (Fix 2) ----

// Anchor implied value to TVL with a score-dependent multiplier.
// Multiplier band: 0.03x (low score) to 0.47x (high score) of TVL.
// A $1B-TVL protocol at top score lands near $470M; median lands in tens of millions.
// Top implied value stays well under $10B (max TVL ~$2.8B * 0.47 ≈ $1.3B).
const VALUE_MULT_MIN = 0.03;
const VALUE_MULT_MAX = 0.47;

function scoreToImpliedValue(tvl_usd: number, score: number, minScore: number, maxScore: number): number {
  // Normalize score to 0-1 within the observed range
  const normalized = maxScore > minScore ? (score - minScore) / (maxScore - minScore) : 0.5;
  // Linear interpolation of multiplier
  const mult = VALUE_MULT_MIN + (VALUE_MULT_MAX - VALUE_MULT_MIN) * normalized;
  return Math.max(1, Math.round(tvl_usd * mult));
}

export function scoreProtocols(protocols: Protocol[]): { rows: ScoredRow[]; excludedCount: number; totalCount: number; preTokenTotal: number } {
  // Filter to farmable, pre-token only
  const farmable = protocols.filter(isFarmable);
  const excludedCount = protocols.length - farmable.length;
  const totalCount = protocols.length;

  // Count pre-token protocols (those without a trading token: no gecko_id and no symbol)
  const preTokenTotal = protocols.filter(p => p.gecko_id === null && p.symbol === null).length;
  // Pre-token protocols excluded = total pre-token minus those that made it to the board
  const preTokenExcluded = preTokenTotal - farmable.length;

  // Score all farmable
  const scored = farmable.map(p => {
    const s = computeScore(p);
    return { protocol: p, ...s };
  });

  // Find min/max scores for value mapping
  const scores = scored.map(s => s.total);
  const minScore = Math.min(...scores);
  const maxScore = Math.max(...scores);

  // Compute implied values anchored to TVL
  const withValues = scored.map(s => ({
    protocol: s.protocol,
    total: s.total,
    tvl: s.tvl,
    growth: s.growth,
    age: s.age,
    chain: s.chain,
    catScore: s.catScore,
    implied_value_usd: scoreToImpliedValue(s.protocol.tvl_usd, s.total, minScore, maxScore),
  }));

  // Sort by implied_value_usd descending, then by slug ascending for tie-breaking (deterministic)
  withValues.sort((a, b) => {
    if (a.implied_value_usd !== b.implied_value_usd) return b.implied_value_usd - a.implied_value_usd;
    return a.protocol.slug < b.protocol.slug ? -1 : a.protocol.slug > b.protocol.slug ? 1 : 0;
  });

  // Assign ranks 1..N and generate farm steps
  const rows: ScoredRow[] = withValues.map((s, i) => {
    const p = s.protocol;
    const row: Omit<ScoredRow, 'farm_steps'> = {
      slug: p.slug,
      name: p.name,
      rank: i + 1,
      implied_value_usd: s.implied_value_usd,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      change_7d: p.change_7d,
      listed_at: p.listed_at,
      score: s.total,
      tvl_score: s.tvl,
      growth_score: s.growth,
      age_score: s.age,
      chain_score: s.chain,
      category_score: s.catScore,
    };
    return { ...row, farm_steps: generateFarmSteps(row) };
  });

  return { rows, excludedCount: preTokenExcluded, totalCount: preTokenTotal };
}

// ---- farm plans ----

function estimateGas(chain: string): number {
  // Rough average gas/fee cost per action in USD
  const costs: Record<string, number> = {
    'Ethereum': 15,
    'Solana': 0.05,
    'Arbitrum': 0.5,
    'Base': 0.3,
    'Optimism': 0.5,
    'Polygon': 0.1,
    'Avalanche': 0.3,
    'Binance': 0.2,
    'Sui': 0.1,
    'zkSync Era': 0.3,
    'Linea': 0.2,
    'Scroll': 0.3,
    'Mantle': 0.1,
    'Fantom': 0.05,
    'Celo': 0.01,
    'Sonic': 0.05,
    'Monad': 0.2,
    'Plasma': 0.1,
    'Unichain': 0.3,
    'Robinhood Chain': 0.2,
    'Ink': 0.2,
    'Arc': 0.3,
    'Elysium Kinetiq': 0.1,
    'MegaETH': 0.1,
    'Soneium': 0.2,
    'Metis': 0.1,
    'Boba': 0.1,
    'xDai': 0.01,
    'Fraxtal': 0.1,
    'Polygon zkEVM': 0.2,
    'Astar': 0.1,
    'Moonbeam': 0.1,
    'Harmony': 0.01,
    'Kava': 0.05,
    'Canto': 0.05,
    'Cronos': 0.05,
    'Telos': 0.01,
    'Aurora': 0.1,
    'Wanchain': 0.05,
    'Fuse': 0.01,
    'Moonriver': 0.05,
    'Kucoin': 0.05,
    'Velas': 0.01,
    'Oasis': 0.05,
    'Evmos': 0.05,
    'Stellar': 0.01,
    'Ripple': 0.02,
    'Cosmos': 0.05,
    'Osmosis': 0.05,
    'Filecoin': 0.1,
    'Celestia': 0.05,
    'Sei': 0.05,
    'Persistence': 0.05,
    'Stride': 0.05,
    'Agoric': 0.05,
    'Regen': 0.05,
    'Morph': 0.2,
    'Flow': 0.05,
    'Polkadot': 0.1,
    'Kusama': 0.1,
    'zkLink': 0.2,
    'Bittensor': 0.5,
    'Anubis': 0.2,
    'Tron': 0.1,
    'Flare': 0.05,
    'Mode': 0.1,
    'Berachain': 0.1,
    'Taiko': 0.2,
    'Hyperliquid': 0.05,
    'Sonic': 0.05,
  };
  return costs[chain] ?? 0.5;
}

function timeEstimate(chain: string): string {
  const fast = new Set(['Solana', 'Arbitrum', 'Base', 'Optimism', 'Polygon', 'Binance', 'Sui', 'Sonic', 'Berachain']);
  const medium = new Set(['Ethereum', 'Avalanche', 'zkSync Era', 'Linea', 'Scroll', 'Mantle', 'Monad', 'Unichain']);
  if (fast.has(chain)) return '1-3 minutes';
  if (medium.has(chain)) return '5-15 minutes';
  return '10-30 minutes';
}

/**
 * Select the primary chain for farm steps.
 * Never return Bitcoin as the primary for on-chain actions (not EVM-compatible).
 * Prefer the first EVM-compatible chain from the list.
 */
function selectPrimaryChain(chains: string[]): string {
  // Non-EVM chains to skip when choosing a primary for on-chain actions
  const nonEVM = new Set(['Bitcoin', 'Ripple', 'Stellar', 'Cardano', 'Solana', 'Sui', 'Polkadot', 'Kusama', 'Cosmos', 'Osmosis', 'Filecoin', 'Celestia', 'Sei', 'Persistence', 'Stride', 'Agoric', 'Regen', 'Flow', 'Bittensor']);
  for (const chain of chains) {
    if (!nonEVM.has(chain)) return chain;
  }
  // Fallback: if all chains are non-EVM, return the first one — farm steps will use adapted language
  return chains[0] ?? 'Ethereum';
}

/** Check if a chain is non-EVM (needs adapted farm-step language). */
function isNonEVM(chain: string): boolean {
  return chain === 'Bitcoin' || chain === 'Ripple' || chain === 'Stellar' || chain === 'Cardano';
}

function generateFarmSteps(row: Omit<ScoredRow, 'farm_steps'>): string[] {
  const { name, chains, category, slug } = row;
  const primary = selectPrimaryChain(chains);
  const primaryIsBitcoin = primary === 'Bitcoin';
  const gasPrimary = estimateGas(primary);
  const timePrimary = timeEstimate(primary);
  const cat = (category || 'DeFi').toLowerCase();
  const steps: string[] = [];

  // Step 1: Set up on primary chain
  if (primaryIsBitcoin) {
    // Bitcoin-specific setup — no "connect wallet" like EVM
    if (cat.includes('payment') || cat.includes('lightning')) {
      steps.push(
        `Set up a Bitcoin Lightning wallet and fund it with a small amount of BTC for channel fees. This takes ${timePrimary}.`
      );
    } else {
      steps.push(
        `Set up a Bitcoin-compatible wallet and acquire a small amount of BTC for transaction fees. This takes ${timePrimary}.`
      );
    }
  } else if (chains.length > 1 && !chains.includes('Ethereum')) {
    const ethGas = estimateGas('Ethereum');
    const bridgeChain = chains.includes(primary) ? primary : chains[0];
    steps.push(
      `Bridge stablecoins from Ethereum to ${bridgeChain} using a cross-chain bridge. Expect ~$${Math.round(ethGas + estimateGas(bridgeChain))} in combined gas fees. This takes ${timeEstimate(bridgeChain)}.`
    );
  } else if (!chains.includes('Ethereum') && chains.length === 1) {
    steps.push(
      `Acquire ${primary} native tokens for gas and transfer them to your wallet on ${primary}. Budget ~$${Math.max(1, Math.round(gasPrimary * 2))} for gas. Allow ${timePrimary}.`
    );
  } else {
    steps.push(
      `Prepare your wallet with sufficient ${primary === 'Ethereum' ? 'ETH' : 'native tokens'} for gas (~$${Math.round(gasPrimary)}) to interact with ${name} on ${primary}. This takes ${timePrimary}.`
    );
  }

  // Step 2: Connect to the app — category-specific
  if (primaryIsBitcoin) {
    // Bitcoin protocols: use native app/protocol language, not "connect wallet"
    if (cat.includes('payment') || cat.includes('lightning')) {
      steps.push(
        `Open the ${name} interface and connect your Lightning wallet to access payment channels and routing features.`
      );
    } else {
      steps.push(
        `Access the ${name} protocol through its web interface and review available features using your Bitcoin wallet address.`
      );
    }
  } else if (cat.includes('dex') || cat.includes('swap')) {
    const chainList = chains.slice(0, 2).join(' and ');
    steps.push(
      `Visit the ${name} ${cat} interface on ${chainList}, connect your wallet, and browse available liquidity pools. Gas cost: ~$${Math.round(gasPrimary)}. Time: ${timePrimary}.`
    );
  } else if (cat.includes('lend')) {
    steps.push(
      `Open the ${name} ${cat} app on ${primary}, connect your wallet, and review available lending and borrowing markets. Gas cost: ~$${Math.round(gasPrimary)}. Time: ${timePrimary}.`
    );
  } else if (cat.includes('bridge')) {
    steps.push(
      `Navigate to the ${name} bridge interface on ${primary}, connect your wallet, and review supported transfer routes. Gas cost: ~$${Math.round(gasPrimary)}. Time: ${timePrimary}.`
    );
  } else if (cat.includes('yield') || cat.includes('farm') || cat.includes('vault') || cat.includes('aggregator')) {
    steps.push(
      `Access the ${name} ${cat} dashboard on ${primary}, connect your wallet, and explore available yield strategies. Gas cost: ~$${Math.round(gasPrimary)}. Time: ${timePrimary}.`
    );
  } else if (cat.includes('staking') || cat.includes('restaking')) {
    steps.push(
      `Go to the ${name} staking portal on ${primary}, connect your wallet, and check current validator performance and reward rates. Gas cost: ~$${Math.round(gasPrimary)}. Time: ${timePrimary}.`
    );
  } else if (cat.includes('deriv') || cat.includes('perp')) {
    steps.push(
      `Enter the ${name} ${cat} platform on ${primary}, connect your wallet, and review available trading pairs and funding rates. Gas cost: ~$${Math.round(gasPrimary)}. Time: ${timePrimary}.`
    );
  } else if (cat.includes('rwa')) {
    steps.push(
      `Access the ${name} ${cat} platform on ${primary}, connect your wallet, and browse available real-world asset offerings. Gas cost: ~$${Math.round(gasPrimary)}. Time: ${timePrimary}.`
    );
  } else if (cat.includes('risk curator') || cat.includes('capital allocator') || cat.includes('basis trading')) {
    steps.push(
      `Connect your wallet to the ${name} dashboard on ${primary} and review available capital allocation strategies. Gas cost: ~$${Math.round(gasPrimary)}. Time: ${timePrimary}.`
    );
  } else if (cat.includes('cdp')) {
    steps.push(
      `Open the ${name} ${cat} app on ${primary}, connect your wallet, and review collateral requirements and borrowing rates. Gas cost: ~$${Math.round(gasPrimary)}. Time: ${timePrimary}.`
    );
  } else if (cat.includes('liquidity manager')) {
    steps.push(
      `Access the ${name} ${cat} interface on ${primary}, connect your wallet, and review active liquidity positions. Gas cost: ~$${Math.round(gasPrimary)}. Time: ${timePrimary}.`
    );
  } else if (cat.includes('synthetic')) {
    steps.push(
      `Visit the ${name} ${cat} platform on ${primary}, connect your wallet, and explore available synthetic asset minting options. Gas cost: ~$${Math.round(gasPrimary)}. Time: ${timePrimary}.`
    );
  } else if (cat.includes('launchpad')) {
    steps.push(
      `Register on the ${name} ${cat} platform on ${primary}, connect your wallet, and review upcoming project allocations. Gas cost: ~$${Math.round(gasPrimary)}. Time: ${timePrimary}.`
    );
  } else if (cat.includes('prediction market') || cat.includes('prediction')) {
    steps.push(
      `Open the ${name} ${cat} on ${primary}, connect your wallet, and browse available markets and odds. Gas cost: ~$${Math.round(gasPrimary)}. Time: ${timePrimary}.`
    );
  } else if (cat.includes('insurance')) {
    steps.push(
      `Visit the ${name} ${cat} app on ${primary}, connect your wallet, and review available coverage options and premiums. Gas cost: ~$${Math.round(gasPrimary)}. Time: ${timePrimary}.`
    );
  } else if (cat.includes('privacy')) {
    steps.push(
      `Access the ${name} ${cat} interface on ${primary}, connect your wallet, and review available privacy features. Gas cost: ~$${Math.round(gasPrimary)}. Time: ${timePrimary}.`
    );
  } else if (cat.includes('options')) {
    steps.push(
      `Open the ${name} ${cat} platform on ${primary}, connect your wallet, and review available option contracts and pricing. Gas cost: ~$${Math.round(gasPrimary)}. Time: ${timePrimary}.`
    );
  } else if (cat.includes('payment')) {
    steps.push(
      `Connect your wallet to the ${name} ${cat} app on ${primary} and review available payment rails. Gas cost: ~$${Math.round(gasPrimary)}. Time: ${timePrimary}.`
    );
  } else if (cat.includes('governance')) {
    steps.push(
      `Visit the ${name} ${cat} portal on ${primary}, connect your wallet, and review active governance proposals. Gas cost: ~$${Math.round(gasPrimary)}. Time: ${timePrimary}.`
    );
  } else if (cat.includes('token locker')) {
    steps.push(
      `Open the ${name} ${cat} on ${primary}, connect your wallet, and review available token lock-up schedules and rewards. Gas cost: ~$${Math.round(gasPrimary)}. Time: ${timePrimary}.`
    );
  } else if (cat.includes('nft')) {
    steps.push(
      `Visit the ${name} ${cat} on ${primary}, connect your wallet, and browse available collections and marketplace features. Gas cost: ~$${Math.round(gasPrimary)}. Time: ${timePrimary}.`
    );
  } else {
    // Generic fallback — honest and non-specific
    steps.push(
      `Connect your wallet to the ${name} application on ${primary} and explore the available features and pools. Gas cost: ~$${Math.round(gasPrimary)}. Time: ${timePrimary}.`
    );
  }

  // Step 3: Provide liquidity / deposit / interact with core product
  if (primaryIsBitcoin) {
    // Bitcoin-specific step 3
    if (cat.includes('payment') || cat.includes('lightning')) {
      steps.push(
        `Open a small payment channel through ${name} and send a test transaction to verify the flow and fees.`
      );
    } else if (cat.includes('bridge')) {
      const chain2 = chains.find(c => c !== 'Bitcoin') ?? chains[0];
      steps.push(
        `Execute a small test transfer through ${name} between Bitcoin and ${chain2}. Monitor the transaction for completion.`
      );
    } else {
      steps.push(
        `Interact with the core ${name} protocol on Bitcoin. Start with a small amount to test the flow and understand the mechanics.`
      );
    }
  } else if (cat.includes('dex') || cat.includes('swap')) {
    steps.push(
      `Deposit a balanced pair of tokens into a ${name} liquidity pool on ${primary}. Allocate assets you are comfortable holding. Gas: ~$${Math.round(gasPrimary * 2)}. Time: ${timePrimary}.`
    );
  } else if (cat.includes('lend')) {
    steps.push(
      `Deposit stablecoins or major assets into ${name} lending markets on ${primary} to start earning supply-side interest. Gas: ~$${Math.round(gasPrimary)}. Time: ${timePrimary}.`
    );
  } else if (cat.includes('yield') || cat.includes('farm') || cat.includes('vault') || cat.includes('aggregator')) {
    steps.push(
      `Deposit tokens into a ${name} ${cat} strategy on ${primary} to begin compounding returns. Review the strategy's risk before committing funds. Gas: ~$${Math.round(gasPrimary * 2)}. Time: ${timePrimary}.`
    );
  } else if (cat.includes('deriv') || cat.includes('perp')) {
    steps.push(
      `Fund your ${name} trading account on ${primary} and open a small test position to familiarize yourself with the interface. Gas: ~$${Math.round(gasPrimary)}. Time: ${timePrimary}.`
    );
  } else if (cat.includes('cdp')) {
    steps.push(
      `Deposit collateral into ${name} on ${primary} and mint stablecoins against it. Monitor the collateral ratio. Gas: ~$${Math.round(gasPrimary * 2)}. Time: ${timePrimary}.`
    );
  } else if (cat.includes('risk curator') || cat.includes('capital allocator')) {
    steps.push(
      `Allocate capital to a ${name} strategy on ${primary} that matches your risk tolerance and return target. Gas: ~$${Math.round(gasPrimary * 2)}. Time: ${timePrimary}.`
    );
  } else if (cat.includes('basis trading')) {
    steps.push(
      `Open a basis trade on ${name} on ${primary} by simultaneously taking spot and futures positions. Gas: ~$${Math.round(gasPrimary * 2)}. Time: ${timePrimary}.`
    );
  } else if (cat.includes('liquidity manager')) {
    steps.push(
      `Deposit assets into a ${name} managed liquidity position on ${primary} to earn fees from automated rebalancing. Gas: ~$${Math.round(gasPrimary * 2)}. Time: ${timePrimary}.`
    );
  } else if (cat.includes('synthetic')) {
    steps.push(
      `Mint a synthetic asset through ${name} on ${primary} by depositing collateral. Review liquidation thresholds first. Gas: ~$${Math.round(gasPrimary * 2)}. Time: ${timePrimary}.`
    );
  } else if (cat.includes('launchpad')) {
    steps.push(
      `Stake or deposit eligible tokens into ${name} on ${primary} to qualify for upcoming project allocations. Gas: ~$${Math.round(gasPrimary)}. Time: ${timePrimary}.`
    );
  } else if (cat.includes('prediction market') || cat.includes('prediction')) {
    steps.push(
      `Place a small position in an active ${name} market on ${primary} to understand the mechanics. Gas: ~$${Math.round(gasPrimary)}. Time: ${timePrimary}.`
    );
  } else if (cat.includes('insurance')) {
    steps.push(
      `Purchase coverage through ${name} on ${primary} for a protocol or smart contract you use. Gas: ~$${Math.round(gasPrimary)}. Time: ${timePrimary}.`
    );
  } else if (cat.includes('privacy')) {
    steps.push(
      `Use ${name} on ${primary} to send a shielded transaction or deposit into a privacy pool. Gas: ~$${Math.round(gasPrimary * 2)}. Time: ${timePrimary}.`
    );
  } else if (cat.includes('options')) {
    steps.push(
      `Buy or sell an option contract on ${name} on ${primary}. Start with a small position to learn the interface. Gas: ~$${Math.round(gasPrimary)}. Time: ${timePrimary}.`
    );
  } else if (cat.includes('payment')) {
    steps.push(
      `Send a test payment through ${name} on ${primary} to verify the flow and fees. Gas: ~$${Math.round(gasPrimary)}. Time: ${timePrimary}.`
    );
  } else if (cat.includes('governance')) {
    steps.push(
      `Review and vote on active ${name} governance proposals on ${primary}. Connect your wallet to cast your vote. Gas: ~$${Math.round(gasPrimary)}. Time: ${timePrimary}.`
    );
  } else if (cat.includes('token locker')) {
    steps.push(
      `Lock eligible tokens in ${name} on ${primary} for a chosen duration to earn rewards. Gas: ~$${Math.round(gasPrimary)}. Time: ${timePrimary}.`
    );
  } else if (cat.includes('rwa')) {
    steps.push(
      `Complete any required KYC steps for ${name} on ${primary}, then allocate funds to an RWA offering that matches your risk profile. Gas: ~$${Math.round(gasPrimary * 2)}. Time: 1-2 hours including verification.`
    );
  } else if (cat.includes('bridge')) {
    const chain2 = chains[1] ?? chains[0];
    steps.push(
      `Execute a small test transfer through the ${name} bridge from ${primary} to ${chain2}. Monitor the transaction for completion. Gas: ~$${Math.round(gasPrimary + estimateGas(chain2))}. Time: ${timeEstimate(chain2)}.`
    );
  } else if (cat.includes('nft')) {
    steps.push(
      `Browse and mint or trade an NFT on ${name} on ${primary} to understand the marketplace flow. Gas: ~$${Math.round(gasPrimary)}. Time: ${timePrimary}.`
    );
  } else if (cat.includes('staking') || cat.includes('restaking')) {
    steps.push(
      `Stake your eligible assets with ${name} on ${primary} and confirm your delegation. Gas: ~$${Math.round(gasPrimary)}. Time: ${timePrimary}.`
    );
  } else {
    // Generic fallback
    steps.push(
      `Provide capital or interact with the core ${name} ${cat} product on ${primary}. Start with a small amount to test the flow. Gas: ~$${Math.round(gasPrimary * 2)}. Time: ${timePrimary}.`
    );
  }

  // Step 4+: Additional steps based on chain count and category
  if (chains.length >= 2) {
    // Pick the second EVM-compatible chain if possible
    const chain2 = selectPrimaryChain(chains.filter(c => c !== primary && c !== 'Bitcoin')) || (chains.length > 1 ? chains[1] : primary);
    const gas2 = estimateGas(chain2);
    const time2 = timeEstimate(chain2);
    steps.push(
      `Expand to ${chain2}: bridge assets from ${primary} and repeat the ${cat} flow on ${chain2}. Gas: ~$${Math.round(gas2)}. Time: ${time2}.`
    );
  }

  if (chains.length >= 3) {
    const chain3 = chains[2];
    const gas3 = estimateGas(chain3);
    const time3 = timeEstimate(chain3);
    steps.push(
      `Add ${chain3} to your ${name} activity. Bridge a small amount and provide liquidity or stake on ${chain3}. Gas: ~$${Math.round(gas3)}. Time: ${time3}.`
    );
  }

  // Category-specific additional steps
  if (cat.includes('dex') || cat.includes('swap')) {
    steps.push(
      `Vote on ${name} governance proposals for pool incentives and fee parameters on ${primary}. Gas: ~$${Math.round(gasPrimary)}. Time: ${timePrimary}.`
    );
  } else if (cat.includes('lend')) {
    steps.push(
      `Monitor your ${name} health factor and adjust collateral ratios as market conditions change on ${primary}. Gas: ~$${Math.round(gasPrimary)}. Time: ${timePrimary}.`
    );
  } else if (cat.includes('yield') || cat.includes('farm') || cat.includes('vault') || cat.includes('aggregator')) {
    steps.push(
      `Compound your ${name} ${cat} position regularly or enable auto-compounding if available on ${primary}. Gas: ~$${Math.round(gasPrimary)}. Time: ${timePrimary}.`
    );
  }

  if (chains.length >= 3) {
    steps.push(
      `Track ${name} positions across ${chains.length} chains using a portfolio tracker. Rebalance when one chain dominates your allocation. Time: 15-30 minutes weekly.`
    );
  }

  // Final step: stay engaged
  if (primaryIsBitcoin) {
    steps.push(
      `Follow ${name} on social channels and community forums to stay informed about protocol updates and potential developments.`
    );
  } else {
    steps.push(
      `Follow ${name} on social channels and governance forums to stay informed about the potential token launch and airdrop eligibility criteria on ${primary}.`
    );
  }

  // Ensure 3-12 steps
  const trimmed = steps.slice(0, 12);
  // Ensure each step is 20-600 chars
  return trimmed.map(s => {
    if (s.length > 600) return s.slice(0, 597) + '...';
    if (s.length < 20) return s + ' Monitor your position regularly.';
    return s;
  }).slice(0, 12);
}

// ---- export for dashboard recomputation ----

export { computeScore, scoreToImpliedValue as scoreToValue, CATEGORY_WEIGHT, W_TVL, W_GROWTH, W_AGE, W_CHAINS, W_CATEGORY, VALUE_MULT_MIN, VALUE_MULT_MAX, isFarmable };

// Recompute implied value for a single protocol (used by dashboard)
export function recomputeValue(p: Protocol, minScore: number, maxScore: number): number {
  const s = computeScore(p);
  return scoreToImpliedValue(p.tvl_usd, s.total, minScore, maxScore);
}
