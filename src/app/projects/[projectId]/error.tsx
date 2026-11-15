"use client";

import * as Sentry from "@sentry/nextjs";
import { useEffect } from "react";

import { ErrorRetryView } from "@/components/error-retry-view";
import { NotFoundView } from "@/components/not-found-view";
import { getAppError } from "@/lib/convex-error";

/**
 * Missing, foreign or malformed project ids. Project and conversation queries
 * throw typed codes, which survive production's error redaction; the message
 * fallback covers malformed URL ids (`v.id("projects")`) in dev.
 */
const isProjectGone = (error: Error) => {
  const code = getAppError(error)?.code;
  return code
    ? code === "NOT_FOUND" || code === "FORBIDDEN"
    : /v\.id\("projects"\)/.test(error.message);
};

// Only a missing or foreign project is "not found"; anything else gets a
// retry, so one failing query doesn't look like a deleted project (#266).
export default function ProjectError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  if (isProjectGone(error)) {
    return (
      <NotFoundView
        title="Project not found"
        description="This project doesn't exist, or you don't have access to it."
      />
    );
  }

  return (
    <ErrorRetryView
      retry={retry}
      description="This workspace hit an unexpected error. Try again, or reload the page."
    />
  );
}
