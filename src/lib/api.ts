/** The advisory board server: login, user management, and the Claude proxy. */
export const API_URL = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/+$/, '') ?? '';

export interface Session {
  token: string;
  username: string;
  isAdmin: boolean;
}

export interface UserRow {
  username: string;
  createdAt: number;
}

const SESSION_KEY = 'advisors.session';

export const loadSession = (): Session | null => {
  try {
    const s = JSON.parse(localStorage.getItem(SESSION_KEY) ?? 'null');
    return s && typeof s.token === 'string' ? s : null;
  } catch {
    return null;
  }
};

export const saveSession = (session: Session | null) => {
  try {
    if (session) localStorage.setItem(SESSION_KEY, JSON.stringify(session));
    else localStorage.removeItem(SESSION_KEY);
  } catch {
    // storage unavailable - the user will need to log in again next time
  }
};

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

const call = async <T>(path: string, init: RequestInit & { token?: string } = {}): Promise<T> => {
  if (!API_URL) throw new ApiError('האתר לא מחובר לשרת (חסר VITE_API_URL).', 0);
  let res: Response;
  try {
    res = await fetch(API_URL + path, {
      ...init,
      headers: {
        'content-type': 'application/json',
        ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
      },
    });
  } catch {
    throw new ApiError('אין חיבור לשרת. בדוק את החיבור לאינטרנט.', 0);
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(body?.error?.message ?? `שגיאת שרת (${res.status})`, res.status);
  return body as T;
};

export const login = (username: string, password: string) =>
  call<Session>('/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) });

export const listUsers = (token: string) => call<{ users: UserRow[] }>('/admin/users', { token });

export const saveUser = (token: string, username: string, password: string) =>
  call<{ ok: true }>('/admin/users', { method: 'POST', token, body: JSON.stringify({ username, password }) });

export const deleteUser = (token: string, username: string) =>
  call<{ ok: true }>(`/admin/users/${encodeURIComponent(username)}`, { method: 'DELETE', token });
