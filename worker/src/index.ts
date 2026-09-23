/**
 * Advisory board API.
 *
 * - Holds the Anthropic API key so the browser never sees it.
 * - Users log in with a username and password; the owner ("admin") manages them.
 * - /v1/messages is proxied to Anthropic for logged-in users, streaming included,
 *   so the web app keeps using the official SDK with this worker as its base URL.
 */
import { DurableObject } from 'cloudflare:workers';

export interface Env {
  ANTHROPIC_API_KEY: string;
  ADMIN_PASSWORD: string;
  /** Comma-separated origins allowed to call the API (the GitHub Pages site, localhost). */
  ALLOWED_ORIGINS: string;
  /** Overridable for local tests. */
  ANTHROPIC_BASE_URL?: string;
  USERS: DurableObjectNamespace<UserStore>;
}

const ADMIN = 'admin';
const SESSION_DAYS = 30;
const MAX_FAILED_LOGINS = 10;
const LOCK_MINUTES = 5;
const PBKDF2_ITERATIONS = 100_000;

interface StoredUser {
  salt: string;
  hash: string;
  createdAt: number;
}

// ---------- crypto helpers ----------

const enc = new TextEncoder();
const toB64 = (bytes: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes))))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
const fromB64 = (s: string) => {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};

const hashPassword = async (password: string, salt: Uint8Array) => {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: PBKDF2_ITERATIONS },
    key,
    256,
  );
  return toB64(bits);
};

const sameText = (a: string, b: string) => {
  const x = enc.encode(a);
  const y = enc.encode(b);
  if (x.length !== y.length) return false;
  return crypto.subtle.timingSafeEqual(x, y);
};

const hmacKey = (secret: string) =>
  crypto.subtle.importKey('raw', fromB64(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);

// ---------- storage: one Durable Object holds all users ----------

export class UserStore extends DurableObject<Env> {
  async sessionSecret(): Promise<string> {
    let secret = await this.ctx.storage.get<string>('session-secret');
    if (!secret) {
      secret = toB64(crypto.getRandomValues(new Uint8Array(32)));
      await this.ctx.storage.put('session-secret', secret);
    }
    return secret;
  }

  async getUser(name: string) {
    return (await this.ctx.storage.get<StoredUser>(`user:${name}`)) ?? null;
  }

  async setUser(name: string, password: string) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const existing = await this.getUser(name);
    await this.ctx.storage.put<StoredUser>(`user:${name}`, {
      salt: toB64(salt),
      hash: await hashPassword(password, salt),
      createdAt: existing?.createdAt ?? Date.now(),
    });
    // A new password ends that user's old sessions.
    await this.ctx.storage.put(`gen:${name}`, ((await this.ctx.storage.get<number>(`gen:${name}`)) ?? 0) + 1);
  }

  async deleteUser(name: string) {
    await this.ctx.storage.delete([`user:${name}`, `fails:${name}`]);
    await this.ctx.storage.put(`gen:${name}`, ((await this.ctx.storage.get<number>(`gen:${name}`)) ?? 0) + 1);
  }

  async generation(name: string) {
    return (await this.ctx.storage.get<number>(`gen:${name}`)) ?? 0;
  }

  async listUsers() {
    const rows = await this.ctx.storage.list<StoredUser>({ prefix: 'user:' });
    return [...rows].map(([key, u]) => ({ username: key.slice(5), createdAt: u.createdAt }));
  }

  /** Returns 'ok', 'bad' or 'locked'; counts failures to slow down password guessing. */
  async checkPassword(name: string, password: string, adminPassword: string): Promise<'ok' | 'bad' | 'locked'> {
    const fails = (await this.ctx.storage.get<{ count: number; until: number }>(`fails:${name}`)) ?? { count: 0, until: 0 };
    if (fails.until > Date.now()) return 'locked';

    let ok = false;
    if (name === ADMIN) {
      ok = !!adminPassword && sameText(password, adminPassword);
    } else {
      const user = await this.getUser(name);
      ok = !!user && sameText(await hashPassword(password, fromB64(user.salt)), user.hash);
    }

    if (ok) {
      await this.ctx.storage.delete(`fails:${name}`);
      return 'ok';
    }
    const count = fails.count + 1;
    await this.ctx.storage.put(`fails:${name}`, {
      count: count >= MAX_FAILED_LOGINS ? 0 : count,
      until: count >= MAX_FAILED_LOGINS ? Date.now() + LOCK_MINUTES * 60_000 : 0,
    });
    return 'bad';
  }
}

// ---------- sessions: signed tokens ----------

interface Session {
  u: string;
  g: number;
  exp: number;
}

const store = (env: Env) => env.USERS.get(env.USERS.idFromName('users'));

const signSession = async (env: Env, username: string) => {
  const s = store(env);
  const payload: Session = { u: username, g: await s.generation(username), exp: Date.now() + SESSION_DAYS * 86_400_000 };
  const body = toB64(enc.encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(await s.sessionSecret()), enc.encode(body));
  return `${body}.${toB64(sig)}`;
};

