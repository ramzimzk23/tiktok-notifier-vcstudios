import { checkAccount } from './tracker.js';
import { createWebServer, addLog, runtimeState, generateDailyReportData } from './server.js';
import {
  getFullConfig,
  isUsingSupabase,
  readLocalCache,
  writeLocalCache,
  loadAccountCacheFromDb,
  saveAccountCacheToDb
} from './db.js';
import {
  sendDiscordWarningNotification,
  sendDiscordDoubleUploadWarning,
  sendDiscordIncompleteWarning
} from './notifier.js';

const warnedNotFoundAccounts = new Set();
const dailyAlertsTracker = {
  currentDate: '',
  doubleUploads: new Set(),
  incompleteWarnings: new Set()
};

let isPolling = false;
let nextPollTimer = null;
const BATCH_CONCURRENCY = 4; // Concurrently scan 4 accounts at a time for high speed & safe pacing

export async function runPoll(isManual = false) {
  if (isPolling) {
    addLog('Pengecekan sedang berlangsung, melewati siklus ini.', 'warn');
    return;
  }

  isPolling = true;
  runtimeState.isScanning = true;
  if (nextPollTimer) {
    clearTimeout(nextPollTimer);
    nextPollTimer = null;
  }

  let intervalSeconds = 120;

  try {
    const config = await getFullConfig();
    intervalSeconds = config.checkIntervalSeconds || 120;
    const delayBetweenBatchesMs = Math.max(800, config.delayBetweenAccountsMs || 1200);
    const groups = config.groups || [];

    // Flatten all accounts into a queue of tasks
    const queue = [];
    for (const group of groups) {
      const webhookUrl = group.webhookUrl;
      const groupName = group.name || group.id;
      for (const account of group.accounts || []) {
        queue.push({
          account,
          webhookUrl,
          groupName,
          groupId: group.id
        });
      }
    }

    const totalAccounts = queue.length;
    runtimeState.lastPollTime = Date.now();
    runtimeState.scanProgress = {
      current: 0,
      total: totalAccounts,
      currentAccount: '',
      status: 'scanning'
    };

    const reason = isManual ? '(Manual Trigger)' : '(Jadwal Berkala)';
    addLog(`Memulai scan ${reason}: ${totalAccounts} akun di ${groups.length} grup (Batch Concurrency: ${BATCH_CONCURRENCY})...`, 'info');

    let processedCount = 0;
    let cacheDirty = false;

    // Check and reset daily alerts if a new day in WIB has arrived
    const nowWIB = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta' }).format(new Date());
    if (dailyAlertsTracker.currentDate !== nowWIB) {
      dailyAlertsTracker.currentDate = nowWIB;
      dailyAlertsTracker.doubleUploads.clear();
      dailyAlertsTracker.incompleteWarnings.clear();
    }
    const startOfDayWIB = Math.floor(new Date(`${nowWIB}T00:00:00+07:00`).getTime() / 1000);
    const endOfDayWIB = startOfDayWIB + 86400;

    // Process accounts in parallel batches
    for (let i = 0; i < queue.length; i += BATCH_CONCURRENCY) {
      const batch = queue.slice(i, i + BATCH_CONCURRENCY);
      runtimeState.scanProgress.currentAccount = batch.map((b) => `@${b.account}`).join(', ');

      const batchPromises = batch.map(async (item) => {
        try {
          const result = await checkAccount(item.account, item.webhookUrl, item.groupName, false);

          if (result && result.success && result.user) {
            const cacheItem = {
              user: result.user,
              groupId: item.groupId,
              groupName: item.groupName,
              latestVideo: result.videos?.[0] || null,
              recentVideos: (result.videos || []).map((v) => ({
                id: v.id,
                createTime: v.createTime,
                desc: v.desc || '',
                url: v.url
              })),
              lastUpdated: Date.now()
            };
            runtimeState.accountCache[item.account.toLowerCase()] = cacheItem;
            saveAccountCacheToDb(item.account, cacheItem).catch(() => {});
            const accKey = `${item.groupId}:${item.account.toLowerCase()}`;
            warnedNotFoundAccounts.delete(accKey);
            cacheDirty = true;

            // Check double upload (uploaded > 1 video today in WIB) - Push warning only 1x
            const todayVideos = (result.videos || []).filter(
              (v) => v && v.createTime && v.createTime >= startOfDayWIB && v.createTime < endOfDayWIB
            );
            if (todayVideos.length > 1) {
              const doubleKey = `${item.groupId}:${item.account.toLowerCase()}:${nowWIB}`;
              if (!dailyAlertsTracker.doubleUploads.has(doubleKey)) {
                dailyAlertsTracker.doubleUploads.add(doubleKey);
                addLog(`⚠️ PERINGATAN: Akun @${item.account} (${item.groupName}) melakukan DOUBLE UPLOAD (${todayVideos.length} video hari ini)!`, 'warn');
                if (item.webhookUrl) {
                  await sendDiscordDoubleUploadWarning(
                    item.webhookUrl,
                    item.groupName,
                    item.account,
                    todayVideos.length,
                    todayVideos[0]
                  );
                }
              }
            }
          } else if (result && result.isNotFound) {
            // Track not found state so UI can show warning badge
            runtimeState.accountCache[item.account.toLowerCase()] = {
              isNotFound: true,
              user: {
                nickname: item.account,
                uniqueId: item.account,
                avatar: 'https://sf16-website-login.neutral.ttwstatic.com/obj/tiktok_web_login_static/favicon.ico'
              },
              error: 'Akun TikTok tidak ditemukan (salah username)',
              lastUpdated: Date.now()
            };
            cacheDirty = true;
            addLog(`⚠️ PERINGATAN: Akun TikTok @${item.account} (${item.groupName}) TIDAK DITEMUKAN. Periksa kembali username!`, 'error');

            const accKey = `${item.groupId}:${item.account.toLowerCase()}`;
            if (item.webhookUrl && !warnedNotFoundAccounts.has(accKey)) {
              warnedNotFoundAccounts.add(accKey);
              await sendDiscordWarningNotification(item.webhookUrl, item.account, item.groupName);
            }
          }
          return { success: true, account: item.account };
        } catch (err) {
          console.error(`[Main] Error memeriksa @${item.account}:`, err.message);
          return { success: false, account: item.account, error: err.message };
        } finally {
          processedCount++;
          runtimeState.scanProgress.current = processedCount;
        }
      });

      await Promise.allSettled(batchPromises);

      // Pacing delay between batches
      if (i + BATCH_CONCURRENCY < queue.length) {
        const jitter = Math.floor(Math.random() * 300) + 100;
        await new Promise((res) => setTimeout(res, delayBetweenBatchesMs + jitter));
      }
    }

    // Persist cache to disk if updated
    if (cacheDirty) {
      await writeLocalCache(runtimeState.accountCache);
    }

    // Check if any group has incomplete quota (< 14 videos)
    // Warning is pushed only 1x per day (in evening >= 18:00 WIB or when manual trigger)
    const currentHourWIB = Number(
      new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: false, timeZone: 'Asia/Jakarta' }).format(new Date())
    );
    if (currentHourWIB >= 18 || isManual) {
      for (const group of groups) {
        if (!group.webhookUrl || !group.accounts || group.accounts.length === 0) continue;
        const incompleteKey = `${group.id}:${nowWIB}`;
        if (!dailyAlertsTracker.incompleteWarnings.has(incompleteKey)) {
          const report = generateDailyReportData(group, runtimeState.accountCache);
          if (!report.isCompleted && (report.remainingNeeded > 0 || report.uploadedCount < 14)) {
            dailyAlertsTracker.incompleteWarnings.add(incompleteKey);
            addLog(`⚠️ PERINGATAN TARGET: Grup ${group.name} belum selesai (${report.uploadedCount}/14 akun). Peringatan 1x dikirim ke Discord.`, 'warn');
            await sendDiscordIncompleteWarning(
              group.webhookUrl,
              group.name,
              report.uploadedCount,
              report.target,
              report.missing
            );
          }
        }
      }
    }

    addLog(`Scan selesai (${processedCount}/${totalAccounts} akun). Siklus berikutnya dalam ${intervalSeconds} detik.`, 'success');
  } catch (err) {
    console.error('[Main] Error pada siklus scan:', err.message);
    addLog(`Error siklus scan: ${err.message}`, 'error');
  } finally {
    isPolling = false;
    runtimeState.isScanning = false;
    runtimeState.scanProgress.status = 'idle';
    runtimeState.scanProgress.currentAccount = '';

    // Schedule next poll cleanly AFTER the current one completes
    runtimeState.nextPollTime = Date.now() + intervalSeconds * 1000;
    nextPollTimer = setTimeout(() => {
      runPoll(false);
    }, intervalSeconds * 1000);
  }
}

