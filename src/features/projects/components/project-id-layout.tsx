"use client";

import { useEffect } from "react";
import { Allotment } from "allotment";

import { useIsCompact } from "@/hooks/use-mobile";
import { cn } from "@/lib/utils";
import { useProjectCommands } from "@/lib/command-palette";
import { ConversationSidebar } from "@/features/conversations/components/conversation-sidebar";
import { ProjectIntegrationsProvider } from "@/features/integrations/components/project-integrations-context";

import { useChatPanelStore } from "../store/use-chat-panel-store";

import { Id } from "../../../../convex/_generated/dataModel";

// Narrower than this the chat is unusable, so the pane snaps shut (at half this
// width, Allotment's snap rule) and the toolbar's "Show chat panel" reopens it.
const MIN_SIDEBAR_WIDTH = 320;
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
  const { isHidden: isChatHidden, setHidden: setChatHidden } = useChatPanelStore();
  useProjectCommands({
    "toggle-chat": isCompact ? null : () => setChatHidden(!useChatPanelStore.getState().isHidden),
  });
  // Every project opens with the chat showing.
  useEffect(() => () => setChatHidden(false), [setChatHidden]);

  return (
    <ProjectIntegrationsProvider projectId={projectId}>
      <div className="w-full h-dvh flex flex-col bg-background">
        <div className="flex-1 p-2 min-h-0 flex overflow-hidden">
        {/* One tree at every width: swapping it for a plain div below the compact
            breakpoint remounted the project view, and its preview booted a new sandbox (#777). */}
        <Allotment
          className="flex-1"
          defaultSizes={[
            DEFAULT_CONVERSATION_SIDEBAR_WIDTH,
            DEFAULT_MAIN_SIZE,
          ]}
          // Dragging the chat shut hides it like "Toggle chat panel" does.
          onVisibleChange={(index, visible) => {
            if (index === 0) setChatHidden(!visible);
          }}
        >
          <Allotment.Pane
            snap
            visible={!isCompact && !isChatHidden}
            minSize={MIN_SIDEBAR_WIDTH}
            maxSize={MAX_SIDEBAR_WIDTH}
            preferredSize={DEFAULT_CONVERSATION_SIDEBAR_WIDTH}
          >
            <div className="h-full pr-1 box-border">
              <div className="h-full rounded-xl bg-card border border-border/60 shadow-[0_1px_3px_rgba(0,0,0,0.12),0_0_0_1px_rgba(0,0,0,0.04)] dark:shadow-[0_1px_3px_rgba(0,0,0,0.4),0_0_0_1px_rgba(255,255,255,0.03)] flex flex-col overflow-hidden relative">
                {/* Compact widths show the chat as a tab inside ProjectIdView instead. */}
                {!isCompact && <ConversationSidebar projectId={projectId} />}
              </div>
            </div>
          </Allotment.Pane>
          <Allotment.Pane>
            <div className={cn("h-full box-border flex flex-col relative overflow-hidden", !isCompact && "pl-1")}>
              {children}
            </div>
          </Allotment.Pane>
        </Allotment>
        </div>
      </div>
    </ProjectIntegrationsProvider>
  );
};
