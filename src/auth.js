import {
  createHmac,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';

const SCRYPT_KEYLEN = 32;

/** Hash a master password as `scrypt$<salt-hex>$<key-hex>`. */
export function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  const key = scryptSync(password, salt, SCRYPT_KEYLEN).toString('hex');
  return `scrypt$${salt}$${key}`;
}

/** Constant-time check of a candidate password against a stored hash. */
export function verifyPassword(password, stored) {
  if (typeof password !== 'string' || typeof stored !== 'string') return false;
  const [scheme, salt, key] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !key) return false;
  let candidate;
  try {
    candidate = scryptSync(password, salt, SCRYPT_KEYLEN);
  } catch {
    return false;
  }
  const expected = Buffer.from(key, 'hex');
  if (expected.length !== candidate.length) return false;
  return timingSafeEqual(candidate, expected);
}

function base64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

/** Mint a session token that carries its own expiry: `<expiry>.<hmac>`. */
export function signSession(secret, ttlMs, now = Date.now()) {
  const payload = base64url(String(now + ttlMs));
  const sig = createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

/** True when the token signature matches and the expiry is still in the future. */
export function verifySession(secret, token, now = Date.now()) {
  if (typeof token !== 'string') return false;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return false;
  const expected = createHmac('sha256', secret)
    .update(payload)
    .digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
  const expiry = Number(Buffer.from(payload, 'base64url').toString());
  return Number.isFinite(expiry) && expiry > now;
}

/** Read one cookie out of a raw `Cookie:` header. */
export function readCookie(header, name) {
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return null;
}

/**
 * Sliding-window lockout so a master password cannot be brute forced.
 * Failures are tracked per client key (IP), successes clear the record.
 */
export class LoginLimiter {
  constructor({ maxAttempts = 5, windowMs = 10 * 60 * 1000 } = {}) {
    this.maxAttempts = maxAttempts;
    this.windowMs = windowMs;
    this.hits = new Map();
  }

  /** Milliseconds the caller must wait, or 0 when a login may proceed. */
  retryAfter(key, now = Date.now()) {
    const record = this.hits.get(key);
    if (!record) return 0;
    if (now - record.first > this.windowMs) {
      this.hits.delete(key);
      return 0;
    }
    if (record.count < this.maxAttempts) return 0;
    return record.first + this.windowMs - now;
  }

  fail(key, now = Date.now()) {
    const record = this.hits.get(key);
    if (!record || now - record.first > this.windowMs) {
      this.hits.set(key, { count: 1, first: now });
      return;
    }
    record.count += 1;
  }

  reset(key) {
    this.hits.delete(key);
  }
}
