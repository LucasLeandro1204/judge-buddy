import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  ArrowLeft,
  ClipboardCheck,
  LayoutGrid,
  Loader2,
  LogOut,
  Menu,
  PlusCircle,
  Send,
  ShieldCheck,
  Wallet,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { useAuth } from "@/auth/useAuth";
import { fetchHealth } from "@/hackathon/api";
import { setPayoutTokenDisplay, shorten } from "@/hackathon/format";

const navItems = [
  { path: "/", label: "Dashboard", icon: LayoutGrid },
  { path: "/hackathon/live", label: "Hackathon Detail", icon: ClipboardCheck },
  { path: "/hackathon/create", label: "Create Hackathon", icon: PlusCircle },
  { path: "/hackathon/submit", label: "Submit Project", icon: Send },
  { path: "/hackathon/submissions", label: "Submissions", icon: LayoutGrid },
  { path: "/hackathon/agents", label: "Operations", icon: Activity },
] as const;

function Brand() {
  return (
    <div className="flex items-center gap-3">
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-sm bg-accent text-accent-foreground">
        <ShieldCheck className="h-4 w-4" />
      </div>
      <div className="min-w-0">
        <div className="truncate text-sm font-black tracking-tight text-foreground">JudgeBuddy Treasury</div>
        <div className="truncate text-[10px] font-mono uppercase tracking-widest text-muted-foreground">
          Hedera + Ledger + Agents
        </div>
      </div>
    </div>
  );
}

function SidebarBody({ onNavigate }: { onNavigate?: () => void }) {
  const location = useLocation();
  const { authStatus, authenticated, openAuthDialog, signOut, user } = useAuth();
  const busy = authStatus === "connecting" || authStatus === "awaiting_signature" || authStatus === "verifying";
  const health = useQuery({
    queryKey: ["health"],
    queryFn: fetchHealth,
    retry: false,
  });

  // The deployment names the payout token; recording it during render (before any page
  // formats an amount in this pass) is what keeps a stale bundle from inventing a symbol.
  if (health.data?.chain) {
    setPayoutTokenDisplay(health.data.chain.payoutTokenSymbol, health.data.chain.payoutTokenDecimals);
  }

  return (
    <>
      <nav className="flex-1 space-y-1 px-3 py-4">
        {navItems.map((item) => {
          const isActive =
            item.path === "/"
              ? location.pathname === "/"
              : location.pathname === item.path || location.pathname.startsWith(`${item.path}/`);
          return (
            <Link
              key={item.path}
              to={item.path}
              onClick={onNavigate}
              className={cn(
                "flex items-center gap-3 rounded-sm px-3 py-2 text-xs font-medium transition-colors",
                isActive
                  ? "bg-accent/10 text-accent"
                  : "text-sidebar-foreground hover:bg-sidebar-accent hover:text-foreground",
              )}
            >
              <item.icon className="h-3.5 w-3.5" />
              {item.label}
            </Link>
          );
        })}
      </nav>

      <div className="space-y-3 border-t border-sidebar-border p-4">
        <div className="rounded-md border border-sidebar-border bg-background/40 p-3 text-[11px]">
          <div className="flex items-center justify-between gap-3">
            <span className="font-mono uppercase tracking-widest text-muted-foreground">API</span>
            {health.isLoading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
            ) : health.data?.ok ? (
              <span className="font-mono text-primary">online</span>
            ) : (
              <span className="font-mono text-destructive">offline</span>
            )}
          </div>
          <div className="mt-2 flex items-center justify-between gap-3">
            <span className="font-mono uppercase tracking-widest text-muted-foreground">Treasury</span>
            <span className={cn("font-mono", health.data?.treasuryContractConfigured ? "text-primary" : "text-muted-foreground")}>
              {health.data?.treasuryContractConfigured ? "configured" : "missing"}
            </span>
          </div>
          <div className="mt-2 flex items-center justify-between gap-3">
            <span className="font-mono uppercase tracking-widest text-muted-foreground">Claim token</span>
            <span className={cn("font-mono", health.data?.prizeClaimTokenConfigured ? "text-primary" : "text-muted-foreground")}>
              {health.data?.prizeClaimTokenConfigured ? "configured" : "missing"}
            </span>
          </div>
        </div>

        {authenticated && user ? (
          <div className="rounded-md border border-sidebar-border bg-background/40 p-3 text-[11px]">
            <div className="flex items-center justify-between gap-3">
              <span className="font-mono uppercase tracking-widest text-muted-foreground">Signed in</span>
              <span className="rounded-full border border-primary/20 bg-primary/10 px-2 py-0.5 font-mono uppercase tracking-wider text-primary">
                {user.network}
              </span>
            </div>
            <p className="mt-2 break-all font-mono text-foreground">{user.accountId}</p>
            <p className="mt-1 break-all font-mono text-muted-foreground">{shorten(user.evmAddress, 10, 6)}</p>
            <Button variant="ghost" size="sm" className="mt-3 h-8 w-full text-[11px]" onClick={() => void signOut()}>
              <LogOut className="mr-1.5 h-3.5 w-3.5" />
              Sign out
            </Button>
          </div>
        ) : (
          <div className="rounded-md border border-sidebar-border bg-background/40 p-3 text-[11px]">
            <p className="font-mono uppercase tracking-widest text-muted-foreground">Identity</p>
            <p className="mt-2 text-muted-foreground">
              Sign in with MetaMask to create hackathons, confirm treasury funding, approve awards, and redeem claims.
            </p>
            <Button size="sm" className="mt-3 h-8 w-full text-[11px]" onClick={openAuthDialog} disabled={busy}>
              {busy ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Wallet className="mr-1.5 h-3.5 w-3.5" />}
              {busy ? "Authenticating" : "Sign in"}
            </Button>
          </div>
        )}

        <Link
          to="/hackathon"
          onClick={onNavigate}
          className="flex items-center gap-2 px-1 text-[10px] font-mono uppercase tracking-widest text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="h-3 w-3" />
          Treasury Home
        </Link>
      </div>
    </>
  );
}

