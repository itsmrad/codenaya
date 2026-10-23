/** "5 minutes ago", like the web's formatDistanceToNow, without date-fns. */
export const timeAgo = (time: number) => {
  const minutes = Math.round((Date.now() - time) / 60_000);
  if (minutes < 1) return "just now";
  const [value, unit] =
    minutes < 60
      ? [minutes, "minute"]
      : minutes < 60 * 24
        ? [Math.round(minutes / 60), "hour"]
        : minutes < 60 * 24 * 30
          ? [Math.round(minutes / (60 * 24)), "day"]
          : [Math.round(minutes / (60 * 24 * 30)), "month"];
  return `${value} ${unit}${value === 1 ? "" : "s"} ago`;
};
