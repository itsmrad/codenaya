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
import { Stack, ThemeProvider } from "expo-router";
import { StatusBar } from "expo-status-bar";

import { Logo } from "@/components/logo";
import { font, useNavigationTheme } from "@/lib/theme";

const convex = new ConvexReactClient(process.env.EXPO_PUBLIC_CONVEX_URL!, {
  unsavedChangesWarning: false,
});

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
  // Convex auth, not just Clerk: queries need the Convex token in place.
  const { isLoading, isAuthenticated } = useConvexAuth();
  if (isLoading) return null;

  return (
    <Stack
      screenOptions={{
        headerShadowVisible: false,
        headerTitleStyle: { fontFamily: font.semibold },
        headerBackButtonDisplayMode: "minimal",
      }}
    >
      <Stack.Protected guard={isAuthenticated}>
        <Stack.Screen name="index" options={{ title: "Codenaya", headerTitle: () => <Logo size={18} /> }} />
        <Stack.Screen name="projects/[id]" options={{ title: "" }} />
      </Stack.Protected>
      <Stack.Protected guard={!isAuthenticated}>
        <Stack.Screen name="sign-in" options={{ headerShown: false }} />
      </Stack.Protected>
    </Stack>
  );
}
