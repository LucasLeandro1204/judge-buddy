import { Link, useLocation } from "react-router-dom";
import { useEffect } from "react";
import { Button } from "@/components/ui/button";

const NotFound = () => {
  const location = useLocation();

  useEffect(() => {
    console.error("404 Error: User attempted to access non-existent route:", location.pathname);
  }, [location.pathname]);

  return (
    <div className="mx-auto max-w-2xl">
      <div className="border border-border bg-card p-8">
        <p className="text-[10px] font-mono uppercase tracking-[0.3em] text-muted-foreground">404</p>
        <h1 className="mt-3 text-2xl font-black tracking-tight text-foreground sm:text-3xl">This page does not exist</h1>
        <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
          Nothing is routed at <span className="break-all font-mono text-foreground">{location.pathname}</span>. Use the
          navigation to reach the dashboard, a hackathon, or the operations console.
        </p>
        <div className="mt-6 flex flex-wrap gap-2">
          <Button asChild>
            <Link to="/">Back to dashboard</Link>
          </Button>
          <Button variant="outline" asChild>
            <Link to="/hackathon/agents">Open operations</Link>
          </Button>
        </div>
      </div>
    </div>
  );
};

export default NotFound;
