import { getTikTokUserVideos } from './scraper.js';
import { sendDiscordNotification } from './notifier.js';
import { getAccountStates, updateAccountState } from './db.js';

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
    return;
  }

  const { user, videos } = result;

  if (!videos || videos.length === 0) {
    console.log(`[Tracker] Tidak ada video ditemukan untuk @${cleanUser}`);
    return;
  }

  const latestVideo = videos[0];
  const states = await getAccountStates();
  const accountState = states[cleanUser];

  if (!accountState || !accountState.lastVideoId) {
    // First time encountering this account
    console.log(`[Tracker] Akun @${cleanUser} baru didaftarkan. ID Video terkini: ${latestVideo.id}`);
    await updateAccountState(cleanUser, latestVideo.id, latestVideo.createTime);

    if (notifyOnFirstDiscovery) {
      console.log(`[Tracker] Mengirim notifikasi inisial ke Discord...`);
      await sendDiscordNotification(webhookUrl, user, latestVideo, groupName);
    } else {
      console.log(`[Tracker] Baseline disimpan. Notifikasi berikutnya akan dikirim jika ada postingan baru.`);
    }
    return;
  }

  // Account exists in state, check for new video ID
  if (accountState.lastVideoId !== latestVideo.id) {
    console.log(`[Tracker] 🔔 POSTINGAN BARU TERDETEKSI untuk @${cleanUser}! (ID: ${latestVideo.id})`);
    
    const sent = await sendDiscordNotification(webhookUrl, user, latestVideo, groupName);
    if (sent) {
      console.log(`[Tracker] ✅ Notifikasi berhasil dikirim ke Discord!`);
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
