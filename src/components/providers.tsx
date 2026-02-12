"use client"

import { ClerkProvider, useAuth, UserButton } from "@clerk/nextjs"
import { Authenticated, AuthLoading, ConvexReactClient, Unauthenticated } from "convex/react"
import { ConvexProviderWithClerk } from "convex/react-clerk"
import { ThemeProvider } from "./theme-provider"
import { UnauthenticatedView } from "@/features/auth/components/unauthenticated-view"
import { AuthLoadingView } from "@/features/auth/components/auth-loading-view"

const convex = new ConvexReactClient(process.env.NEXT_PUBLIC_CONVEX_URL!)

export const Providers = ({ children }: { children: React.ReactNode }) => {
  return (
    <ClerkProvider>
      <ConvexProviderWithClerk client={convex} useAuth={useAuth}>
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          enableSystem
          disableTransitionOnChange
        >
          <Authenticated>
            <UserButton />
            {children}
          </Authenticated>
          <Unauthenticated>
            <UnauthenticatedView />
          </Unauthenticated>
          <AuthLoading>
            <AuthLoadingView />
          </AuthLoading>
        </ThemeProvider>
      </ConvexProviderWithClerk>
    </ClerkProvider>
  )
}