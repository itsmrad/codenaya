import { useUser } from "@clerk/expo";
import { Image } from "expo-image";
import { StyleSheet, Text, View } from "react-native";

import { getInitials } from "@/lib/project-cover";
import { font, useColors } from "@/lib/theme";

/** The signed-in user's display name, as Settings and Account show it. */
export const useDisplayName = () => {
  const { user } = useUser();
  return user?.fullName || user?.username || "Your account";
};

/** The user's photo, else their initials on a dark disc. */
export function UserAvatar({ size = 48 }: { size?: number }) {
  const c = useColors();
  const { user } = useUser();
  const name = useDisplayName();
  const shape = { width: size, height: size, borderRadius: size / 2 };
  if (user?.hasImage) return <Image source={user.imageUrl} style={shape} />;
  return (
    <View style={[styles.disc, shape, { backgroundColor: c.foreground }]}>
      <Text style={[styles.initials, { color: c.background, fontSize: size * 0.36 }]}>{getInitials(name)}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  disc: { alignItems: "center", justifyContent: "center" },
  initials: { fontFamily: font.semibold },
});
