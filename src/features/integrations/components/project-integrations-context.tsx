"use client";

import React from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

import { Id } from "../../../../convex/_generated/dataModel";
import { linkedProviderId, PROJECT_INTEGRATIONS_PARAM } from "../links";
import { IntegrationsDialog } from "./integrations-dialog";

interface ProjectIntegrationsContextValue {
  /** Opens the dialog, on that provider when one is given. */
  openIntegrations: (providerId?: string) => void;
}

const ProjectIntegrationsContext =
  React.createContext<ProjectIntegrationsContextValue | null>(null);

export const ProjectIntegrationsProvider = ({
  children,
  projectId,
}: {
  children: React.ReactNode;
  projectId: Id<"projects">;
}) => {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  // `?integrations=<providerId>` (see integrationLink) opens the dialog too.
  const linked = searchParams.get(PROJECT_INTEGRATIONS_PARAM);
  const [requested, setRequested] = React.useState<{ providerId?: string } | null>(null);
  const value = React.useMemo(
    () => ({ openIntegrations: (providerId?: string) => setRequested({ providerId }) }),
    [],
  );

  const onOpenChange = (open: boolean) => {
    if (open) return;
    setRequested(null);
    if (linked === null) return;
    // Drop the param so closing sticks and a reload doesn't reopen it.
    const params = new URLSearchParams(searchParams);
    params.delete(PROJECT_INTEGRATIONS_PARAM);
    const query = params.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  };

  return (
    <ProjectIntegrationsContext.Provider value={value}>
      <IntegrationsDialog
        projectId={projectId}
        open={requested !== null || linked !== null}
        onOpenChange={onOpenChange}
        initialProviderId={requested ? linkedProviderId(requested.providerId) : linkedProviderId(linked)}
      />
      {children}
    </ProjectIntegrationsContext.Provider>
  );
};

export const useProjectIntegrations = (): ProjectIntegrationsContextValue => {
  const context = React.useContext(ProjectIntegrationsContext);
  if (!context) {
    throw new Error(
      "useProjectIntegrations must be used inside ProjectIntegrationsProvider",
    );
  }
  return context;
};
