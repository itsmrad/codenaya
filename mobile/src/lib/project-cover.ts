// Same as the web's src/components/project-cover.tsx, so a project or
// template gets the same cover in both apps.

/** Small, stable string hash (FNV-1a) so a seed always gets the same cover. */
export const hashSeed = (seed: string) => {
  let hash = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
};

/** Up to two letters from a name: "arch-routers-page" → "AR". */
export const getInitials = (name: string) => {
  const words = name.split(/[^a-zA-Z0-9]+/).filter(Boolean);
  return (words.length > 1 ? words[0][0] + words[1][0] : (words[0] ?? "?").slice(0, 2)).toUpperCase();
};
