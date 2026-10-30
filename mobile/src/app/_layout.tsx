import { ClerkProvider, useAuth } from "@clerk/expo";
import { tokenCache } from "@clerk/expo/token-cache";
// Each weight by path: the package index bundles all 18 Inter files.
import { Inter_400Regular } from "@expo-google-fonts/inter/400Regular";
import { Inter_500Medium } from "@expo-google-fonts/inter/500Medium";
import { Inter_600SemiBold } from "@expo-google-fonts/inter/600SemiBold";
import { Inter_700Bold } from "@expo-google-fonts/inter/700Bold";
import { IBMPlexMono_400Regular } from "@expo-google-fonts/ibm-plex-mono/400Regular";
import { IBMPlexMono_500Medium } from "@expo-google-fonts/ibm-plex-mono/500Medium";
import { ConvexReactClient, useConvexAuth } from "convex/react";
import { ConvexProviderWithClerk } from "convex/react-clerk";
import { useFonts } from "expo-font";
import { type ErrorBoundaryProps, Stack, ThemeProvider } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { ActivityIndicator, Platform, Pressable, Text, View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";

import { ConnectionBanner } from "@/components/connection-banner";
import { DialogHost } from "@/components/dialogs";
import { GridHeader } from "@/components/grid";
import { Logo } from "@/components/logo";
import { SheetHost } from "@/components/sheet-host";
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
  const [fontsLoaded] = useFonts({
    Inter_400Regular,
    Inter_500Medium,
    Inter_600SemiBold,
    Inter_700Bold,
    IBMPlexMono_400Regular,
    IBMPlexMono_500Medium,
  });
  if (!fontsLoaded) return null;

  return (
    // Gestures (dragging sheets closed) need a root view above everything.
    <GestureHandlerRootView style={{ flex: 1 }}>
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
    </GestureHandlerRootView>
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
    <SheetHost>
      <Stack
        screenOptions={{
          header: GridHeader,
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
    </SheetHost>
    {/* After the sheets, so confirms and toasts show above an open sheet. */}
    <DialogHost />
    </>
  );
}
