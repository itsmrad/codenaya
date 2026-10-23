import { StyleSheet, Text, View } from "react-native";
import Svg, { Path } from "react-native-svg";

import { font, useColors } from "@/lib/theme";

/** The website's mark (public/logo-alt.svg) and lowercase wordmark. */
export function Logo({ size = 20 }: { size?: number }) {
  const c = useColors();
  return (
    <View style={styles.row}>
      <Svg width={size} height={size * 1.2} viewBox="0 0 40 48" fill="none">
        <Path
          d="M20 4V16.3604C20 19.087 16.6569 20.3998 14.8016 18.4017L7 10M40 24H27.6396C24.913 24 23.6002 20.6569 25.5983 18.8016L34 11M20 44V31.6396C20 28.913 23.3431 27.6002 25.1984 29.5983L33 38M0 24L12.3604 24C15.087 24 16.3998 27.3431 14.4017 29.1984L6 37"
          stroke={c.foreground}
          strokeWidth={4}
        />
      </Svg>
      <Text style={[styles.word, { color: c.foreground, fontSize: size * 0.8 }]}>codenaya</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: 10 },
  word: { fontFamily: font.semibold, letterSpacing: -0.3 },
});
