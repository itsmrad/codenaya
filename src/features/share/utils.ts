/** The public website preview of a shared project (#260). */
export const sharePath = (token: string) => `/preview/${token}`;

type TreeFile = { _id: string; parentId: string | null; name: string; type: "file" | "folder" };

/** Children by parent id (null = root), folders first, then by name, like the IDE's explorer. */
export const childrenByParent = <F extends TreeFile>(files: F[]) => {
  const map = new Map<F["parentId"], F[]>();
  for (const file of files) {
    map.set(file.parentId, [...(map.get(file.parentId) ?? []), file]);
  }
  for (const list of map.values()) {
    list.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "folder" ? -1 : 1));
  }
  return map;
};
