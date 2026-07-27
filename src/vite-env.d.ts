/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_ESCROW_USE_MOCK?: string;
  /**
   * Optional API base for local development (e.g. `http://localhost:3001`).
   * When unset the app calls the same-origin `/api` mount served by the Worker.
   */
  readonly VITE_HEDERA_API_URL?: string;
  /** Decimals of the payout token used for prize amounts. Defaults to 6 (USDC). */
  readonly VITE_PAYOUT_TOKEN_DECIMALS?: string;
  /** Display symbol for the payout token. Defaults to `USDC`. */
  readonly VITE_PAYOUT_TOKEN_SYMBOL?: string;
  /** Deployed `HackathonTreasury` used by browser-side treasury transactions. */
  readonly VITE_TREASURY_CONTRACT_ADDRESS?: string;
  /** Deployed prize-claim token address. */
  readonly VITE_PRIZE_CLAIM_TOKEN_ADDRESS?: string;
  readonly VITE_WALLETCONNECT_PROJECT_ID?: string;
  /** Optional HTS token id (0.0.x) for a USDC-style demo token in the token picker */
  readonly VITE_HEDERA_USDC_TOKEN_ID?: string;
  /** Optional: operator account id shown so funders know where to send HBAR/HTS */
  readonly VITE_HEDERA_OPERATOR_ID?: string;
  /** Deployed `HederaTaskEscrow` on Hedera EVM (must match server `ESCROW_CONTRACT_ADDRESS`) */
  readonly VITE_ESCROW_CONTRACT_ADDRESS?: string;
  /** Optional; defaults to Hashio testnet in wallet helper */
  readonly VITE_HEDERA_EVM_RPC?: string;
  /** Optional Hedera mirror REST base (MetaMask sign-in resolves 0.0.x from EVM address); defaults to testnet mirror */
  readonly VITE_HEDERA_MIRROR_BASE?: string;
  /**
   * JudgeBuddy: when `false`, events load from `GET /hackathons` and creates go to `POST /hackathons` (server JSON store).
   * Default / unset = mock data. Requires `VITE_HEDERA_API_URL`.
   */
  readonly VITE_HACKATHON_MOCKUP?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
