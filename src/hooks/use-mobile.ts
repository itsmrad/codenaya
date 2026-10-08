import * as React from "react"

const MOBILE_BREAKPOINT = 768
// Below this the project IDE shows one pane at a time (Chat / Code / Preview)
// instead of the chat panel beside the editor.
const COMPACT_BREAKPOINT = 1024

function useIsBelow(breakpoint: number) {
  const subscribe = React.useCallback(
    (onChange: () => void) => {
      const mql = window.matchMedia(`(max-width: ${breakpoint - 1}px)`)
      mql.addEventListener("change", onChange)
      return () => mql.removeEventListener("change", onChange)
    },
    [breakpoint]
  )

  return React.useSyncExternalStore(
    subscribe,
    () => window.innerWidth < breakpoint,
    () => false
  )
}

export function useIsMobile() {
  return useIsBelow(MOBILE_BREAKPOINT)
}

export function useIsCompact() {
  return useIsBelow(COMPACT_BREAKPOINT)
}
