import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SessionProvider } from '../lib/session';

export default function RootLayout() {
  return (
    <SessionProvider>
      <StatusBar style="dark" />
      {/* Expo SDK 58 on iOS 26 draws a see-through header, and screens scrolled under it. A solid header keeps content below it. */}
      <Stack screenOptions={{ headerTransparent: false }}>
        <Stack.Screen name="index" options={{ headerShown: false }} />
        <Stack.Screen name="login" options={{ title: 'Sign in', headerBackVisible: false }} />
        <Stack.Screen name="leads/index" options={{ title: 'Leads', headerBackVisible: false }} />
        <Stack.Screen name="leads/[id]" options={{ title: 'Lead' }} />
      </Stack>
    </SessionProvider>
  );
}
