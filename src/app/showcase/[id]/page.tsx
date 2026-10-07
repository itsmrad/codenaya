import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { cache, Suspense } from "react";
import { ArrowLeftIcon } from "lucide-react";
import { fetchQuery } from "convex/nextjs";

import { AppNavbar } from "@/components/app-navbar";
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
    <div className="min-h-screen flex flex-col bg-background">
      <AppNavbar />
      <main className="mx-auto w-full max-w-3xl px-4 py-8 md:px-8 md:py-12">
        <Link
          href="/showcase"
          className="mb-4 inline-flex items-center gap-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeftIcon className="size-3.5" />
          Community showcase
        </Link>
        <Suspense
          fallback={
            <div className="flex justify-center py-24">
              <Spinner className="size-6 text-ring" />
            </div>
          }
        >
          <ShowcaseIdContent {...props} />
        </Suspense>
      </main>
    </div>
  );
};

export default ShowcaseIdPage;
