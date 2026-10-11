export type AuthConfig =
  | { provider?: 'supabase'; url: string; publishableKey: string }
  | { provider: 'clerk'; publishableKey: string };

export function readAuthConfig(value: unknown): AuthConfig | undefined {
  if (
    !value ||
    typeof value !== 'object' ||
    !('publishableKey' in value) ||
    typeof value.publishableKey !== 'string' ||
    !value.publishableKey
  )
    return;
  if ('provider' in value && value.provider === 'clerk') {
    if (!/^pk_(test|live)_[A-Za-z0-9+/=]+$/.test(value.publishableKey)) return;
    return { provider: 'clerk', publishableKey: value.publishableKey };
  }
  if (
    'provider' in value &&
    value.provider !== undefined &&
    value.provider !== 'supabase'
  )
    return;
  if ('url' in value && typeof value.url === 'string' && value.url)
    return { url: value.url, publishableKey: value.publishableKey };
}
