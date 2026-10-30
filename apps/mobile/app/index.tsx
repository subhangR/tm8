/**
 * The scaffold's placeholder route. s-lld §3 makes index.tsx redirect to the
 * last scope or to /welcome; t-p2-root builds that and replaces this file.
 *
 * Until then it shows what the build actually loaded, read at runtime: the
 * React the renderer runs (the React split, apps/mobile/README.md), the
 * platform, and the core kind count from @tm8/contract's kind-info subpath,
 * which proves a contract subpath resolves through Metro, Hermes, tsc and jest
 * without the barrel (s-lld §13). Copy is inline English until the i18n lane
 * adds t() (s-lld §15).
 */
import { CORE_KIND_INFO } from '@tm8/contract/kind-info';
import { Stack, useTheme } from 'expo-router';
import { version as reactVersion } from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';

const coreKindCount = Object.keys(CORE_KIND_INFO).length;

export default function Index() {
  const { colors } = useTheme();
  return (
    <View style={styles.page} accessibilityLabel="TM8 Mobile scaffold">
      <Stack.Screen options={{ title: 'TM8' }} />
      <Text style={{ color: colors.text }} accessibilityRole="header">
        TM8 Mobile
      </Text>
      <Text style={{ color: colors.text }}>
        React {reactVersion} · {Platform.OS}
      </Text>
      <Text style={{ color: colors.text }}>{coreKindCount} core kinds</Text>
    </View>
  );
}

// Layout only: type roles, spacing and colours arrive with t-p0-theme.
const styles = StyleSheet.create({
  page: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});
