/**
 * Root layout (s-lld §3), the scaffold's stand-in: one Stack whose navigation
 * theme follows the system scheme, so light and dark both render from day one
 * without a colour of the app's own (L-C: colours come from theme tokens only,
 * and t-p0-theme has not generated them yet). t-p2-root replaces this with the
 * shell: servers, scopes and the four tabs.
 */
import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useColorScheme } from 'react-native';

export default function RootLayout() {
  const scheme = useColorScheme();
  return (
    <ThemeProvider value={scheme === 'dark' ? DarkTheme : DefaultTheme}>
      <Stack />
      <StatusBar style="auto" />
    </ThemeProvider>
  );
}
