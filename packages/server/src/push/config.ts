/**
 * Whether this node sends pushes. DARK BY DEFAULT: nothing is wired, and no
 * request ever reaches a relay, unless both are set:
 *
 *   TM8_PUSH_RELAY=expo        the relay (decide Q5: Expo Push Service)
 *   TM8_PUBLIC_ORIGIN=https://…  the origin the phone knows this server by;
 *                              every payload names it (`o`) and the phone maps a
 *                              push to a server by exact origin, so a loopback
 *                              bind address would route nowhere
 *
 * TM8_EXPO_ACCESS_TOKEN is Expo's enhanced push security token, needed only
 * when the Expo project turns that on. It is a credential: read here, handed to
 * the relay client, never logged.
 */
export interface PushConfig {
  readonly relay: 'expo';
  readonly origin: string;
  readonly accessToken?: string;
}

export type PushConfigResult =
  | { readonly enabled: true; readonly config: PushConfig }
  | { readonly enabled: false; readonly reason: string };

export function pushConfigFromEnv(
  env: Readonly<Record<string, string | undefined>>,
  publicOrigin: string | undefined,
): PushConfigResult {
  const relay = env['TM8_PUSH_RELAY']?.trim().toLowerCase() ?? '';
  if (relay === '' || relay === 'off') {
    return { enabled: false, reason: 'not configured (set TM8_PUSH_RELAY=expo and TM8_PUBLIC_ORIGIN)' };
  }
  if (relay !== 'expo') {
    return { enabled: false, reason: `TM8_PUSH_RELAY=${JSON.stringify(relay.slice(0, 40))} is not a relay this node knows (expo)` };
  }
  if (!publicOrigin) {
    return {
      enabled: false,
      reason: 'TM8_PUBLIC_ORIGIN is not set: every push names the origin the phone knows this server by',
    };
  }
  const accessToken = env['TM8_EXPO_ACCESS_TOKEN']?.trim();
  return { enabled: true, config: { relay: 'expo', origin: publicOrigin, ...(accessToken ? { accessToken } : {}) } };
}
