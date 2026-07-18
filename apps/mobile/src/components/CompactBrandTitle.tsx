import { View } from "react-native";

import { AppText as Text } from "./AppText";
import { useThemeColor } from "../lib/useThemeColor";

/**
 * Compact brand lockup sized for native navigation bars.
 */
export function CompactBrandTitle() {
  const iconColor = useThemeColor("--color-icon");
  const mutedColor = useThemeColor("--color-foreground-muted");
  const subtleColor = useThemeColor("--color-subtle");

  return (
    <View
      aria-level={1}
      accessibilityLabel="Apna Tasks"
      accessible
      role="heading"
      style={{ alignItems: "center", flexDirection: "row", gap: 6 }}
    >
      <Text
        style={{
          color: iconColor,
          fontFamily: "DMSans-Bold",
          fontSize: 14,
          letterSpacing: -0.35,
        }}
      >
        Apna
      </Text>
      <Text
        style={{
          color: mutedColor,
          fontFamily: "DMSans-Medium",
          fontSize: 14,
          letterSpacing: -0.35,
        }}
      >
        Tasks
      </Text>
      <View
        style={{
          backgroundColor: subtleColor,
          borderRadius: 999,
          paddingHorizontal: 6,
          paddingVertical: 2,
        }}
      >
        <Text
          style={{
            color: mutedColor,
            fontFamily: "DMSans-Bold",
            fontSize: 9,
            letterSpacing: 0.9,
            textTransform: "uppercase",
          }}
        >
          Alpha
        </Text>
      </View>
    </View>
  );
}

export function renderCompactBrandTitle() {
  return <CompactBrandTitle />;
}
