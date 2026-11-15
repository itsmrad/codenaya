/** Engine changes reload the page so its COOP/COEP headers follow the choice. */
export const previewEngineUrl = (pathname: string, search: string, engine: "sandbox" | "webcontainer") => {
  const params = new URLSearchParams(search);
  if (engine === "sandbox") params.delete("engine");
  else params.set("engine", engine);
  params.set("view", "preview");
  return `${pathname}?${params.toString()}`;
};
