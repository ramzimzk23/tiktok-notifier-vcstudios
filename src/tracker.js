import { getTikTokUserVideos } from './scraper.js';
import { sendDiscordNotification } from './notifier.js';
import { getAccountStates, updateAccountState, hasVideoBeenSent, markVideoAsSent } from './db.js';

/**
 * Check an individual TikTok account for new videos
 * @param {string} username TikTok username
 * @param {string} webhookUrl Discord Webhook URL
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

  const latestVideo = videos[0];
  const states = await getAccountStates();
  const accountState = states[cleanUser];

  if (!accountState || !accountState.lastVideoId) {
    // First time encountering this account
    console.log(`[Tracker] Akun @${cleanUser} baru didaftarkan. ID Video terkini: ${latestVideo.id}`);
    await updateAccountState(cleanUser, latestVideo.id, latestVideo.createTime);

    if (notifyOnFirstDiscovery) {
      const alreadySent = await hasVideoBeenSent(cleanUser, latestVideo.id);
      if (!alreadySent) {
        console.log(`[Tracker] Mengirim notifikasi inisial ke Discord...`);
        const sent = await sendDiscordNotification(webhookUrl, user, latestVideo, groupName);
        if (sent) {
          await markVideoAsSent(cleanUser, latestVideo.id);
        }
      }
    } else {
      // Mark as sent so baseline video will never trigger an alert later
      await markVideoAsSent(cleanUser, latestVideo.id);
      console.log(`[Tracker] Baseline disimpan. Notifikasi berikutnya akan dikirim jika ada postingan baru.`);
    }
    return result;
  }

  // Account exists in state, check for new video ID
  if (accountState.lastVideoId !== latestVideo.id) {
    // ANTI-SPAM GUARD: verify video ID has not already been sent to Discord
    const alreadySent = await hasVideoBeenSent(cleanUser, latestVideo.id);
    if (alreadySent) {
      console.log(`[Tracker] ℹ️ Video @${cleanUser} (ID: ${latestVideo.id}) sudah pernah dikirim ke Discord. Melewati notifikasi untuk mencegah spam.`);
      await updateAccountState(cleanUser, latestVideo.id, latestVideo.createTime);
      return result;
    }

    console.log(`[Tracker] 🔔 POSTINGAN BARU TERDETEKSI untuk @${cleanUser}! (ID: ${latestVideo.id})`);
    
    const sent = await sendDiscordNotification(webhookUrl, user, latestVideo, groupName);
    if (sent) {
      console.log(`[Tracker] ✅ Notifikasi berhasil dikirim ke Discord!`);
      await markVideoAsSent(cleanUser, latestVideo.id);
      await updateAccountState(cleanUser, latestVideo.id, latestVideo.createTime);
    } else {
      console.error(`[Tracker] ❌ Gagal mengirim notifikasi ke Discord.`);
    }
  } else {
    console.log(`[Tracker] Belum ada postingan baru untuk @${cleanUser}. (Video terakhir ID: ${latestVideo.id})`);
    await updateAccountState(cleanUser, accountState.lastVideoId, accountState.lastPostTime);
  }

  return result;
}
