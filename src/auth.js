import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';
import { getSupabaseClient, isUsingSupabase } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const USERS_FILE = path.resolve(__dirname, '../users.json');
const SECRET = process.env.SESSION_SECRET || 'vcstudios-default-secret-salt-2026';

export function getAdminCredentials() {
  return {
    username: (process.env.ADMIN_USERNAME || 'ramzimzk23@virzha.com').trim().toLowerCase(),
    password: process.env.ADMIN_PASSWORD || 'ksbenned123'
  };
}

/**
 * Hash password with salt
 */
export function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.pbkdf2Sync(password, salt, 10000, 64, 'sha512').toString('hex');
  return { hash, salt };
}

/**
 * Verify password against salt and hash
 */
export function verifyPassword(password, salt, expectedHash) {
  const { hash } = hashPassword(password, salt);
  return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(expectedHash));
}

/**
 * Load local users file
 */
async function loadLocalUsers() {
  try {
    const raw = await fs.readFile(USERS_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

/**
 * Save local users file
 */
async function saveLocalUsers(users) {
  await fs.writeFile(USERS_FILE, JSON.stringify(users, null, 2), 'utf-8');
}

/**
 * Generate HMAC token: base64(username:timestamp:hmac)
 */
export function generateAuthToken(username) {
  const expiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000; // 7 days
  const payload = `${username}:${expiresAt}`;
  const hmac = crypto.createHmac('sha256', SECRET).update(payload).digest('hex');
  const token = Buffer.from(`${payload}:${hmac}`).toString('base64');
  return { token, expiresAt };
}

/**
 * Verify HMAC token
 */
export function verifyAuthToken(token) {
  if (!token) return false;
  try {
    const raw = Buffer.from(token, 'base64').toString('utf-8');
    const parts = raw.split(':');
    if (parts.length !== 3) return false;

    const [username, expiresAtStr, receivedHmac] = parts;
    const expiresAt = Number(expiresAtStr);

    if (Date.now() > expiresAt) {
      return false; // Token expired
    }

    const payload = `${username}:${expiresAtStr}`;
    const expectedHmac = crypto.createHmac('sha256', SECRET).update(payload).digest('hex');

    if (crypto.timingSafeEqual(Buffer.from(receivedHmac), Buffer.from(expectedHmac))) {
      return { username, expiresAt };
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Register a new user
 */
export async function registerUser(username, password) {
  const cleanUser = username.trim().toLowerCase();
  if (!cleanUser || cleanUser.length < 3) {
    throw new Error('Username / Email minimal 3 karakter.');
  }
  if (!password || password.length < 6) {
    throw new Error('Password minimal 6 karakter.');
  }

  // Check admin conflict
  const admin = getAdminCredentials();
  if (cleanUser === admin.username) {
    throw new Error('Username ini sudah terdaftar sebagai Administrator.');
  }

  const supabase = getSupabaseClient();
  const usingSupabase = isUsingSupabase() && supabase;

  // Check existing users in Supabase
  if (usingSupabase) {
    try {
      const { data: existing } = await supabase
        .from('app_users')
        .select('username')
        .eq('username', cleanUser)
        .maybeSingle();

      if (existing) {
        throw new Error('Username / Email ini sudah terdaftar.');
      }
    } catch (err) {
      if (!err.message.includes('already registered') && !err.message.includes('sudah terdaftar')) {
        console.warn('[Auth] Supabase check user table failed, falling back to local:', err.message);
      } else {
        throw err;
      }
    }
  }

  // Check local users
  const localUsers = await loadLocalUsers();
  if (localUsers.some((u) => u.username === cleanUser)) {
    throw new Error('Username / Email ini sudah terdaftar.');
  }

  const { hash, salt } = hashPassword(password);
  const newUser = {
    id: 'user-' + Date.now(),
    username: cleanUser,
    password_hash: hash,
    salt,
    created_at: new Date().toISOString()
  };

  // Save to Supabase if available
  if (usingSupabase) {
    try {
      await supabase.from('app_users').insert(newUser);
    } catch (err) {
      console.warn('[Auth] Gagal simpan user ke Supabase:', err.message);
    }
  }

  // Save to local file
  localUsers.push(newUser);
  await saveLocalUsers(localUsers);

  // Return logged in session
  return generateAuthToken(cleanUser);
}

/**
 * Authenticate username and password
 */
export async function authenticateUser(username, password) {
  const cleanUser = username.trim().toLowerCase();

  // 1. Check admin credentials from .env
  const admin = getAdminCredentials();
  if (cleanUser === admin.username && password === admin.password) {
    return generateAuthToken(cleanUser);
  }

  // 2. Check Supabase app_users table
  const supabase = getSupabaseClient();
  if (isUsingSupabase() && supabase) {
    try {
      const { data: userRow } = await supabase
        .from('app_users')
        .select('*')
        .eq('username', cleanUser)
        .maybeSingle();

      if (userRow && userRow.password_hash && userRow.salt) {
        if (verifyPassword(password, userRow.salt, userRow.password_hash)) {
          return generateAuthToken(cleanUser);
        }
      }
    } catch (err) {
      console.warn('[Auth] Query app_users di Supabase gagal:', err.message);
    }
  }

  // 3. Check local users.json
  const localUsers = await loadLocalUsers();
  const found = localUsers.find((u) => u.username === cleanUser);
  if (found && found.password_hash && found.salt) {
    if (verifyPassword(password, found.salt, found.password_hash)) {
      return generateAuthToken(cleanUser);
    }
  }

  return null;
}
