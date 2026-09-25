import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import ws from 'ws';
import { ALL_WEBHOOK_EVENTS } from './notifier.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_FILE = path.resolve(__dirname, '../config.json');
const STATE_FILE = path.resolve(__dirname, '../state.json');
const CACHE_FILE = path.resolve(__dirname, '../cache.json');
const SENT_VIDEOS_FILE = path.resolve(__dirname, '../sent_videos.json');

// In-memory set of video IDs that have already been sent to Discord (to prevent duplicate spam)
const sentVideosSet = new Set();
let sentVideosLoaded = false;

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
    const groups = (parsed.groups || []).map((g) => {
      let webhooks = [];
      let primaryUrl = '';
      if (Array.isArray(g.webhooks) && g.webhooks.length > 0) {
        webhooks = g.webhooks.map((w) => ({
          url: (w.url || '').trim(),
          name: (w.name || 'Default').trim(),
          events: Array.isArray(w.events) && w.events.length > 0 ? w.events : ALL_WEBHOOK_EVENTS,
          mention: (w.mention || 'everyone').trim(),
          mentionRole: (w.mentionRole || '').trim()
        }));
        primaryUrl = webhooks[0]?.url || g.webhookUrl || '';
      } else if (g.webhookUrl) {
        primaryUrl = g.webhookUrl;
        webhooks = [{
          url: g.webhookUrl,
          name: 'Default',
          events: ALL_WEBHOOK_EVENTS,
          mention: (g.mention || 'everyone').trim(),
          mentionRole: (g.mentionRole || '').trim()
        }];
      }
      return {
        ...g,
        webhookUrl: primaryUrl,
        webhooks,
        taskReminderStartTime: g.taskReminderStartTime || '09:00',
        taskDeadline: g.taskDeadline || '22:00',
        taskWarningIntervalMinutes: g.taskWarningIntervalMinutes !== undefined ? Number(g.taskWarningIntervalMinutes) : 60,
        taskReminder10MinEnabled: g.taskReminder10MinEnabled !== undefined ? Boolean(g.taskReminder10MinEnabled) : true,
        taskReminderMinutes: g.taskReminderMinutes !== undefined ? Number(g.taskReminderMinutes) : 10,
        taskReminderEnabled: g.taskReminderEnabled !== undefined ? Boolean(g.taskReminderEnabled) : true
      };
    });
    return {
      appUrl: parsed.appUrl || process.env.APP_URL || '',
      checkIntervalSeconds: parsed.checkIntervalSeconds || 120,
      delayBetweenAccountsMs: parsed.delayBetweenAccountsMs || 2000,
      groups
    };
  } catch {
    return {
      appUrl: process.env.APP_URL || '',
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

/**
 * Load sent video history from sent_videos.json
 */
export async function loadSentVideos() {
  if (sentVideosLoaded) return sentVideosSet;
  try {
    const raw = await fs.readFile(SENT_VIDEOS_FILE, 'utf-8');
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) {
      for (const id of arr) {
        sentVideosSet.add(String(id));
      }
    }
  } catch {
    // File will be created on first mark or seed
  }
  sentVideosLoaded = true;
  return sentVideosSet;
}

/**
 * Synchronous check if a video has already been posted to Discord webhook
 */
export function hasVideoBeenSentSync(username, videoId) {
  if (!videoId) return false;
  const vId = String(videoId);
  const u = (username || '').replace(/^@/, '').toLowerCase();
  return sentVideosSet.has(vId) || (u && sentVideosSet.has(`${u}:${vId}`));
}

/**
 * Check if a video has already been posted to Discord webhook
 */
export async function hasVideoBeenSent(username, videoId) {
  if (!videoId) return false;
  if (!sentVideosLoaded) await loadSentVideos();
  return hasVideoBeenSentSync(username, videoId);
}

/**
 * Mark a video as sent to Discord to prevent duplicate webhook notifications
 */
export async function markVideoAsSent(username, videoId) {
  if (!videoId) return;
  if (!sentVideosLoaded) await loadSentVideos();
  const vId = String(videoId);
  const u = (username || '').replace(/^@/, '').toLowerCase();
  sentVideosSet.add(vId);
  if (u) sentVideosSet.add(`${u}:${vId}`);

  try {
    const arr = Array.from(sentVideosSet);
    await fs.writeFile(SENT_VIDEOS_FILE, JSON.stringify(arr, null, 2), 'utf-8');
  } catch (err) {
    console.error('[DB] Gagal menyimpan sent_videos:', err.message);
  }
}

/**
 * Pre-populate sent_videos with existing cached videos so historical videos are never alerted as new.
 * IMPORTANT: Only videos that are explicitly marked as webhookSent === true OR uploaded BEFORE today (WIB)
 * are seeded as sent. Today's videos that have NOT been sent to Discord will NOT be seeded,
 * allowing the tracker to reliably dispatch webhooks for them!
 */
export async function seedSentVideosFromCache(cache) {
  if (!cache) return;
  if (!sentVideosLoaded) await loadSentVideos();

  const nowWIB = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta' }).format(new Date());
  const startOfDayWIB = Math.floor(new Date(`${nowWIB}T00:00:00+07:00`).getTime() / 1000);

  let added = 0;
  for (const [user, data] of Object.entries(cache)) {
    const cleanUser = user.replace(/^@/, '').toLowerCase();
    const videos = data.recentVideos || (data.latestVideo ? [data.latestVideo] : []);
    for (const v of videos) {
      if (v && v.id) {
        const vId = String(v.id);
        const isHistorical = v.createTime && v.createTime < startOfDayWIB;
        const explicitlySent = v.webhookSent === true;

        if (isHistorical || explicitlySent) {
          if (!sentVideosSet.has(vId)) {
            sentVideosSet.add(vId);
            sentVideosSet.add(`${cleanUser}:${vId}`);
            added++;
          }
        }
      }
    }
  }

  if (added > 0) {
    try {
      const arr = Array.from(sentVideosSet);
      await fs.writeFile(SENT_VIDEOS_FILE, JSON.stringify(arr, null, 2), 'utf-8');
      console.log(`[DB] Berhasil menyinkronkan ${sentVideosSet.size} riwayat video terkirim (anti-spam aktif).`);
    } catch {}
  }
}

/**
 * Load cached creator profiles and video list from Supabase cloud database
 * Ensures instant data availability on server startup or page refresh!
 */
export async function loadAccountCacheFromDb() {
  const cache = {};

  if (isSupabaseActive && supabaseClient) {
    try {
      const { data, error } = await supabaseClient
        .from('tracked_accounts')
        .select('username, group_id, nickname, avatar_url, last_video_id, last_post_time, last_check_time');

      if (!error && Array.isArray(data)) {
        for (const row of data) {
          if (!row.username) continue;
          const u = row.username.toLowerCase();
          let videos = [];
          if (row.last_video_id) {
            try {
              if (row.last_video_id.startsWith('[') || row.last_video_id.startsWith('{')) {
                const parsed = JSON.parse(row.last_video_id);
                const rawArr = Array.isArray(parsed) ? parsed : [parsed];
                videos = rawArr.map((v) => {
                  const vId = String(v.id || '');
                  const isSent = v.webhookSent === true || hasVideoBeenSentSync(u, vId);
                  if (isSent && vId) {
                    sentVideosSet.add(vId);
                    sentVideosSet.add(`${u}:${vId}`);
                  }
                  return {
                    id: vId,
                    createTime: Number(v.createTime) || 0,
                    desc: v.desc || '',
                    url: v.url || `https://www.tiktok.com/@${u}/video/${vId}`,
                    webhookSent: isSent,
                    sentAt: v.sentAt || null
                  };
                });
              } else {
                const isSent = hasVideoBeenSentSync(u, row.last_video_id);
                videos = [{
                  id: String(row.last_video_id),
                  createTime: Number(row.last_post_time) || 0,
                  url: `https://www.tiktok.com/@${u}/video/${row.last_video_id}`,
                  webhookSent: isSent
                }];
              }
            } catch {
              videos = [{
                id: String(row.last_video_id),
                createTime: Number(row.last_post_time) || 0,
                url: `https://www.tiktok.com/@${u}/video/${row.last_video_id}`,
                webhookSent: hasVideoBeenSentSync(u, row.last_video_id)
              }];
            }
          }

          cache[u] = {
            user: {
              nickname: row.nickname || u,
              uniqueId: u,
              avatar: row.avatar_url || ''
            },
            groupId: row.group_id,
            latestVideo: videos[0] || null,
            recentVideos: videos,
            lastUpdated: Number(row.last_check_time) || Date.now()
          };
        }
      }
    } catch (err) {
      console.error('[DB] Gagal memuat cache dari Supabase:', err.message);
    }
  }

  // Merge with local cache if present
  const localCache = await readLocalCache();
  return { ...localCache, ...cache };
}

/**
 * Persist an account scan result to Supabase tracked_accounts table
 */
export async function saveAccountCacheToDb(username, cacheData) {
  if (!username) return;
  const cleanUser = username.replace(/^@/, '').toLowerCase();

  // 1. Update local cache file
  try {
    const local = await readLocalCache();
    local[cleanUser] = cacheData;
    await writeLocalCache(local);
  } catch {
    // Ignore local error
  }

  // 2. Persist to Supabase cloud database
  if (isSupabaseActive && supabaseClient) {
    try {
      const recentVideos = cacheData.recentVideos || (cacheData.latestVideo ? [cacheData.latestVideo] : []);
      const latestVideo = recentVideos[0] || null;

      const mappedVideos = recentVideos.map(v => {
        const vId = String(v.id || '');
        const isSent = v.webhookSent === true || hasVideoBeenSentSync(cleanUser, vId);
        return {
          id: vId,
          createTime: Number(v.createTime) || 0,
          desc: v.desc || '',
          url: v.url || `https://www.tiktok.com/@${cleanUser}/video/${vId}`,
          webhookSent: isSent,
          sentAt: v.sentAt || (isSent ? Date.now() : null)
        };
      });

      const payload = {
        nickname: cacheData.user?.nickname || cleanUser,
        avatar_url: cacheData.user?.avatar || '',
        last_video_id: mappedVideos.length > 0 ? JSON.stringify(mappedVideos) : null,
        last_post_time: latestVideo?.createTime || null,
        last_check_time: Date.now()
      };

      await supabaseClient
        .from('tracked_accounts')
        .update(payload)
        .eq('username', cleanUser);
    } catch (err) {
      console.error(`[DB] Gagal menyimpan cache akun @${cleanUser} ke Supabase:`, err.message);
    }
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

        let webhooks = [];
        let primaryWebhookUrl = '';
        let taskReminderStartTime = '09:00';
        let taskDeadline = '22:00';
        let taskWarningIntervalMinutes = 60;
        let taskReminder10MinEnabled = true;
        let taskReminderMinutes = 10;
        let taskReminderEnabled = true;

        if (g.webhook_url) {
          if (g.webhook_url.startsWith('[') || g.webhook_url.startsWith('{')) {
            try {
              const parsed = JSON.parse(g.webhook_url);
              if (Array.isArray(parsed)) {
                webhooks = parsed.map((w) => ({
                  url: (w.url || '').trim(),
                  name: (w.name || 'Default').trim(),
                  events: Array.isArray(w.events) && w.events.length > 0 ? w.events : ALL_WEBHOOK_EVENTS,
                  mention: (w.mention || 'everyone').trim(),
                  mentionRole: (w.mentionRole || '').trim()
                }));
              } else if (parsed && typeof parsed === 'object') {
                const list = Array.isArray(parsed.webhooks) ? parsed.webhooks : [];
                webhooks = list.map((w) => ({
                  url: (w.url || '').trim(),
                  name: (w.name || 'Default').trim(),
                  events: Array.isArray(w.events) && w.events.length > 0 ? w.events : ALL_WEBHOOK_EVENTS,
                  mention: (w.mention || 'everyone').trim(),
                  mentionRole: (w.mentionRole || '').trim()
                }));
                if (parsed.taskReminderStartTime) taskReminderStartTime = parsed.taskReminderStartTime;
                if (parsed.taskDeadline) taskDeadline = parsed.taskDeadline;
                if (parsed.taskWarningIntervalMinutes !== undefined) taskWarningIntervalMinutes = Number(parsed.taskWarningIntervalMinutes);
                if (parsed.taskReminder10MinEnabled !== undefined) taskReminder10MinEnabled = Boolean(parsed.taskReminder10MinEnabled);
                if (parsed.taskReminderMinutes !== undefined) taskReminderMinutes = Number(parsed.taskReminderMinutes);
                if (parsed.taskReminderEnabled !== undefined) taskReminderEnabled = Boolean(parsed.taskReminderEnabled);
              }
              primaryWebhookUrl = webhooks[0]?.url || '';
            } catch {
              primaryWebhookUrl = g.webhook_url;
              webhooks = [{ url: g.webhook_url, name: 'Default', events: ALL_WEBHOOK_EVENTS, mention: 'everyone', mentionRole: '' }];
            }
          } else {
            primaryWebhookUrl = g.webhook_url;
            webhooks = [{ url: g.webhook_url, name: 'Default', events: ALL_WEBHOOK_EVENTS, mention: 'everyone', mentionRole: '' }];
          }
        }

        return {
          id: g.id,
          name: g.name,
          webhookUrl: primaryWebhookUrl,
          webhooks,
          taskReminderStartTime: taskReminderStartTime || '09:00',
          taskDeadline,
          taskWarningIntervalMinutes,
          taskReminder10MinEnabled,
          taskReminderMinutes,
          taskReminderEnabled,
          accounts: groupAccounts
        };
      });

      const local = await readLocalConfig();
      const fullConfig = {
        appUrl: local.appUrl || process.env.APP_URL || '',
        checkIntervalSeconds: settingsData?.check_interval_seconds || 120,
        delayBetweenAccountsMs: settingsData?.delay_between_accounts_ms || 2000,
        groups
      };

      // Keep local file updated as fallback cache
      writeLocalConfig(fullConfig).catch(() => {});

      return fullConfig;
    } catch (err) {
      console.error('[DB] Gagal membaca dari Supabase, beralih ke cache lokal:', err.message);
    }
  }

  return await readLocalConfig();
}

