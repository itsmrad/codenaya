"use client";

import { FaGithub } from "react-icons/fa";
import { Check, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { NavRow } from "../nav-row";

interface GithubStepProps {
  connected: boolean;
  username?: string | null;
  avatarUrl?: string | null;
  onLink: () => Promise<void>;
  onUnlink: () => Promise<void>;
  loading?: boolean;
  onNext: () => void;
  onBack: () => void;
}

export function GithubStep({
  connected,
  username,
  avatarUrl,
  onLink,
  onUnlink,
  loading = false,
  onNext,
  onBack,
}: GithubStepProps) {
  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-1 flex-col gap-7">
        <h1 className="text-4xl font-bold text-foreground">
          Connect a repository
        </h1>
        <p className="max-w-[420px] text-[15px] text-muted-foreground">
          Link GitHub to import an existing repo, or export projects you
          build here. This is separate from how you signed in.
        </p>

        <div className="flex max-w-[544px] items-center justify-between gap-4 rounded-xl border border-border/60 bg-card/40 p-4 transition-colors">
          <div className="flex items-center gap-3.5">
            <div className="relative flex size-10 shrink-0 items-center justify-center rounded-lg border border-border/60 bg-muted/60">
              {avatarUrl ? (
                <img
                  src={avatarUrl}
                  alt={username ? `@${username}` : "GitHub Avatar"}
                  className="size-full rounded-lg object-cover"
                />
              ) : (
                <FaGithub className="size-5 text-foreground" />
              )}
              {connected && (
                <span
                  className="absolute -bottom-1 -right-1 flex size-4 items-center justify-center rounded-full bg-emerald-500 text-white ring-2 ring-background"
                  title="Verified GitHub connection"
                >
                  <Check className="size-2.5 stroke-[3]" />
                </span>
              )}
            </div>

            <div className="flex flex-col gap-0.5">
              <div className="flex items-center gap-2">
                <p className="text-sm font-semibold text-foreground">GitHub</p>
                {connected && (
                  <Badge
                    variant="outline"
                    className="border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0 text-[10px] font-medium text-emerald-400"
                  >
                    Connected
                  </Badge>
                )}
              </div>
              <p className="font-mono text-xs text-muted-foreground">
                {connected
                  ? username
                    ? `Linked as @${username}`
                    : "Repository access linked"
                  : "Not linked"}
              </p>
            </div>
          </div>

          <div>
            {connected ? (
              <button
                type="button"
                onClick={onUnlink}
                disabled={loading}
                className="font-mono text-xs text-muted-foreground hover:text-destructive transition-colors disabled:opacity-50"
              >
                {loading ? "Unlinking…" : "Unlink"}
              </button>
            ) : (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={onLink}
                disabled={loading}
                className="font-mono text-xs border-brand/40 text-brand hover:bg-brand/10 hover:text-brand"
              >
                {loading ? (
                  <>
                    <Loader2 className="mr-1.5 size-3.5 animate-spin" />
                    Connecting…
                  </>
                ) : (
                  "Link GitHub"
                )}
              </Button>
            )}
          </div>
        </div>

        <p className="text-xs text-muted-foreground">
          You can link or change this later from Settings.
        </p>
      </div>

      <NavRow onBack={onBack}>
        <Button
          className="bg-brand text-brand-foreground hover:bg-brand/90"
          onClick={onNext}
        >
          {connected ? "Continue" : "Continue without GitHub"}
        </Button>
      </NavRow>
    </div>
  );
}
