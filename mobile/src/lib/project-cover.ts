// Same as the web's src/components/project-cover.tsx.

/** Up to two letters from a name: "arch-routers-page" → "AR". */
export const getInitials = (name: string) => {
  const words = name.split(/[^a-zA-Z0-9]+/).filter(Boolean);
  return (words.length > 1 ? words[0][0] + words[1][0] : (words[0] ?? "?").slice(0, 2)).toUpperCase();
};
