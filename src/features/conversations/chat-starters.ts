import {
  BookOpenIcon,
  BugIcon,
  DatabaseIcon,
  FileTextIcon,
  LayoutTemplateIcon,
  MoonIcon,
  PaletteIcon,
  SmartphoneIcon,
  type LucideIcon,
} from "lucide-react";

export interface ChatStarters {
  title: string;
  suggestions: { icon: LucideIcon; prompt: string }[];
}

/** The chat empty state's title and one-click prompts, picked to fit the project (#312). */
export const chatStarters = (project: {
  name: string;
  imported: boolean;
  hasFiles: boolean;
}): ChatStarters => {
  if (!project.imported && !project.hasFiles) {
    return {
      title: "What do you want to build?",
      suggestions: [
        { icon: LayoutTemplateIcon, prompt: "Add a landing page with a hero and pricing section" },
        { icon: PaletteIcon, prompt: "Restyle the app with a clean, minimal dark theme" },
        { icon: BugIcon, prompt: "Find and fix bugs in the current code" },
        { icon: DatabaseIcon, prompt: "Add a todo list that saves to localStorage" },
      ],
    };
  }
  return {
    title: `Continue building ${project.name}`,
    suggestions: project.imported
      ? [
          { icon: BookOpenIcon, prompt: "Explain this codebase" },
          { icon: BugIcon, prompt: "Find and fix bugs" },
          { icon: FileTextIcon, prompt: "Add a README" },
        ]
      : [
          { icon: SmartphoneIcon, prompt: "Improve the mobile layout" },
          { icon: MoonIcon, prompt: "Add dark mode" },
          { icon: BugIcon, prompt: "Find and fix bugs" },
        ],
  };
};
