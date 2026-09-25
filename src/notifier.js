/**
 * VCStudios • Discord Webhook Notifier
 * Supports multiple webhooks per group with event filtering (new_video, task_warning, double_upload, daily_report, account_not_found)
 */

export const WEBHOOK_EVENTS = {
  NEW_VIDEO: 'new_video',          // Postingan Video Baru TikTok
  TASK_WARNING: 'task_warning',    // Peringatan Target / Task Belum Selesai
  DOUBLE_UPLOAD: 'double_upload',  // Peringatan Double Upload
  DAILY_REPORT: 'daily_report',    // Rekap Daily Report Lengkap
  ACCOUNT_NOT_FOUND: 'account_not_found' // Peringatan Akun Salah / Tidak Ditemukan
};

export const ALL_WEBHOOK_EVENTS = Object.values(WEBHOOK_EVENTS);

/**
 * Extract active webhook URLs for a specific event
 * @param {string|object|Array} target Single URL, Webhooks array, or Group object
 * @param {string} eventType One of WEBHOOK_EVENTS
 * @returns {string[]} List of valid Discord Webhook URLs that subscribe to eventType
 */
export function getWebhooksForEvent(target, eventType) {
  if (!target) return [];
  if (typeof target === 'string') {
    const trimmed = target.trim();
    return trimmed ? [trimmed] : [];
  }
  let list = [];
  if (Array.isArray(target)) {
    list = target;
  } else if (typeof target === 'object') {
    if (Array.isArray(target.webhooks) && target.webhooks.length > 0) {
      list = target.webhooks;
    } else if (target.webhookUrl) {
      list = [{ url: target.webhookUrl, events: ALL_WEBHOOK_EVENTS }];
    }
  }

  const urls = [];
  for (const item of list) {
    if (!item) continue;
    const url = typeof item === 'string' ? item : item.url;
    if (!url || typeof url !== 'string') continue;
    const cleanUrl = url.trim();
    if (!cleanUrl) continue;

    // Check events filter
    if (typeof item === 'object' && Array.isArray(item.events) && item.events.length > 0) {
      if (item.events.includes(eventType)) {
        urls.push(cleanUrl);
      }
    } else {
      // Default to subscribing to all events if events array not specified
      urls.push(cleanUrl);
    }
  }

  return urls;
}

export let lastWebhookError = '';

/**
 * Send a Discord payload to a list of webhook URLs
 */
async function dispatchDiscordPayload(urls, payload, eventName = 'Notifikasi') {
  if (!urls || urls.length === 0) {
    lastWebhookError = 'Tidak ada URL webhook Discord tujuan yang valid';
    return false;
  }
  let successCount = 0;
  lastWebhookError = '';

  for (const rawUrl of urls) {
    const url = (rawUrl || '').trim();
    if (!url) continue;

    try {
      let res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10000)
      });

      // Handle Discord 429 Rate Limiting with automatic backoff retry
      if (res.status === 429) {
        try {
          const rateData = await res.json().catch(() => ({}));
          const waitMs = Math.min(5000, Math.ceil((rateData.retry_after || 1.5) * 1000) + 100);
          console.warn(`[Notifier] Webhook rate-limited (429) pada ${url}. Menunggu ${waitMs}ms lalu mencoba ulang...`);
          await new Promise((r) => setTimeout(r, waitMs));
          res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(10000)
          });
        } catch {}
      }

      if (res.ok) {
        successCount++;
      } else {
        const errText = await res.text();
        console.error(`[Notifier] Webhook failed (${res.status}) on ${url}:`, errText);
        if (res.status === 429) {
          lastWebhookError = 'Discord membatasi frekuensi pesan (Rate Limit / 429). Mohon tunggu beberapa detik lalu coba lagi.';
        } else if (res.status === 404) {
          lastWebhookError = 'Webhook tidak ditemukan di Discord (404 Not Found). Webhook mungkin sudah dihapus dari channel Discord Anda.';
        } else if (res.status === 401 || res.status === 403) {
          lastWebhookError = 'Akses webhook ditolak oleh Discord (Token webhook tidak valid / 401 Unauthorized).';
        } else {
          lastWebhookError = `Discord menolak webhook (Status ${res.status}): ${errText.slice(0, 100)}`;
        }
      }
    } catch (err) {
      console.error(`[Notifier] Error dispatching ${eventName} to ${url}:`, err.message);
      lastWebhookError = `Gagal menghubungi server Discord: ${err.message}`;
    }
  }
  return successCount > 0;
}

