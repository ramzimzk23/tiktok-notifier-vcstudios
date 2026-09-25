import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getTikTokUserVideos } from './scraper.js';
import {
  sendDiscordNotification,
  sendDiscordDoubleUploadWarning,
  sendDiscordIncompleteWarning,
  sendDiscordDailyReport,
  sendDiscordTestPing
} from './notifier.js';
import {
  getFullConfig,
  saveSettings,
  upsertGroup,
  removeGroup,
  addAccountToGroup,
  addAccountsBatchToGroup,
  editAccountInGroup,
  removeAccountFromGroup,
  getAccountStates,
  isUsingSupabase,
  initSupabase,
  migrateLocalToSupabase,
  loadAccountCacheFromDb
} from './db.js';
import { authenticateUser, registerUser, verifyAuthToken, getAdminCredentials } from './auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, '../public');

export const runtimeState = {
  isRunning: true,
  isScanning: false,
  scanProgress: {
    current: 0,
    total: 0,
    currentAccount: '',
    status: 'idle'
  },
  lastPollTime: null,
  nextPollTime: null,
  logs: [],
  accountCache: {}
};

export function addLog(message, type = 'info') {
  const timestamp = new Date().toLocaleTimeString('id-ID');
  runtimeState.logs.unshift({ timestamp, message, type });
  if (runtimeState.logs.length > 60) {
    runtimeState.logs.pop();
  }
}

/**
 * Get date boundaries in Asia/Jakarta (WIB)
 * @param {number} offsetDays 0 for today, -1 for yesterday
 */
export function getJakartaDateInfo(offsetDays = 0) {
  const numOffset = parseInt(offsetDays, 10) || 0;
  const now = new Date();
  const targetDate = new Date(now.getTime() + (numOffset * 86400 * 1000));
  const dateStr = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta' }).format(targetDate);
  const startOfDayWIB = Math.floor(new Date(`${dateStr}T00:00:00+07:00`).getTime() / 1000);
  const endOfDayWIB = startOfDayWIB + 86400;
  const formattedDate = new Intl.DateTimeFormat('id-ID', {
    dateStyle: 'full',
    timeZone: 'Asia/Jakarta'
  }).format(targetDate);
  const isToday = numOffset === 0;
  const dayLabel = isToday ? 'Hari Ini' : (numOffset === -1 ? 'Kemarin (Hari Sebelumnya)' : `${Math.abs(numOffset)} hari lalu`);
  return { dateStr, startOfDayWIB, endOfDayWIB, formattedDate, offsetDays: numOffset, isToday, dayLabel };
}

/**
 * Generate complete Daily Report data for a clipper group
 * @param {object} group Group configuration
 * @param {object} accountCache Account cache
 * @param {number} offsetDays 0 for today, -1 for yesterday
 */
