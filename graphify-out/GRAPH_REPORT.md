# Graph Report - coinswitch-main  (2026-09-21)

## Corpus Check
- Corpus is ~18,160 words - fits in a single context window. You may not need a graph.

## Summary
- 307 nodes · 536 edges · 22 communities (18 shown, 4 thin omitted)
- Extraction: 91% EXTRACTED · 8% INFERRED · 1% AMBIGUOUS · INFERRED: 43 edges (avg confidence: 0.85)
- Token cost: 362,928 input · 0 output

## Community Hubs (Navigation)
- Wallet and Swap UI
- Devnet Settlement Architecture
- Auth, Prisma and Wallet Services
- Build Config and Tooling
- Vault Signing and Transfers
- TypeScript Compiler Config
- Jupiter Quotes and Token Constants
- Runtime Dependencies
- App Shell and Layout
- Devnet Bootstrap Script
- Dev Dependencies
- Landing Page
- Globe Icon Asset
- Default Token Icon Fallback
- Solana Token Icon
- USDT Token Icon
- Window Icon Asset
- Next.js Branding Assets
- USDC Token Icon
- PostCSS Config
- File Icon Asset
- Vercel Logo Asset

## God Nodes (most connected - your core abstractions)
1. `next` - 16 edges
2. `compilerOptions` - 16 edges
3. `next-auth` - 15 edges
4. `authConfig` - 10 edges
5. `react` - 10 edges
6. `app service` - 10 edges
7. `POST()` - 9 edges
8. `session` - 9 edges
9. `explorerTxUrl()` - 9 edges
10. `resolveWallet()` - 9 edges

## Surprising Connections (you probably didn't know these)
- `Env Var Defaults with Required Solana Values` --semantically_similar_to--> `.vault.json Idempotent Reuse`  [INFERRED] [semantically similar]
  docker-compose.yml → README.md
- `postgres service` --conceptually_related_to--> `Unencrypted Private Key Storage Limitation`  [INFERRED]
  docker-compose.yml → README.md
- `app service` --conceptually_related_to--> `Devnet Faucet Rate Limit`  [AMBIGUOUS]
  docker-compose.yml → README.md
- `MAINNET_RPC_URL / DEVNET_RPC_URL` --implements--> `Two-Network Split (mainnet quote, devnet settle)`  [INFERRED]
  docker-compose.yml → README.md
- `app service` --shares_data_with--> `Vault Keypair Counterparty`  [INFERRED]
  docker-compose.yml → README.md

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Quote-Record-Settle-Verify Swap Flow** — readme_api_quote, readme_api_swap, readme_lib_devnet, readme_vault_keypair, readme_atomic_settlement, readme_quoted_vs_delivered [EXTRACTED 1.00]
- **Compose Startup Chain: postgres to migrate to app** — docker_compose_postgres_service, docker_compose_migrate_service, docker_compose_app_service, docker_compose_healthcheck_gating [EXTRACTED 1.00]
- **Custodial Wallet Model and Its Constraints** — readme_custodial_wallets, readme_no_key_import, readme_max_wallets_per_user, readme_unencrypted_key_storage, readme_lib_wallets, readme_fund_from_vault [INFERRED 0.85]
- **SOL Token Visual Identity in the Wallet/Swap UI** — public_tokens_sol_logo, public_tokens_sol_solana_asset, public_tokens_sol_token_icon_convention, public_tokens_sol_circular_badge_design [INFERRED 0.75]
- **Token Logo Resolution and Fallback** — public_tokens_default_token_icon_convention, public_tokens_default_icon, public_tokens_default_fallback_placeholder_strategy, public_tokens_default_monochrome_vector_style [INFERRED 0.75]

## Communities (22 total, 4 thin omitted)

### Community 0 - "Wallet and Swap UI"
Cohesion: 0.08
Nodes (26): Receipt, SendPanel(), shorten(), TransferLog(), TransferRow, LedgerRow, Receipt, SwapPanel() (+18 more)

### Community 1 - "Devnet Settlement Architecture"
Cohesion: 0.06
Nodes (47): app service, DATABASE_URL, Env Var Defaults with Required Solana Values, Healthcheck-Gated Startup Ordering, migrate service (prisma migrate deploy), NextAuth Configuration (NEXTAUTH_URL/SECRET, Google OAuth), pgdata volume, postgres service (+39 more)

### Community 2 - "Auth, Prisma and Wallet Services"
Cohesion: 0.14
Nodes (24): handler, POST(), readBody(), PATCH(), GET(), POST(), Dashboard(), globalForPrisma (+16 more)

### Community 3 - "Build Config and Tooling"
Cohesion: 0.06
Nodes (29): eslintConfig, name, private, scripts, build, db:migrate, dev, lint (+21 more)

### Community 4 - "Vault Signing and Transfers"
Cohesion: 0.21
Nodes (22): POST(), SendRequest, POST(), SwapRequest, GET(), GET(), explorerTxUrl(), tokenByMint() (+14 more)

### Community 5 - "TypeScript Compiler Config"
Cohesion: 0.11
Nodes (18): compilerOptions, allowJs, esModuleInterop, incremental, isolatedModules, jsx, lib, module (+10 more)

