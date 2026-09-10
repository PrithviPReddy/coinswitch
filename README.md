# CoinSwitch

A Solana token swap application that quotes against mainnet liquidity and
settles on devnet, so every trade produces a real transaction signature that
resolves on Solscan.

## Why two networks

Jupiter's routers only have liquidity on mainnet. Its program is deployed on
devnet under the same address and the same API endpoints serve both, but
almost every pair returns no route there, so a devnet quote is an empty
response rather than a cheap one.

Rather than pretend otherwise, the two halves are split:

| Stage | Network | What happens |
| --- | --- | --- |
| Quote | mainnet | Jupiter returns a route, an expected output and a price impact figure |
| Record | database | The quoted figure is written to the swap log before anything is signed |
| Settle | devnet | One transaction moves the input to the vault and the output back |
| Verify | devnet | The delivered amount is read from account state and shown beside the quote |

Settlement uses two SPL mints this project creates itself, held by a vault
keypair that acts as counterparty. Both transfers sit in a single transaction,
so either the swap completes or nothing moves.

This is not an automated market maker and should not be described as one. It
is devnet settlement against a project-operated vault, priced from live
mainnet quotes.

## Setup

Requires Docker and Node 22.

```bash
cp .env.example .env
npm install
npm run setup:devnet     # creates the vault and the two mints, prints env values
```

Paste the three printed values (`DEVNET_USDC_MINT`, `DEVNET_USDT_MINT`,
`VAULT_SECRET_KEY`) into `.env`, then:

```bash
docker compose up --build
```

The app is on http://localhost:3000. Sign in with the demo credentials from
`.env`, press **Fund from vault**, and swap.

The setup script is safe to re-run. It reuses `.vault.json` if one exists, so
your mints and vault survive a rebuild.

### Running without Docker

```bash
docker compose up -d postgres
npx prisma migrate deploy
npm run dev
```

## Demo path

1. Sign in with the demo account (no OAuth round trip needed).
2. **Fund from vault** — sends devnet SOL and 500 of each project token to
   the selected wallet.
3. Enter an amount. The quote, route and price impact come from mainnet.
4. **Swap**. The receipt shows quoted against delivered, with the signature.
5. Click the signature to open the transaction on Solscan devnet, where both
   transfer instructions are visible inside one transaction.
6. The settlement log keeps every swap with its explorer link, scoped to the
   wallet you are looking at.
7. **New wallet** creates a second devnet wallet on the same account. It
   starts empty, so fund it before swapping from it.
8. The **Send** tab moves tokens straight out to any devnet address, or to
   another of your own wallets in one click.

## Wallets

An account holds up to five devnet wallets. The first is created at sign-in;
the rest come from **New wallet** in the terminal. Balances, the swap you are
about to make and the settlement log all follow the wallet selected in the
sidebar, so the numbers on screen always belong to the wallet a swap would
debit.

There is no import. Keys are generated server side and stored by this project,
which is what lets the server sign a settlement without a browser wallet;
accepting an outside key would mean custody of a secret this project did not
create. Every key here controls worthless devnet tokens and nothing else.

The five-wallet cap is `MAX_WALLETS_PER_USER`. It exists because every wallet
can call **Fund from vault**, and the vault is refilled by a rate-limited
faucet.

## Sending

The **Send** tab beside **Swap** transfers a token out of the selected wallet
to any devnet address. There is no quote and no counterparty: the amount that
leaves is the amount that arrives.

The vault signs as fee payer here, as it does for swaps. Two things follow
from that. A wallet holding no SOL can still send its tokens, and a SOL
balance can be sent down to zero, because nothing is held back for the fee.
If the recipient has never held the token, their associated token account is
created in the same transaction at the vault's expense, so sending to a fresh
address behaves like sending to a funded one.

Amounts are checked against devnet account state at request time rather than
against the balance the interface happens to be showing. Sends are recorded
before signing, the same way swaps are, and each wallet's history is listed
under the tab.

## Known limitations

- Wallets are custodial and every private key, on every wallet an account
  creates, is stored unencrypted in Postgres. This is a devnet demo decision
  that keeps the flow to one click with no browser wallet; the keys control
  worthless test tokens. It is not a design suitable for real funds.
- Settlement is vault-based, so there is no on-chain price impact on the
  devnet side. Price impact shown in the interface is mainnet's, from the
  quote.
- The public devnet faucet rate limits. If `setup:devnet` cannot fund the
  vault, fund it manually and re-run.

## Layout

```
app/
  api/quote      mainnet quotes through Jupiter
  api/swap       records the quote, settles on devnet, reads the result back
  api/swaps      settlement history
  api/send       transfers a token out to any devnet address
  api/transfers  outbound transfer history
  api/fund       tops a wallet up from the vault
  api/tokens     devnet balances priced with mainnet prices
  api/wallets    list, create and rename an account's wallets
  lib/devnet     vault handling, atomic settlement and outbound transfers
  lib/wallets    wallet creation and the per-request ownership check
  components     interface
scripts/
  setup-devnet.mjs   creates the vault and the project mints
```