export function generateDailyReportData(group, accountCache = {}, offsetDays = 0) {
  const { dateStr, startOfDayWIB, endOfDayWIB, formattedDate, isToday, dayLabel } = getJakartaDateInfo(offsetDays);
  const target = 14;
  const accounts = group.accounts || [];

  const uploaded = [];
  const missing = [];
  const doubles = [];

  for (const rawAcc of accounts) {
    const acc = rawAcc.toLowerCase();
    const cached = accountCache[acc];
    const videos = cached?.recentVideos || (cached?.latestVideo ? [cached.latestVideo] : []);

    // Filter videos created on this date in WIB
    const targetVideos = videos.filter(
      (v) => v && v.createTime && v.createTime >= startOfDayWIB && v.createTime < endOfDayWIB
    );

    if (targetVideos.length > 0) {
      const topVideo = targetVideos[0];
      const videoUrl = topVideo.url || `https://www.tiktok.com/@${acc}/video/${topVideo.id}`;
      uploaded.push({
        account: acc,
        nickname: cached?.user?.nickname || acc,
        videoUrl,
        videoId: topVideo.id,
        desc: topVideo.desc || '',
        createTime: topVideo.createTime,
        uploadCountToday: targetVideos.length,
        todayVideos: targetVideos.map((v) => ({
          id: v.id,
          url: v.url || `https://www.tiktok.com/@${acc}/video/${v.id}`,
          createTime: v.createTime,
          desc: v.desc || ''
        }))
      });

      if (targetVideos.length > 1) {
        doubles.push({
          account: acc,
          count: targetVideos.length,
          videos: targetVideos.map((v) => ({
            id: v.id,
            url: v.url || `https://www.tiktok.com/@${acc}/video/${v.id}`,
            createTime: v.createTime
          }))
        });
      }
    } else {
      missing.push(acc);
    }
  }

  const uploadedCount = uploaded.length; // Number of unique accounts in group that uploaded on selected date
  const isCompleted = uploadedCount >= target; // 14 accounts each uploading 1 video = SELESAI
  const remainingNeeded = Math.max(0, target - uploadedCount);
  const percentage = Math.min(100, Math.round((uploadedCount / target) * 100));

  // Format clean text
  const copyLines = [];
  copyLines.push(`📊 DAILY REPORT CLIPPERS — ${group.name.toUpperCase()}`);
  copyLines.push(`📅 Hari/Tanggal: ${formattedDate} (${dayLabel})`);
  copyLines.push(`🎯 Target Kuota: 1 video di ${target} akun = Selesai`);
  copyLines.push(`📈 Pencapaian: ${uploadedCount}/${target} Akun (${percentage}%)`);
  copyLines.push(`⚡ Status: ${isCompleted ? '✅ SELESAI (Target 14 Akun Tuntas)' : `⚠️ BELUM SELESAI (Kurang ${remainingNeeded} Akun Lagi)`}`);
  copyLines.push('');
  copyLines.push(`✅ SUDAH UPLOAD (${uploadedCount} AKUN):`);
  if (uploaded.length === 0) {
    copyLines.push(`(Belum ada akun yang upload pada ${dayLabel.toLowerCase()})`);
  } else {
    uploaded.forEach((u, i) => {
      copyLines.push(`${i + 1}. @${u.account} — ${u.videoUrl}`);
    });
  }

  copyLines.push('');
  if (isCompleted) {
    copyLines.push(`🎉 Target ${target} akun telah terpenuhi (Selesai).`);
  } else {
    copyLines.push(`❌ BELUM UPLOAD (Kurang ${remainingNeeded} Akun Lagi Menuju Target):`);
    missing.forEach((m, i) => {
      copyLines.push(`${i + 1}. @${m}`);
    });
  }

  if (doubles.length > 0) {
    copyLines.push('');
    copyLines.push(`⚠️ PERINGATAN DOUBLE UPLOAD (${doubles.length} AKUN):`);
    doubles.forEach((d) => {
      copyLines.push(`• @${d.account} (${d.count} video ${isToday ? 'hari ini' : 'kemarin'}):`);
      d.videos.forEach((v) => {
        copyLines.push(`   - ${v.url}`);
      });
    });
  }

  const copyText = copyLines.join('\n');

  return {
    groupId: group.id,
    groupName: group.name,
    webhookUrl: group.webhookUrl || '',
    date: dateStr,
    formattedDate,
    offsetDays: parseInt(offsetDays, 10) || 0,
    isToday,
    dayLabel,
    target,
    totalAccounts: accounts.length,
    accounts,
    uploadedCount,
    remainingNeeded,
    missingCount: isCompleted ? 0 : remainingNeeded,
    percentage,
    isCompleted,
    uploaded,
    missing,
    doubles,
    copyText
  };
}

// In-Memory Login Rate Limiting (Brute-Force Protection)
const loginAttemptTracker = new Map();

function checkLoginRateLimit(ip) {
  const now = Date.now();
  const record = loginAttemptTracker.get(ip);
  if (!record) return { allowed: true };

  if (record.lockedUntil && now < record.lockedUntil) {
    const waitSec = Math.ceil((record.lockedUntil - now) / 1000);
    const waitMin = Math.ceil(waitSec / 60);
    return {
      allowed: false,
      error: `Akses diblokir sementara karena terlalu banyak percobaan login gagal dari IP Anda. Coba lagi dalam ${waitMin} menit (${waitSec} detik).`
    };
  }

  if (now > record.resetAt) {
    loginAttemptTracker.delete(ip);
    return { allowed: true };
  }

  return { allowed: true };
}

function recordLoginAttempt(ip, success) {
  const now = Date.now();
  if (success) {
    loginAttemptTracker.delete(ip);
    return;
  }

  const record = loginAttemptTracker.get(ip) || { count: 0, resetAt: now + 15 * 60 * 1000, lockedUntil: 0 };
  record.count += 1;

  // Lock out IP after 5 failed attempts for 15 minutes
  if (record.count >= 5) {
    record.lockedUntil = now + 15 * 60 * 1000;
  }

  loginAttemptTracker.set(ip, record);
}

