import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import ws from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_FILE = path.resolve(__dirname, '../config.json');
const STATE_FILE = path.resolve(__dirname, '../state.json');
const CACHE_FILE = path.resolve(__dirname, '../cache.json');

let supabaseClient = null;
let isSupabaseActive = false;

export const DEFAULT_SUPABASE_URL = 'https://nooymoegamxwwwdvzffa.supabase.co';
export const DEFAULT_SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5vb3ltb2VnYW14d3d3ZHZ6ZmZhIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc5MDIzNzkyNywiZXhwIjoyMTA1ODEzOTI3fQ.JlmO7AyjaknDF1XIn_7z9esIYdtMVHIsIAP7DPCX-7I';

// Initialize Supabase (Permanent default cloud database)
export function initSupabase(
  url = process.env.SUPABASE_URL || DEFAULT_SUPABASE_URL,
  key = process.env.SUPABASE_KEY || DEFAULT_SUPABASE_KEY
) {
  if (url && key && url.startsWith('http')) {
    try {
      supabaseClient = createClient(url, key, {
        auth: { persistSession: false },
        realtime: { transport: ws }
      });
      isSupabaseActive = true;
      return true;
    } catch (err) {
      console.error('[DB] Gagal menginisialisasi client Supabase:', err.message);
      isSupabaseActive = false;
      return false;
    }
  }
  isSupabaseActive = false;
  return false;
}

// Initial attempt (Always connects to Supabase permanently)
initSupabase();

export function isUsingSupabase() {
  return isSupabaseActive;
}

export function getSupabaseClient() {
  return supabaseClient;
}

