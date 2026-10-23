import { useSignIn } from "@clerk/expo";
import { useSSO } from "@clerk/expo/experimental";
import * as WebBrowser from "expo-web-browser";
import { Play } from "lucide-react-native";
import { useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import { GoogleIcon } from "@/components/google-icon";
import { Logo } from "@/components/logo";
import { webUrl } from "@/lib/http";
import { font, radius, useColors } from "@/lib/theme";

// Closes Google's browser tab when it redirects back to the app.
WebBrowser.maybeCompleteAuthSession();

/**
 * The website's Clerk sign-in card: Google, or an email address followed by a
 * one-time code. Sign-up opens the website.
 */
export default function SignIn() {
  const c = useColors();
  const { signIn, fetchStatus } = useSignIn();
  const { startSSOFlow } = useSSO();
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [codeSent, setCodeSent] = useState(false);
  const [error, setError] = useState<string>();
  const [googleBusy, setGoogleBusy] = useState(false);
  const busy = fetchStatus === "fetching" || googleBusy;

  const signInWithGoogle = async () => {
    setError(undefined);
    setGoogleBusy(true);
    try {
      // Activates the session itself; a closed browser tab just returns.
      await startSSOFlow({ strategy: "oauth_google" });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Google sign-in failed.");
    } finally {
      setGoogleBusy(false);
    }
  };

  const sendCode = async () => {
    setError(undefined);
    const result = await signIn.emailCode.sendCode({ emailAddress: email.trim() });
    if (result.error) return setError(result.error.message);
    setCodeSent(true);
  };

  const verifyCode = async () => {
    setError(undefined);
    const verified = await signIn.emailCode.verifyCode({ code: code.trim() });
    if (verified.error) return setError(verified.error.message);
    // The layout switches to the dashboard once the session is active.
    const finalized = await signIn.finalize();
    if (finalized.error) setError(finalized.error.message);
  };

  const startOver = async () => {
    await signIn.reset();
    setCode("");
    setCodeSent(false);
    setError(undefined);
  };

  const canContinue = !busy && (codeSent ? code.trim() : email.trim()).length > 0;
  const inputStyle = [styles.input, { color: c.foreground, borderColor: c.border, backgroundColor: c.muted }];

  return (
    <KeyboardAvoidingView
      style={[styles.flex, { backgroundColor: c.background }]}
      behavior="padding"
    >
      <ScrollView contentContainerStyle={styles.screen} keyboardShouldPersistTaps="handled">
        <View style={styles.logo}>
          <Logo size={22} />
        </View>

        <View style={[styles.card, { backgroundColor: c.card, borderColor: c.border }]}>
          <View style={styles.cardBody}>
            <Text style={[styles.title, { color: c.foreground }]}>
              {codeSent ? "Check your email" : "Sign in to codenaya"}
            </Text>
            <Text style={[styles.subtitle, { color: c.mutedForeground }]}>
              {codeSent
                ? `Enter the verification code sent to ${email.trim()}`
                : "Welcome back! Please sign in to continue"}
            </Text>

            {!codeSent && (
              <>
                <Pressable
                  style={[styles.google, { borderColor: c.border }, busy && styles.disabled]}
                  onPress={signInWithGoogle}
                  disabled={busy}
                >
                  {googleBusy ? (
                    <ActivityIndicator color={c.foreground} />
                  ) : (
                    <>
                      <GoogleIcon size={18} />
                      <Text style={[styles.googleText, { color: c.foreground }]}>Continue with Google</Text>
                    </>
                  )}
                </Pressable>
                <View style={styles.divider}>
                  <View style={[styles.rule, { backgroundColor: c.border }]} />
                  <Text style={[styles.or, { color: c.mutedForeground }]}>or</Text>
                  <View style={[styles.rule, { backgroundColor: c.border }]} />
                </View>
              </>
            )}

            <Text style={[styles.label, { color: c.foreground }]}>
              {codeSent ? "Verification code" : "Email address"}
            </Text>
            {codeSent ? (
              <TextInput
                key="code"
                style={inputStyle}
                value={code}
                onChangeText={setCode}
                placeholder="Enter the 6-digit code"
                placeholderTextColor={c.mutedForeground}
                keyboardType="number-pad"
                autoComplete="one-time-code"
                textContentType="oneTimeCode"
                onSubmitEditing={verifyCode}
                autoFocus
              />
            ) : (
              <TextInput
                key="email"
                style={inputStyle}
                value={email}
                onChangeText={setEmail}
                placeholder="Enter your email address"
                placeholderTextColor={c.mutedForeground}
                keyboardType="email-address"
                autoCapitalize="none"
                autoComplete="email"
                textContentType="emailAddress"
                onSubmitEditing={sendCode}
              />
            )}

            {error && <Text style={[styles.error, { color: c.destructive }]}>{error}</Text>}

            <Pressable
              style={[styles.continue, { backgroundColor: c.brand }, !canContinue && styles.disabled]}
              onPress={codeSent ? verifyCode : sendCode}
              disabled={!canContinue}
            >
              {fetchStatus === "fetching" ? (
                <ActivityIndicator color={c.brandForeground} />
              ) : (
                <>
                  <Text style={[styles.continueText, { color: c.brandForeground }]}>Continue</Text>
                  <Play size={9} color={c.brandForeground} fill={c.brandForeground} />
                </>
              )}
            </Pressable>

            {codeSent && (
              <Pressable onPress={startOver} disabled={busy}>
                <Text style={[styles.link, { color: c.brandText }]}>Use a different email</Text>
              </Pressable>
            )}
          </View>

          <View style={[styles.cardFooter, { borderColor: c.border, backgroundColor: c.muted }]}>
            <Text style={[styles.footerText, { color: c.mutedForeground }]}>
              Don’t have an account?{" "}
              <Text
                style={{ color: c.foreground, fontFamily: font.medium }}
                onPress={() => WebBrowser.openBrowserAsync(webUrl("/sign-up"))}
              >
                Sign up
              </Text>
            </Text>
          </View>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  screen: { flexGrow: 1, justifyContent: "center", padding: 20, gap: 28 },
  logo: { alignItems: "center" },
  card: { borderWidth: 1, borderRadius: radius.xl, overflow: "hidden" },
  cardBody: { padding: 28, gap: 12 },
  title: { fontSize: 18, fontFamily: font.semibold, textAlign: "center" },
  subtitle: { fontSize: 14, fontFamily: font.regular, textAlign: "center", marginBottom: 16 },
  google: {
    borderWidth: 1,
    borderRadius: radius.sm,
    height: 44,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
  },
  googleText: { fontSize: 14, fontFamily: font.medium },
  divider: { flexDirection: "row", alignItems: "center", gap: 16, marginVertical: 8 },
  rule: { flex: 1, height: 1 },
  or: { fontSize: 13, fontFamily: font.regular },
  label: { fontSize: 13, fontFamily: font.medium, marginTop: 4 },
  input: {
    borderWidth: 1,
    borderRadius: radius.sm,
    height: 44,
    paddingHorizontal: 12,
    fontSize: 14,
    fontFamily: font.regular,
  },
  error: { fontSize: 13, fontFamily: font.regular },
  continue: {
    marginTop: 12,
    height: 44,
    borderRadius: radius.sm,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  continueText: { fontSize: 14, fontFamily: font.medium },
  disabled: { opacity: 0.6 },
  link: { textAlign: "center", paddingVertical: 6, fontSize: 13, fontFamily: font.medium },
  cardFooter: { borderTopWidth: 1, paddingVertical: 18, alignItems: "center" },
  footerText: { fontSize: 13, fontFamily: font.regular },
});
