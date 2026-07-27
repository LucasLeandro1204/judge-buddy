import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { AlertCircle, Loader2, ShieldCheck, Wallet } from "lucide-react";
import { BrowserProvider, getAddress } from "ethers";

import { buildAuthSignedMessage, type AuthChallenge, type AuthenticatedUser } from "@/auth/auth-message";
import { AuthContext } from "@/auth/context";
import type { AuthSession, AuthStatus, WalletConnection } from "@/auth/types";
import { resolveHederaAccountIdFromEvm } from "@/auth/resolveHederaAccount";
import { HEDERA_API_URL } from "@/contracts/env";
import { ensureHederaTestnetEvmChain, getInjectedEip1193 } from "@/lib/hederaEscrowContract";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

type SessionResponse = {
  authenticated: boolean;
  user?: AuthenticatedUser;
};

type WalletState = {
  accountId: string | null;
  connected: boolean;
  evmAddress: string | null;
  network: "testnet";
  walletName: "MetaMask" | null;
  walletType: "injected" | null;
};

const AUTH_NETWORK = "testnet" as const;

function readErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toWalletConnection(state: WalletState | null, sessionUser: AuthenticatedUser | null): WalletConnection {
  return {
    accountId: state?.accountId ?? sessionUser?.accountId ?? null,
    canExecuteNativeTransactions: false,
    connected: state?.connected ?? Boolean(sessionUser),
    network: AUTH_NETWORK,
    ready: true,
    walletName: state?.walletName ?? (sessionUser ? "MetaMask" : null),
    walletSource: "metamask",
    walletType: state?.walletType ?? null,
  };
}

