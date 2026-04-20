# WaterX Agent

Programmatic TypeScript SDK for the [WaterX](https://waterx.io) perpetual trading protocol on SUI blockchain. Designed for AI agents and automated trading — no browser wallet needed.

Built on top of [`@waterx/perp-sdk`](https://github.com/WaterXProtocol/waterx-sdk) with a high-level agent abstraction layer.

## Quick Start

```bash
# 1. Clone and install
git clone <repo-url> waterx-agent
cd waterx-agent
npm install

# 2. Bootstrap (generates wallet, funds it, creates account)
npm run setup

# 3. Done! Use in your code:
```

```typescript
import { loadWallet, AgentSigner, openLong, getPositions } from "./src/agent/index.ts";

const { keypair } = loadWallet();
const signer = new AgentSigner(keypair, "TESTNET");

// Open a 5x long BTC position with 10 USDC collateral
await openLong(signer, {
  accountId: process.env.WATERX_ACCOUNT_ID!,
  base: "BTC",
  collateralAmount: 10_000_000, // 10 USDC (6 decimals)
  leverage: 5,
});

// Check positions
const positions = await getPositions(signer, process.env.WATERX_ACCOUNT_ID!, "BTC", 65000);
console.log(positions);
```

## Prerequisites

- **Node.js** >= 18 (tested with 22+)
- **npm** or **pnpm**

No SUI CLI installation needed — everything runs through the `@mysten/sui` npm package.

## Environment Variables

After running `npm run setup`, your `.env` file will contain:

| Variable | Description |
|----------|-------------|
| `WATERX_NETWORK` | `TESTNET` or `MAINNET` (default: TESTNET) |
| `SUI_PRIVATE_KEY` | Bech32-encoded Ed25519 private key (`suiprivkey1...`) |
| `WATERX_ACCOUNT_ID` | On-chain WaterX account object address |

## Available Functions

### Setup & Wallet

| Function | Description |
|----------|-------------|
| `generateWallet()` | Generate a new Ed25519 keypair |
| `loadWallet()` | Load keypair from `SUI_PRIVATE_KEY` env |
| `getOrCreateWallet()` | Load or generate + save to `.env` |
| `AgentSigner(keypair, network)` | Create a signer with WaterX client |
| `requestTestnetSui(address)` | Request SUI from testnet faucet |
| `mintTestnetUsdc(signer, amount)` | Mint testnet mock USDC |
| `getOrCreateAccount(signer)` | Create WaterX account if needed |
| `depositToAccount(signer, id, amt)` | Deposit collateral to account |

### Trading

| Function | Description |
|----------|-------------|
| `openLong(signer, params)` | Open a long position |
| `openShort(signer, params)` | Open a short position |
| `closePosition(signer, params)` | Close position entirely |
| `increasePosition(signer, params)` | Add size to existing position |
| `decreasePosition(signer, params)` | Reduce position size |
| `addCollateral(signer, params)` | Increase position margin |
| `removeCollateral(signer, params)` | Decrease position margin |
| `placeOrder(signer, params)` | Place limit/stop order |
| `placeTakeProfit(signer, params)` | Place TP on existing position |
| `placeStopLoss(signer, params)` | Place SL on existing position |
| `cancelOrder(signer, params)` | Cancel an order |

### Queries

| Function | Description |
|----------|-------------|
| `getAccounts(signer)` | List all accounts owned by wallet |
| `getPositions(signer, accountId, base, price)` | Get open positions for a market |
| `getOrders(signer, accountId, base)` | Get open orders for a market |
| `getAllOrders(signer, accountId)` | Get all orders across all markets |
| `getAccountBalances(signer, id)` | Get USDC/USDSUI balance in account |
| `getMarketInfo(signer, base)` | Get market data (OI, fees, etc.) |
| `getPoolInfo(signer)` | Get WLP pool summary |
| `getWalletBalance(signer)` | Get wallet SUI balance |
| `getWalletUsdcBalance(signer)` | Get wallet USDC balance |
| `printAccountSummary(signer, id)` | Print full account state |

### WLP & Rewards

| Function | Description |
|----------|-------------|
| `mintWlp(signer, params)` | Mint WLP from collateral |
| `redeemWlp(signer, params)` | Request WLP redemption |
| `stakeRewards(signer, params)` | Stake in reward distributor |
| `unstakeRewards(signer, params)` | Unstake from rewards |
| `claimRewards(signer)` | Claim accrued rewards |

## Supported Markets

| Symbol | Description | Type |
|--------|-------------|------|
| BTC | Bitcoin | Crypto |
| ETH | Ethereum | Crypto |
| SOL | Solana | Crypto |
| SUI | Sui | Crypto |
| DEEP | DeepBook | Crypto |
| WAL | Walrus | Crypto |
| AAPLX | Apple xStock | Stock |
| GOOGLX | Google xStock | Stock |
| METAX | Meta xStock | Stock |
| NVDAX | Nvidia xStock | Stock |
| QQQX | QQQ xStock | ETF |
| SPYX | S&P 500 xStock | ETF |
| TSLAX | Tesla xStock | Stock |

## Collateral Types

| Symbol | Decimals | Description |
|--------|----------|-------------|
| USDC | 6 | Mock USDC (testnet) |
| USDSUI | 6 | Mock USD-pegged SUI (testnet) |

## Price & Amount Scales

- **Collateral amounts**: raw units with 6 decimals (e.g., `10_000_000` = 10 USDC)
- **Position size**: 1e9-scaled (Float type)
- **Prices**: USD for agent functions (auto-converted), 1e9-scaled for low-level SDK
- **Leverage**: multiplier (e.g., `5` = 5x)

## Architecture

```
src/
├── agent/           # Agent-specific wrapper (wallet, signer, trading, queries)
├── helpers.ts       # Price conversion utilities (rawPrice, FLOAT_SCALE)
└── index.ts         # Re-exports @waterx/perp-sdk + agent layer
```

The core SDK logic is provided by `@waterx/perp-sdk` (v0.6.1+). This repo adds the `agent/` layer for:
- Wallet management (generate, load, save to `.env`)
- `AgentSigner` class (keypair + client bundled together)
- Human-friendly trading functions (USD prices auto-converted)
- CLI scripts for quick testing

## License

MIT
