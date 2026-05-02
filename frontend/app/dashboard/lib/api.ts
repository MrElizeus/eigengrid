const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8000';

function getToken(): string {
  if (typeof window === 'undefined') return '';
  return localStorage.getItem('eigengrid_token') ?? '';
}

export async function apiFetch<T>(
  path: string,
  init?: RequestInit
): Promise<T> {
  const token = getToken();
  const headers: HeadersInit = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    ...(init?.headers ?? {}),
  };

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers,
  });

  if (!res.ok) {
    let errorMessage = `HTTP ${res.status}`;
    try {
      const data = await res.json();
      errorMessage = data.message ?? errorMessage;
    } catch {
      // Ignore parse errors
    }
    throw new Error(errorMessage);
  }

  return res.json() as Promise<T>;
}

export interface WOLResponse {
  status: string;
  message: string;
  machine_id: string;
}

export interface SSHSessionResponse {
  status: string;
  token: string;
  ws_url: string;
}

export async function wakeOnLan(machineId: string): Promise<WOLResponse> {
  return apiFetch(`/api/wol/${machineId}`, {
    method: 'POST',
  });
}

export async function createSSHSession(
  machineId: string
): Promise<SSHSessionResponse> {
  return apiFetch('/api/ssh/session', {
    method: 'POST',
    body: JSON.stringify({ machine_id: machineId }),
  });
}
