"use client";

import { Allotment } from "allotment";

import { ConversationSidebar } from "@/features/conversations/components/conversation-sidebar";

import { Navbar } from "./navbar";
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
  return (
    <div className="w-full h-screen flex flex-col bg-muted/20">
      <div className="shrink-0 bg-background border-b border-border/40 z-10">
        <Navbar projectId={projectId} />
      </div>
      <div className="flex-1 p-3 min-h-0 flex overflow-hidden">
        <Allotment
          className="flex-1"
          defaultSizes={[
            DEFAULT_CONVERSATION_SIDEBAR_WIDTH,
            DEFAULT_MAIN_SIZE
          ]}
        >
          <Allotment.Pane
            snap
            minSize={MIN_SIDEBAR_WIDTH}
            maxSize={MAX_SIDEBAR_WIDTH}
            preferredSize={DEFAULT_CONVERSATION_SIDEBAR_WIDTH}
          >
            <div className="h-full pr-1.5 box-border">
              <div className="h-full rounded-2xl bg-background border border-border/50 shadow-sm flex flex-col overflow-hidden relative">
                <ConversationSidebar projectId={projectId} />
              </div>
            </div>
          </Allotment.Pane>
          <Allotment.Pane>
            <div className="h-full pl-1.5 box-border flex flex-col relative overflow-hidden">
              {children}
            </div>
          </Allotment.Pane>
        </Allotment>
      </div>
    </div>
  );
};
