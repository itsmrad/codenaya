"use client"

import * as React from "react"
import { ThemeProvider as NextThemesProvider } from "next-themes"

// next-themes renders an inline <script> that sets the theme before paint. It
// only runs from the server HTML; when React creates it on the client (a
// client-rendered subtree, e.g. Clerk keyless mode), React 19 warns that the
// script never executes. Typing it as data on the client silences that, and
// suppressHydrationWarning on the script covers the server/client mismatch.
const scriptProps =
  typeof window === "undefined" ? undefined : { type: "application/json" }

export function ThemeProvider({
  children,
  ...props
}: React.ComponentProps<typeof NextThemesProvider>) {
  return (
    <NextThemesProvider scriptProps={scriptProps} {...props}>
      {children}
    </NextThemesProvider>
  )
}
