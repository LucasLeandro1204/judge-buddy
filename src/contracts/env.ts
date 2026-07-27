/** Legacy toggle for the old escrow demo. The treasury app expects live API mode by default. */
export const ESCROW_USE_MOCK =
  typeof import.meta.env.VITE_ESCROW_USE_MOCK === "string"
    ? import.meta.env.VITE_ESCROW_USE_MOCK === "true"
    : false;

/**
 * Same-origin API mount used when `VITE_HEDERA_API_URL` is not set.
 *
 * Production deploys JudgeBuddy as a single Cloudflare Worker that serves both the
 * static assets and the API under `/api`, so no build-time URL is required there.
 */
export const DEFAULT_API_BASE = "/api";

const configuredApiUrl = (import.meta.env.VITE_HEDERA_API_URL as string | undefined)?.trim() ?? "";

/**
 * Base URL for the JudgeBuddy API.
 *
 * Set `VITE_HEDERA_API_URL` for local development against a separate API process
 * (e.g. `http://localhost:3001`). When unset this resolves to the same-origin
 * `/api` mount, so it is always a usable value and never throws.
 */
export const HEDERA_API_URL = configuredApiUrl ? configuredApiUrl.replace(/\/+$/, "") : DEFAULT_API_BASE;

/** True when the API base came from `VITE_HEDERA_API_URL` rather than the same-origin default. */
export const HEDERA_API_URL_IS_EXPLICIT = configuredApiUrl.length > 0;

const escrowAddr = (import.meta.env.VITE_ESCROW_CONTRACT_ADDRESS as string | undefined)?.trim() ?? "";

/** When set, new tasks must use an HTS ERC-20 (not HBAR) to match `HederaTaskEscrow`. */
export const ONCHAIN_ESCROW_ENABLED = escrowAddr.startsWith("0x") && escrowAddr.length >= 42;