// --- Local File Helpers ---
async function readLocalConfig() {
  try {
    const raw = await fs.readFile(CONFIG_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    return {
      checkIntervalSeconds: parsed.checkIntervalSeconds || 120,
      delayBetweenAccountsMs: parsed.delayBetweenAccountsMs || 2000,
      groups: parsed.groups || []
    };
  } catch {
    return {
      checkIntervalSeconds: 120,
      delayBetweenAccountsMs: 2000,
      groups: []
    };
  }
}

async function writeLocalConfig(config) {
  await fs.writeFile(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
}

async function readLocalState() {
  try {
    const raw = await fs.readFile(STATE_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function writeLocalState(state) {
  await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
}

export async function readLocalCache() {
  try {
    const raw = await fs.readFile(CACHE_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

export async function writeLocalCache(cache) {
  try {
    await fs.writeFile(CACHE_FILE, JSON.stringify(cache, null, 2), 'utf-8');
  } catch (err) {
    console.error('[DB] Gagal menulis cache:', err.message);
  }
}

// --- Unified Database Interface ---

/**
 * Load full application config & groups
 */
export async function getFullConfig() {
  if (isSupabaseActive && supabaseClient) {
    try {
      // 1. Fetch settings
      const { data: settingsData } = await supabaseClient
        .from('app_settings')
        .select('*')
        .eq('id', 'global')
        .single();

      // 2. Fetch groups
      const { data: groupsData, error: groupsError } = await supabaseClient
        .from('groups')
        .select('*')
        .order('created_at', { ascending: true });

      if (groupsError) throw groupsError;

      // 3. Fetch accounts
      const { data: accountsData, error: accountsError } = await supabaseClient
        .from('tracked_accounts')
        .select('*');

      if (accountsError) throw accountsError;

      // Assemble groups with their accounts
      const groups = (groupsData || []).map((g) => {
        const groupAccounts = (accountsData || [])
          .filter((a) => a.group_id === g.id)
          .map((a) => a.username);
        return {
          id: g.id,
          name: g.name,
          webhookUrl: g.webhook_url,
          accounts: groupAccounts
        };
      });

      return {
        checkIntervalSeconds: settingsData?.check_interval_seconds || 120,
        delayBetweenAccountsMs: settingsData?.delay_between_accounts_ms || 2000,
        groups
      };
    } catch (err) {
      console.error('[DB] Gagal membaca dari Supabase, beralih ke cache lokal:', err.message);
    }
  }

  return await readLocalConfig();
}

/**
 * Save / Update Global Settings
 */
export async function saveSettings(intervalSeconds, delayMs) {
  if (isSupabaseActive && supabaseClient) {
    try {
      await supabaseClient
        .from('app_settings')
        .upsert({
          id: 'global',
          check_interval_seconds: intervalSeconds,
          delay_between_accounts_ms: delayMs,
          updated_at: new Date().toISOString()
        });
    } catch (err) {
      console.error('[DB] Gagal menyimpan settings ke Supabase:', err.message);
    }
  }

  const local = await readLocalConfig();
  if (intervalSeconds) local.checkIntervalSeconds = intervalSeconds;
  if (delayMs) local.delayBetweenAccountsMs = delayMs;
  await writeLocalConfig(local);
}

/**
 * Create or Update a Group
 */
export async function upsertGroup(group) {
  if (isSupabaseActive && supabaseClient) {
    try {
      await supabaseClient
        .from('groups')
        .upsert({
          id: group.id,
          name: group.name,
          webhook_url: group.webhookUrl || ''
        });
    } catch (err) {
      console.error('[DB] Gagal upsert group ke Supabase:', err.message);
    }
  }

  // Update local file for redundancy
  const local = await readLocalConfig();
  const idx = local.groups.findIndex((g) => g.id === group.id);
  if (idx >= 0) {
    local.groups[idx] = { ...local.groups[idx], ...group };
  } else {
    local.groups.push({ ...group, accounts: group.accounts || [] });
  }
  await writeLocalConfig(local);
}

/**
 * Delete a Group
 */
export async function removeGroup(groupId) {
  if (isSupabaseActive && supabaseClient) {
    try {
      await supabaseClient.from('groups').delete().eq('id', groupId);
    } catch (err) {
      console.error('[DB] Gagal menghapus group di Supabase:', err.message);
    }
  }

  const local = await readLocalConfig();
  local.groups = local.groups.filter((g) => g.id !== groupId);
  await writeLocalConfig(local);
}

/**
 * Add Account to Group
 */
export async function addAccountToGroup(groupId, username, user = null, latestVideo = null) {
  const cleanUser = username.replace(/^@/, '').toLowerCase();

  if (isSupabaseActive && supabaseClient) {
    try {
      await supabaseClient
        .from('tracked_accounts')
        .upsert({
          username: cleanUser,
          group_id: groupId,
          nickname: user?.nickname || cleanUser,
          avatar_url: user?.avatar || '',
          last_video_id: latestVideo?.id || null,
          last_post_time: latestVideo?.createTime || null,
          last_check_time: Date.now()
        });
    } catch (err) {
      console.error('[DB] Gagal menambah akun ke Supabase:', err.message);
    }
  }

  const local = await readLocalConfig();
  const group = local.groups.find((g) => g.id === groupId);
  if (group) {
    if (!group.accounts.includes(cleanUser)) {
      group.accounts.push(cleanUser);
      await writeLocalConfig(local);
    }
  }

  if (latestVideo) {
    const state = await readLocalState();
    state[cleanUser] = {
      lastVideoId: latestVideo.id,
      lastPostTime: latestVideo.createTime,
      lastCheckTime: Date.now()
    };
    await writeLocalState(state);
  }
}

/**
 * Add Multiple Accounts in Batch to Group (Fast Bulk Insertion)
 */
export async function addAccountsBatchToGroup(groupId, rawList) {
  const cleanUsers = [...new Set(
    rawList
      .map((u) =>
        u
          .trim()
          .replace(/^["'@]+|["']+$/g, '')
          .replace(/https?:\/\/(www\.)?tiktok\.com\/@/i, '')
          .replace(/[/?#].*$/, '')
          .toLowerCase()
      )
      .filter((u) => u.length > 0)
  )];

  if (cleanUsers.length === 0) {
    return { added: [], skipped: [] };
  }

  const config = await getFullConfig();
  const group = config.groups.find((g) => g.id === groupId);
  if (!group) throw new Error('Grup tidak ditemukan');

  const existingSet = new Set((group.accounts || []).map((a) => a.toLowerCase()));
  const toAdd = cleanUsers.filter((u) => !existingSet.has(u));
  const skipped = cleanUsers.filter((u) => existingSet.has(u));

  if (toAdd.length > 0) {
    // 1. Supabase bulk upsert
    if (isSupabaseActive && supabaseClient) {
      try {
        const rows = toAdd.map((username) => ({
          username,
          group_id: groupId,
          nickname: username,
          avatar_url: '',
          last_check_time: Date.now()
        }));
        await supabaseClient.from('tracked_accounts').upsert(rows, { onConflict: 'username' });
      } catch (err) {
        console.error('[DB] Gagal bulk insert akun ke Supabase:', err.message);
      }
    }

    // 2. Local config update
    const local = await readLocalConfig();
    const localGroup = local.groups.find((g) => g.id === groupId);
    if (localGroup) {
      if (!localGroup.accounts) localGroup.accounts = [];
      for (const u of toAdd) {
        if (!localGroup.accounts.includes(u)) {
          localGroup.accounts.push(u);
        }
      }
      await writeLocalConfig(local);
    }
  }

  return { added: toAdd, skipped };
}

/**
 * Remove Account from Group
 */
export async function removeAccountFromGroup(groupId, username) {
  const cleanUser = username.replace(/^@/, '').toLowerCase();

  if (isSupabaseActive && supabaseClient) {
    try {
      await supabaseClient
        .from('tracked_accounts')
        .delete()
        .eq('group_id', groupId)
        .eq('username', cleanUser);
    } catch (err) {
      console.error('[DB] Gagal menghapus akun di Supabase:', err.message);
    }
  }

  const local = await readLocalConfig();
  const group = local.groups.find((g) => g.id === groupId);
  if (group) {
    group.accounts = group.accounts.filter((a) => a !== cleanUser);
    await writeLocalConfig(local);
  }

  const state = await readLocalState();
  delete state[cleanUser];
  await writeLocalState(state);
}

/**
 * Edit / Rename an Account in a Group
 */
export async function editAccountInGroup(groupId, oldUsername, newUsername, newUser = null, newLatestVideo = null) {
  const cleanOld = oldUsername.trim().replace(/^@/, '').toLowerCase();
  const cleanNew = newUsername.trim().replace(/^@/, '').toLowerCase();

  if (isSupabaseActive && supabaseClient) {
    try {
      // 1. Delete old record
      await supabaseClient
        .from('tracked_accounts')
        .delete()
        .eq('group_id', groupId)
        .eq('username', cleanOld);

      // 2. Insert new record
      await supabaseClient
        .from('tracked_accounts')
        .upsert({
          username: cleanNew,
          group_id: groupId,
          nickname: newUser?.nickname || cleanNew,
          avatar_url: newUser?.avatar || '',
          last_video_id: newLatestVideo?.id || null,
          last_post_time: newLatestVideo?.createTime || null,
          last_check_time: Date.now()
        });
    } catch (err) {
      console.error('[DB] Gagal update akun di Supabase:', err.message);
    }
  }

  // Update local config
  const local = await readLocalConfig();
  const group = local.groups.find((g) => g.id === groupId);
  if (group) {
    const idx = group.accounts.indexOf(cleanOld);
    if (idx !== -1) {
      group.accounts[idx] = cleanNew;
    } else if (!group.accounts.includes(cleanNew)) {
      group.accounts.push(cleanNew);
    }
    await writeLocalConfig(local);
  }

  // Update local state
  const state = await readLocalState();
  delete state[cleanOld];
  if (newLatestVideo) {
    state[cleanNew] = {
      lastVideoId: newLatestVideo.id,
      lastPostTime: newLatestVideo.createTime,
      lastCheckTime: Date.now()
    };
  }
  await writeLocalState(state);

  return { cleanOld, cleanNew };
}

/**
 * Get state for accounts (last known video IDs)
 */
export async function getAccountStates() {
  if (isSupabaseActive && supabaseClient) {
    try {
      const { data, error } = await supabaseClient
        .from('tracked_accounts')
        .select('username, last_video_id, last_post_time, last_check_time');

      if (!error && data) {
        const stateMap = {};
        for (const row of data) {
          stateMap[row.username] = {
            lastVideoId: row.last_video_id,
            lastPostTime: row.last_post_time,
            lastCheckTime: row.last_check_time
          };
        }
        return stateMap;
      }
    } catch (err) {
      console.error('[DB] Gagal membaca state dari Supabase:', err.message);
    }
  }

  return await readLocalState();
}

/**
 * Update account last checked video ID
 */
export async function updateAccountState(username, videoId, postTime) {
  const cleanUser = username.replace(/^@/, '').toLowerCase();

  if (isSupabaseActive && supabaseClient) {
    try {
      await supabaseClient
        .from('tracked_accounts')
        .update({
          last_video_id: videoId,
          last_post_time: postTime,
          last_check_time: Date.now()
        })
        .eq('username', cleanUser);
    } catch (err) {
      console.error('[DB] Gagal update state di Supabase:', err.message);
    }
  }

  const state = await readLocalState();
  state[cleanUser] = {
    lastVideoId: videoId,
    lastPostTime: postTime,
    lastCheckTime: Date.now()
  };
  await writeLocalState(state);
}

/**
 * Migrate all local data (config.json & state.json) to Supabase
 */
export async function migrateLocalToSupabase() {
  if (!isSupabaseActive || !supabaseClient) {
    throw new Error('Supabase client belum terhubung');
  }

  const localConfig = await readLocalConfig();
  const localState = await readLocalState();

  // 1. Migrate settings
  await supabaseClient.from('app_settings').upsert({
    id: 'global',
    check_interval_seconds: localConfig.checkIntervalSeconds || 120,
    delay_between_accounts_ms: localConfig.delayBetweenAccountsMs || 2000
  });

  // 2. Migrate groups & accounts
  for (const group of localConfig.groups || []) {
    await supabaseClient.from('groups').upsert({
      id: group.id,
      name: group.name,
      webhook_url: group.webhookUrl || ''
    });

    for (const acc of group.accounts || []) {
      const state = localState[acc.toLowerCase()] || {};
      await supabaseClient.from('tracked_accounts').upsert({
        username: acc.toLowerCase(),
        group_id: group.id,
        nickname: acc,
        last_video_id: state.lastVideoId || null,
        last_post_time: state.lastPostTime || null,
        last_check_time: state.lastCheckTime || Date.now()
      });
    }
  }

  return { success: true, count: localConfig.groups?.length || 0 };
}
