# $RONIN — The Masterless Samurai

<p align="center">
  <strong>RUGGED. BUT WE RISE.</strong>
</p>

<p align="center">
  A non-custodial, multi-chain Web3 ecosystem built around $RONIN, swaps, Samurai Points, rewards, and the next generation of the Ronin experience.
</p>

<p align="center">
  <a href="https://ronin-swap6.vercel.app">Live App</a> •
  <a href="https://github.com/kkainatAMIR/Ronin-swap">GitHub</a>
</p>

---

## ⚔️ What is Ronin?

**Ronin** is a Web3 ecosystem designed around the $RONIN community, combining a non-custodial swap experience with Samurai Points, rewards, burn tracking, tokenomics, and an expanding NFT/game ecosystem.

The project is built around one simple principle:

> **RUGGED. BUT WE RISE.**

Users remain in control of their wallets and transactions. The application never asks for seed phrases or private keys.

---

## ✨ Ecosystem

| Surface               | Purpose                                                  |
| --------------------- | -------------------------------------------------------- |
| 🔄 **Swap**           | Non-custodial token swapping across supported networks   |
| 🏆 **Samurai Points** | Points earned from verified swap activity                |
| 💰 **Rewards**        | Claim eligible Samurai Points rewards on Solana          |
| 🔥 **Burn**           | Track $RONIN burn activity and ecosystem statistics      |
| 🎮 **Game**           | Game ecosystem surface prepared for future functionality |
| 🖼️ **NFT**           | NFT ecosystem surface prepared for the next phase        |
| 📊 **Tokenomics**     | $RONIN supply and ecosystem information                  |
| 🛡️ **Transparency**  | Public-facing ecosystem and contract information         |

---

## ⛓️ Supported Networks

Ronin uses a chain-aware architecture supporting:

* **Solana** — Jupiter-powered swaps and Solana rewards
* **Ethereum** — EVM wallet and swap infrastructure
* **Robinhood Chain** — EVM support through the multi-chain routing layer

The application uses wallet signatures for user-authorized transactions.

**Private keys and seed phrases are never requested or handled by the application.**

---

## 🔄 Non-Custodial Swaps

The swap experience is designed so users remain in control of their assets.

### Solana

* Jupiter-powered swaps
* Phantom-compatible wallet flow
* Live quotes and transaction status
* $RONIN support

### Ethereum

* EVM wallet support
* MetaMask-compatible flow
* 0x-based routing

### Robinhood Chain

* EVM-compatible wallet flow
* Chain ID `4663`
* LI.FI routing foundation

Every transaction requiring authorization must be approved by the user's wallet.

---

## 🏆 Samurai Points

**Samurai Points** are the rewards accounting layer of the Ronin ecosystem.

Points are based on **verified executed swap volume**, rather than simply connecting a wallet or opening the application.

The rewards system is designed around:

* Verified swap activity
* Unified wallet/account accounting
* Configurable reward rules
* Cross-chain activity support
* On-chain Solana reward settlement

---

## 💰 Solana Rewards

The Ronin rewards system includes a Solana **Anchor program** for on-chain reward settlement.

The program is located under:

```text
program/programs/ronin_rewards/
```

Deployment, initialization, testing, and verification scripts are available under:

```text
program/scripts/
```

For the detailed Solana program documentation:

**[View the Solana Rewards Program Guide](program/README.md)**

---

## 🔥 $RONIN

$RONIN is the core token of the ecosystem.

### Solana Mint

```text
2JVEVXoRsskapZ8T56MjMNJq6Dk3feEUYSRmzkkipump
```

The application uses the configured token registry and live blockchain data where applicable.

Always verify the token mint before making a transaction.

---

## 🛡️ Security Principles

Ronin follows a non-custodial architecture.

* 🔐 **No seed phrases requested**
* 🔑 **No private keys handled by the app**
* ✍️ **Transactions require user wallet approval**
* 🌐 **Blockchain data is read from RPC/indexer infrastructure**
* ⚙️ **Server credentials remain server-side**
* 🚫 **No fake transaction success states**

