import { AlertTriangle, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

function readErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message.trim();
  if (typeof error === "string" && error.trim()) return error.trim();
  return "The request failed without an error message.";
}

/**
 * Distinct "the backend is unreachable" state. Never collapse a failed query into an
 * empty state — a reviewer must be able to tell a broken API from a genuinely empty list.
 */
export function QueryErrorState({
  title = "Backend unreachable",
  description = "JudgeBuddy could not reach its API, so this section has no data to show. This is a connection failure, not an empty result.",
  error,
  onRetry,
  isRetrying = false,
  className,
}: {
  title?: string;
  description?: string;
  error: unknown;
  onRetry?: () => void;
  isRetrying?: boolean;
  className?: string;
}) {
  return (
    <div
      role="alert"
      className={cn("border border-destructive/30 bg-destructive/5 p-6", className)}
    >
      <div className="flex items-start gap-3">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-bold text-destructive">{title}</h3>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">{description}</p>
          <p className="mt-3 break-words rounded-md border border-border bg-background/60 p-3 font-mono text-[11px] leading-5 text-muted-foreground">
            {readErrorMessage(error)}
          </p>
          {onRetry ? (
            <Button variant="outline" size="sm" className="mt-4" onClick={onRetry} disabled={isRetrying}>
              <RefreshCw className={cn("mr-2 h-3.5 w-3.5", isRetrying && "animate-spin")} />
              {isRetrying ? "Retrying" : "Retry"}
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/** Neutral "nothing here yet" state, for use only when a query genuinely succeeded. */
export function EmptyState({
  title,
  description,
  className,
}: {
  title: string;
  description?: string;
  className?: string;
}) {
  return (
    <div className={cn("border border-border bg-card p-6", className)}>
      <p className="text-sm font-medium text-foreground">{title}</p>
      {description ? <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{description}</p> : null}
    </div>
  );
}
