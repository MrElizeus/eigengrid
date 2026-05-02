export function getApiBaseUrl(): string {
  const configured = process.env.NEXT_PUBLIC_API_URL?.trim();
  if (configured) {
    return configured.replace(/\/$/, '');
  }

  if (typeof window === 'undefined') {
    return 'http://localhost:8000';
  }

  const { protocol, hostname, host, port } = window.location;
  const isLocalHost =
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '::1';

  if (isLocalHost) {
    return 'http://localhost:8000';
  }

  // Local network dev (e.g. http://192.168.x.x:3000) -> backend on :8000
  if (port === '3000') {
    return `${protocol}//${hostname}:8000`;
  }

  // Production default: same origin as the frontend host
  return `${protocol}//${host}`;
}
