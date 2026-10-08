"use client";

import React from "react";

import { Id } from "../../../../convex/_generated/dataModel";
import { IntegrationsDialog } from "./integrations-dialog";

interface ProjectIntegrationsContextValue {
  openIntegrations: () => void;
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
  const [open, setOpen] = React.useState(false);
  const value = React.useMemo(
    () => ({ openIntegrations: () => setOpen(true) }),
    [],
  );

  return (
    <ProjectIntegrationsContext.Provider value={value}>
      <IntegrationsDialog
        projectId={projectId}
        open={open}
        onOpenChange={setOpen}
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
