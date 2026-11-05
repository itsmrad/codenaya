import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { cache, Suspense } from "react";
import { ArrowLeftIcon } from "lucide-react";
import { fetchQuery } from "convex/nextjs";

import { PublicShell } from "@/components/landing/public-shell";
import { Spinner } from "@/components/ui/spinner";
import { ShowcaseDetail } from "@/features/showcase/components/showcase-detail";

import { api } from "../../../../convex/_generated/api";
import { Id } from "../../../../convex/_generated/dataModel";

type ShowcaseIdPageProps = {
  params: Promise<{ id: string }>;
};

/** One public showcase project, shared by the metadata and the page render. */
const getShowcaseProject = cache(async (id: string) => {
  try {
    return await fetchQuery(api.showcase.getById, {
      id: id as Id<"showcaseProjects">,
    });
  } catch {
    // A malformed id fails Convex argument validation: treat it as not found.
    return null;
  }
});

export const generateMetadata = async ({
  params,
}: ShowcaseIdPageProps): Promise<Metadata> => {
  const { id } = await params;
  const project = await getShowcaseProject(id);
  if (!project) return { title: "Showcase project not found — Codenaya" };

  const title = `${project.title} — Codenaya showcase`;
  const description =
    project.description || `An app by ${project.ownerName}, built with Codenaya.`;
  // Without a screenshot, fall back to the site-wide card from the root layout.
  const images = project.previewUrl
    ? [{ url: project.previewUrl, alt: project.title }]
    : [{ url: "/og.png", width: 1200, height: 630, alt: "Codenaya" }];

  return {
    title,
    description,
    openGraph: { type: "website", siteName: "Codenaya", url: `/showcase/${id}`, title, description, images },
    twitter: { card: "summary_large_image", title, description, images },
  };
};

const ShowcaseIdContent = async ({ params }: ShowcaseIdPageProps) => {
  const { id } = await params;
  const project = await getShowcaseProject(id);
  if (!project) notFound();

  return (
    <article className="overflow-hidden rounded-xl border border-border/50 bg-card">
      <ShowcaseDetail project={project} />
    </article>
  );
};

// Public: readable signed out so a published app can be shared by link.
const ShowcaseIdPage = (props: ShowcaseIdPageProps) => {
  return (
    <PublicShell>
      <Link
        href="/showcase"
        className="flex h-11 items-center gap-2 border-b border-border px-6 font-mono text-[11px] uppercase tracking-[0.16em] text-muted-foreground transition-colors hover:text-foreground md:px-8"
      >
        <ArrowLeftIcon className="size-3.5" />
        Community showcase
      </Link>
      <div className="border-b border-border px-4 py-10 md:px-8 md:py-14">
        <div className="mx-auto w-full max-w-3xl">
          <Suspense
            fallback={
              <div className="flex justify-center py-24">
                <Spinner className="size-6 text-ring" />
              </div>
            }
          >
            <ShowcaseIdContent {...props} />
          </Suspense>
        </div>
      </div>
    </PublicShell>
  );
};

export default ShowcaseIdPage;
