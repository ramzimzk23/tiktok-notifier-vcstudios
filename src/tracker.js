import { getTikTokUserVideos } from './scraper.js';
import { sendDiscordNotification } from './notifier.js';
import { getAccountStates, updateAccountState, hasVideoBeenSent, markVideoAsSent } from './db.js';

/**
 * Check an individual TikTok account for new or un-notified videos.
 * Guarantees:
 * 1. If an account uploads 1 or more videos, EVERY video that hasn't been sent to Discord will be sent.
 * 2. Videos already sent to Discord will NEVER be sent repeatedly (anti-duplicate / anti-spam).
 * 3. Videos uploaded today (WIB) are prioritized and dispatched in chronological order.
 * 
 * @param {string} username TikTok username
 * @param {object|string} webhookUrl Discord Webhook URL or Group object
 * @param {string} groupName Optional group name for channel routing
 * @param {boolean} notifyOnFirstDiscovery If true, sends alert even on first run
 */
export async function checkAccount(username, webhookUrl, groupName = null, notifyOnFirstDiscovery = false) {
  const cleanUser = username.replace(/^@/, '').toLowerCase();
  const groupLabel = groupName ? `[Grup: ${groupName}] ` : '';
  console.log(`[Tracker] [${new Date().toLocaleTimeString()}] ${groupLabel}Memeriksa @${cleanUser}...`);

  const result = await getTikTokUserVideos(cleanUser);

  if (!result.success) {
    console.error(`[Tracker] Gagal mengambil data @${cleanUser}: ${result.error}`);
    return result;
  }

  const { user, videos } = result;

  if (!videos || videos.length === 0) {
    console.log(`[Tracker] Tidak ada video ditemukan untuk @${cleanUser}`);
    return result;
  }

  // Get current WIB day start timestamp
  const nowWIB = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta' }).format(new Date());
  const startOfDayWIB = Math.floor(new Date(`${nowWIB}T00:00:00+07:00`).getTime() / 1000);

  const states = await getAccountStates();
  const accountState = states[cleanUser];
  const isFirstEncounter = !accountState || !accountState.lastVideoId;

  // Inspect all recent videos returned by scraper (up to 10)
  const candidateVideos = videos.slice(0, 10);
  const videosToSend = [];

  for (const v of candidateVideos) {
    if (!v || !v.id) continue;
    const vId = String(v.id);
    const alreadySent = await hasVideoBeenSent(cleanUser, vId);

    if (alreadySent) {
      v.webhookSent = true;
      continue;
    }

    // Video has NOT been sent to Discord yet!
    const isToday = v.createTime && v.createTime >= startOfDayWIB;
    const isNewerThanState = accountState?.lastPostTime && v.createTime && v.createTime > accountState.lastPostTime;

    if (isFirstEncounter) {
      if (isToday || notifyOnFirstDiscovery) {
        // Even on first encounter: if uploaded TODAY, it counts towards today's quota so we MUST notify!
        videosToSend.push(v);
      } else {
        // Historical video from past days before this account was registered: mark as baseline
        await markVideoAsSent(cleanUser, vId);
        v.webhookSent = true;
      }
    } else {
      // Account is already tracked: if not sent yet, and it's from today OR newer than last post time
      if (isToday || isNewerThanState || accountState.lastVideoId !== vId) {
        videosToSend.push(v);
      }
    }
  }

  // If there are un-notified videos, dispatch in chronological order (oldest to newest)
  if (videosToSend.length > 0) {
    videosToSend.sort((a, b) => (a.createTime || 0) - (b.createTime || 0));
    console.log(`[Tracker] 🔔 Terdeteksi ${videosToSend.length} postingan baru / belum ternotifikasi untuk @${cleanUser}!`);

    for (const v of videosToSend) {
      console.log(`[Tracker] Mengirim notifikasi postingan (ID: ${v.id}) @${cleanUser} ke Discord...`);
      const sent = await sendDiscordNotification(webhookUrl, user, v, groupName);
      if (sent) {
        console.log(`[Tracker] ✅ Webhook postingan (ID: ${v.id}) @${cleanUser} berhasil dikirim ke Discord!`);
        await markVideoAsSent(cleanUser, v.id);
        v.webhookSent = true;
        v.sentAt = Date.now();
      } else {
        console.error(`[Tracker] ❌ Gagal mengirim notifikasi video (ID: ${v.id}) @${cleanUser} ke Discord. Akan dicoba lagi pada siklus berikutnya.`);
        v.webhookSent = false;
      }

      if (videosToSend.length > 1) {
        // Pacing delay between multiple webhook dispatches for the same account
        await new Promise((resolve) => setTimeout(resolve, 600));
      }
    }
  } else {
    console.log(`[Tracker] Tidak ada video baru yang perlu dikirim untuk @${cleanUser}. (Semua sudah ternotifikasi)`);
  }

  // Always update account state to the absolute latest video
  const latestVideo = videos[0];
  await updateAccountState(cleanUser, latestVideo.id, latestVideo.createTime);

  // Return the result with updated webhookSent flags
  result.videos = videos.map((v) => ({
    ...v,
    webhookSent: v.webhookSent === true
  }));

  return result;
}
