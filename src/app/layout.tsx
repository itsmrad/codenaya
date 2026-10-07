import type { Metadata, Viewport } from "next";
import { IBM_Plex_Mono, Inter } from "next/font/google";
import { Suspense } from "react";

import { Toaster } from "@/components/ui/sonner";
import { Providers } from "@/components/providers";
import { AuthLoadingView } from "@/features/auth/components/auth-loading-view";

import "allotment/dist/style.css";
import "./globals.css";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
});

const plexMono = IBM_Plex_Mono({
  variable: "--font-plex-mono",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
});

// Reuse IBM Plex Mono as the Nerd-font-backed monospace for the editor.
// This gives theme.ts's var(--font-nerd-mono) a real font to resolve to.
const nerdMono = IBM_Plex_Mono({
  variable: "--font-nerd-mono",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
});

const title = "Codenaya — AI-Powered Browser IDE";
const description =
  "Build, edit, and deploy code from your browser with AI assistance. Real-time collaboration, GitHub integration, and instant preview.";

// Absolute base for Open Graph / Twitter image URLs.
const appUrl =
  process.env.NEXT_PUBLIC_APP_URL ??
  (process.env.VERCEL_PROJECT_PRODUCTION_URL
    ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
    : "http://localhost:3000");

const ogImage = {
  url: "/og.png",
  width: 1200,
  height: 630,
  alt: "Codenaya — Build with AI. Ship from your browser.",
};

export const metadata: Metadata = {
  metadataBase: new URL(appUrl),
  title,
  description,
  applicationName: "Codenaya",
  openGraph: {
    type: "website",
    siteName: "Codenaya",
    title,
    description,
    images: [ogImage],
  },
  twitter: {
    card: "summary_large_image",
    title,
    description,
    images: [ogImage],
  },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#faf8f5" },
    { media: "(prefers-color-scheme: dark)", color: "#09090b" },
  ],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${inter.variable} ${plexMono.variable} ${nerdMono.variable} font-sans antialiased`}
      >
        {/* Clerk's keyless mode (no publishable key) reads route segments in
            ClerkProvider, which Cache Components requires under <Suspense>. */}
        <Suspense fallback={<AuthLoadingView />}>
          <Providers>
            {children}
            <Toaster />
          </Providers>
        </Suspense>
      </body>
    </html>
  );
}
