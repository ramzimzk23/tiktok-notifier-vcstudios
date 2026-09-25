import { checkAccount } from './tracker.js';
import { createWebServer, addLog, runtimeState, generateDailyReportData } from './server.js';
import {
  getFullConfig,
  isUsingSupabase,
  readLocalCache,
  writeLocalCache,
  loadAccountCacheFromDb,
  saveAccountCacheToDb,
  seedSentVideosFromCache,
  hasVideoBeenSent,
  markVideoAsSent
} from './db.js';
import {
  sendDiscordNotification,
  sendDiscordWarningNotification,
  sendDiscordDoubleUploadWarning,
  sendDiscordIncompleteWarning,
  sendDiscordTaskCompletedNotification
} from './notifier.js';

const warnedNotFoundAccounts = new Set();
const dailyAlertsTracker = {
  currentDate: '',
  doubleUploads: new Set(),
  incompleteWarnings: new Set(),
  reminders10Min: new Set(),
  deadlineWarnings: new Set(),
  completedAlerts: new Set()
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
          group,
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
          const result = await checkAccount(item.account, item.group || item.webhookUrl, item.groupName, false);

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
                url: v.url,
                webhookSent: v.webhookSent === true
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
                await sendDiscordDoubleUploadWarning(
                  item.group || item.webhookUrl,
                  item.groupName,
                  item.account,
                  todayVideos.length,
                  todayVideos[0]
                );
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
            if (!warnedNotFoundAccounts.has(accKey)) {
              warnedNotFoundAccounts.add(accKey);
              await sendDiscordWarningNotification(item.group || item.webhookUrl, item.account, item.groupName);
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

    // Safety reconciliation: Ensure every video from today present in accountCache has had its webhook sent to Discord!
    for (const group of groups) {
      for (const account of group.accounts || []) {
        const cleanUser = account.toLowerCase();
        const cached = runtimeState.accountCache[cleanUser];
        if (!cached || !cached.recentVideos) continue;

        for (const v of cached.recentVideos) {
          if (!v || !v.id || !v.createTime) continue;
          if (v.createTime >= startOfDayWIB && v.createTime < endOfDayWIB) {
            const alreadySent = await hasVideoBeenSent(cleanUser, v.id);
            if (!alreadySent) {
              console.log(`[Auto-Reconcile] Mengirim webhook video hari ini untuk @${cleanUser} (ID: ${v.id})...`);
              const ok = await sendDiscordNotification(group, cached.user, v, group.name || group.id);
              if (ok) {
                await markVideoAsSent(cleanUser, v.id);
                v.webhookSent = true;
                v.sentAt = Date.now();
                saveAccountCacheToDb(cleanUser, cached).catch(() => {});
                addLog(`✅ Auto-reconcile berhasil mengirim webhook untuk @${cleanUser} (ID: ${v.id})`, 'success');
                await new Promise((r) => setTimeout(r, 600));
              }
            }
          }
        }
      }
    }

    // Persist cache to disk if updated
    if (cacheDirty) {
      await writeLocalCache(runtimeState.accountCache);
    }

    // Check task deadlines and reminders (10 min before deadline & at deadline)
    await checkTaskDeadlinesAndReminders(isManual);

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

/**
 * Automatically check task deadlines and push reminders:
 * 1. Periodic warning every X minutes (configurable, e.g. every 60m, 30m, etc.) while incomplete
 * 2. Final 1x alert exactly 10 minutes before deadline
 * Resets daily and guarantees target 14 complete groups receive zero alerts.
 */
export async function checkTaskDeadlinesAndReminders(isManual = false) {
  try {
    const config = await getFullConfig();
    const groups = config.groups || [];
    if (groups.length === 0) return;

    const now = new Date();
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Jakarta',
      hour: 'numeric',
      minute: 'numeric',
      hour12: false
    }).formatToParts(now);
    const hour = Number(parts.find((p) => p.type === 'hour')?.value || 0);
    const minute = Number(parts.find((p) => p.type === 'minute')?.value || 0);
    const currentMinutes = hour * 60 + minute;

    const nowWIB = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta' }).format(now);
    if (dailyAlertsTracker.currentDate !== nowWIB) {
      dailyAlertsTracker.currentDate = nowWIB;
      dailyAlertsTracker.doubleUploads.clear();
      dailyAlertsTracker.incompleteWarnings.clear();
      dailyAlertsTracker.reminders10Min.clear();
      dailyAlertsTracker.deadlineWarnings.clear();
      dailyAlertsTracker.completedAlerts.clear();
      runtimeState.lastPeriodicWarningTimestamps?.clear();
    }

    for (const group of groups) {
      if (group.taskReminderEnabled === false && !isManual) continue;
      const hasWebhooks = (Array.isArray(group.webhooks) && group.webhooks.length > 0) || !!group.webhookUrl;
      if (!hasWebhooks || !group.accounts || group.accounts.length === 0) continue;

      const report = generateDailyReportData(group, runtimeState.accountCache);
      const deadlineStr = (group.taskDeadline || '22:00').trim();
      const groupKey = `${group.id}:${nowWIB}`;

      // 0. Notifikasi Webhook Jika Target Kuota Harian Sudah Tuntas (Minimal 14 Akun atau Semua Akun Selesai)
      const targetCount = report.target || (group.accounts?.length > 0 ? Math.min(14, group.accounts.length) : 14);
      const isGroupFinished = report.isCompleted || report.uploadedCount >= targetCount || (group.accounts.length > 0 && report.missing.length === 0);

      if (isGroupFinished) {
        if (!dailyAlertsTracker.completedAlerts.has(groupKey)) {
          dailyAlertsTracker.completedAlerts.add(groupKey);
          addLog(`🎉 TARGET TUNTAS! Grup "${group.name}" telah menyelesaikan kuota (${report.uploadedCount}/${targetCount} akun). Mengirim notifikasi selesai ke Discord...`, 'success');
          await sendDiscordTaskCompletedNotification(
            group,
            group.name,
            report.uploadedCount,
            targetCount,
            report.uploaded,
            {
              deadlineTime: deadlineStr
            }
          );
        }
        // JIKA SUDAH SELESAI: STOP! Jangan kirim reminder/peringatan apapun lagi untuk grup ini hari ini.
        continue;
      }

      const [sHourStr, sMinStr] = (group.taskReminderStartTime || '09:00').split(':');
      const sHour = parseInt(sHourStr, 10) || 9;
      const sMin = parseInt(sMinStr, 10) || 0;
      const startTotalMinutes = sHour * 60 + sMin;

      const [dHourStr, dMinStr] = deadlineStr.split(':');
      const dHour = parseInt(dHourStr, 10) || 22;
      const dMin = parseInt(dMinStr, 10) || 0;
      const deadlineTotalMinutes = dHour * 60 + dMin;

      // Jendela Waktu Reminder: Hanya berjalan mulai jam 09:00 WIB sampai 22:00 WIB (atau batas deadline)
      if (!isManual) {
        if (currentMinutes < startTotalMinutes) {
          // Belum masuk jam reminder (sebelum 09:00 WIB)
          continue;
        }
        if (currentMinutes >= deadlineTotalMinutes) {
          // Sudah lewat jam batas deadline (setelah 22:00 WIB)
          continue;
        }
      }

      const warningIntervalMins = group.taskWarningIntervalMinutes !== undefined ? Number(group.taskWarningIntervalMinutes) : 60;
      const is10MinEnabled = group.taskReminder10MinEnabled !== false;
      const reminderStartMinutes = Math.max(startTotalMinutes, deadlineTotalMinutes - 10);

      // 1. 10 Menit Sebelum Deadline (HANYA 1x Peringatan per Hari)
      if (is10MinEnabled && currentMinutes >= reminderStartMinutes && currentMinutes < deadlineTotalMinutes) {
        if (!dailyAlertsTracker.reminders10Min.has(groupKey)) {
          addLog(`🚨 PERINGATAN TERAKHIR (10 MENIT SEBELUM DEADLINE): Tim "${group.name}" belum tuntas (${report.uploadedCount}/${targetCount} akun). Mengirim ke Discord...`, 'warn');
          const sent = await sendDiscordIncompleteWarning(
            group,
            group.name,
            report.uploadedCount,
            targetCount,
            report.missing,
            {
              reminderType: '10_min_reminder',
              deadlineTime: deadlineStr,
              reminderMinutes: 10
            }
          );
          if (sent) {
            dailyAlertsTracker.reminders10Min.add(groupKey);
            runtimeState.lastPeriodicWarningTimestamps?.set(group.id, Date.now());
            addLog(`✅ Peringatan 10 menit sebelum deadline berhasil dikirim ke grup "${group.name}"!`, 'success');
          }
          continue;
        }
      }

      // 2. Peringatan Berkala Setiap X Menit (Hanya aktif 09:00 s/d 22:00 WIB)
      if (warningIntervalMins > 0) {
        // Jangan kirim pengingat berkala jika batas waktu harian sudah lewat
        if (currentMinutes >= deadlineTotalMinutes && !isManual) continue;

        const intervalMs = warningIntervalMins * 60 * 1000;
        const lastSent = runtimeState.lastPeriodicWarningTimestamps?.get(group.id) || 0;
        const timeSinceLast = Date.now() - lastSent;

        // Jangan kirim peringatan interval jika saat ini sedang dalam rentang 10 menit menuju deadline (agar tidak tumpang tindih)
        const in10MinWindow = is10MinEnabled && currentMinutes >= reminderStartMinutes && currentMinutes < deadlineTotalMinutes;

        if ((timeSinceLast >= (intervalMs - 5000) || isManual) && !in10MinWindow) {
          addLog(`⏰ PERINGATAN BERKALA (${warningIntervalMins} MENIT): Mengirim pengingat task belum tuntas ke grup "${group.name}" (${report.uploadedCount}/${targetCount} akun selesai, deadline ${deadlineStr} WIB)...`, 'info');
          const sent = await sendDiscordIncompleteWarning(
            group,
            group.name,
            report.uploadedCount,
            targetCount,
            report.missing,
            {
              reminderType: 'periodic_interval',
              intervalMinutes: warningIntervalMins,
              deadlineTime: deadlineStr
            }
          );

          if (sent) {
            runtimeState.lastPeriodicWarningTimestamps?.set(group.id, Date.now());
            addLog(`✅ Reminder berkala (${warningIntervalMins}m) berhasil dikirim ke Discord grup "${group.name}"!`, 'success');
          } else {
            addLog(`⚠️ Gagal mengirim reminder berkala ke Discord "${group.name}". Akan dicoba ulang pada siklus berikutnya.`, 'warn');
          }
        }
      }
    }
  } catch (err) {
    console.error('[Reminder] Error checking task deadlines:', err.message);
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
      await seedSentVideosFromCache(cachedData);
    }
  } catch (err) {
    console.error('Failed to load initial cache from DB:', err.message);
  }

  // Start Web Server immediately (non-blocking!)
  createWebServer(PORT, (manual) => {
    runPoll(manual);
  });

  addLog(`Sistem VCStudios TikTok Notifier siap. Database: ${dbStatus}`, 'success');

  // Dedicated background ticker for task deadlines and reminders (runs every 30s)
  setInterval(() => {
    checkTaskDeadlinesAndReminders(false);
  }, 30000);

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
