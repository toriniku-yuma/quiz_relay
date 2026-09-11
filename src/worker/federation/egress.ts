import { INBOX_PATH, origin } from './signatures';

const paths = new Set([INBOX_PATH, '/federation/v1/question-set-export']);

// Initial egress profile: exact approved workers.dev origins only; no custom DNS.
export function peerRequest(
  peerOrigin: string,
  approvedOrigins: readonly string[],
  path: string,
  message: string,
) {
  origin(peerOrigin);

  const url = new URL(peerOrigin);
  const host = url.hostname;
  if (
    url.port ||
    !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.workers\.dev$/.test(
      host,
    )
  )
    throw new Error('DESTINATION_PROFILE');
  if (
    !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(
      host,
    ) ||
    /^[\d.]+$/.test(host) ||
    /(?:^|\.)(?:localhost|local|internal|test|invalid)$/.test(host)
  )
    throw new Error('DESTINATION_HOST');
  if (!approvedOrigins.includes(peerOrigin)) throw new Error('UNAPPROVED_PEER');
  if (!paths.has(path)) throw new Error('DESTINATION_PATH');

  return new Request(peerOrigin + path, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message }),
  });
}

export function rejectRedirect(response: Response) {
  if (response.status >= 300 && response.status < 400)
    throw new Error('REDIRECT_REJECTED');

  return response;
}
