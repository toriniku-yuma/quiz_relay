export type AuthConfig = { publishableKey: string };

export function readAuthConfig(value: unknown): AuthConfig | undefined {
  if (
    !value ||
    typeof value !== 'object' ||
    Object.keys(value).length !== 1 ||
    !('publishableKey' in value) ||
    typeof value.publishableKey !== 'string' ||
    !/^pk_(test|live)_[A-Za-z0-9+/=]+$/.test(value.publishableKey)
  )
    return;
  return { publishableKey: value.publishableKey };
}
