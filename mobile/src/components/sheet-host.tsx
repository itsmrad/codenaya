import { Fragment, type ReactNode, createContext, useCallback, useContext, useState } from "react";

type Place = (id: string, node: ReactNode | null) => void;

const SheetPortal = createContext<Place | null>(null);

/**
 * Renders open sheets above every screen, in the app's own edge-to-edge
 * window. A React Native Modal opens a separate Android window that stops at
 * the navigation bar, which left a black band under each sheet.
 */
export function SheetHost({ children }: { children: ReactNode }) {
  const [nodes, setNodes] = useState<Record<string, ReactNode>>({});
  const place = useCallback<Place>(
    (id, node) =>
      setNodes((current) => {
        // Closed sheets re-render often; leave the state alone for them.
        if (!node && !(id in current)) return current;
        const next = { ...current };
        if (node) next[id] = node;
        else delete next[id];
        return next;
      }),
    [],
  );
  return (
    <SheetPortal.Provider value={place}>
      {children}
      {Object.entries(nodes).map(([id, node]) => (
        <Fragment key={id}>{node}</Fragment>
      ))}
    </SheetPortal.Provider>
  );
}

export const useSheetPortal = () => {
  const place = useContext(SheetPortal);
  if (!place) throw new Error("Sheets need a <SheetHost> above them");
  return place;
};