export function createWebServer(port = 3000, triggerPollCallback = null) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = url.pathname;

    const sendJson = (data, status = 200) => {
      res.writeHead(status, {
        'Content-Type': 'application/json',
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY',
        'X-XSS-Protection': '1; mode=block',
        'Referrer-Policy': 'strict-origin-when-cross-origin',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS'
      });
      res.end(JSON.stringify(data));
    };

    const parseBody = async () => {
      return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', (chunk) => (body += chunk));
        req.on('end', () => {
          try {
            resolve(body ? JSON.parse(body) : {});
          } catch (e) {
            reject(e);
          }
        });
        req.on('error', reject);
      });
    };

    // CORS preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization'
      });
      res.end();
      return;
    }

    // 0. Public Auth Endpoints
    if (pathname === '/api/auth/login' && req.method === 'POST') {
      const clientIp = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket?.remoteAddress || '127.0.0.1';
      const rateLimit = checkLoginRateLimit(clientIp);
      if (!rateLimit.allowed) {
        addLog(`[Keamanan] Upaya login diblokir karena brute-force (IP: ${clientIp})`, 'error');
        sendJson({ success: false, error: rateLimit.error }, 429);
        return;
      }

      try {
        const body = await parseBody();
        const username = (body.username || '').trim();
        const password = (body.password || '').trim();

        const authResult = await authenticateUser(username, password);
        if (authResult) {
          recordLoginAttempt(clientIp, true);
          addLog(`Pengguna "${username}" (Role: ${authResult.role}) berhasil login ke sistem`, 'success');
          sendJson({ success: true, token: authResult.token, username: authResult.username, role: authResult.role });
        } else {
          recordLoginAttempt(clientIp, false);
          addLog(`Gagal login: Kredensial tidak valid untuk user "${username}" (IP: ${clientIp})`, 'warn');
          sendJson({ success: false, error: 'Username atau password salah!' }, 401);
        }
      } catch (err) {
        sendJson({ success: false, error: err.message }, 500);
      }
      return;
    }

    if (pathname === '/api/auth/register' && req.method === 'POST') {
      sendJson({ success: false, error: 'Pendaftaran akun baru telah dinonaktifkan secara permanen oleh Administrator.' }, 403);
      return;
    }

    if (pathname === '/api/auth/verify' && req.method === 'POST') {
      const authHeader = req.headers['authorization'] || '';
      const token = authHeader.replace(/^Bearer\s+/i, '');
      const valid = verifyAuthToken(token);
      sendJson({ valid: !!valid, user: valid ? valid.username : null, role: valid ? valid.role : null });
      return;
    }

    // Public Health Check Endpoint (For UptimeRobot / Keep-Alive)
    if ((pathname === '/health' || pathname === '/api/health') && req.method === 'GET') {
      sendJson({
        status: 'healthy',
        bot: 'VCStudios TikTok Notifier',
        uptimeSeconds: Math.floor(process.uptime()),
        timestamp: new Date().toISOString()
      });
      return;
    }

    // Public Daily Report Data API (No Login Required)
    if (pathname === '/api/public/daily-report' && req.method === 'GET') {
      try {
        const config = await getFullConfig();
        const groups = config.groups || [];
        const targetGroupId = url.searchParams.get('groupId') || url.searchParams.get('group');
        const dateParam = (url.searchParams.get('date') || '').toLowerCase();
        let offsetDays = parseInt(url.searchParams.get('offset') || '0', 10);
        if (dateParam === 'yesterday' || dateParam === 'kemarin' || dateParam === 'prev') {
          offsetDays = -1;
        }
        if (isNaN(offsetDays)) offsetDays = 0;

        // Ensure account cache is hydrated
        if (!runtimeState.accountCache || Object.keys(runtimeState.accountCache).length === 0) {
          try {
            const dbCache = await loadAccountCacheFromDb();
            if (dbCache && Object.keys(dbCache).length > 0) {
              runtimeState.accountCache = dbCache;
            }
          } catch {}
        }

        // Return clean public report without sensitive webhook URLs
        const groupReports = groups.map((g) => {
          const report = generateDailyReportData(g, runtimeState.accountCache, offsetDays);
          return {
            id: g.id,
            name: g.name,
            totalAccounts: g.accounts?.length || 0,
            report
          };
        });

        // Pick requested group or first group that has accounts
        let selected = null;
        if (targetGroupId) {
          selected = groupReports.find((g) => g.id === targetGroupId) || null;
        }
        if (!selected) {
          selected = groupReports.find((g) => g.totalAccounts > 0) || groupReports[0] || null;
        }

        const dateInfo = getJakartaDateInfo(offsetDays);

        sendJson({
          success: true,
          offsetDays,
          dateInfo,
          groups: groupReports.map((g) => ({ id: g.id, name: g.name, totalAccounts: g.totalAccounts })),
          selectedGroup: selected,
          timestamp: Date.now()
        });
      } catch (err) {
        sendJson({ success: false, error: err.message }, 500);
      }
      return;
    }

    // Auth Middleware for all other /api routes
    if (pathname.startsWith('/api/')) {
      const authHeader = req.headers['authorization'] || '';
      const token = authHeader.replace(/^Bearer\s+/i, '');
      const verified = verifyAuthToken(token);
      if (!verified) {
        sendJson({ error: 'Unauthorized', requireLogin: true }, 401);
        return;
      }
      req.user = verified;

      // Enforce Read-Only for Viewer role (can only perform GET requests)
      if (verified.role === 'Viewer' && req.method !== 'GET') {
        sendJson({
          success: false,
          error: 'Akses Ditolak: Akun Anda memiliki role Viewer (Hanya Baca) dan tidak memiliki izin untuk mengubah data.'
        }, 403);
        return;
      }
    }

    // 1. GET /api/status
    if (pathname === '/api/status' && req.method === 'GET') {
      try {
        const config = await getFullConfig();
        const state = await getAccountStates();

        // If memory cache is empty (e.g. server just booted/restarted), hydrate immediately from DB
        if (!runtimeState.accountCache || Object.keys(runtimeState.accountCache).length === 0) {
          try {
            const dbCache = await loadAccountCacheFromDb();
            if (dbCache && Object.keys(dbCache).length > 0) {
              runtimeState.accountCache = dbCache;
            }
          } catch {}
        }

        sendJson({
          config,
          state,
          isSupabase: isUsingSupabase(),
          runtime: {
            isRunning: runtimeState.isRunning,
            isScanning: runtimeState.isScanning,
            scanProgress: runtimeState.scanProgress,
            lastPollTime: runtimeState.lastPollTime,
            nextPollTime: runtimeState.nextPollTime,
            accountCache: runtimeState.accountCache,
            logs: runtimeState.logs
          }
        });
      } catch (err) {
        sendJson({ error: err.message }, 500);
      }
      return;
    }

    // 2. POST /api/check-now
    if (pathname === '/api/check-now' && req.method === 'POST') {
      if (triggerPollCallback) {
        addLog('Manual trigger pengecekan dijalankan oleh user', 'info');
        triggerPollCallback(true);
        sendJson({ success: true, message: 'Pengecekan akun dimulai' });
      } else {
        sendJson({ success: false, message: 'Poller callback tidak tersedia' }, 500);
      }
      return;
    }

    // 3. POST /api/test-webhook
    if (pathname === '/api/test-webhook' && req.method === 'POST') {
      try {
        const body = await parseBody();
        const config = await getFullConfig();
        const groupId = body.groupId;
        let group = config.groups.find((g) => g.id === groupId);

        if (!group && config.groups.length > 0) {
          group = config.groups[0];
        }

        const testUrl = body.webhookUrl || group?.webhooks?.[0]?.url || group?.webhookUrl;

        if (!testUrl) {
          sendJson({ success: false, error: 'Grup atau Webhook URL belum diisi' }, 400);
          return;
        }

        const username = body.username || group?.accounts?.[0];
        let sent = false;

        if (username) {
          addLog(`Menjalankan tes webhook grup "${group?.name || 'Test'}" untuk @${username}...`, 'info');
          const result = await getTikTokUserVideos(username);
          if (result.success && result.videos && result.videos.length > 0) {
            sent = await sendDiscordNotification(testUrl, result.user, result.videos[0], group?.name || 'Tes Webhook');
          }
        }

        // If no username or video fetch failed, send direct test ping embed
        if (!sent) {
          addLog(`Mengirim pesan tes koneksi langsung ke webhook "${group?.name || 'Discord'}"...`, 'info');
          sent = await sendDiscordTestPing(testUrl, group?.name || 'Tes Webhook');
        }

        if (sent) {
          addLog(`✅ Notifikasi tes berhasil dikirim ke webhook "${group?.name || 'Discord'}"!`, 'success');
          sendJson({ success: true, message: `Notifikasi berhasil dikirim ke webhook ${group?.name || 'Discord'}` });
        } else {
          addLog(`❌ Gagal mengirim webhook Discord untuk grup "${group?.name || 'Discord'}"`, 'error');
          sendJson({ success: false, message: 'Gagal mengirim ke Discord. Periksa URL webhook Anda.' }, 500);
        }
      } catch (err) {
        sendJson({ success: false, error: err.message }, 500);
      }
      return;
    }

    // 4. POST /api/groups (Create Group)
    if (pathname === '/api/groups' && req.method === 'POST') {
      try {
        const body = await parseBody();
        const name = (body.name || '').trim();
        const rawWebhooks = Array.isArray(body.webhooks) ? body.webhooks : [];
        const webhooks = rawWebhooks
          .filter((w) => w && w.url && typeof w.url === 'string' && w.url.trim().startsWith('http'))
          .map((w) => ({
            url: w.url.trim(),
            name: (w.name || '').trim(),
            events: Array.isArray(w.events) && w.events.length > 0 ? w.events : ['new_video', 'task_warning', 'double_upload', 'daily_report', 'account_not_found']
          }));

        const fallbackUrl = (body.webhookUrl || '').trim();
        if (webhooks.length === 0 && fallbackUrl) {
          webhooks.push({
            url: fallbackUrl,
            name: 'Default',
            events: ['new_video', 'task_warning', 'double_upload', 'daily_report', 'account_not_found']
          });
        }

        if (!name) {
          sendJson({ success: false, error: 'Nama grup tidak boleh kosong' }, 400);
          return;
        }

        const id = 'group-' + Date.now();
        const newGroup = {
          id,
          name,
          webhookUrl: webhooks[0]?.url || fallbackUrl || '',
          webhooks,
          accounts: []
        };

        await upsertGroup(newGroup);
        addLog(`Grup baru "${name}" berhasil dibuat (${webhooks.length} webhook terkonfigurasi)`, 'success');
        sendJson({ success: true, group: newGroup });
      } catch (err) {
        sendJson({ success: false, error: err.message }, 500);
      }
      return;
    }

    // 5. PUT /api/groups/:id (Edit Group)
    if (pathname.startsWith('/api/groups/') && req.method === 'PUT') {
      try {
        const groupId = pathname.replace('/api/groups/', '');
        const body = await parseBody();
        const config = await getFullConfig();
        const group = config.groups.find((g) => g.id === groupId);

        if (!group) {
          sendJson({ success: false, error: 'Grup tidak ditemukan' }, 404);
          return;
        }

        if (body.name) group.name = body.name.trim();

        if (Array.isArray(body.webhooks)) {
          group.webhooks = body.webhooks
            .filter((w) => w && w.url && typeof w.url === 'string' && w.url.trim().startsWith('http'))
            .map((w) => ({
              url: w.url.trim(),
              name: (w.name || '').trim(),
              events: Array.isArray(w.events) && w.events.length > 0 ? w.events : ['new_video', 'task_warning', 'double_upload', 'daily_report', 'account_not_found']
            }));
          group.webhookUrl = group.webhooks[0]?.url || '';
        } else if (body.webhookUrl !== undefined) {
          group.webhookUrl = body.webhookUrl.trim();
          if (group.webhookUrl) {
            group.webhooks = [{ url: group.webhookUrl, name: 'Default', events: ['new_video', 'task_warning', 'double_upload', 'daily_report', 'account_not_found'] }];
          } else {
            group.webhooks = [];
          }
        }

        await upsertGroup(group);
        addLog(`Grup "${group.name}" berhasil diperbarui (${group.webhooks?.length || 0} webhook terkonfigurasi)`, 'success');
        sendJson({ success: true, group });
      } catch (err) {
        sendJson({ success: false, error: err.message }, 500);
      }
      return;
    }

    // 6. DELETE /api/groups/:id (Delete Group)
    if (pathname.startsWith('/api/groups/') && req.method === 'DELETE' && !pathname.includes('/accounts/')) {
      try {
        const groupId = pathname.replace('/api/groups/', '');
        const config = await getFullConfig();

        if (config.groups.length <= 1) {
          sendJson({ success: false, error: 'Minimal harus ada 1 grup tersisa' }, 400);
          return;
        }

        const group = config.groups.find((g) => g.id === groupId);
        await removeGroup(groupId);

        addLog(`Grup "${group?.name || groupId}" dihapus`, 'warn');
        sendJson({ success: true, message: 'Grup dihapus' });
      } catch (err) {
        sendJson({ success: false, error: err.message }, 500);
      }
      return;
    }

    // 7. POST /api/groups/:id/accounts (Add account to group)
    if (pathname.match(/^\/api\/groups\/([^/]+)\/accounts$/) && req.method === 'POST') {
      try {
        const match = pathname.match(/^\/api\/groups\/([^/]+)\/accounts$/);
        const groupId = match[1];
        const body = await parseBody();
        const username = (body.username || '').replace(/^@/, '').trim().toLowerCase();

        if (!username) {
          sendJson({ success: false, error: 'Username tidak boleh kosong' }, 400);
          return;
        }

        const config = await getFullConfig();
        const group = config.groups.find((g) => g.id === groupId);

        if (!group) {
          sendJson({ success: false, error: 'Grup tidak ditemukan' }, 404);
          return;
        }

        if (group.accounts.includes(username)) {
          sendJson({ success: false, error: `Akun @${username} sudah ada di grup ini` }, 400);
          return;
        }

        addLog(`Memverifikasi akun baru @${username}...`, 'info');
        const probe = await getTikTokUserVideos(username);
        if (!probe.success) {
          if (probe.isNotFound) {
            addLog(`⚠️ PERINGATAN: Akun TikTok @${username} TIDAK DITEMUKAN (salah username)!`, 'error');
            sendJson({
              success: false,
              isNotFound: true,
              error: `⚠️ Akun TikTok @${username} TIDAK DITEMUKAN! Pastikan ejaan username sudah benar.`
            }, 404);
            return;
          }
          sendJson({ success: false, error: `Gagal memverifikasi akun @${username}: ${probe.error}` }, 400);
          return;
        }

        const latest = probe.videos?.[0] || null;
        await addAccountToGroup(groupId, username, probe.user, latest);

        if (probe.user) {
          runtimeState.accountCache[username] = {
            user: probe.user,
            groupId: group.id,
            groupName: group.name,
            latestVideo: latest,
            lastUpdated: Date.now()
          };
        }

        addLog(`Akun @${username} berhasil ditambahkan ke grup "${group.name}"!`, 'success');
        sendJson({ success: true, user: probe.user, group });
      } catch (err) {
        sendJson({ success: false, error: err.message }, 500);
      }
      return;
    }

    // 7b. POST /api/groups/:id/accounts/batch (Batch add accounts to group)
    if (pathname.match(/^\/api\/groups\/([^/]+)\/accounts\/batch$/) && req.method === 'POST') {
      try {
        const match = pathname.match(/^\/api\/groups\/([^/]+)\/accounts\/batch$/);
        const groupId = match[1];
        const body = await parseBody();

        let rawUsernames = [];
        if (Array.isArray(body.usernames)) {
          rawUsernames = body.usernames;
        } else if (typeof body.usernames === 'string') {
          rawUsernames = body.usernames.split(/[\r\n,;]+/);
        }

        const result = await addAccountsBatchToGroup(groupId, rawUsernames);
        addLog(`Batch Input: Berhasil menambahkan ${result.added.length} akun ke grup (${result.skipped.length} dilewati/sudah ada)`, 'success');

        sendJson({
          success: true,
          added: result.added,
          skipped: result.skipped,
          count: result.added.length
        });
      } catch (err) {
        sendJson({ success: false, error: err.message }, 500);
      }
      return;
    }

    // 8. DELETE /api/groups/:id/accounts/:username (Remove account from group)
    if (pathname.match(/^\/api\/groups\/([^/]+)\/accounts\/([^/]+)$/) && req.method === 'DELETE') {
      try {
        const match = pathname.match(/^\/api\/groups\/([^/]+)\/accounts\/([^/]+)$/);
        const groupId = match[1];
        const username = decodeURIComponent(match[2]).replace(/^@/, '').trim().toLowerCase();

        await removeAccountFromGroup(groupId, username);
        delete runtimeState.accountCache[username];

        addLog(`Akun @${username} dihapus dari grup`, 'warn');
        sendJson({ success: true, message: `Akun @${username} dihapus` });
      } catch (err) {
        sendJson({ success: false, error: err.message }, 500);
      }
      return;
    }

    // 8b. PUT /api/groups/:id/accounts/:username (Edit / Rename TikTok account in group)
    if (pathname.match(/^\/api\/groups\/([^/]+)\/accounts\/([^/]+)$/) && (req.method === 'PUT' || req.method === 'PATCH')) {
      try {
        const match = pathname.match(/^\/api\/groups\/([^/]+)\/accounts\/([^/]+)$/);
        const groupId = match[1];
        const oldUsername = decodeURIComponent(match[2]).replace(/^@/, '').trim().toLowerCase();
        const body = await parseBody();
        const rawNewUser = (body.newUsername || body.username || '').replace(/^@/, '').trim().toLowerCase();

        if (!rawNewUser) {
          sendJson({ success: false, error: 'Username baru tidak boleh kosong' }, 400);
          return;
        }

        const config = await getFullConfig();
        const group = config.groups.find((g) => g.id === groupId);
        if (!group) {
          sendJson({ success: false, error: 'Grup tidak ditemukan' }, 404);
          return;
        }

        if (rawNewUser !== oldUsername && group.accounts.includes(rawNewUser)) {
          sendJson({ success: false, error: `Akun @${rawNewUser} sudah ada di grup ini` }, 400);
          return;
        }

        addLog(`Memverifikasi koreksi username TikTok @${rawNewUser}...`, 'info');
        const probe = await getTikTokUserVideos(rawNewUser);
        if (!probe.success) {
          if (probe.isNotFound) {
            addLog(`⚠️ PERINGATAN: Koreksi username @${rawNewUser} TIDAK DITEMUKAN di TikTok!`, 'error');
            sendJson({
              success: false,
              isNotFound: true,
              error: `⚠️ Username TikTok @${rawNewUser} TIDAK DITEMUKAN! Pastikan ejaan sudah benar.`
            }, 404);
            return;
          }
          sendJson({ success: false, error: `Gagal memverifikasi akun @${rawNewUser}: ${probe.error}` }, 400);
          return;
        }

        const latest = probe.videos?.[0] || null;
        await editAccountInGroup(groupId, oldUsername, rawNewUser, probe.user, latest);

        delete runtimeState.accountCache[oldUsername];
        if (probe.user) {
          runtimeState.accountCache[rawNewUser] = {
            user: probe.user,
            groupId: group.id,
            groupName: group.name,
            latestVideo: latest,
            recentVideos: (probe.videos || []).map((v) => ({
              id: v.id,
              createTime: v.createTime,
              desc: v.desc || '',
              url: v.url
            })),
            lastUpdated: Date.now()
          };
        }

        addLog(`Username TikTok @${oldUsername} berhasil dikoreksi menjadi @${rawNewUser} di grup "${group.name}"!`, 'success');
        sendJson({ success: true, oldUsername, newUsername: rawNewUser, user: probe.user });
      } catch (err) {
        sendJson({ success: false, error: err.message }, 500);
      }
      return;
    }

    // 8c. GET /api/groups/:id/daily-report
    if (pathname.match(/^\/api\/groups\/([^/]+)\/daily-report$/) && req.method === 'GET') {
      try {
        const match = pathname.match(/^\/api\/groups\/([^/]+)\/daily-report$/);
        const groupId = match[1];
        const config = await getFullConfig();
        const group = config.groups.find((g) => g.id === groupId);
        if (!group) {
          sendJson({ success: false, error: 'Grup tidak ditemukan' }, 404);
          return;
        }

        const dateParam = (url.searchParams.get('date') || '').toLowerCase();
        let offsetDays = parseInt(url.searchParams.get('offset') || '0', 10);
        if (dateParam === 'yesterday' || dateParam === 'kemarin' || dateParam === 'prev') {
          offsetDays = -1;
        }
        if (isNaN(offsetDays)) offsetDays = 0;

        const report = generateDailyReportData(group, runtimeState.accountCache, offsetDays);
        sendJson({ success: true, report, offsetDays });
      } catch (err) {
        sendJson({ success: false, error: err.message }, 500);
      }
      return;
    }

    // 8d. POST /api/groups/:id/daily-report/send
    if (pathname.match(/^\/api\/groups\/([^/]+)\/daily-report\/send$/) && req.method === 'POST') {
      try {
        const match = pathname.match(/^\/api\/groups\/([^/]+)\/daily-report\/send$/);
        const groupId = match[1];
        const config = await getFullConfig();
        const group = config.groups.find((g) => g.id === groupId);
        if (!group) {
          sendJson({ success: false, error: 'Grup tidak ditemukan' }, 404);
          return;
        }

        const hasWebhooks = (Array.isArray(group.webhooks) && group.webhooks.length > 0) || !!group.webhookUrl;
        if (!hasWebhooks) {
          sendJson({ success: false, error: 'Discord webhook belum dikonfigurasi untuk grup ini' }, 400);
          return;
        }

        const body = await parseBody().catch(() => ({}));
        let offsetDays = parseInt(body.offsetDays ?? url.searchParams.get('offset') ?? '0', 10);
        if (isNaN(offsetDays)) offsetDays = 0;

        const report = generateDailyReportData(group, runtimeState.accountCache, offsetDays);
        const sent = await sendDiscordDailyReport(group, group.name, report);
        if (!sent) {
          sendJson({ success: false, error: 'Gagal mengirim Daily Report ke Discord Webhook (periksa filter webhook)' }, 502);
          return;
        }

        addLog(`📊 Daily Report grup ${group.name} berhasil dipush ke Discord Webhook!`, 'success');
        sendJson({ success: true, message: 'Daily Report berhasil dikirim ke Discord' });
      } catch (err) {
        sendJson({ success: false, error: err.message }, 500);
      }
      return;
    }

    // 8e. POST /api/groups/:id/daily-report/warn-incomplete
    if (pathname.match(/^\/api\/groups\/([^/]+)\/daily-report\/warn-incomplete$/) && req.method === 'POST') {
      try {
        const match = pathname.match(/^\/api\/groups\/([^/]+)\/daily-report\/warn-incomplete$/);
        const groupId = match[1];
        const config = await getFullConfig();
        const group = config.groups.find((g) => g.id === groupId);
        if (!group) {
          sendJson({ success: false, error: 'Grup tidak ditemukan' }, 404);
          return;
        }

        const hasWebhooks = (Array.isArray(group.webhooks) && group.webhooks.length > 0) || !!group.webhookUrl;
        if (!hasWebhooks) {
          sendJson({ success: false, error: 'Discord webhook belum dikonfigurasi untuk grup ini' }, 400);
          return;
        }

        const report = generateDailyReportData(group, runtimeState.accountCache);
        const sent = await sendDiscordIncompleteWarning(
          group,
          group.name,
          report.uploadedCount,
          report.target,
          report.missing
        );

        if (!sent) {
          sendJson({ success: false, error: 'Gagal mengirim peringatan ke Discord Webhook (periksa filter webhook)' }, 502);
          return;
        }

        addLog(`⚠️ Peringatan target belum tuntas (${report.uploadedCount}/${report.target}) grup ${group.name} dikirim ke Discord!`, 'warn');
        sendJson({ success: true, message: 'Peringatan target belum tuntas berhasil dikirim ke Discord' });
      } catch (err) {
        sendJson({ success: false, error: err.message }, 500);
      }
      return;
    }

    // 9. POST /api/config (General settings)
    if (pathname === '/api/config' && req.method === 'POST') {
      try {
        const body = await parseBody();
        const interval = body.checkIntervalSeconds ? Math.max(30, Number(body.checkIntervalSeconds)) : 120;
        const delay = body.delayBetweenAccountsMs ? Math.max(500, Number(body.delayBetweenAccountsMs)) : 2000;

        await saveSettings(interval, delay);
        addLog(`Pengaturan interval diperbarui (${interval}s, delay: ${delay}ms)`, 'success');
        sendJson({ success: true });
      } catch (err) {
        sendJson({ success: false, error: err.message }, 500);
      }
      return;
    }

    // 10. POST /api/supabase/connect (Connect Supabase & Migrate)
    if (pathname === '/api/supabase/connect' && req.method === 'POST') {
      try {
        const body = await parseBody();
        const url = (body.url || '').trim();
        const key = (body.key || '').trim();

        if (!url || !key) {
          sendJson({ success: false, error: 'URL dan Key Supabase wajib diisi' }, 400);
          return;
        }

        const ok = initSupabase(url, key);
        if (!ok) {
          sendJson({ success: false, error: 'Gagal membuat koneksi Supabase' }, 400);
          return;
        }

        // Save into .env preserving admin credentials and session secret
        const adminUser = process.env.ADMIN_USERNAME || 'ramzimzk23@virzha.com';
        const adminPass = process.env.ADMIN_PASSWORD || 'ksbenned123';
        const secret = process.env.SESSION_SECRET || 'vcstudios-super-secret-auth-key-2026';
        const envContent = `SUPABASE_URL=${url}\nSUPABASE_KEY=${key}\nPORT=3000\nADMIN_USERNAME=${adminUser}\nADMIN_PASSWORD=${adminPass}\nSESSION_SECRET=${secret}\n`;
        await fs.writeFile(path.resolve(__dirname, '../.env'), envContent, 'utf-8');

        // Migrate local data into Supabase
        await migrateLocalToSupabase();

        addLog('⚡ Supabase berhasil dihubungkan & data lokal berhasil dimigrasikan!', 'success');
        sendJson({ success: true, message: 'Supabase berhasil dihubungkan dan data disinkronkan' });
      } catch (err) {
        sendJson({ success: false, error: err.message }, 500);
      }
      return;
    }

    // Static Files Handler
    let filePath;
    if (pathname === '/report' || pathname === '/report/') {
      filePath = path.join(PUBLIC_DIR, 'report.html');
    } else {
      filePath = path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname);
    }

    if (!filePath.startsWith(PUBLIC_DIR)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }

    try {
      const stat = await fs.stat(filePath);
      if (stat.isDirectory()) {
        filePath = path.join(filePath, 'index.html');
      }

      const content = await fs.readFile(filePath);
      const ext = path.extname(filePath);
      const mimeTypes = {
        '.html': 'text/html; charset=utf-8',
        '.css': 'text/css; charset=utf-8',
        '.js': 'application/javascript; charset=utf-8',
        '.json': 'application/json',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.svg': 'image/svg+xml'
      };

      res.writeHead(200, {
        'Content-Type': mimeTypes[ext] || 'application/octet-stream',
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY'
      });
      res.end(content);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
    }
  });

  server.listen(port, () => {
    console.log(`🌐 Web Dashboard aktif di: http://localhost:${port}`);
  });

  return server;
}
