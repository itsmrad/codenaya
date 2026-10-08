import Link from "next/link";

import { AppNavbar } from "@/components/app-navbar";
import { GridPattern } from "@/components/landing/grid-pattern";
import { Button } from "@/components/ui/button";

type NotFoundViewProps = {
  title: string;
  description: string;
};

export const NotFoundView = ({ title, description }: NotFoundViewProps) => {
  return (
    <div className="min-h-screen flex flex-col bg-background">
      <AppNavbar />
      <main className="relative flex-1 flex items-center justify-center overflow-hidden px-6 py-16">
        <GridPattern />
        <div className="relative z-10 max-w-md text-center flex flex-col items-center gap-5">
          <span className="text-[11px] uppercase tracking-[0.2em] text-muted-foreground/60 font-mono">
            Error 404
          </span>
          <h1 className="text-4xl md:text-5xl font-bold tracking-tighter text-foreground">
            {title}
          </h1>
          <p className="text-base md:text-lg text-muted-foreground leading-relaxed font-light">
            {description}
          </p>
          <Button
            asChild
            className="mt-2 h-11 px-7 font-medium bg-brand text-brand-foreground hover:bg-brand/90 rounded-full"
          >
            <Link href="/">Back to home</Link>
          </Button>
        </div>
      </main>
    </div>
  );
};
