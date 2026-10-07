"use client";

import { Allotment } from "allotment";

import { useIsCompact } from "@/hooks/use-mobile";
import { ConversationSidebar } from "@/features/conversations/components/conversation-sidebar";
import { ProjectIntegrationsProvider } from "@/features/integrations/components/project-integrations-context";

import { Id } from "../../../../convex/_generated/dataModel";

const MIN_SIDEBAR_WIDTH = 200;
const MAX_SIDEBAR_WIDTH = 800;
const DEFAULT_CONVERSATION_SIDEBAR_WIDTH = 400;
const DEFAULT_MAIN_SIZE = 1000;

export const ProjectIdLayout = ({
  children,
  projectId,
}: {
  children: React.ReactNode;
  projectId: Id<"projects">;
}) => {
  // Phones and tablets get a tabbed layout instead: ProjectIdView renders the
  // chat as one of its full-size tabs, so the side-by-side panes are skipped.
  const isCompact = useIsCompact();

  return (
    <ProjectIntegrationsProvider projectId={projectId}>
      <div className="w-full h-dvh flex flex-col bg-background">
        <div className="flex-1 p-2 min-h-0 flex overflow-hidden">
        {isCompact ? (
          <div className="flex-1 min-w-0 flex flex-col relative">{children}</div>
        ) : (
        <Allotment
          className="flex-1"
          defaultSizes={[
            DEFAULT_CONVERSATION_SIDEBAR_WIDTH,
            DEFAULT_MAIN_SIZE,
          ]}
        >
          <Allotment.Pane
            snap
            minSize={MIN_SIDEBAR_WIDTH}
            maxSize={MAX_SIDEBAR_WIDTH}
            preferredSize={DEFAULT_CONVERSATION_SIDEBAR_WIDTH}
          >
            <div className="h-full pr-1 box-border">
              <div className="h-full rounded-xl bg-card border border-border/60 shadow-[0_1px_3px_rgba(0,0,0,0.12),0_0_0_1px_rgba(0,0,0,0.04)] dark:shadow-[0_1px_3px_rgba(0,0,0,0.4),0_0_0_1px_rgba(255,255,255,0.03)] flex flex-col overflow-hidden relative">
                <ConversationSidebar projectId={projectId} />
              </div>
            </div>
          </Allotment.Pane>
          <Allotment.Pane>
            <div className="h-full pl-1 box-border flex flex-col relative overflow-hidden">
              {children}
            </div>
          </Allotment.Pane>
        </Allotment>
        )}
        </div>
      </div>
    </ProjectIntegrationsProvider>
  );
};
