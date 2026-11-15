"use client";

import * as Sentry from "@sentry/nextjs";
import { useEffect } from "react";

import { ErrorRetryView } from "@/components/error-retry-view";

// A failing settings query lands here, inside the layout, so the settings nav
// stays; without it the error fell through to the root boundary and lost the nav.
export default function SettingsError({
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
      className="h-auto py-16"
      retry={retry}
      description="Couldn't load this settings page. Your settings are unchanged. Try again, or pick another section."
    />
  );
}
