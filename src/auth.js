import crypto from 'node:crypto';
import 'dotenv/config';

// Sanitize secret key to prevent newline / quote injection
const RAW_SECRET = process.env.SESSION_SECRET || 'vcstudios-super-secret-auth-key-2026';
const SECRET = RAW_SECRET.replace(/["'\r\n]/g, '').trim();

/**
 * Retrieve sanitized administrator credentials
 */
export function getAdminCredentials() {
  const rawUser = process.env.ADMIN_USERNAME || 'ramzimzk23@virzha.com';
  const rawPass = process.env.ADMIN_PASSWORD || 'ksbenned123';

  return {
    username: rawUser.replace(/["']/g, '').trim().toLowerCase(),
    password: rawPass.replace(/["'\r\n]/g, '').trim()
  };
}

/**
 * Generate HMAC token: base64(username:timestamp:hmac)
 * Valid for 7 days
 */
export function generateAuthToken(username) {
  const cleanUser = username.trim().toLowerCase();
  const expiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000; // 7 days
  const payload = `${cleanUser}:${expiresAt}`;
  const hmac = crypto.createHmac('sha256', SECRET).update(payload).digest('hex');
  const token = Buffer.from(`${payload}:${hmac}`).toString('base64');
  return { token, expiresAt };
}

/**
 * Verify HMAC token with timing-safe check and admin identity confirmation
 */
export function verifyAuthToken(token) {
  if (!token || typeof token !== 'string') return false;
  try {
    const raw = Buffer.from(token, 'base64').toString('utf-8');
    const parts = raw.split(':');
    if (parts.length !== 3) return false;

    const [username, expiresAtStr, receivedHmac] = parts;
    const expiresAt = Number(expiresAtStr);

    // Check expiration
    if (!expiresAt || Date.now() > expiresAt) {
      return false; // Token expired
    }

    // STRICT: Only the designated Administrator can hold a valid active token
    const admin = getAdminCredentials();
    if (username.toLowerCase() !== admin.username) {
      return false;
    }

    const payload = `${username}:${expiresAtStr}`;
    const expectedHmac = crypto.createHmac('sha256', SECRET).update(payload).digest('hex');

    const receivedBuf = Buffer.from(receivedHmac);
    const expectedBuf = Buffer.from(expectedHmac);

    if (receivedBuf.length === expectedBuf.length && crypto.timingSafeEqual(receivedBuf, expectedBuf)) {
      return { username, expiresAt };
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Authenticate Administrator (Strict Single-Admin Access)
 * Uses constant-time hashing comparison to prevent timing attacks.
 */
export async function authenticateUser(username, password) {
  if (!username || !password) return null;

  const cleanUser = String(username).replace(/["']/g, '').trim().toLowerCase();
  const cleanPass = String(password).replace(/["'\r\n]/g, '').trim();

  const admin = getAdminCredentials();

  // Check if username matches admin
  if (cleanUser !== admin.username) {
    return null;
  }

  // Timing-safe password check using sha256 digest comparison
  const enteredHash = crypto.createHash('sha256').update(cleanPass).digest();
  const expectedHash = crypto.createHash('sha256').update(admin.password).digest();

  if (crypto.timingSafeEqual(enteredHash, expectedHash)) {
    return generateAuthToken(cleanUser);
  }

  return null;
}

/**
 * Register User - PERMANENTLY DISABLED
 * Throws an explicit forbidden error if called.
 */
export async function registerUser() {
  throw new Error('Pendaftaran akun baru telah ditutup secara permanen oleh Administrator.');
}
