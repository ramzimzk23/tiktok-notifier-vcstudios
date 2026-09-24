import { checkAccount } from './tracker.js';
import { createWebServer, addLog, runtimeState } from './server.js';
import { getTikTokUserVideos } from './scraper.js';
import { getFullConfig, isUsingSupabase } from './db.js';

let isPolling = false;

export async function runPoll(isManual = false) {
  if (isPolling) {
    addLog('Pengecekan sedang berlangsung, melewati siklus ini.', 'warn');
    return;
  }

  isPolling = true;
  const config = await getFullConfig();
  const intervalSeconds = config.checkIntervalSeconds || 120;
  const delayMs = config.delayBetweenAccountsMs || 2000;
  const groups = config.groups || [];

  const totalAccounts = groups.reduce((acc, g) => acc + (g.accounts?.length || 0), 0);

  runtimeState.lastPollTime = Date.now();
  runtimeState.nextPollTime = Date.now() + intervalSeconds * 1000;

  const reason = isManual ? '(Manual Trigger)' : '(Jadwal Berkala)';
  addLog(`Memulai scan ${reason}: ${totalAccounts} akun di ${groups.length} grup...`, 'info');

  for (const group of groups) {
    const webhookUrl = group.webhookUrl;
    const groupName = group.name || group.id;

    if (!webhookUrl) {
      addLog(`⚠️ Grup "${groupName}" belum memiliki Webhook URL.`, 'warn');
    }

    for (const account of group.accounts || []) {
      try {
        // Fetch details and cache for the dashboard
        const probe = await getTikTokUserVideos(account);
        if (probe.success && probe.user) {
          runtimeState.accountCache[account.toLowerCase()] = {
            user: probe.user,
            groupId: group.id,
            groupName: groupName,
            latestVideo: probe.videos?.[0] || null,
            lastUpdated: Date.now()
          };
        }

        await checkAccount(account, webhookUrl, groupName, false);
        addLog(`Pengecekan @${account} (${groupName}) selesai`, 'info');

        // Pacing delay with random jitter (200ms - 600ms) to look natural and prevent WAF blocks
        const jitter = Math.floor(Math.random() * 400) + 200;
        await new Promise((res) => setTimeout(res, delayMs + jitter));
      } catch (err) {
        console.error(`[Main] Error saat memeriksa @${account} (${groupName}):`, err.message);
        addLog(`Error memeriksa @${account}: ${err.message}`, 'error');
      }
    }
  }

  isPolling = false;
  addLog(`Scan selesai. Menunggu siklus berikutnya dalam ${intervalSeconds} detik.`, 'success');
}

async function main() {
  console.log('='.repeat(55));
  console.log('🚀 VCStudios • TikTok Discord Notifier Aktif');
  console.log('='.repeat(55));

  const config = await getFullConfig();
  const intervalSeconds = config.checkIntervalSeconds || 120;
  const PORT = process.env.PORT || 3000;

  const dbStatus = isUsingSupabase() ? '⚡ Supabase PostgreSQL' : '📁 File Lokal (config.json)';
  console.log(`🗄️ Database Mode  : ${dbStatus}`);

  // Start Web Server
  createWebServer(PORT, (manual) => {
    runPoll(manual);
  });

  addLog(`Sistem VCStudios TikTok Notifier siap. Database: ${dbStatus}`, 'success');

  // Run initial poll
  await runPoll(false);

  // Set recurring interval
  const timer = setInterval(() => {
    runPoll(false);
  }, intervalSeconds * 1000);

  const cleanup = () => {
    console.log('\n🛑 Menghentikan VCStudios Notifier...');
    clearInterval(timer);
    process.exit(0);
  };

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
}

main();
