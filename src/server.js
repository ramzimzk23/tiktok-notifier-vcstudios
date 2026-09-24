import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getTikTokUserVideos } from './scraper.js';
import { sendDiscordNotification } from './notifier.js';
import {
  getFullConfig,
  saveSettings,
  upsertGroup,
  removeGroup,
  addAccountToGroup,
  removeAccountFromGroup,
  getAccountStates,
  isUsingSupabase,
  initSupabase,
  migrateLocalToSupabase
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

export function createWebServer(port = 3000, triggerPollCallback = null) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = url.pathname;

    const sendJson = (data, status = 200) => {
      res.writeHead(status, {
        'Content-Type': 'application/json',
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
      try {
        const body = await parseBody();
        const username = (body.username || '').trim();
        const password = (body.password || '').trim();

        const authResult = await authenticateUser(username, password);
        if (authResult) {
          addLog(`Pengguna "${username}" berhasil login ke dashboard`, 'success');
          sendJson({ success: true, token: authResult.token, username });
        } else {
          addLog(`Gagal login: Kredensial tidak valid untuk user "${username}"`, 'warn');
          sendJson({ success: false, error: 'Username atau password salah!' }, 401);
        }
      } catch (err) {
        sendJson({ success: false, error: err.message }, 500);
      }
      return;
    }

    if (pathname === '/api/auth/register' && req.method === 'POST') {
      try {
        const body = await parseBody();
        const username = (body.username || '').trim();
        const password = (body.password || '').trim();

        const result = await registerUser(username, password);
        addLog(`Pengguna baru "${username}" berhasil mendaftar`, 'success');
        sendJson({ success: true, token: result.token, username });
      } catch (err) {
        sendJson({ success: false, error: err.message }, 400);
      }
      return;
    }

    if (pathname === '/api/auth/verify' && req.method === 'POST') {
      const authHeader = req.headers['authorization'] || '';
      const token = authHeader.replace(/^Bearer\s+/i, '');
      const valid = verifyAuthToken(token);
      sendJson({ valid: !!valid, user: valid ? valid.username : null });
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

    // Auth Middleware for all other /api routes
    if (pathname.startsWith('/api/')) {
      const authHeader = req.headers['authorization'] || '';
      const token = authHeader.replace(/^Bearer\s+/i, '');
      const verified = verifyAuthToken(token);
      if (!verified) {
        sendJson({ error: 'Unauthorized', requireLogin: true }, 401);
        return;
      }
    }

    // 1. GET /api/status
    if (pathname === '/api/status' && req.method === 'GET') {
      try {
        const config = await getFullConfig();
        const state = await getAccountStates();
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

        if (!group || !group.webhookUrl) {
          sendJson({ success: false, error: 'Grup atau Webhook URL belum diisi' }, 400);
          return;
        }

        const username = body.username || group.accounts[0] || 'varsatilevibes';
        addLog(`Menjalankan tes webhook grup "${group.name}" untuk @${username}...`, 'info');

        const result = await getTikTokUserVideos(username);
        if (!result.success || !result.videos || result.videos.length === 0) {
          addLog(`Gagal mengambil data @${username} untuk tes webhook: ${result.error}`, 'error');
          sendJson({ success: false, error: result.error || 'Video tidak ditemukan' }, 400);
          return;
        }

        const sent = await sendDiscordNotification(group.webhookUrl, result.user, result.videos[0], group.name);
        if (sent) {
          addLog(`✅ Notifikasi tes untuk @${username} berhasil dikirim ke grup "${group.name}"!`, 'success');
          sendJson({ success: true, message: `Notifikasi berhasil dikirim ke grup ${group.name}` });
        } else {
          addLog(`❌ Gagal mengirim webhook Discord untuk grup "${group.name}"`, 'error');
          sendJson({ success: false, message: 'Gagal mengirim ke Discord' }, 500);
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
        const webhookUrl = (body.webhookUrl || '').trim();

        if (!name) {
          sendJson({ success: false, error: 'Nama grup tidak boleh kosong' }, 400);
          return;
        }

        const id = 'group-' + Date.now();
        const newGroup = {
          id,
          name,
          webhookUrl,
          accounts: []
        };

        await upsertGroup(newGroup);
        addLog(`Grup baru "${name}" berhasil dibuat (${isUsingSupabase() ? 'Supabase' : 'Lokal'})`, 'success');
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
        if (body.webhookUrl !== undefined) group.webhookUrl = body.webhookUrl.trim();

        await upsertGroup(group);
        addLog(`Grup "${group.name}" berhasil diperbarui`, 'success');
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

        // Save into .env for persistence
        const envContent = `SUPABASE_URL=${url}\nSUPABASE_KEY=${key}\nPORT=3000\n`;
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
    let filePath = path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname);

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

      res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' });
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