/**
 * Format and send a TikTok new video notification to Discord Webhook
 * @param {string|object|Array} target Discord Webhook URL, Webhooks array, or Group object
 * @param {object} user TikTok user info
 * @param {object} video TikTok video info
 * @param {string} groupName Group name
 * @returns {Promise<boolean>}
 */
export async function sendDiscordNotification(target, user, video, groupName = null) {
  const urls = getWebhooksForEvent(target, WEBHOOK_EVENTS.NEW_VIDEO);
  if (urls.length === 0) {
    return false;
  }

  const groupText = groupName ? ` • Group: ${groupName}` : '';

  const payload = {
    username: 'VCStudios',
    avatar_url: 'https://sf16-website-login.neutral.ttwstatic.com/obj/tiktok_web_login_static/favicon.ico',
    content: `@everyone 📢 **${user.nickname}** (@${user.uniqueId}) baru saja mengunggah video baru di TikTok!`,
    allowed_mentions: {
      parse: ['everyone']
    },
    embeds: [
      {
        author: {
          name: `${user.nickname} (@${user.uniqueId})`,
          url: `https://www.tiktok.com/@${user.uniqueId}`,
          icon_url: user.avatar || undefined
        },
        title: '🎬 Tonton Video Terbaru',
        url: video.url,
        description: video.desc ? video.desc : '*Tidak ada caption.*',
        color: 0xfe2c55, // TikTok signature pink-red
        image: video.cover ? { url: video.cover } : undefined,
        fields: [
          {
            name: '🕒 Waktu Posting',
            value: `<t:${video.createTime}:F> (<t:${video.createTime}:R>)`,
            inline: true
          },
          ...(groupName
            ? [
                {
                  name: '📁 Grup Saluran',
                  value: `\`${groupName}\``,
                  inline: true
                }
              ]
            : []),
          {
            name: '🔗 Direct Link',
            value: `[Klik di sini untuk menonton](${video.url})`,
            inline: false
          }
        ],
        footer: {
          text: `VCStudios${groupText} • TikTok Monitor`,
          icon_url: 'https://sf16-website-login.neutral.ttwstatic.com/obj/tiktok_web_login_static/favicon.ico'
        },
        timestamp: new Date(video.createTime * 1000).toISOString()
      }
    ]
  };

  return await dispatchDiscordPayload(urls, payload, 'Video Baru');
}

/**
 * Send Discord Warning Alert (e.g. Account not found / invalid username)
 */
export async function sendDiscordWarningNotification(target, username, groupName = null, reason = 'Akun tidak ditemukan di TikTok') {
  const urls = getWebhooksForEvent(target, WEBHOOK_EVENTS.ACCOUNT_NOT_FOUND);
  if (urls.length === 0) return false;

  const payload = {
    username: 'VCStudios Bot',
    avatar_url: 'https://sf16-website-login.neutral.ttwstatic.com/obj/tiktok_web_login_static/favicon.ico',
    content: `@everyone ⚠️ **Peringatan TikTok:** Akun @${username} tidak ditemukan!`,
    allowed_mentions: {
      parse: ['everyone']
    },
    embeds: [
      {
        title: `⚠️ Peringatan: Akun @${username} Tidak Ditemukan`,
        description: `Bot VCStudios mendeteksi bahwa akun **@${username}** tidak ditemukan di TikTok. Kemungkinan akun telah dihapus, berganti nama, atau ada salah ketik (typo).`,
        color: 0xff9900, // Amber / Warning color
        fields: [
          ...(groupName ? [{ name: '📁 Grup Saluran', value: `\`${groupName}\``, inline: true }] : []),
          { name: '🔍 Masalah', value: reason, inline: true },
          { name: '💡 Solusi', value: 'Periksa kembali ejaan username di Dashboard Web atau hapus akun ini dari daftar.', inline: false }
        ],
        footer: {
          text: 'VCStudios • TikTok Monitor Alert',
          icon_url: 'https://sf16-website-login.neutral.ttwstatic.com/obj/tiktok_web_login_static/favicon.ico'
        },
        timestamp: new Date().toISOString()
      }
    ]
  };

  return await dispatchDiscordPayload(urls, payload, 'Peringatan Akun Tidak Ditemukan');
}

