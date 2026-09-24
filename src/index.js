import { checkAccount } from './tracker.js';
import { createWebServer, addLog, runtimeState } from './server.js';
import { getFullConfig, isUsingSupabase } from './db.js';

let isPolling = false;
let nextPollTimer = null;

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
    const delayMs = config.delayBetweenAccountsMs || 1500;
    const groups = config.groups || [];

    const totalAccounts = groups.reduce((acc, g) => acc + (g.accounts?.length || 0), 0);

    runtimeState.lastPollTime = Date.now();
    runtimeState.scanProgress = {
      current: 0,
      total: totalAccounts,
      currentAccount: '',
      status: 'scanning'
    };

    const reason = isManual ? '(Manual Trigger)' : '(Jadwal Berkala)';
    addLog(`Memulai scan ${reason}: ${totalAccounts} akun di ${groups.length} grup...`, 'info');

    let processedCount = 0;

    for (const group of groups) {
      const webhookUrl = group.webhookUrl;
      const groupName = group.name || group.id;

      if (!webhookUrl) {
        addLog(`⚠️ Grup "${groupName}" belum memiliki Webhook URL.`, 'warn');
      }

      for (const account of group.accounts || []) {
        processedCount++;
        runtimeState.scanProgress.current = processedCount;
        runtimeState.scanProgress.currentAccount = account;

        try {
          // Perform check and obtain scraper result in a SINGLE request
          const result = await checkAccount(account, webhookUrl, groupName, false);

          if (result && result.success && result.user) {
            runtimeState.accountCache[account.toLowerCase()] = {
              user: result.user,
              groupId: group.id,
              groupName: groupName,
              latestVideo: result.videos?.[0] || null,
              lastUpdated: Date.now()
            };
          }

          addLog(`Pengecekan @${account} (${groupName}) selesai [${processedCount}/${totalAccounts}]`, 'info');

          // Pacing delay with gentle jitter (100ms - 300ms)
          const jitter = Math.floor(Math.random() * 200) + 100;
          await new Promise((res) => setTimeout(res, delayMs + jitter));
        } catch (err) {
          console.error(`[Main] Error saat memeriksa @${account} (${groupName}):`, err.message);
          addLog(`Error memeriksa @${account}: ${err.message}`, 'error');
        }
      }
    }

    addLog(`Scan selesai (${processedCount} akun). Menunggu siklus berikutnya dalam ${intervalSeconds} detik.`, 'success');
  } catch (err) {
    console.error('[Main] Error pada siklus scan:', err.message);
    addLog(`Error siklus scan: ${err.message}`, 'error');
  } finally {
    isPolling = false;
    runtimeState.isScanning = false;
    runtimeState.scanProgress.status = 'idle';
    runtimeState.scanProgress.currentAccount = '';

    // Schedule next poll cleanly AFTER the current one is completely finished
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

  // Start Web Server
  createWebServer(PORT, (manual) => {
    runPoll(manual);
  });

  addLog(`Sistem VCStudios TikTok Notifier siap. Database: ${dbStatus}`, 'success');

  // Run initial poll immediately
  await runPoll(false);

  const cleanup = () => {
    console.log('\n🛑 Menghentikan VCStudios Notifier...');
    if (nextPollTimer) clearTimeout(nextPollTimer);
    process.exit(0);
  };

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
}

main();
