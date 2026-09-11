"use client";

import * as React from "react";

/**
 * Dev-only helper for verifying error boundaries.
 *
 * Renders nothing in production. In development it shows a tiny button that,
 * when clicked, throws during render on the next tick so the nearest
 * {@link import("@/components/error-boundary").ErrorBoundary} catches it and
 * shows its fallback.
 *
 * Usage:
 *   <ErrorBoundary section="File explorer">
 *     <ErrorThrower label="explorer" />
 *     <FileExplorer ... />
 *   </ErrorBoundary>
 */
export function ErrorThrower({ label }: { label?: string }) {
  const [shouldThrow, setShouldThrow] = React.useState(false);

  if (process.env.NODE_ENV !== "development") {
    return null;
  }

  if (shouldThrow) {
    throw new Error(
      `Deliberate test error${label ? ` from "${label}"` : ""} (ErrorThrower)`
    );
  }

  return (
    <button
      type="button"
      onClick={() => setShouldThrow(true)}
      title="Dev only: throw a test error to verify the error boundary"
      className="absolute right-1 top-1 z-50 rounded bg-destructive/80 px-1.5 py-0.5 text-[10px] font-medium text-white opacity-40 transition-opacity hover:opacity-100"
    >
      💥 throw
    </button>
  );
}
