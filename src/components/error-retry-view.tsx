import Link from "next/link";

import { Button } from "@/components/ui/button";

interface ErrorRetryViewProps {
  /** Re-fetches and re-renders the failed route (Next's `retry`). */
  retry: () => void;
  description: string;
}

/** A route's error fallback: what happened, Try again, and a way out to the dashboard. */
export const ErrorRetryView = ({ retry, description }: ErrorRetryViewProps) => (
  <div className="flex h-screen w-full flex-col items-center justify-center gap-4 bg-background px-4 text-center">
    <div className="space-y-2">
      <h1 className="text-xl font-semibold text-foreground">Something went wrong</h1>
      <p className="max-w-md text-sm text-muted-foreground">{description}</p>
    </div>
    <div className="flex items-center gap-2">
      <Button onClick={() => retry()} size="sm">
        Try again
      </Button>
      <Button asChild size="sm" variant="outline">
        <Link href="/">Back to home</Link>
      </Button>
    </div>
  </div>
);
