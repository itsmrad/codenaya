import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { fetchQuery } from "convex/nextjs";
import { SharedProjectView } from "@/features/share/components/shared-project-view";
import { validShareToken } from "@/features/share/preview-policy";
import { api } from "../../../../convex/_generated/api";

export const metadata: Metadata = { title: "Site preview · Codenaya", robots: { index: false, follow: false }, referrer: "no-referrer" };
const Content = async ({ params }: { params: Promise<{ token: string }> }) => {
  const { token } = await params;
  if (!validShareToken(token)) notFound();
  const project = await fetchQuery(api.projects.getShared, { token });
  if (!project) notFound();
  return <SharedProjectView token={token} initial={project} />;
};
export default function PreviewPage(props: { params: Promise<{ token: string }> }) {
  return <Suspense fallback={<main className="h-dvh grid place-items-center">Starting the site… ~30-60 s on first visit</main>}><Content {...props} /></Suspense>;
}
