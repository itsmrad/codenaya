"use client";

import * as Sentry from "@sentry/nextjs";
import { useEffect } from "react";

import { ErrorRetryView } from "@/components/error-retry-view";

// Any route without its own boundary. Without this, an error fell through to
// `global-error`, which replaces the whole page with Next's unstyled default.
export default function RootError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <ErrorRetryView
      retry={retry}
      description="This page hit an unexpected error. Try again, or head back home."
    />
  );
}
