import { ClerkProvider, useAuth } from "@clerk/expo";
import { tokenCache } from "@clerk/expo/token-cache";
import {
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
  Inter_700Bold,
  useFonts,
} from "@expo-google-fonts/inter";
import { ConvexReactClient, useConvexAuth } from "convex/react";
import { ConvexProviderWithClerk } from "convex/react-clerk";
import { type ErrorBoundaryProps, Stack, ThemeProvider } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { ActivityIndicator, Platform, Pressable, Text, View } from "react-native";

import { ConnectionBanner } from "@/components/connection-banner";
import { Logo } from "@/components/logo";
import { applySavedTheme } from "@/lib/appearance";
import { CONVEX_URL } from "@/lib/env";
import { font, useColors, useNavigationTheme } from "@/lib/theme";

applySavedTheme();

const convex = new ConvexReactClient(CONVEX_URL, {
  unsavedChangesWarning: false,
});

/**
 * Shown instead of a crash when a screen throws (e.g. a query for a project
 * deleted elsewhere). Retry re-renders the screen.
 */
export function ErrorBoundary({ error, retry }: ErrorBoundaryProps) {
  const c = useColors();
  return (
    <View style={{ flex: 1, justifyContent: "center", alignItems: "center", gap: 12, padding: 24, backgroundColor: c.background }}>
      <Text style={{ color: c.foreground, fontSize: 17, fontFamily: font.semibold }}>Something went wrong</Text>
      <Text style={{ color: c.mutedForeground, fontSize: 13, fontFamily: font.regular, textAlign: "center" }}>
        {error.message}
      </Text>
      <Pressable onPress={retry} style={{ backgroundColor: c.primary, borderRadius: 10, paddingHorizontal: 18, paddingVertical: 10 }}>
        <Text style={{ color: c.primaryForeground, fontFamily: font.medium }}>Try again</Text>
      </Pressable>
    </View>
  );
}

export default function RootLayout() {
  const navigationTheme = useNavigationTheme();
  const [fontsLoaded] = useFonts({ Inter_400Regular, Inter_500Medium, Inter_600SemiBold, Inter_700Bold });
  if (!fontsLoaded) return null;

  return (
    <ClerkProvider
      publishableKey={process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY!}
      tokenCache={tokenCache}
    >
      <ConvexProviderWithClerk client={convex} useAuth={useAuth}>
        <ThemeProvider value={navigationTheme}>
          <StatusBar style="auto" />
          <Screens />
        </ThemeProvider>
      </ConvexProviderWithClerk>
    </ClerkProvider>
  );
}

function Screens() {
  const c = useColors();
  // Convex auth, not just Clerk: queries need the Convex token in place.
  const { isLoading, isAuthenticated } = useConvexAuth();
  if (isLoading) {
    return (
      <View style={{ flex: 1, justifyContent: "center", backgroundColor: c.background }}>
        <ActivityIndicator color={c.mutedForeground} />
      </View>
    );
  }

  return (
    <>
      <Stack
        screenOptions={{
          headerShadowVisible: false,
          headerTitleStyle: { fontFamily: font.semibold },
          headerBackButtonDisplayMode: "minimal",
          // iOS keeps its native push; Android gets the same slide-over (its
          // default fades and jumps), played in reverse on back.
          animation: Platform.OS === "android" ? "ios_from_right" : "default",
          // Swipe back from anywhere on the screen, not only the left edge.
          fullScreenGestureEnabled: true,
          // A solid page under every screen, so nothing flashes mid-slide.
          contentStyle: { backgroundColor: c.background },
        }}
      >
        <Stack.Protected guard={isAuthenticated}>
          <Stack.Screen
            name="index"
            options={{ title: "Codenaya", headerTitle: "", headerLeft: () => <Logo size={22} /> }}
          />
          <Stack.Screen name="projects/index" options={{ title: "All projects" }} />
        <Stack.Screen name="projects/[id]/index" options={{ title: "" }} />
          <Stack.Screen name="projects/[id]/files" options={{ title: "Files" }} />
          <Stack.Screen name="projects/[id]/file" options={{ title: "" }} />
        <Stack.Screen name="projects/[id]/integrations" options={{ title: "Integrations & env" }} />
        <Stack.Screen name="settings/index" options={{ title: "Settings" }} />
        <Stack.Screen name="settings/account" options={{ title: "Account" }} />
        <Stack.Screen name="settings/appearance" options={{ title: "Appearance" }} />
        <Stack.Screen name="settings/ai-providers" options={{ title: "AI providers" }} />
        <Stack.Screen name="settings/skills" options={{ title: "Skills" }} />
        <Stack.Screen name="settings/skill" options={{ title: "" }} />
        <Stack.Screen name="settings/integrations" options={{ title: "Integrations" }} />
        </Stack.Protected>
        <Stack.Protected guard={!isAuthenticated}>
          <Stack.Screen name="sign-in" options={{ headerShown: false }} />
        </Stack.Protected>
      </Stack>
      <ConnectionBanner />
    </>
  );
}
