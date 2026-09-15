import { Button } from "@/components/ui/button";
import { NavRow } from "../nav-row";

export function GithubStep({
  connected,
  onToggle,
  onNext,
  onBack,
}: {
  connected: boolean;
  onToggle: () => void;
  onNext: () => void;
  onBack: () => void;
}) {
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

        <div className="flex max-w-[544px] items-center gap-4 border-b border-border py-4">
          <span aria-hidden className="size-4 shrink-0 rounded bg-brand/20" />
          <div className="flex flex-1 flex-col gap-1">
            <p className="text-base font-semibold text-foreground">GitHub</p>
            <p className="text-[13px] text-muted-foreground">
              {connected ? "Repository access linked" : "Not linked"}
            </p>
          </div>
          <button
            type="button"
            onClick={onToggle}
            className="font-mono text-xs text-brand"
          >
            {connected ? "Unlink" : "Link GitHub"}
          </button>
        </div>

        <p className="text-xs text-muted-foreground">
          You can link this later from Settings.
        </p>
      </div>

      <NavRow onBack={onBack}>
        <Button
          className="bg-brand text-brand-foreground hover:bg-brand/90"
          onClick={onNext}
        >
          Continue
        </Button>
      </NavRow>
    </div>
  );
}
