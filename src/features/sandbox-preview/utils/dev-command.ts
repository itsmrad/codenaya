import { detectFramework, type Framework } from "./framework";

/** Reads the same project snapshot used to boot or select a preview engine. */
export const detectFrameworkFromFiles = (
  files: { path: string; content: string }[],
  devCommand = "",
): Framework | null => {
  let pkg;
  try {
    const parsed = JSON.parse(files.find((file) => file.path === "package.json")?.content ?? "null");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) pkg = parsed;
  } catch {
    // During generation package.json may still be half-written; configs still count.
  }
  if (/\bnext\s+dev\b/.test(devCommand) || /\bnext\s+dev\b/.test(pkg?.scripts?.dev ?? "")) return "next";
  return detectFramework(files.map((file) => file.path), pkg);
};

/** E2B needs an external binding; npm requires a separator before script args. */
export const appendHostFlag = (devCommand: string, framework?: Framework | null): string => {
  if (framework === "next" || /\bnext\s+dev\b/.test(devCommand)) {
    // A stored dev command may still carry the Vite flag after a framework change.
    const command = devCommand.replace(/\s--host(?:=[^\s]+|\s+(?!-)[^\s]+)?(?=\s|$)/g, "").trim();
    if (/(?:^|\s)(?:--hostname(?:=|\s)|-H(?:\s|$))/.test(command)) return command;
    const separator = /^npm\s+run\s+/.test(command) && !/\s--(?:\s|$)/.test(command) ? " --" : "";
    return `${command}${separator} -H 0.0.0.0`;
  }
  if (devCommand.includes("--host") || devCommand.includes("-H ")) return devCommand;
  if (/^(npm|yarn|pnpm)\s+run\s+/.test(devCommand)) return `${devCommand} -- --host 0.0.0.0`;
  if (devCommand.includes("vite")) return `${devCommand} --host 0.0.0.0`;
  return devCommand;
};