async function main() {
  console.log('='.repeat(55));
  console.log('🚀 VCStudios • TikTok Discord Notifier Aktif');
  console.log('='.repeat(55));

  const PORT = process.env.PORT || 3000;
  const dbStatus = isUsingSupabase() ? '⚡ Supabase PostgreSQL' : '📁 File Lokal (config.json)';
  console.log(`🗄️ Database Mode  : ${dbStatus}`);

  // Pre-load cached creator profiles and video list from Supabase cloud database
  try {
    const cachedData = await loadAccountCacheFromDb();
    if (cachedData && Object.keys(cachedData).length > 0) {
      runtimeState.accountCache = cachedData;
      console.log(`⚡ Pre-loaded ${Object.keys(cachedData).length} akun dari database persistent.`);
    }
  } catch (err) {
    console.error('Failed to load initial cache from DB:', err.message);
  }

  // Start Web Server immediately (non-blocking!)
  createWebServer(PORT, (manual) => {
    runPoll(manual);
  });

  addLog(`Sistem VCStudios TikTok Notifier siap. Database: ${dbStatus}`, 'success');

  // Trigger background poll asynchronously after 3s delay (does NOT block server startup)
  setTimeout(() => {
    runPoll(false);
  }, 3000);

  const cleanup = () => {
    console.log('\n🛑 Menghentikan VCStudios Notifier...');
    if (nextPollTimer) clearTimeout(nextPollTimer);
    process.exit(0);
  };

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
}

main();
