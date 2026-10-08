import { useState } from "react";
import { toast } from "sonner";

import { Doc } from "../../../../convex/_generated/dataModel";
import { validateProjectName } from "../utils/project-name";
import { useRenameProject } from "./use-projects";

/** Inline rename state shared by the dashboard card and the IDE top bar. */
export const useProjectRename = (project: Doc<"projects"> | undefined) => {
  const renameProject = useRenameProject();
  const [isRenaming, setIsRenaming] = useState(false);
  const [name, setName] = useState("");

  const error = isRenaming ? validateProjectName(name.trim()) : null;

  const start = () => {
    if (!project) return;
    setName(project.name);
    setIsRenaming(true);
  };

  const cancel = () => setIsRenaming(false);

  /** Saves a changed, valid name. An invalid one keeps the input open on Enter. */
  const submit = ({ keepOpenOnError }: { keepOpenOnError: boolean }) => {
    if (!project) return;

    const trimmedName = name.trim();
    if (trimmedName === project.name) {
      setIsRenaming(false);
      return;
    }
    if (error) {
      if (keepOpenOnError) {
        toast.error(error);
      } else {
        setIsRenaming(false);
      }
      return;
    }

    setIsRenaming(false);
    renameProject({ id: project._id, name: trimmedName }).catch(() => {
      toast.error("Couldn't rename the project");
    });
  };

  const inputProps = {
    value: name,
    autoFocus: true,
    "aria-label": "Project name",
    "aria-invalid": error !== null,
    title: error ?? undefined,
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => setName(e.target.value),
    onFocus: (e: React.FocusEvent<HTMLInputElement>) => e.currentTarget.select(),
    onBlur: () => submit({ keepOpenOnError: false }),
    onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter") {
        submit({ keepOpenOnError: true });
      } else if (e.key === "Escape") {
        cancel();
      }
    },
  };

  return { isRenaming, start, inputProps };
};
