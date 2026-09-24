import { checkAccount } from './tracker.js';
import { createWebServer, addLog, runtimeState } from './server.js';
import { getFullConfig, isUsingSupabase, readLocalCache, writeLocalCache } from './db.js';

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

    // Process accounts in parallel batches
    for (let i = 0; i < queue.length; i += BATCH_CONCURRENCY) {
      const batch = queue.slice(i, i + BATCH_CONCURRENCY);
      runtimeState.scanProgress.currentAccount = batch.map((b) => `@${b.account}`).join(', ');

      const batchPromises = batch.map(async (item) => {
        try {
          const result = await checkAccount(item.account, item.webhookUrl, item.groupName, false);

          if (result && result.success && result.user) {
            runtimeState.accountCache[item.account.toLowerCase()] = {
              user: result.user,
              groupId: item.groupId,
              groupName: item.groupName,
              latestVideo: result.videos?.[0] || null,
              lastUpdated: Date.now()
            };
            cacheDirty = true;
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

  // Pre-load cached creator profiles so dashboard has instant data on visit
  try {
    const cachedData = await readLocalCache();
    if (cachedData && Object.keys(cachedData).length > 0) {
      runtimeState.accountCache = cachedData;
      console.log(`⚡ Pre-loaded ${Object.keys(cachedData).length} akun dari cache lokal.`);
    }
  } catch (err) {
    console.error('Failed to load initial cache:', err.message);
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
