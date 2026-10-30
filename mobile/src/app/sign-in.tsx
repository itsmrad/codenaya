import { useSignIn } from "@clerk/expo";
import { useSSO } from "@clerk/expo/experimental";
import * as WebBrowser from "expo-web-browser";
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
import { Corners, DotGrid, LabelStrip, monoLabel } from "@/components/grid";
import { ArrowRight } from "@/components/icons";
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
  const [focused, setFocused] = useState(false);
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
  const inputStyle = [
    styles.input,
    { color: c.foreground, borderColor: focused ? c.brand : c.border, backgroundColor: c.card },
  ];
  const focusProps = { onFocus: () => setFocused(true), onBlur: () => setFocused(false) };

  return (
    <KeyboardAvoidingView
      style={[styles.flex, { backgroundColor: c.background }]}
      behavior="padding"
    >
      <DotGrid />
      <ScrollView contentContainerStyle={styles.screen} keyboardShouldPersistTaps="handled">
        <View style={styles.logo}>
          <Logo size={22} />
        </View>

        {/* The web's window: `+` corners outside the card, a `[ SIGN IN ]` strip on top. */}
        <View style={styles.window}>
          <Corners />
          <View style={[styles.card, { backgroundColor: c.card, borderColor: c.border }]}>
            <LabelStrip
            label={codeSent ? "Verify" : "Sign in"}
            right={<Text style={[monoLabel, { color: c.mutedForeground }]}>{codeSent ? "02 / 02" : "01 / 02"}</Text>}
          />
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
                    <Text style={[monoLabel, { color: c.mutedForeground }]}>or</Text>
                    <View style={[styles.rule, { backgroundColor: c.border }]} />
                  </View>
                </>
              )}

              <Text style={[monoLabel, styles.label, { color: c.mutedForeground }]}>
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
                  {...focusProps}
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
                  {...focusProps}
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
                    <Text style={[monoLabel, styles.continueText, { color: c.brandForeground }]}>Continue</Text>
                    <ArrowRight size={14} color={c.brandForeground} />
                  </>
                )}
              </Pressable>

              {codeSent && (
                <Pressable onPress={startOver} disabled={busy}>
                  <Text style={[styles.link, { color: c.mutedForeground }]}>Use a different email</Text>
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
        </View>

        <Text style={[monoLabel, styles.hint, { color: c.mutedForeground }]}>
          {codeSent ? "No code? Check your spam folder" : "A 6-digit code is sent to your email"}
        </Text>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  screen: { flexGrow: 1, justifyContent: "center", padding: 20, gap: 24 },
  logo: { alignItems: "center" },
  window: { position: "relative" },
  card: {
    borderWidth: 1,
    borderRadius: 6,
    overflow: "hidden",
    shadowColor: "#000",
    shadowOpacity: 0.08,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 12 },
    elevation: 2,
  },
  cardBody: { padding: 22, gap: 12 },
  title: { fontSize: 24, fontFamily: font.semibold, letterSpacing: -0.4 },
  subtitle: { fontSize: 14, fontFamily: font.regular, marginBottom: 14 },
  google: {
    borderWidth: 1,
    borderRadius: 6,
    height: 46,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
  },
  googleText: { fontSize: 14, fontFamily: font.medium },
  divider: { flexDirection: "row", alignItems: "center", gap: 12, marginVertical: 6 },
  rule: { flex: 1, height: 1 },
  label: { marginTop: 4 },
  input: {
    borderWidth: 1,
    borderRadius: 6,
    height: 46,
    paddingHorizontal: 14,
    fontSize: 15,
    fontFamily: font.regular,
  },
  error: { fontSize: 13, fontFamily: font.regular },
  continue: {
    marginTop: 8,
    height: 46,
    borderRadius: 6,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  continueText: { fontSize: 11, fontFamily: font.monoMedium },
  disabled: { opacity: 0.6 },
  link: {
    textAlign: "center",
    paddingVertical: 6,
    fontSize: 13,
    fontFamily: font.regular,
    textDecorationLine: "underline",
    textDecorationStyle: "dotted",
  },
  cardFooter: { borderTopWidth: 1, paddingVertical: 16, alignItems: "center" },
  footerText: { fontSize: 13, fontFamily: font.regular },
  hint: { textAlign: "center" },
});
