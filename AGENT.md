# WaterX Agent — Quick Reference for AI Agents

## Setup (run once)

```bash
npm install
npm run setup
```

This generates a SUI wallet, funds it with testnet SUI + USDC, creates a WaterX account, and deposits USDC. All credentials are saved to `.env`.

You can also run each step individually:

```bash
npm run generate-wallet    # Generate wallet -> .env
npm run fund-sui           # Request testnet SUI from faucet
npm run mint-usdc          # Mint 100 testnet USDC
npm run create-account     # Create WaterX account -> .env
npm run deposit -- --amount 50   # Deposit 50 USDC
```

## Script Commands

All arguments use `--key value` format. Use `--help` on any script for usage info.

### Setup
| Command | Description |
|---------|-------------|
| `npm run setup` | Full bootstrap (wallet + fund + account + deposit) |
| `npm run generate-wallet` | Generate or load SUI wallet |
| `npm run fund-sui` | Request testnet SUI from faucet |
| `npm run mint-usdc [-- --amount 100]` | Mint testnet USDC |
| `npm run create-account` | Create WaterX trading account |
| `npm run deposit -- --amount 50 [--collateral USDC]` | Deposit to account |

### Trading
| Command | Description |
|---------|-------------|
| `npm run open-long -- --base BTC --collateral 10 --leverage 5 [--tp 70000] [--sl 60000]` | Open long |
| `npm run open-short -- --base ETH --collateral 10 --leverage 3` | Open short |
| `npm run close-position -- --base BTC --position-id 0` | Close position |
| `npm run increase-position -- --base BTC --position-id 0 --collateral 5` | Add size |
| `npm run decrease-position -- --base BTC --position-id 0 --size 1000000000` | Reduce size |
| `npm run add-collateral -- --base BTC --position-id 0 --amount 5` | Add margin |
| `npm run remove-collateral -- --base BTC --position-id 0 --amount 2` | Remove margin |

### Orders
| Command | Description |
|---------|-------------|
| `npm run place-order -- --base BTC --long --collateral 10 --leverage 5 --trigger-price 60000` | Limit order |
| `npm run place-order -- --base BTC --short --collateral 10 --trigger-price 70000 --stop` | Stop order |
| `npm run place-tp -- --base BTC --position-id 0 --long --trigger-price 70000` | Take-profit |
| `npm run place-sl -- --base BTC --position-id 0 --long --trigger-price 58000` | Stop-loss |
| `npm run cancel-order -- --base BTC --order-id 0` | Cancel order |

### WLP & Rewards
| Command | Description |
|---------|-------------|
| `npm run mint-wlp -- --deposit-coin <objectId>` | Mint WLP |
| `npm run redeem-wlp -- --lp-coin <objectId>` | Redeem WLP |
| `npm run stake -- --stake-coin <objectId>` | Stake WLP |
| `npm run unstake -- --amount 1000000` | Unstake |
| `npm run claim-rewards` | Claim rewards |

### Queries (on-chain)
| Command | Description |
|---------|-------------|
| `npm run accounts` | List WaterX accounts |
| `npm run balances` | Wallet + account balances |
| `npm run positions -- --base BTC --price 65000` | Open positions |
| `npm run orders [-- --base BTC]` | Open orders |
| `npm run market-info -- --base BTC` | Market summary |
| `npm run pool-info` | WLP pool info |
| `npm run summary` | Full account summary |

### Queries (API — requires `WATERX_API_URL`)
| Command | Description |
|---------|-------------|
| `npm run tickers [-- --symbol BTC]` | Market tickers (all or specific) |
| `npm run candles -- --symbol BTC --tf 1h [--limit 20]` | Candlestick data |
| `npm run trades -- --symbol BTC [--limit 20]` | Recent trades |
| `npm run funding -- --symbol BTC [--history --limit 10]` | Funding rate info/history |
| `npm run history [-- --category trade --limit 20]` | Trade/order history |
| `npm run pnl` | PnL summary (today/7d/30d/all) |
| `npm run wlp-apy [-- --period 7d]` | WLP APY + fee stats |
| `npm run wlp-stats [-- --user 0x...]` | WLP pool utilization & staking |
| `npm run prices -- --coins bitcoin,ethereum,sui` | Coin prices (CoinGecko) |
| `npm run fear-greed [-- --days 7]` | Fear & Greed Index |
| `npm run referral [-- --codes --referrer --stats]` | Referral info |

## Programmatic Usage

```typescript
import dotenv from "dotenv";
dotenv.config();

import {
  loadWallet,
  AgentSigner,
  openLong,
  closePosition,
  getPositions,
  getAccountBalances,
} from "./src/agent/index.ts";

const { keypair } = loadWallet();
const signer = new AgentSigner(keypair, "TESTNET");
const accountId = process.env.WATERX_ACCOUNT_ID!;

// Open a 5x long BTC position with 10 USDC
await openLong(signer, {
  accountId,
  base: "BTC",
  collateralAmount: 10_000_000, // 10 USDC (6 decimals)
  leverage: 5,
  takeProfitPrice: 70000,
  stopLossPrice: 60000,
});
```

## API Client (REST Backend)

Set `WATERX_API_URL` in `.env` to enable market data, analytics, and more. The API client is optional — the agent works without it in on-chain-only mode.

```typescript
import dotenv from "dotenv";
dotenv.config();

import { WaterXApiClient } from "./src/agent/index.ts";

const api = new WaterXApiClient(); // reads WATERX_API_URL from env

// Market data
const ticker = await api.getTicker("BTC");
console.log(`BTC: $${ticker.spotPrice} (${ticker.changePercent24h.toFixed(2)}%)`);

const candles = await api.getCandles("ETH", { tf: "1h", limit: 10 });
const funding = await api.getFundingInfo("BTC");

// Account analytics
const pnl = await api.getPnlSummary(process.env.WATERX_ACCOUNT_ID!);
const history = await api.getHistory({ account: process.env.WATERX_ACCOUNT_ID!, limit: 10 });

// Market intelligence
const prices = await api.getCoinPrices("bitcoin,ethereum,sui");
const fearGreed = await api.getFearGreed();

// WLP analytics
const apy = await api.getWlpApy("7d");
const utilization = await api.getUtilization();
```

## SDK

This project uses `@waterx/perp-sdk` (v0.6.1+) as a dependency. The full SDK API is re-exported from `src/index.ts` for advanced usage.

## Markets

Crypto: `BTC`, `ETH`, `SOL`, `SUI`, `DEEP`, `WAL`

xStocks: `AAPLX`, `GOOGLX`, `METAX`, `NVDAX`, `QQQX`, `SPYX`, `TSLAX`

## Amounts

- Collateral: 6 decimals (`1_000_000` = 1 USDC). Scripts accept human units (`--collateral 10` = 10 USDC).
- Prices: USD (`65000` = $65,000)
- Leverage: multiplier (`10` = 10x)
- Size: 1e9-scaled on-chain units (used in decrease-position)