/**
 * Send Discord Warning for Double Upload (Account uploaded >1 video in 1 day)
 */
export async function sendDiscordDoubleUploadWarning(target, groupName, username, uploadCount, latestVideo) {
  const urls = getWebhooksForEvent(target, WEBHOOK_EVENTS.DOUBLE_UPLOAD);
  if (urls.length === 0) return false;

  const payload = {
    username: 'VCStudios Bot',
    avatar_url: 'https://sf16-website-login.neutral.ttwstatic.com/obj/tiktok_web_login_static/favicon.ico',
    content: `@everyone ⚠️ **PERINGATAN DOUBLE UPLOAD:** Akun @${username} mengunggah lebih dari 1 video hari ini!`,
    allowed_mentions: {
      parse: ['everyone']
    },
    embeds: [
      {
        title: `⚠️ Peringatan: Double Upload Terdeteksi`,
        description: `Akun clippers **@${username}** pada grup **${groupName}** telah mengunggah **${uploadCount} video** hari ini (aturan kuota: 1 akun = 1 video/hari).`,
        color: 0xff3366, // Highlighted magenta warning
        fields: [
          { name: '📁 Grup Saluran', value: `\`${groupName}\``, inline: true },
          { name: '📊 Total Upload Hari Ini', value: `**${uploadCount} Video**`, inline: true },
          ...(latestVideo?.url ? [{ name: '🎬 Video Terakhir', value: `[Buka Postingan TikTok](${latestVideo.url})`, inline: false }] : [])
        ],
        footer: {
          text: 'VCStudios • Daily Rule Monitor',
          icon_url: 'https://sf16-website-login.neutral.ttwstatic.com/obj/tiktok_web_login_static/favicon.ico'
        },
        timestamp: new Date().toISOString()
      }
    ]
  };

  return await dispatchDiscordPayload(urls, payload, 'Peringatan Double Upload');
}

/**
 * Send Discord Warning if Daily Quota is Incomplete (Target: 14 accounts each uploading 1 video)
 */
