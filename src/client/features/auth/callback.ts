export function hasAuthCallback(url: URL) {
  const hash = new URLSearchParams(url.hash.slice(1));

  return (
    url.searchParams.has('code') || url.searchParams.has('error') || hash.has('error')
  );
}