async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${HEDERA_API_URL}${path}`, {
    ...init,
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || response.statusText);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}

async function connectMetaMask(): Promise<WalletState> {
  const ethereum = getInjectedEip1193();
  if (!ethereum) {
    throw new Error("No injected wallet found. Install MetaMask and connect it to Hedera Testnet.");
  }

  await ensureHederaTestnetEvmChain(ethereum);
  const provider = new BrowserProvider(ethereum);
  const signer = await provider.getSigner();
  const evmAddress = getAddress(await signer.getAddress());
  const accountId = await resolveHederaAccountIdFromEvm(evmAddress);

  if (!accountId) {
    throw new Error(
      "Could not resolve a Hedera account for this EVM address. Use a Hedera ECDSA account with a mirror-node evm_address.",
    );
  }

  return {
    accountId,
    connected: true,
    evmAddress,
    network: AUTH_NETWORK,
    walletName: "MetaMask",
    walletType: "injected",
  };
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [loading, setLoading] = useState(true);
  const [walletState, setWalletState] = useState<WalletState | null>(null);
  const [user, setUser] = useState<AuthenticatedUser | null>(null);
  const [authDialogOpen, setAuthDialogOpen] = useState(false);
  const [authStatus, setAuthStatus] = useState<AuthStatus>("idle");
  const [authError, setAuthError] = useState<string | null>(null);

  const refreshSession = useCallback(async () => {
    const payload = await fetchJson<SessionResponse>("/auth/session", { method: "GET" });
    const nextUser = payload.authenticated ? payload.user ?? null : null;
    setUser(nextUser);

    if (nextUser) {
      setWalletState({
        accountId: nextUser.accountId,
        connected: true,
        evmAddress: nextUser.evmAddress,
        network: AUTH_NETWORK,
        walletName: "MetaMask",
        walletType: "injected",
      });
    } else {
      setWalletState(null);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    const boot = async () => {
      try {
        await refreshSession();
      } catch (error) {
        if (!cancelled) {
          setAuthError(readErrorMessage(error));
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    void boot();

    return () => {
      cancelled = true;
    };
  }, [refreshSession]);

  const closeAuthDialog = useCallback(() => {
    setAuthDialogOpen(false);
    if (authStatus !== "verifying" && authStatus !== "awaiting_signature") {
      setAuthError(null);
      setAuthStatus("idle");
    }
  }, [authStatus]);

  const openAuthDialog = useCallback(() => {
    setAuthDialogOpen(true);
    setAuthError(null);
    setAuthStatus("idle");
  }, []);

  const signOut = useCallback(async () => {
    try {
      await fetchJson<void>("/auth/logout", { method: "POST" });
    } finally {
      setUser(null);
      setWalletState(null);
      setAuthDialogOpen(false);
      setAuthError(null);
      setAuthStatus("idle");
    }
  }, []);

  const signInWithMetaMask = useCallback(async () => {
    try {
      setAuthError(null);
      setAuthStatus("connecting");

      const nextWallet = await connectMetaMask();
      setWalletState(nextWallet);

      setAuthStatus("awaiting_signature");
      const challenge = await fetchJson<AuthChallenge>("/auth/nonce", {
        method: "POST",
        body: JSON.stringify({
          accountId: nextWallet.accountId,
          evmAddress: nextWallet.evmAddress,
        }),
      });

      const signedPayload = buildAuthSignedMessage({
        ...challenge,
        accountId: nextWallet.accountId!,
        evmAddress: nextWallet.evmAddress!,
        network: AUTH_NETWORK,
        walletSource: "metamask",
      });

      const provider = new BrowserProvider(getInjectedEip1193()!);
      const signer = await provider.getSigner();
      const signature = await signer.signMessage(signedPayload);

      setAuthStatus("verifying");
      const payload = await fetchJson<{ user: AuthenticatedUser }>("/auth/verify", {
        method: "POST",
        body: JSON.stringify({
          accountId: nextWallet.accountId,
          challengeId: challenge.challengeId,
          evmAddress: nextWallet.evmAddress,
          signature,
          signedPayload,
        }),
      });

      setUser(payload.user);
      setWalletState({
        accountId: payload.user.accountId,
        connected: true,
        evmAddress: payload.user.evmAddress,
        network: AUTH_NETWORK,
        walletName: "MetaMask",
        walletType: "injected",
      });
      setAuthDialogOpen(false);
      setAuthStatus("idle");
    } catch (error) {
      setAuthStatus("error");
      setAuthError(readErrorMessage(error));
      throw error;
    }
  }, []);

  const associateToken = useCallback<AuthSession["associateToken"]>(async () => {
    throw new Error("Native HTS association is not available in the MetaMask-only treasury flow.");
  }, []);

  const value = useMemo<AuthSession>(
    () => ({
      associateToken,
      authDialogOpen,
      authError,
      authStatus,
      authenticated: Boolean(user),
      closeAuthDialog,
      loading,
      openAuthDialog,
      refreshSession,
      signIn: signInWithMetaMask,
      signInWithMetaMask,
      signOut,
      user,
      wallet: toWalletConnection(walletState, user),
    }),
    [
      associateToken,
      authDialogOpen,
      authError,
      authStatus,
      closeAuthDialog,
      loading,
      openAuthDialog,
      refreshSession,
      signInWithMetaMask,
      signOut,
      user,
      walletState,
    ],
  );

  const dialogBusy = authStatus === "connecting" || authStatus === "awaiting_signature" || authStatus === "verifying";

  return (
    <AuthContext.Provider value={value}>
      {children}

      <Dialog
        open={authDialogOpen}
        onOpenChange={(open) => {
          if (open) {
            setAuthDialogOpen(true);
            return;
          }
          closeAuthDialog();
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-base">
              <Wallet className="h-4 w-4" />
              MetaMask Sign-In
            </DialogTitle>
            <DialogDescription>
              Connect a Hedera Testnet MetaMask account. If your MetaMask account is backed by Ledger, approvals stay Ledger-secured while using the same browser flow.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div className="rounded-md border border-border bg-muted/20 p-3 text-[11px] text-muted-foreground">
              <div className="flex items-center justify-between gap-3">
                <span className="font-mono uppercase tracking-widest">Wallet</span>
                <span className="font-medium text-foreground">{value.wallet.walletName ?? "Not connected"}</span>
              </div>
              <div className="mt-2 flex items-center justify-between gap-3">
                <span className="font-mono uppercase tracking-widest">Account</span>
                <span className="font-mono text-foreground">{value.wallet.accountId ?? "—"}</span>
              </div>
              <div className="mt-2 flex items-center justify-between gap-3">
                <span className="font-mono uppercase tracking-widest">EVM</span>
                <span className="font-mono text-foreground">{walletState?.evmAddress ?? user?.evmAddress ?? "—"}</span>
              </div>
              <div className="mt-2 flex items-center justify-between gap-3">
                <span className="font-mono uppercase tracking-widest">Network</span>
                <span className="font-medium uppercase text-foreground">{AUTH_NETWORK}</span>
              </div>
            </div>

            {authError && (
              <div className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-[11px] text-destructive">
                <div className="flex items-start gap-2">
                  <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>{authError}</span>
                </div>
              </div>
            )}

            {authStatus === "awaiting_signature" && (
              <div className="rounded-md border border-primary/20 bg-primary/5 p-3 text-[11px] text-muted-foreground">
                Approve the JudgeBuddy sign-in message in MetaMask to finish authentication.
              </div>
            )}

            {value.authenticated && value.user && (
              <div className="rounded-md border border-primary/20 bg-primary/5 p-3 text-[11px] text-muted-foreground">
                <div className="flex items-start gap-2">
                  <ShieldCheck className="mt-0.5 h-3.5 w-3.5 text-primary" />
                  <span>
                    Signed in as <span className="font-mono text-foreground">{value.user.accountId}</span>.
                  </span>
                </div>
              </div>
            )}
          </div>

          <DialogFooter className="flex-col gap-2 sm:flex-row sm:justify-end">
            <Button variant="ghost" onClick={closeAuthDialog}>
              Close
            </Button>
            <Button
              type="button"
              onClick={() => {
                // `signInWithMetaMask` rethrows so programmatic callers can react to a
                // failure; here the error is already rendered from `authError`, so the
                // rejection is absorbed instead of becoming an unhandled rejection.
                void signInWithMetaMask().catch(() => undefined);
              }}
              disabled={dialogBusy}
            >
              {dialogBusy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Wallet className="mr-2 h-4 w-4" />}
              {authStatus === "awaiting_signature"
                ? "Awaiting signature"
                : authStatus === "verifying"
                  ? "Verifying"
                  : "Sign in with MetaMask"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AuthContext.Provider>
  );
}