export async function sendDiscordIncompleteWarning(
  target,
  groupName,
  completedCount,
  targetCount = 14,
  missingAccounts = [],
  options = {}
) {
  const isTest = Boolean(options.isTest);

  // If 14 or more accounts have uploaded and not a test run -> Do not send warning!
  if (!isTest && completedCount >= targetCount) return false;

  let urls = typeof target === 'string'
    ? [target.trim()]
    : getWebhooksForEvent(target, WEBHOOK_EVENTS.TASK_WARNING);

  if (urls.length === 0 && isTest) {
    if (target?.url) urls = [target.url.trim()];
    else if (target?.webhookUrl) urls = [target.webhookUrl.trim()];
  }
  if (urls.length === 0) {
    lastWebhookError = 'Tidak ada webhook yang aktif untuk menerima peringatan task';
    return false;
  }

  const effectiveCompleted = isTest && completedCount >= targetCount ? Math.max(0, targetCount - 2) : completedCount;
  const remainingNeeded = Math.max(1, targetCount - effectiveCompleted);
  const effectiveMissing = (missingAccounts && missingAccounts.length > 0) ? missingAccounts : ['akun_clippers_sample_1', 'akun_clippers_sample_2'];
  const missingList = effectiveMissing.slice(0, 14).map((acc, i) => `${i + 1}. @${acc}`).join('\n');
  const moreText = effectiveMissing.length > 14 ? `\n... dan ${effectiveMissing.length - 14} akun lainnya` : '';

  const {
    reminderType = 'standard', // '10_min_reminder' | 'deadline_reached' | 'standard'
    deadlineTime = '22:00',
    reminderMinutes = 10
  } = options;

  const formattedDeadline = (deadlineTime || '22:00').replace(':', '.');

  const content = `@everyone\n‼️🚨REMINDER🚨‼️\n${groupName}…. upload TikToknyaaa!!!\nbatas kirim report jam ${formattedDeadline} WIB👿💥`;
  const color = reminderType === '10_min_reminder' ? 0xff0033 : 0xfe2c55;

  let title = '📊 Detail Progres Target Harian';
  let description = undefined;

  if (reminderType === '10_min_reminder') {
    title = `⏰ PERINGATAN TERAKHIR (${reminderMinutes} MENIT LAGI)`;
    description = `⚠️ Batas waktu kirim report akan berakhir dalam **${reminderMinutes} menit lagi** (pukul **${formattedDeadline} WIB**)!`;
  } else if (reminderType === 'deadline_reached') {
    title = '🚨 BATAS WAKTU SELESAI';
    description = `Batas waktu pengiriman report telah berakhir pada pukul **${formattedDeadline} WIB**.`;
  }

  const payload = {
    username: 'VCStudios Bot',
    avatar_url: 'https://sf16-website-login.neutral.ttwstatic.com/obj/tiktok_web_login_static/favicon.ico',
    content,
    allowed_mentions: {
      parse: ['everyone']
    },
    embeds: [
      {
        title,
        description,
        color,
        fields: [
          { name: '📁 Grup Saluran', value: `\`${groupName}\``, inline: true },
          { name: '⏰ Batas Waktu Report', value: `\`${formattedDeadline} WIB\``, inline: true },
          { name: '🎯 Status Kuota Harian', value: `**${completedCount} / ${targetCount} Akun** (${remainingNeeded} Belum Selesai)`, inline: true },
          { name: `❌ Akun yang Belum Upload (${effectiveMissing.length} Akun)`, value: missingList + moreText, inline: false }
        ],
        footer: {
          text: 'VCStudios • Daily Target Reminder',
          icon_url: 'https://sf16-website-login.neutral.ttwstatic.com/obj/tiktok_web_login_static/favicon.ico'
        },
        timestamp: new Date().toISOString()
      }
    ]
  };

  return await dispatchDiscordPayload(urls, payload, `Peringatan Target (${reminderType})`);
}

/**
 * Send celebratory notification to Discord when daily quota/task is completed (14 accounts finished)
 * @param {string|object} target Webhook URL or Group object
 * @param {string} groupName Group name
 * @param {number} completedCount Total accounts uploaded
 * @param {number} targetCount Target count (default: 14)
 * @param {Array} uploadedAccounts List of accounts that uploaded
 * @param {object} options Options (e.g. deadlineTime)
 * @returns {Promise<boolean>}
 */
