[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/Apihpih96/token-radar-01/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/Apihpih96/token-radar-01/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

# Token Launch Radar

A dashboard that ranks pre-token DeFi protocols by their implied launch value, with farm plans for each. Built for the [make.fun](https://make.fun) token-radar-01 bounty.

## Model

Each protocol is scored from its snapshot data using a weighted composite: TVL on a log scale (35%), 7-day TVL change (15%), age since listing without a token (25%), chain diversity (15%), and category weight (10%). The implied value is TVL multiplied by a score-dependent multiple in the 0.03x–0.47x band, so the top protocol lands at $1.29B and the median near $5.2M — all well under the $10B cap.

The board covers farmable pre-token protocols only: 134 pre-token protocols are excluded as non-farmable (centralised exchanges, bridges, staked products), and all 40 watchlist slugs are represented.

## Running

```bash
node main.ts --input ~/workspace/makefun/token-radar-01-kit/input/snapshot.json
```

Or with environment variables:

```bash
MAKEFUN_OUTPUT_DIR=out node main.ts
```

## License

SPDX-License-Identifier: MIT
