// main.ts — token radar entry point
// Node 22 stdlib only. No network. Deterministic.

import { readFileSync, writeFileSync, mkdirSync, cpSync, statSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { scoreProtocols, computeScore, CATEGORY_WEIGHT, W_TVL, W_GROWTH, W_AGE, W_CHAINS, W_CATEGORY, VALUE_MULT_MIN, VALUE_MULT_MAX } from './lib/model.ts';
import { buildDossier } from './vendor/makefun-board.ts';
import type { Protocol } from './lib/model.ts';

// ---- CLI parsing ----

function parseArgs(argv: string[]): { input: string; output: string } {
  let input = '/input';
  let output = process.env.MAKEFUN_OUTPUT_DIR || '/output';
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--input' && i + 1 < argv.length) input = argv[++i];
    else if (argv[i] === '--output' && i + 1 < argv.length) output = argv[++i];
  }
  // If input is a directory, append snapshot.json
  try {
    const st = statSync(input);
    if (st.isDirectory()) input = join(input, 'snapshot.json');
  } catch { /* treat as file path */ }
  return { input, output };
}

const { input: inputPath, output: outPath } = parseArgs(process.argv);

// ---- Read snapshot ----

const raw = readFileSync(inputPath, 'utf-8');
const snapshot = JSON.parse(raw) as {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: Protocol[];
  watchlist: string[];
};

const protocols = snapshot.protocols;
const asOf = snapshot.as_of;
const floorUsd = snapshot.floor_usd;
const watchlist = snapshot.watchlist;

// ---- Score and rank ----

const { rows, excludedCount, totalCount } = scoreProtocols(protocols);
const preTokenTotal = rows.length + excludedCount; // total pre-token = board rows + pre-token excluded

// Verify all watchlist slugs are present
const rowSlugs = new Set(rows.map(r => r.slug));
const missing = watchlist.filter(s => !rowSlugs.has(s));
if (missing.length > 0) {
  console.error('ERROR: missing watchlist slugs:', missing);
  process.exit(1);
}

// Verify rank ordering
for (let i = 1; i < rows.length; i++) {
  if (rows[i].implied_value_usd > rows[i - 1].implied_value_usd) {
    console.error(`ERROR: rank ${i + 1} value ${rows[i].implied_value_usd} > rank ${i} value ${rows[i - 1].implied_value_usd}`);
    process.exit(1);
  }
}

// Verify all implied_value_usd are positive and not all equal
const allValues = rows.map(r => r.implied_value_usd);
const allEqual = allValues.every(v => v === allValues[0]);
if (allEqual && rows.length > 1) {
  console.error('ERROR: all implied_value_usd are equal');
  process.exit(1);
}

// Verify farm_steps
for (const row of rows) {
  if (row.farm_steps.length < 3 || row.farm_steps.length > 12) {
    console.error(`ERROR: ${row.slug} has ${row.farm_steps.length} farm_steps`);
    process.exit(1);
  }
  for (const step of row.farm_steps) {
    const trimmed = step.trim();
    if (trimmed.length < 20 || trimmed.length > 600) {
      console.error(`ERROR: ${row.slug} farm_step length ${trimmed.length}: "${trimmed.slice(0, 50)}..."`);
      process.exit(1);
    }
  }
}

// Verify no non-farmable categories in the board
const nonFarmableCats = new Set(['CEX', 'Bridge', 'Canonical Bridge', 'Cross Chain Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC']);
for (const row of rows) {
  if (row.category && nonFarmableCats.has(row.category)) {
    console.error(`ERROR: ${row.slug} has non-farmable category: ${row.category}`);
    process.exit(1);
  }
}

console.log(`Scored ${rows.length} farmable pre-token protocols (${excludedCount} of ${totalCount} pre-token protocols excluded as non-farmable)`);

// ---- Compute score range for dashboard recomputation ----

// Only farmable protocols for the score range
import { isFarmable } from './lib/model.ts';
const farmableProtocols = protocols.filter(isFarmable);
const allScores = farmableProtocols.map(p => computeScore(p).total);
const minScore = Math.min(...allScores);
const maxScore = Math.max(...allScores);

// ---- Write board.json ----

const board = {
  rows: rows.map(r => ({
    slug: r.slug,
    name: r.name,
    rank: r.rank,
    implied_value_usd: r.implied_value_usd,
    farm_steps: r.farm_steps,
  })),
};

mkdirSync(join(outPath), { recursive: true });
writeFileSync(join(outPath, 'board.json'), JSON.stringify(board));
console.log(`Wrote board.json`);

// ---- Write data.js ----

// Build exclusion reason string for dashboard display
const exclusionNote = `${excludedCount} pre-token protocols excluded: centralised exchanges, bridges and staked products cannot be farmed on-chain`;

const modelMeta = {
  version: '2.0.0',
  formula: `Score = ${W_TVL}×TVL(log) + ${W_GROWTH}×7d_change + ${W_AGE}×age + ${W_CHAINS}×chain_diversity + ${W_CATEGORY}×category; Implied value = TVL × (${VALUE_MULT_MIN}x–${VALUE_MULT_MAX}x score multiplier)`,
  params: { W_TVL, W_GROWTH, W_AGE, W_CHAINS, W_CATEGORY, minScore, maxScore, value_mult_min: VALUE_MULT_MIN, value_mult_max: VALUE_MULT_MAX },
};

const dataJs = `window.RADAR=${JSON.stringify({
  rows: rows.map(r => ({
    slug: r.slug,
    name: r.name,
    rank: r.rank,
    implied_value_usd: r.implied_value_usd,
    farm_steps: r.farm_steps,
    category: r.category,
    chains: r.chains,
    tvl_usd: r.tvl_usd,
    change_7d: r.change_7d,
    listed_at: r.listed_at,
    score: r.score,
    tvl_score: +r.tvl_score.toFixed(4),
    growth_score: +r.growth_score.toFixed(4),
    age_score: +r.age_score.toFixed(4),
    chain_score: +r.chain_score.toFixed(4),
    category_score: +r.category_score.toFixed(4),
  })),
  model: modelMeta,
  meta: {
    as_of: asOf,
    floor: floorUsd,
    watchlist_size: watchlist.length,
    total_pre_token: preTokenTotal,
    excluded_count: excludedCount,
    exclusion_note: exclusionNote,
    watchlist: watchlist,
  },
})}`;

writeFileSync(join(outPath, 'data.js'), dataJs);
console.log(`Wrote data.js`);

// ---- Copy dashboard/ and screenshots/ ----

const srcRoot = dirname(resolve(process.argv[1]));
const dashSrc = join(srcRoot, 'dashboard');
const shotsSrc = join(srcRoot, 'screenshots');

if (existsSync(dashSrc)) {
  cpSync(dashSrc, join(outPath, 'dashboard'), { recursive: true });
  console.log(`Copied dashboard/`);
} else {
  console.error('ERROR: dashboard/ directory not found');
  process.exit(1);
}

if (existsSync(shotsSrc)) {
  cpSync(shotsSrc, join(outPath, 'screenshots'), { recursive: true });
  console.log(`Copied screenshots/`);
} else {
  console.error('ERROR: screenshots/ directory not found');
  process.exit(1);
}

// ---- Write dossier.json ----

const dossier = buildDossier(outPath, {
  text_max_bytes: 65536,
  screenshots: { max: 4, max_bytes: 524288 },
  dashboard: { max_files: 400, max_bytes: 4194304 },
});

writeFileSync(join(outPath, 'dossier.json'), dossier);
console.log(`Wrote dossier.json (${dossier.length} bytes)`);

console.log('Done.');
