import { Button } from "@/components/ui/button";
import { NavRow } from "../nav-row";

export function WelcomeStep({ onNext }: { onNext: () => void }) {
  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-1 flex-col gap-7">
        <h1 className="text-[40px] font-bold leading-[1.12] text-foreground">
          Welcome to Codenaya
        </h1>
        <p className="max-w-[420px] text-[15px] leading-relaxed text-muted-foreground">
          Your AI-powered, browser-based IDE. Here&apos;s what you&apos;ll set
          up, then let&apos;s get you in.
        </p>
      </div>
      <NavRow>
        <Button
          className="bg-brand text-brand-foreground hover:bg-brand/90"
          onClick={onNext}
        >
          Get Started
        </Button>
      </NavRow>
    </div>
  );
}
