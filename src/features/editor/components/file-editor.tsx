import { useEffect, useState, useSyncExternalStore } from "react";

import { Button } from "@/components/ui/button";
import { useUpdateFile } from "@/features/projects/hooks/use-files";
import type { Id } from "../../../../convex/_generated/dataModel";
import { EditorSession } from "../editor-session";
import { CodeEditor } from "./code-editor";

export const FileEditor = ({ file, sessions }: {
  file: { _id: Id<"files">; name: string; content?: string };
  sessions: Map<Id<"files">, EditorSession>;
}) => {
  const updateFile = useUpdateFile();
  const [session] = useState(() => {
    let draft = sessions.get(file._id);
    if (!draft) {
      draft = new EditorSession(file.content ?? "", (content, expectedContent) =>
        updateFile({ id: file._id, content, expectedContent }));
      sessions.set(file._id, draft);
    }
    return draft;
  });
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  useEffect(() => { session.receive(file.content ?? ""); }, [session, file.content]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      {(state.conflict || state.error) && (
        <div role="alert" className="flex flex-wrap items-center gap-2 border-b bg-muted px-3 py-2 text-sm">
          <p className="flex-1">
            {state.conflict
              ? "This file changed elsewhere. Your edits are preserved and autosave is paused. Reload to discard your edits, or keep your edits to replace the latest file."
              : state.error}
          </p>
          {state.conflict ? <>
            <Button size="sm" variant="outline" disabled={state.saving} onClick={session.reload}>Reload file</Button>
            <Button size="sm" variant="outline" disabled={state.saving} onClick={session.keepMine}>Keep my edits</Button>
          </> : <Button size="sm" variant="outline" disabled={state.saving} onClick={() => void session.save()}>Retry save</Button>}
        </div>
      )}
      <div className="min-h-0 flex-1">
        <CodeEditor fileName={file.name} initialValue={state.content} onChange={(content, previous) => session.edit(content, previous)} />
      </div>
    </div>
  );
};
