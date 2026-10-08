"use client";

import * as Sentry from "@sentry/nextjs";
import { useEffect } from "react";

import { NotFoundView } from "@/components/not-found-view";

// Convex project queries throw when the id is malformed, missing, or owned by
// someone else. Show a friendly state instead of crashing the whole app.
export default function ProjectError({
  error,
}: {
  error: Error & { digest?: string };
}) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <NotFoundView
      title="Project not found"
      description="This project doesn't exist, or you don't have access to it."
    />
  );
}