/**
 * Save / Update Global Settings
 */
export async function saveSettings(intervalSeconds, delayMs, appUrl = undefined) {
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
  if (appUrl !== undefined) local.appUrl = appUrl;
  await writeLocalConfig(local);
}

/**
 * Create or Update a Group
 */
export async function upsertGroup(group) {
  const webhooksToSave = Array.isArray(group.webhooks) && group.webhooks.length > 0
    ? group.webhooks
    : (group.webhookUrl ? [{ url: group.webhookUrl, name: 'Default', events: ALL_WEBHOOK_EVENTS }] : []);

  const taskReminderStartTime = group.taskReminderStartTime || '09:00';
  const taskDeadline = group.taskDeadline || '22:00';
  const taskWarningIntervalMinutes = group.taskWarningIntervalMinutes !== undefined ? Number(group.taskWarningIntervalMinutes) : 60;
  const taskReminder10MinEnabled = group.taskReminder10MinEnabled !== undefined ? Boolean(group.taskReminder10MinEnabled) : true;
  const taskReminderMinutes = group.taskReminderMinutes !== undefined ? Number(group.taskReminderMinutes) : 10;
  const taskReminderEnabled = group.taskReminderEnabled !== undefined ? Boolean(group.taskReminderEnabled) : true;

  const storedWebhookValue = JSON.stringify({
    webhooks: webhooksToSave,
    taskReminderStartTime,
    taskDeadline,
    taskWarningIntervalMinutes,
    taskReminder10MinEnabled,
    taskReminderMinutes,
    taskReminderEnabled
  });

  if (isSupabaseActive && supabaseClient) {
    try {
      await supabaseClient
        .from('groups')
        .upsert({
          id: group.id,
          name: group.name,
          webhook_url: storedWebhookValue
        });
    } catch (err) {
      console.error('[DB] Gagal upsert group ke Supabase:', err.message);
    }
  }

  // Update local file for redundancy
  const local = await readLocalConfig();
  const idx = local.groups.findIndex((g) => g.id === group.id);
  const groupObj = {
    ...group,
    webhookUrl: webhooksToSave[0]?.url || group.webhookUrl || '',
    webhooks: webhooksToSave,
    taskReminderStartTime,
    taskDeadline,
    taskWarningIntervalMinutes,
    taskReminder10MinEnabled,
    taskReminderMinutes,
    taskReminderEnabled
  };
  if (idx >= 0) {
    local.groups[idx] = { ...local.groups[idx], ...groupObj };
  } else {
    local.groups.push({ ...groupObj, accounts: groupObj.accounts || [] });
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
          let cleanId = row.last_video_id;
          if (cleanId && (cleanId.startsWith('[') || cleanId.startsWith('{'))) {
            try {
              const parsed = JSON.parse(cleanId);
              cleanId = Array.isArray(parsed) ? (parsed[0]?.id || null) : (parsed?.id || null);
            } catch {
              cleanId = row.last_video_id;
            }
          }
          stateMap[row.username] = {
            lastVideoId: cleanId,
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