Users should always verify transaction details in their wallet before approving a transaction.

---

## 🏗️ Tech Stack

### Frontend

* React
* Vite
* JavaScript
* Responsive Web3 UI

### Blockchain

* Solana
* Anchor
* Ethereum / EVM
* Robinhood Chain

### Web3 Infrastructure

* Jupiter
* 0x
* LI.FI
* Phantom
* MetaMask
* Helius / Solana RPC

### Backend & Data

* Vercel Serverless Functions
* Supabase
* Node.js

---

## 📁 Project Structure

```text
Ronin-swap/
├── api/                         # Serverless API handlers
├── src/                         # React/Vite frontend
├── supabase/migrations/         # Database migrations
├── program/                     # Solana Anchor rewards program
│   ├── programs/ronin_rewards/  # On-chain program
│   ├── tests/                   # Anchor tests
│   └── scripts/                 # Deployment & verification scripts
├── scripts/                     # Application test / utility scripts
├── docs/                        # Project documentation
├── public/                      # Static assets and artwork
├── .env.example                 # Environment variable template
└── README.md                    # Project documentation
```

---

## 🚀 Run Locally

### 1. Clone the repository

```bash
git clone https://github.com/kkainatAMIR/Ronin-swap.git
cd Ronin-swap
```

### 2. Install dependencies

```bash
npm install
```

### 3. Configure environment variables

```bash
cp .env.example .env
```

Add the required RPC and API configuration to your local environment.

**Never commit real credentials, private keys, or seed phrases.**

### 4. Start development

```bash
npm run dev
```

The application will be available at:

```text
http://localhost:5173
```

### 5. Build for production

```bash
npm run build
```

Preview the production build with:

```bash
npm run preview
```

---

## ☁️ Deployment

The frontend is designed for deployment on **Vercel**.

Recommended production setup:

1. Import the repository into Vercel.
2. Use the Vite framework preset.
3. Use `npm run build` as the build command.
4. Use `dist` as the output directory.
5. Configure the required environment variables.
6. Never commit `.env.local` or production credentials.

---

## 📚 Documentation

Detailed implementation documentation is intentionally separated from the main README.

| Documentation                            | Description                                 |
| ---------------------------------------- | ------------------------------------------- |
| [`program/README.md`](program/README.md) | Solana rewards program and deployment guide |
| `docs/`                                  | Project-specific technical documentation    |
| `.env.example`                           | Environment variable reference              |

---

## 🗺️ Roadmap

### Phase 1 — Core Ecosystem

* [x] $RONIN frontend
* [x] Non-custodial swap foundation
* [x] Solana integration
* [x] Multi-chain architecture
* [x] Samurai Points foundation
* [x] Solana rewards program

### Phase 2 — Ecosystem Expansion

* [x] NFT ecosystem foundation
* [ ] NFT functionality expansion
* [ ] Game ecosystem
* [ ] Additional reward mechanics
* [ ] Further multi-chain expansion

### Phase 3 — The Ronin Ecosystem

* [ ] Expanded NFT ecosystem
* [ ] Game integrations
* [ ] Additional community features
* [ ] Further ecosystem utilities

> Roadmap items are subject to development and may change as the ecosystem evolves.

---

## ⚠️ Disclaimer

Ronin is a software project and ecosystem interface. Blockchain transactions involve financial and technical risks.

Always verify token addresses, network selections, transaction details, and wallet prompts before signing.

**Never share your seed phrase or private key with anyone.**

---

## 🤝 Contributing

Contributions, testing, security feedback, and technical discussion are welcome.

Please open an issue or pull request with enough context to reproduce a problem or understand the proposed change.

---

## 📜 License

See the repository for the applicable license and project terms.

---

<p align="center">
  <strong>$RONIN — RUGGED. BUT WE RISE.</strong>
</p>

 
 
