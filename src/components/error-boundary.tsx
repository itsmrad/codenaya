"use client";

import * as React from "react";
import * as Sentry from "@sentry/nextjs";
import { RotateCwIcon, TriangleAlertIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

interface FallbackProps {
  /** The caught error. */
  error: Error;
  /** Resets the boundary so the wrapped subtree can re-render. */
  reset: () => void;
  /** Human-friendly label for the section that crashed. */
  section?: string;
}

export interface ErrorBoundaryProps {
  children: React.ReactNode;
  /**
   * Human-friendly label for the section being protected (e.g. "File explorer").
   * Used in the default fallback message and attached to the Sentry report.
   */
  section?: string;
  /** Custom fallback renderer. Falls back to {@link DefaultErrorFallback}. */
  fallback?: (props: FallbackProps) => React.ReactNode;
  /** Optional callback invoked after the error is logged. */
  onError?: (error: Error, info: React.ErrorInfo) => void;
  /** Extra classes applied to the default fallback container. */
  className?: string;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * Generic React error boundary that catches render-time crashes in a subtree,
 * reports them to Sentry, and renders a friendly fallback with a retry button.
 *
 * React only supports error boundaries via class components, so this stays a class.
 */
export class ErrorBoundary extends React.Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    Sentry.captureException(error, {
      tags: { boundary: this.props.section ?? "unknown" },
      contexts: {
        react: {
          componentStack: info.componentStack,
        },
      },
    });

    this.props.onError?.(error, info);
  }

  reset = () => {
    this.setState({ error: null });
  };

  render() {
    const { error } = this.state;

    if (error) {
      const fallbackProps: FallbackProps = {
        error,
        reset: this.reset,
        section: this.props.section,
      };

      if (this.props.fallback) {
        return this.props.fallback(fallbackProps);
      }

      return (
        <DefaultErrorFallback {...fallbackProps} className={this.props.className} />
      );
    }

    return this.props.children;
  }
}

function DefaultErrorFallback({
  error,
  reset,
  section,
  className,
}: FallbackProps & { className?: string }) {
  return (
    <div
      role="alert"
      className={cn(
        "flex h-full w-full flex-col items-center justify-center gap-3 p-6 text-center",
        className
      )}
    >
      <div className="flex size-10 items-center justify-center rounded-full bg-destructive/10 text-destructive">
        <TriangleAlertIcon className="size-5" />
      </div>
      <div className="space-y-1">
        <p className="text-sm font-medium text-foreground">
          {section ? `${section} ran into a problem` : "Something went wrong"}
        </p>
        <p className="max-w-xs text-xs text-muted-foreground">
          This section failed to load. You can try again — the rest of the app
          keeps working.
        </p>
      </div>
      {process.env.NODE_ENV === "development" && error.message && (
        <pre className="max-w-xs overflow-auto rounded-md bg-muted px-2 py-1.5 text-left text-[11px] text-muted-foreground">
          {error.message}
        </pre>
      )}
      <Button size="sm" variant="outline" onClick={reset}>
        <RotateCwIcon className="size-3.5" />
        Try again
      </Button>
    </div>
  );
}
