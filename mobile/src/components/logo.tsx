import { StyleSheet, Text, View, useColorScheme } from "react-native";
import Svg, { Path, Rect } from "react-native-svg";

import { font, useColors } from "@/lib/theme";

// The "Cursor C" monogram (assets/brand/cursor-c-*.svg): a ring with a block
// cursor in its mouth. The light version uses a deeper orange for contrast.
const MARK = {
  dark: { ring: "#FAFAF9", cursor: "#EC6A47" },
  light: { ring: "#09090B", cursor: "#D45431" },
};
const RING = "M26.79 -20.93A34 34 0 1 0 26.79 20.93L14.97 11.70A19 19 0 1 1 14.97 -11.70Z";

/** The Cursor C mark, optionally with the lowercase wordmark. */
export function Logo({ size = 20, wordmark = true }: { size?: number; wordmark?: boolean }) {
  const c = useColors();
  const colors = MARK[useColorScheme() === "light" ? "light" : "dark"];
  return (
    <View style={[styles.row, { gap: size * 0.45 }]}>
      <Svg width={size} height={size} viewBox="-34.5 -34 68 68">
        <Path d={RING} fill={colors.ring} />
        <Rect x={24} y={-9.5} width={9} height={19} fill={colors.cursor} />
      </Svg>
      {wordmark && (
        // Sized like the brand board (the wordmark about as tall as the C), with
        // a line box that hugs the glyphs so the row centres the C on the text.
        <Text style={[styles.word, { color: c.foreground, fontSize: size, lineHeight: size * 1.15 }]}>codenaya</Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center" },
  word: { fontFamily: font.semibold, letterSpacing: -0.5, includeFontPadding: false, textAlignVertical: "center" },
});