### Community 6 - "Jupiter Quotes and Token Constants"
Cohesion: 0.17
Nodes (11): GET(), getAccountBalance(), DEFAULT_SLIPPAGE_BPS, DEVNET_RPC, devnetConnection, getSupportedTokens(), JupiterPrice, MAINNET_RPC (+3 more)

### Community 7 - "Runtime Dependencies"
Cohesion: 0.13
Nodes (15): dependencies, axios, bs58, cross-fetch, jsonwebtoken, next, next-auth, prisma (+7 more)

### Community 8 - "App Shell and Layout"
Cohesion: 0.22
Nodes (7): AppBar(), Providers(), app_globals, geistMono, geistSans, metadata, sourceSerif

### Community 9 - "Devnet Bootstrap Script"
Cohesion: 0.27
Nodes (9): ref_node_fs, ref_node_path, @solana/spl-token, connection, createProjectMint(), ensureFunded(), loadOrCreateVault(), main() (+1 more)

### Community 10 - "Dev Dependencies"
Cohesion: 0.22
Nodes (9): devDependencies, eslint, eslint-config-next, tailwindcss, @tailwindcss/postcss, @types/node, @types/react, @types/react-dom (+1 more)

### Community 12 - "Globe Icon Asset"
Cohesion: 0.50
Nodes (5): SVG clipPath #a (16x16 viewport mask), Globe Icon (globe.svg), Neutral Grey Icon Fill (#666) Convention, Next.js public/ Static Icon Asset Set, Wireframe Globe Glyph (meridians and parallels on filled sphere)

### Community 13 - "Default Token Icon Fallback"
Cohesion: 0.60
Nodes (5): Missing-Logo Fallback Placeholder Strategy, Default Token Icon Asset, Monochrome Flat-Fill Vector Icon Style, Next.js Wordmark Artwork, Token Icon Lookup Convention (public/tokens/<symbol>.svg)

### Community 14 - "Solana Token Icon"
Cohesion: 0.67
Nodes (4): Circular Dark-Field Token Badge Design, Solana (SOL) Token Logo Asset, Solana (SOL) Asset Identity, Per-Token Icon Asset Convention (public/tokens/<Symbol>.png)

### Community 15 - "USDT Token Icon"
Cohesion: 0.83
Nodes (4): Tether Teal Diamond Brand Mark, USDT Token Logo Asset, Tether (USDT) Stablecoin, Token Icon Asset Convention (public/tokens/<SYMBOL>.png)

### Community 16 - "Window Icon Asset"
Cohesion: 0.67
Nodes (4): Browser Window Glyph Motif, Window Icon (window.svg), Monochrome 16px UI Icon System, Next.js public/ Static Asset

### Community 17 - "Next.js Branding Assets"
Cohesion: 1.00
Nodes (3): create-next-app Default Scaffold Assets, Monochrome Vector Branding Asset, Next.js Wordmark Logo

### Community 18 - "USDC Token Icon"
Cohesion: 1.00
Nodes (3): USDC Token Logo Asset, USDC Stablecoin, Token Icon Asset Convention

## Ambiguous Edges - Review These
- `Devnet Faucet Rate Limit` → `app service`  [AMBIGUOUS]
  docker-compose.yml · relation: conceptually_related_to
- `create-next-app Default Scaffold Assets` → `Monochrome Vector Branding Asset`  [AMBIGUOUS]
  public/next.svg · relation: conceptually_related_to
- `Next.js Wordmark Artwork` → `Missing-Logo Fallback Placeholder Strategy`  [AMBIGUOUS]
  public/tokens/default.svg · relation: conceptually_related_to

## Knowledge Gaps
- **100 isolated node(s):** `handler`, `SendRequest`, `SwapRequest`, `Receipt`, `TransferRow` (+95 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 132 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **4 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **What is the exact relationship between `Devnet Faucet Rate Limit` and `app service`?**
  _Edge tagged AMBIGUOUS (relation: conceptually_related_to) - confidence is low._
- **What is the exact relationship between `create-next-app Default Scaffold Assets` and `Monochrome Vector Branding Asset`?**
  _Edge tagged AMBIGUOUS (relation: conceptually_related_to) - confidence is low._
- **What is the exact relationship between `Next.js Wordmark Artwork` and `Missing-Logo Fallback Placeholder Strategy`?**
  _Edge tagged AMBIGUOUS (relation: conceptually_related_to) - confidence is low._
- **Why does `next` connect `Auth, Prisma and Wallet Services` to `Wallet and Swap UI`, `Build Config and Tooling`, `Vault Signing and Transfers`, `Jupiter Quotes and Token Constants`, `App Shell and Layout`, `Landing Page`?**
  _High betweenness centrality (0.096) - this node is a cross-community bridge._
- **Why does `@solana/web3.js` connect `Vault Signing and Transfers` to `Devnet Bootstrap Script`, `Auth, Prisma and Wallet Services`, `Build Config and Tooling`, `Jupiter Quotes and Token Constants`?**
  _High betweenness centrality (0.063) - this node is a cross-community bridge._
- **Why does `dependencies` connect `Runtime Dependencies` to `Build Config and Tooling`?**
  _High betweenness centrality (0.060) - this node is a cross-community bridge._
- **What connects `handler`, `SendRequest`, `SwapRequest` to the rest of the system?**
  _100 weakly-connected nodes found - possible documentation gaps or missing edges._