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
import { ActivityIndicator, View } from "react-native";

import { Logo } from "@/components/logo";
import { font, useColors, useNavigationTheme } from "@/lib/theme";

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
    <Stack
      screenOptions={{
        headerShadowVisible: false,
        headerTitleStyle: { fontFamily: font.semibold },
        headerBackButtonDisplayMode: "minimal",
      }}
    >
      <Stack.Protected guard={isAuthenticated}>
        <Stack.Screen name="index" options={{ title: "Codenaya", headerTitle: () => <Logo size={18} /> }} />
        <Stack.Screen name="projects/[id]/index" options={{ title: "" }} />
        <Stack.Screen name="projects/[id]/files" options={{ title: "Files" }} />
        <Stack.Screen name="projects/[id]/file" options={{ title: "" }} />
      </Stack.Protected>
      <Stack.Protected guard={!isAuthenticated}>
        <Stack.Screen name="sign-in" options={{ headerShown: false }} />
      </Stack.Protected>
    </Stack>
  );
}