export function HackathonLayout({ children }: { children: React.ReactNode }) {
  const location = useLocation();
  const [drawerOpen, setDrawerOpen] = useState(false);

  // Subscribe the layout itself to the (deduplicated) health query so the pages under it
  // re-render once the payout token identity arrives — the sidebar's own subscription
  // only re-renders the sidebar.
  const health = useQuery({ queryKey: ["health"], queryFn: fetchHealth, retry: false });
  if (health.data?.chain) {
    setPayoutTokenDisplay(health.data.chain.payoutTokenSymbol, health.data.chain.payoutTokenDecimals);
  }

  // A route change from inside the drawer should close it.
  useEffect(() => {
    setDrawerOpen(false);
  }, [location.pathname, location.search]);

  return (
    <div className="min-h-screen bg-background">
      {/* Mobile / tablet: top bar with a nav drawer. */}
      <header className="sticky top-0 z-40 flex h-16 items-center justify-between gap-3 border-b border-border bg-sidebar-background px-4 lg:hidden">
        <Link to="/" className="min-w-0">
          <Brand />
        </Link>
        <Sheet open={drawerOpen} onOpenChange={setDrawerOpen}>
          <SheetTrigger asChild>
            <Button variant="ghost" size="icon" aria-label="Open navigation">
              <Menu className="h-5 w-5" />
            </Button>
          </SheetTrigger>
          <SheetContent
            side="left"
            aria-describedby={undefined}
            className="flex w-[17rem] max-w-[85vw] flex-col gap-0 border-r border-border bg-sidebar-background p-0"
          >
            <div className="flex h-16 items-center gap-3 border-b border-sidebar-border px-5 pr-12">
              <SheetTitle asChild>
                <div>
                  <Brand />
                </div>
              </SheetTitle>
            </div>
            <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
              <SidebarBody onNavigate={() => setDrawerOpen(false)} />
            </div>
          </SheetContent>
        </Sheet>
      </header>

      {/* Desktop: fixed sidebar. */}
      <aside className="fixed left-0 top-0 z-40 hidden h-screen w-64 flex-col border-r border-border bg-sidebar-background lg:flex">
        <div className="flex h-16 items-center gap-3 border-b border-sidebar-border px-5">
          <Brand />
        </div>
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          <SidebarBody />
        </div>
      </aside>

      <main className="min-w-0 p-4 sm:p-6 lg:ml-64 lg:min-h-screen lg:p-8">{children}</main>
    </div>
  );
}
