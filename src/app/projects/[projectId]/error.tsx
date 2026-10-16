"use client";

import * as Sentry from "@sentry/nextjs";
import { useEffect } from "react";

import { NotFoundView } from "@/components/not-found-view";
import { Button } from "@/components/ui/button";

// Convex project queries throw when the id is malformed, missing, or owned by
// someone else. Show a friendly not-found state for ownership/not-found errors,
// and a recoverable retry state for any other runtime error.
export default function ProjectError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset?: () => void;
}) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  const message = error?.message?.toLowerCase() ?? "";
  const isNotFoundOrUnauthorized =
    message.includes("not found") ||
    message.includes("unauthorized") ||
    message.includes("does not exist");

  if (isNotFoundOrUnauthorized) {
    return (
      <NotFoundView
        title="Project not found"
        description="This project doesn't exist, or you don't have access to it."
      />
    );
  }

  return (
    <div className="flex h-screen w-full flex-col items-center justify-center gap-4 bg-background px-4 text-center">
      <div className="space-y-2">
        <h2 className="text-xl font-semibold text-foreground">Something went wrong</h2>
        <p className="max-w-md text-sm text-muted-foreground">
          {error.message || "An unexpected error occurred while loading this workspace."}
        </p>
      </div>
      {reset && (
        <Button onClick={() => reset()} variant="default" size="sm">
          Try again
        </Button>
      )}
    </div>
  );
}
