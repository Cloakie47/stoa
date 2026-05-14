# DEPLOYMENTS.md

Canonical record of Stoa's deployed contracts. Update this file every time something is deployed or redeployed. Tx hashes link to `https://testnet.arcscan.app/tx/{hash}` and contracts to `https://testnet.arcscan.app/address/{addr}`.

---

## Arc Testnet (chain ID `5042002`)

### Stoa Phase 1 contracts (2026-05-14)

| Contract | Address | Deploy tx |
|---|---|---|
| **Splitter** | [`0x114942B5FeebFDf9F1FA2F161eA9C2A1754C407F`](https://testnet.arcscan.app/address/0x114942B5FeebFDf9F1FA2F161eA9C2A1754C407F) | [`0xb8f2e334…04adc29`](https://testnet.arcscan.app/tx/0xb8f2e3342abcfbf62571d79b95b86c0bc8dd490782707f7e06428be4104adc29) |
| **TracePin** | [`0x657355b621494C5F99253ce9A4c2cE8B9b488B7B`](https://testnet.arcscan.app/address/0x657355b621494C5F99253ce9A4c2cE8B9b488B7B) | [`0xb3131e75…c10f101c7`](https://testnet.arcscan.app/tx/0xb3131e755773ac6db3267151abba679b69f7d6fd3500ebb2e16801fc10f101c7) |

**Deploy details**
- Deployer: `0x5342ac8383c39bf680a4035C02EcACdc8E412435` (generated via `cast wallet new`, key in local `.env`)
- Source commit: `2b10662` (the `.gitignore + .env.example` initial-hygiene commit)
- Splitter gas used: 421,196 (block `0x283f2d4` = 42,463,956)
- TracePin gas used: 132,667 (block `0x283f2da` = 42,463,962)
- Effective gas price: ~20 gwei (`0x4a8270a40`)
- Total deploy cost: 0.011 USDC (deployer went from 20.000 → 19.989 USDC)
- Verified post-deploy: `Splitter.BPS_DENOMINATOR()` returned `10000`; TracePin has code at the address.
- Solc version: `0.8.24`, optimizer on (200 runs), no via-IR.

### Reference contracts on Arc Testnet (sourced from docs.arc.io, not deployed by us)

| Contract | Address | Purpose |
|---|---|---|
| USDC (ERC-20 interface) | `0x3600000000000000000000000000000000000000` | Wraps native gas balance for ERC-20 ops; 6-decimal display, 18-decimal native unit |
| USYC | `0xe9185F0c5F296Ed1797AaE4238D26CCaBEadb86C` | Tokenized money-market fund shares for operator-share yield |
| USYC Teller | `0x9fdF14c5B14173D74C08Af27AebFf39240dC105A` | Mint/redeem USYC |
| USYC Entitlements | `0xcc205224862c7641930c87679e98999d23c26113` | Eligibility / entitlements registry |
| CCTP TokenMessengerV2 | `0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA` | CCTP V2 burn entrypoint |
| CCTP MessageTransmitterV2 | `0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275` | CCTP V2 mint entrypoint |
| CCTP TokenMinterV2 | `0xb43db544E2c27092c107639Ad201b3dEfAbcF192` | CCTP V2 mint logic |
| EURC | `0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a` | Circle euro stable (unused, listed for reference) |
| FxEscrow (StableFX) | `0x867650F5eAe8df91445971f14d89fd84F0C9a9f8` | Stable FX exchange escrow |

---

## Polygon mainnet (chain ID `137`) — references only, nothing of ours deployed

| Contract | Address | Source |
|---|---|---|
| CTF Exchange V2 (standard) | `0xE111180000d2663C0091e4f400237545B87B996B` | docs.polymarket.com/resources/contracts |
| CTF Exchange V2 (neg-risk) | `0xe2222d279d744050d28e00520010520000310F59` | same |
| Conditional Tokens | `0x4D97DCd97eC945f40cF65F87097ACe5EA0476045` | same |
| pUSD (proxy) | `0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB` | same |
| CollateralOnramp (USDC.e → pUSD) | `0x93070a847efEf7F70739046A929D47a521F5B8ee` | same |
| CollateralOfframp (pUSD → USDC.e) | `0x2957922Eb93258b93368531d39fAcCA3B4dC5854` | same |
| USDC.e | `0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174` | same |
| Deposit Wallet Factory | `0x00000000000Fb5C9ADea0298D729A0CB3823Cc07` | same |