export async function sendDiscordTaskCompletedNotification(
  target,
  groupName,
  completedCount,
  targetCount = 14,
  uploadedAccounts = [],
  options = {}
) {
  let urls = [];
  if (typeof target === 'string') {
    urls = [target.trim()];
  } else {
    // Deliver to webhooks subscribed to TASK_WARNING (the remainder channel) and DAILY_REPORT (admin channel)
    const warningUrls = getWebhooksForEvent(target, WEBHOOK_EVENTS.TASK_WARNING);
    const reportUrls = getWebhooksForEvent(target, WEBHOOK_EVENTS.DAILY_REPORT);
    urls = Array.from(new Set([...warningUrls, ...reportUrls]));
  }

  if (urls.length === 0) {
    if (target?.url) urls = [target.url.trim()];
    else if (target?.webhookUrl) urls = [target.webhookUrl.trim()];
  }

  if (urls.length === 0) {
    lastWebhookError = 'Tidak ada webhook yang aktif untuk menerima notifikasi selesai';
    return false;
  }

  const { deadlineTime = '22:00' } = options;
  const formattedDeadline = (deadlineTime || '22:00').replace(':', '.');

  const content = `@everyone
🎉✅ **TARGET KUOTA HARIAN SELESAI!** ✅🎉
Alhamdulillah, task upload TikTok grup **${groupName}** hari ini SUDAH TUNTAS! (**${completedCount}/${targetCount} Akun**)
Terima kasih semuanya! Kerja bagus tim clippers! 🚀🔥`;

  const topUploaded = (uploadedAccounts || []).slice(0, 14);
  const uploadedList = topUploaded.map((u, i) => {
    const acc = typeof u === 'string' ? u : (u.account || u.nickname || 'akun');
    const url = u.videoUrl ? ` — [Tonton Video](${u.videoUrl})` : '';
    return `${i + 1}. **@${acc}**${url}`;
  }).join('\n') || `• ${completedCount} akun telah berhasil mengunggah video.`;

  const extraCount = (uploadedAccounts || []).length > 14 ? (uploadedAccounts.length - 14) : 0;
  const extraText = extraCount > 0 ? `\n*... dan ${extraCount} video tambahan lainnya*` : '';

  const payload = {
    username: 'VCStudios Bot',
    avatar_url: 'https://sf16-website-login.neutral.ttwstatic.com/obj/tiktok_web_login_static/favicon.ico',
    content,
    allowed_mentions: {
      parse: ['everyone']
    },
    embeds: [
      {
        title: '📊 Rincian Penyelesaian Kuota Harian',
        description: `Semua target minimal **1 video di ${targetCount} akun** telah terpenuhi sebelum batas report jam **${formattedDeadline} WIB**. 🚀🔥`,
        color: 0x00ff88, // Radiant Neon Green
        fields: [
          { name: '📁 Grup Saluran', value: `\`${groupName}\``, inline: true },
          { name: '🎯 Pencapaian Target', value: `✅ **${completedCount} / ${targetCount} Akun** (100%)`, inline: true },
          { name: '⏰ Batas Waktu Report', value: `\`${formattedDeadline} WIB\``, inline: true },
          { name: `✨ Akun yang Telah Selesai Mengunggah (${completedCount} Akun)`, value: uploadedList + extraText, inline: false }
        ],
        footer: {
          text: 'VCStudios • Daily Target Completed',
          icon_url: 'https://sf16-website-login.neutral.ttwstatic.com/obj/tiktok_web_login_static/favicon.ico'
        },
        timestamp: new Date().toISOString()
      }
    ]
  };

  return await dispatchDiscordPayload(urls, payload, 'Notifikasi Task Selesai');
}

/**
 * Send Full Formatted Daily Report to Discord
 */