const readSession = async (env: Env, request: Request): Promise<string | null> => {
  const token = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
  if (!token) return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const s = store(env);
  let valid = false;
  try {
    valid = await crypto.subtle.verify('HMAC', await hmacKey(await s.sessionSecret()), fromB64(sig), enc.encode(body));
  } catch {
    return null;
  }
  if (!valid) return null;
  let session: Session;
  try {
    session = JSON.parse(new TextDecoder().decode(fromB64(body)));
  } catch {
    return null;
  }
  if (session.exp < Date.now()) return null;
  if (session.g !== (await s.generation(session.u))) return null;
  if (session.u !== ADMIN && !(await s.getUser(session.u))) return null;
  return session.u;
};

// ---------- HTTP ----------

const corsHeaders = (env: Env, request: Request): Record<string, string> => {
  const origin = request.headers.get('origin') ?? '';
  const allowed = env.ALLOWED_ORIGINS.split(',').map((o) => o.trim());
  if (!allowed.includes(origin)) return {};
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'access-control-allow-headers': request.headers.get('access-control-request-headers') ?? 'authorization, content-type',
    'access-control-max-age': '86400',
    vary: 'origin',
  };
};

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });

const error = (message: string, status: number) =>
  // Same shape as Anthropic errors, so the SDK surfaces the message.
  json({ type: 'error', error: { type: status === 401 ? 'authentication_error' : 'invalid_request_error', message } }, status);

const USERNAME_RE = /^[\p{L}\p{N}._-]{2,32}$/u;

const readJson = async <T>(request: Request): Promise<T | null> => {
  try {
    return (await request.json()) as T;
  } catch {
    return null;
  }
};

const route = async (request: Request, env: Env): Promise<Response> => {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '');

  if (path === '/auth/login' && request.method === 'POST') {
    const body = await readJson<{ username?: string; password?: string }>(request);
    const username = body?.username?.trim().toLowerCase() ?? '';
    const password = body?.password ?? '';
    if (!username || !password) return error('חסרים שם משתמש או סיסמה.', 400);
    const result = await store(env).checkPassword(username, password, env.ADMIN_PASSWORD);
    if (result === 'locked') return error('יותר מדי ניסיונות כושלים. נסה שוב בעוד כמה דקות.', 429);
    if (result === 'bad') return error('שם המשתמש או הסיסמה שגויים.', 401);
    return json({ token: await signSession(env, username), username, isAdmin: username === ADMIN });
  }

  const user = await readSession(env, request);
  if (!user) return error('צריך להתחבר מחדש.', 401);

  if (path === '/auth/me' && request.method === 'GET') {
    return json({ username: user, isAdmin: user === ADMIN });
  }

  if (path === '/v1/messages' && request.method === 'POST') {
    if (!env.ANTHROPIC_API_KEY) return error('לשרת לא הוגדר מפתח API.', 500);
    const headers = new Headers({
      'content-type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': request.headers.get('anthropic-version') ?? '2023-06-01',
    });
    const beta = request.headers.get('anthropic-beta');
    if (beta) headers.set('anthropic-beta', beta);
    const upstream = await fetch(`${env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com'}/v1/messages${url.search}`, {
      method: 'POST',
      headers,
      body: request.body,
    });
    const out = new Headers();
    for (const h of ['content-type', 'request-id', 'retry-after']) {
      const v = upstream.headers.get(h);
      if (v) out.set(h, v);
    }
    return new Response(upstream.body, { status: upstream.status, headers: out });
  }

  if (path.startsWith('/admin/')) {
    if (user !== ADMIN) return error('רק המנהל יכול לנהל משתמשים.', 403);
    const s = store(env);
    if (path === '/admin/users' && request.method === 'GET') {
      return json({ users: await s.listUsers() });
    }
    if (path === '/admin/users' && request.method === 'POST') {
      const body = await readJson<{ username?: string; password?: string }>(request);
      const username = body?.username?.trim().toLowerCase() ?? '';
      const password = body?.password ?? '';
      if (!USERNAME_RE.test(username) || username === ADMIN) {
        return error('שם משתמש לא תקין: 2-32 אותיות, ספרות, נקודה, מקף או קו תחתון.', 400);
      }
      if (password.length < 6) return error('הסיסמה צריכה להיות באורך 6 תווים לפחות.', 400);
      await s.setUser(username, password);
      return json({ ok: true });
    }
    const match = path.match(/^\/admin\/users\/([^/]+)$/);
    if (match && request.method === 'DELETE') {
      await s.deleteUser(decodeURIComponent(match[1]).toLowerCase());
      return json({ ok: true });
    }
  }

  return error('לא נמצא.', 404);
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const cors = corsHeaders(env, request);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    let response: Response;
    try {
      response = await route(request, env);
    } catch (e) {
      console.error(e);
      response = error('שגיאת שרת.', 500);
    }
    const headers = new Headers(response.headers);
    for (const [k, v] of Object.entries(cors)) headers.set(k, v);
    return new Response(response.body, { status: response.status, headers });
  },
} satisfies ExportedHandler<Env>;
