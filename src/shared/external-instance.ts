import { participationId, participationOrigin } from './participation.ts';

export function externalInstanceUrl(value: unknown) {
  if (typeof value !== 'string' || value.length > 2048)
    throw new Error('INVALID_INSTANCE_URL');
  const url = new URL(value);
  if (
    !participationOrigin(url.origin) ||
    url.username ||
    url.password ||
    url.hash ||
    !['/game/', '/casual/', '/rooms/'].includes(url.pathname) ||
    [...url.searchParams.keys()].some((key) => key !== 'instance') ||
    url.searchParams.getAll('instance').length !== 1 ||
    !participationId(url.searchParams.get('instance'))
  )
    throw new Error('INVALID_INSTANCE_URL');
  return {
    peerOrigin: url.origin,
    instanceId: url.searchParams.get('instance') as string,
  };
}