export async function sendDiscordDailyReport(target, groupName, report) {
  const urls = getWebhooksForEvent(target, WEBHOOK_EVENTS.DAILY_REPORT);
  if (urls.length === 0) return false;

  const uploadedList = (report.uploaded || []).map((u, i) => `${i + 1}. **@${u.account}** — [Tonton Video](${u.videoUrl})`).join('\n') || '(Belum ada akun upload hari ini)';
  const remainingNeeded = Math.max(0, (report.target || 14) - (report.uploadedCount || 0));
  const missingList = (report.missing || []).slice(0, 14).map((m, i) => `${i + 1}. @${m}`).join('\n') || '🎉 Target 14 akun sudah tuntas!';
  const doubleList = (report.doubles || []).map((d) => `• @${d.account} (${d.count} video hari ini)`).join('\n') || 'Tidak ada.';

  const payload = {
    username: 'VCStudios Bot',
    avatar_url: 'https://sf16-website-login.neutral.ttwstatic.com/obj/tiktok_web_login_static/favicon.ico',
    content: `@everyone 📊 **DAILY REPORT CLIPPERS — ${groupName.toUpperCase()}** (${report.date})`,
    allowed_mentions: {
      parse: ['everyone']
    },
    embeds: [
      {
        title: `📊 Laporan Harian Unggahan Video: ${groupName}`,
        description: `Ringkasan unggahan video clippers untuk tanggal **${report.date}**.\nAturan kuota: **1 video di 14 akun = SELESAI**.`,
        color: report.isCompleted ? 0x10b981 : 0x38bdf8,
        fields: [
          { name: '🎯 Status Pencapaian', value: `**${report.uploadedCount} / ${report.target} Akun Selesai** (${report.percentage}%)`, inline: true },
          { name: '⚡ Status', value: report.isCompleted ? '✅ SELESAI (14 Akun Tuntas)' : `⚠️ BELUM SELESAI (Kurang ${remainingNeeded} Akun)`, inline: true },
          { name: `✅ Sudah Upload (${report.uploadedCount} Akun)`, value: uploadedList, inline: false },
          ...(!report.isCompleted ? [{ name: `❌ Belum Upload (${remainingNeeded} Akun Lagi Menuju Target)`, value: missingList, inline: false }] : []),
          ...(report.doubles.length > 0 ? [{ name: `⚠️ Double Upload (${report.doubles.length} Akun)`, value: doubleList, inline: false }] : [])
        ],
        footer: {
          text: 'VCStudios • Daily Report Generator',
          icon_url: 'https://sf16-website-login.neutral.ttwstatic.com/obj/tiktok_web_login_static/favicon.ico'
        },
        timestamp: new Date().toISOString()
      }
    ]
  };

  return await dispatchDiscordPayload(urls, payload, 'Daily Report');
}

/**
 * Send Test Ping to Discord Webhook
 */
export async function sendDiscordTestPing(target, groupName = 'Grup') {
  let urls = [];
  if (typeof target === 'string') {
    const trimmed = target.trim();
    if (trimmed) urls = [trimmed];
  } else if (Array.isArray(target)) {
    urls = target.map((t) => (typeof t === 'string' ? t.trim() : t?.url?.trim())).filter(Boolean);
  } else if (typeof target === 'object' && target !== null) {
    if (target.url) {
      urls = [target.url.trim()];
    } else if (Array.isArray(target.webhooks) && target.webhooks.length > 0) {
      urls = target.webhooks.map((w) => (typeof w === 'string' ? w.trim() : w?.url?.trim())).filter(Boolean);
    } else if (target.webhookUrl) {
      urls = [target.webhookUrl.trim()];
    }
  }

  if (urls.length === 0) {
    lastWebhookError = 'URL webhook Discord tidak ditemukan atau kosong';
    return false;
  }

  const payload = {
    username: 'VCStudios Bot',
    avatar_url: 'https://sf16-website-login.neutral.ttwstatic.com/obj/tiktok_web_login_static/favicon.ico',
    embeds: [
      {
        title: '🧪 Webhook Connected Successfully!',
        description: `Webhook Discord untuk grup **${groupName}** berhasil terhubung dan siap menerima notifikasi otomatis.`,
        color: 0x25f4ee,
        fields: [
          { name: '📁 Grup Saluran', value: `\`${groupName}\``, inline: true },
          { name: '⚡ Status', value: '✅ Aktif & Terverifikasi', inline: true }
        ],
        footer: {
          text: 'VCStudios • TikTok Notifier',
          icon_url: 'https://sf16-website-login.neutral.ttwstatic.com/obj/tiktok_web_login_static/favicon.ico'
        },
        timestamp: new Date().toISOString()
      }
    ]
  };

  return await dispatchDiscordPayload(urls, payload, 'Tes Webhook Ping');
}

