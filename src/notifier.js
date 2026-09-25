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
 * Format the mention prefix based on webhook setting
 * @param {string} mentionType 'everyone' | 'here' | 'none' | 'role' | 'custom'
 * @param {string} mentionRole Role ID or custom text
 * @returns {string} e.g. '@everyone', '@here', '<@&123...>', or ''
 */
export function formatMentionTag(mentionType = 'everyone', mentionRole = '') {
  const m = String(mentionType || 'everyone').trim().toLowerCase();
  if (m === 'none' || m === 'silent' || m === 'off') {
    return '';
  }
  if (m === 'here') {
    return '@here';
  }
  if (m === 'user') {
    const u = String(mentionRole || '').trim();
    if (!u) return '';
    const parts = u.split(/[\s,]+/).filter(Boolean);
    if (parts.length > 1) {
      return parts.map((p) => {
        if (p.startsWith('<@') || p.startsWith('@')) return p;
        if (/^\d+$/.test(p)) return `<@${p}>`;
        return `@${p}`;
      }).join(' ');
    }
    if (u.startsWith('<@') || u.startsWith('@')) return u;
    if (/^\d+$/.test(u)) return `<@${u}>`;
    return `@${u}`;
  }
  if (m === 'role') {
    const r = String(mentionRole || '').trim();
    if (!r) return '';
    if (r.startsWith('<@&') || r.startsWith('@')) return r;
    if (/^\d+$/.test(r)) return `<@&${r}>`;
    return `@${r}`;
  }
  if (m === 'custom') {
    return String(mentionRole || '').trim();
  }
  return '@everyone';
}

/**
 * Extract active webhook objects with events and mention settings
 * @param {string|object|Array} target Single URL, Webhooks array, or Group object
 * @param {string} eventType One of WEBHOOK_EVENTS (optional)
 * @returns {Array<{url: string, name: string, events: string[], mention: string, mentionRole: string}>}
 */
export function getWebhookTargetsForEvent(target, eventType) {
  if (!target) return [];
  if (typeof target === 'string') {
    const trimmed = target.trim();
    return trimmed ? [{ url: trimmed, name: 'Default', events: ALL_WEBHOOK_EVENTS, mention: 'everyone', mentionRole: '' }] : [];
  }
  let list = [];
  if (Array.isArray(target)) {
    list = target;
  } else if (typeof target === 'object') {
    if (Array.isArray(target.webhooks) && target.webhooks.length > 0) {
      list = target.webhooks;
    } else if (target.url) {
      list = [target];
    } else if (target.webhookUrl) {
      list = [{ url: target.webhookUrl, name: 'Default', events: ALL_WEBHOOK_EVENTS, mention: target.mention || 'everyone', mentionRole: target.mentionRole || '' }];
    }
  }

  const targets = [];
  for (const item of list) {
    if (!item) continue;
    const url = typeof item === 'string' ? item : item.url;
    if (!url || typeof url !== 'string') continue;
    const cleanUrl = url.trim();
    if (!cleanUrl) continue;

    const events = (typeof item === 'object' && Array.isArray(item.events) && item.events.length > 0)
      ? item.events
      : ALL_WEBHOOK_EVENTS;

    if (!eventType || events.includes(eventType)) {
      targets.push({
        url: cleanUrl,
        name: typeof item === 'object' ? (item.name || 'Webhook') : 'Webhook',
        events,
        mention: typeof item === 'object' ? (item.mention || 'everyone') : 'everyone',
        mentionRole: typeof item === 'object' ? (item.mentionRole || '') : ''
      });
    }
  }

  return targets;
}

/**
 * Extract active webhook URLs for a specific event
 * @param {string|object|Array} target Single URL, Webhooks array, or Group object
 * @param {string} eventType One of WEBHOOK_EVENTS
 * @returns {string[]} List of valid Discord Webhook URLs that subscribe to eventType
 */
export function getWebhooksForEvent(target, eventType) {
  return getWebhookTargetsForEvent(target, eventType).map((t) => t.url);
}

export let lastWebhookError = '';

/**
 * Send a Discord payload to a list of webhook URLs or targets
 */
async function dispatchDiscordPayload(targets, payloadOrBuilder, eventName = 'Notifikasi') {
  let targetList = [];
  if (Array.isArray(targets)) {
    targetList = targets.map((t) => {
      if (typeof t === 'string') {
        return { url: t.trim(), name: 'Webhook', mention: 'everyone', mentionRole: '' };
      }
      return {
        url: (t?.url || '').trim(),
        name: t?.name || 'Webhook',
        mention: t?.mention || 'everyone',
        mentionRole: t?.mentionRole || ''
      };
    }).filter((t) => Boolean(t.url));
  } else if (typeof targets === 'string' && targets.trim()) {
    targetList = [{ url: targets.trim(), name: 'Webhook', mention: 'everyone', mentionRole: '' }];
  } else if (targets && typeof targets === 'object' && targets.url) {
    targetList = [{
      url: targets.url.trim(),
      name: targets.name || 'Webhook',
      mention: targets.mention || 'everyone',
      mentionRole: targets.mentionRole || ''
    }];
  }

  if (targetList.length === 0) {
    lastWebhookError = 'Tidak ada URL webhook Discord tujuan yang valid';
    return false;
  }

  let successCount = 0;
  lastWebhookError = '';

  for (const targetWh of targetList) {
    const url = targetWh.url;
    if (!url) continue;

    const mentionTag = formatMentionTag(targetWh.mention, targetWh.mentionRole);
    let payload;
    if (typeof payloadOrBuilder === 'function') {
      payload = payloadOrBuilder(mentionTag, targetWh);
    } else {
      payload = { ...payloadOrBuilder };
      if (typeof payload.content === 'string') {
        if (mentionTag === '') {
          payload.content = payload.content.replace(/^@everyone\s*\n?/, '').trim();
        } else if (mentionTag !== '@everyone') {
          payload.content = payload.content.replace(/^@everyone/, mentionTag);
        }
      }
    }

    let attempts = 0;
    const maxAttempts = 3;

    while (attempts < maxAttempts) {
      attempts++;
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(10000)
        });

        if (res.ok) {
          successCount++;
          break;
        }

        if (res.status === 429 && attempts < maxAttempts) {
          let waitMs = 2000;
          try {
            const retryHeader = res.headers.get('retry-after');
            if (retryHeader) {
              waitMs = Math.ceil(parseFloat(retryHeader) * 1000) + 200;
            } else {
              const rateData = await res.json().catch(() => ({}));
              if (rateData.retry_after) {
                waitMs = Math.ceil(Number(rateData.retry_after) * 1000) + 200;
              }
            }
          } catch {}
          waitMs = Math.max(1000, Math.min(waitMs, 10000));
          console.warn(`[Notifier] Webhook rate-limited (429) pada ${url}. Menunggu ${waitMs}ms lalu mencoba ulang (${attempts}/${maxAttempts})...`);
          await new Promise((r) => setTimeout(r, waitMs));
          continue;
        }

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
        break;
      } catch (err) {
        if (attempts >= maxAttempts) {
          console.error(`[Notifier] Error dispatching ${eventName} to ${url}:`, err.message);
          lastWebhookError = `Gagal menghubungi server Discord: ${err.message}`;
        } else {
          await new Promise((r) => setTimeout(r, 1000));
        }
      }
    }
  }
  return successCount > 0;
}

/**
 * Safely format an array of item strings into one or more Discord embed fields
 * so that no field value exceeds Discord's 1024-character maximum limit.
 */
function formatListToDiscordFields(title, items, isInline = false, maxCharsPerField = 850) {
  if (!items || items.length === 0) {
    return [{ name: title, value: '(Belum ada data)', inline: isInline }];
  }

  const fields = [];
  let currentChunk = [];
  let currentLength = 0;
  let chunkStartIndex = 1;

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const itemLen = item.length + 1;

    if (currentChunk.length > 0 && currentLength + itemLen > maxCharsPerField) {
      const chunkEndIndex = chunkStartIndex + currentChunk.length - 1;
      const fieldTitle = items.length === currentChunk.length
        ? title
        : `${title} (${chunkStartIndex}–${chunkEndIndex})`;

      fields.push({
        name: fieldTitle,
        value: currentChunk.join('\n'),
        inline: isInline
      });

      currentChunk = [];
      currentLength = 0;
      chunkStartIndex = i + 1;
    }

    currentChunk.push(item);
    currentLength += itemLen;
  }

  if (currentChunk.length > 0) {
    const chunkEndIndex = chunkStartIndex + currentChunk.length - 1;
    const fieldTitle = fields.length === 0
      ? title
      : `${title} (${chunkStartIndex}–${chunkEndIndex})`;

    fields.push({
      name: fieldTitle,
      value: currentChunk.join('\n'),
      inline: isInline
    });
  }

  return fields;
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
  const targets = getWebhookTargetsForEvent(target, WEBHOOK_EVENTS.NEW_VIDEO);
  if (targets.length === 0) {
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

  return await dispatchDiscordPayload(targets, payload, 'Video Baru');
}

/**
 * Send Discord Warning Alert (e.g. Account not found / invalid username)
 */
export async function sendDiscordWarningNotification(target, username, groupName = null, reason = 'Akun tidak ditemukan di TikTok') {
  const targets = getWebhookTargetsForEvent(target, WEBHOOK_EVENTS.ACCOUNT_NOT_FOUND);
  if (targets.length === 0) return false;

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

  return await dispatchDiscordPayload(targets, payload, 'Peringatan Akun Tidak Ditemukan');
}

/**
 * Send Discord Warning for Double Upload (Account uploaded >1 video in 1 day)
 */
export async function sendDiscordDoubleUploadWarning(target, groupName, username, uploadCount, latestVideo) {
  const targets = getWebhookTargetsForEvent(target, WEBHOOK_EVENTS.DOUBLE_UPLOAD);
  if (targets.length === 0) return false;

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

  return await dispatchDiscordPayload(targets, payload, 'Peringatan Double Upload');
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

  let targets = typeof target === 'string'
    ? [{ url: target.trim(), mention: 'everyone', mentionRole: '' }]
    : getWebhookTargetsForEvent(target, WEBHOOK_EVENTS.TASK_WARNING);

  if (targets.length === 0 && isTest) {
    if (target?.url) targets = [{ url: target.url.trim(), mention: target.mention || 'everyone', mentionRole: target.mentionRole || '' }];
    else if (target?.webhookUrl) targets = [{ url: target.webhookUrl.trim(), mention: target.mention || 'everyone', mentionRole: target.mentionRole || '' }];
  }
  if (targets.length === 0) {
    lastWebhookError = 'Tidak ada webhook yang aktif untuk menerima peringatan task';
    return false;
  }

  const effectiveCompleted = isTest && completedCount >= targetCount ? Math.max(0, targetCount - 2) : completedCount;
  const remainingNeeded = Math.max(1, targetCount - effectiveCompleted);
  const effectiveMissing = (missingAccounts && missingAccounts.length > 0) ? missingAccounts : ['akun_clippers_sample_1', 'akun_clippers_sample_2'];
  const missingItems = effectiveMissing.slice(0, 14).map((acc, i) => `${i + 1}. @${acc}`);
  if (effectiveMissing.length > 14) {
    missingItems.push(`*... dan ${effectiveMissing.length - 14} akun lainnya*`);
  }
  const missingFields = formatListToDiscordFields(
    `❌ Akun yang Belum Upload (${effectiveMissing.length} Akun)`,
    missingItems,
    false,
    850
  );

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
          ...missingFields
        ],
        footer: {
          text: 'VCStudios • Daily Target Reminder',
          icon_url: 'https://sf16-website-login.neutral.ttwstatic.com/obj/tiktok_web_login_static/favicon.ico'
        },
        timestamp: new Date().toISOString()
      }
    ]
  };

  return await dispatchDiscordPayload(targets, payload, `Peringatan Target (${reminderType})`);
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
  let targets = [];
  if (typeof target === 'string') {
    targets = [{ url: target.trim(), mention: 'everyone', mentionRole: '' }];
  } else {
    // Deliver to webhooks subscribed to TASK_WARNING (the remainder channel) and DAILY_REPORT (admin channel)
    const warningTargets = getWebhookTargetsForEvent(target, WEBHOOK_EVENTS.TASK_WARNING);
    const reportTargets = getWebhookTargetsForEvent(target, WEBHOOK_EVENTS.DAILY_REPORT);
    const seenUrls = new Set();
    for (const t of [...warningTargets, ...reportTargets]) {
      if (!seenUrls.has(t.url)) {
        seenUrls.add(t.url);
        targets.push(t);
      }
    }
  }

  if (targets.length === 0) {
    if (target?.url) targets = [{ url: target.url.trim(), mention: target.mention || 'everyone', mentionRole: target.mentionRole || '' }];
    else if (target?.webhookUrl) targets = [{ url: target.webhookUrl.trim(), mention: target.mention || 'everyone', mentionRole: target.mentionRole || '' }];
  }

  if (targets.length === 0) {
    lastWebhookError = 'Tidak ada webhook yang aktif untuk menerima notifikasi selesai';
    return false;
  }

  const { deadlineTime = '22:00', reportUrl = '' } = options;
  const formattedDeadline = (deadlineTime || '22:00').replace(':', '.');

  const reportLinkSection = reportUrl
    ? `\n\n📋 **Link Laporan Lengkap (Bisa di-copy):**\n${reportUrl}`
    : '';

  const content = `@everyone
🎉✅ **TARGET KUOTA HARIAN SELESAI!** ✅🎉
Alhamdulillah, task upload TikTok grup **${groupName}** hari ini SUDAH TUNTAS! (**${completedCount}/${targetCount} Akun**)
Terima kasih semuanya! Kerja bagus tim clippers! 🚀🔥${reportLinkSection}`;

  const topUploaded = (uploadedAccounts || []).slice(0, 14);
  const uploadedItems = topUploaded.map((u, i) => {
    const acc = typeof u === 'string' ? u : (u.account || u.nickname || 'akun');
    const url = u.videoUrl ? ` — [Tonton Video](${u.videoUrl})` : '';
    return `${i + 1}. **@${acc}**${url}`;
  });

  const extraCount = (uploadedAccounts || []).length > 14 ? (uploadedAccounts.length - 14) : 0;
  if (extraCount > 0) {
    uploadedItems.push(`*... dan ${extraCount} video tambahan lainnya*`);
  }

  const uploadedFields = formatListToDiscordFields(
    `✨ Akun yang Telah Selesai Mengunggah (${completedCount} Akun)`,
    uploadedItems,
    false,
    850
  );

  const payload = {
    username: 'VCStudios Bot',
    avatar_url: 'https://sf16-website-login.neutral.ttwstatic.com/obj/tiktok_web_login_static/favicon.ico',
    content,
    allowed_mentions: {
      parse: ['everyone', 'roles', 'users']
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
          ...(reportUrl ? [{
            name: '📋 Link Laporan Lengkap (Salin / Buka)',
            value: `[🌐 Buka Laporan Interaktif Web](${reportUrl})\n\`${reportUrl}\``,
            inline: false
          }] : []),
          ...uploadedFields
        ],
        footer: {
          text: 'VCStudios • Daily Target Completed',
          icon_url: 'https://sf16-website-login.neutral.ttwstatic.com/obj/tiktok_web_login_static/favicon.ico'
        },
        timestamp: new Date().toISOString()
      }
    ]
  };

  return await dispatchDiscordPayload(targets, payload, 'Notifikasi Task Selesai');
}

/**
 * Send Full Formatted Daily Report to Discord
 */
export async function sendDiscordDailyReport(target, groupName, report) {
  const targets = getWebhookTargetsForEvent(target, WEBHOOK_EVENTS.DAILY_REPORT);
  if (targets.length === 0) return false;

  const uploadedItems = (report.uploaded || []).map((u, i) => `${i + 1}. **@${u.account}** — [Tonton Video](${u.videoUrl})`);
  const uploadedFields = formatListToDiscordFields(
    `✅ Sudah Upload (${report.uploadedCount} Akun)`,
    uploadedItems,
    false,
    850
  );

  const remainingNeeded = Math.max(0, (report.target || 14) - (report.uploadedCount || 0));
  const missingItems = (report.missing || []).slice(0, 14).map((m, i) => `${i + 1}. @${m}`);
  const missingFields = !report.isCompleted
    ? formatListToDiscordFields(`❌ Belum Upload (${remainingNeeded} Akun Lagi Menuju Target)`, missingItems, false, 850)
    : [];

  const doubleList = (report.doubles || []).map((d) => `• @${d.account} (${d.count} video hari ini)`).join('\n') || 'Tidak ada.';

  const payload = {
    username: 'VCStudios Bot',
    avatar_url: 'https://sf16-website-login.neutral.ttwstatic.com/obj/tiktok_web_login_static/favicon.ico',
    content: `@everyone 📊 **DAILY REPORT CLIPPERS — ${groupName.toUpperCase()}** (${report.date})`,
    allowed_mentions: {
      parse: ['everyone', 'roles', 'users']
    },
    embeds: [
      {
        title: `📊 Laporan Harian Unggahan Video: ${groupName}`,
        description: `Ringkasan unggahan video clippers untuk tanggal **${report.date}**.\nAturan kuota: **1 video di 14 akun = SELESAI**.`,
        color: report.isCompleted ? 0x10b981 : 0x38bdf8,
        fields: [
          { name: '🎯 Status Pencapaian', value: `**${report.uploadedCount} / ${report.target} Akun Selesai** (${report.percentage}%)`, inline: true },
          { name: '⚡ Status', value: report.isCompleted ? '✅ SELESAI (14 Akun Tuntas)' : `⚠️ BELUM SELESAI (Kurang ${remainingNeeded} Akun)`, inline: true },
          ...uploadedFields,
          ...missingFields,
          ...(report.doubles.length > 0 ? [{ name: `⚠️ Double Upload (${report.doubles.length} Akun)`, value: doubleList.slice(0, 1000), inline: false }] : [])
        ],
        footer: {
          text: 'VCStudios • Daily Report Generator',
          icon_url: 'https://sf16-website-login.neutral.ttwstatic.com/obj/tiktok_web_login_static/favicon.ico'
        },
        timestamp: new Date().toISOString()
      }
    ]
  };

  return await dispatchDiscordPayload(targets, payload, 'Daily Report');
}

/**
 * Send Test Ping to Discord Webhook
 */
export async function sendDiscordTestPing(target, groupName = 'Grup') {
  let targets = [];
  if (typeof target === 'string') {
    const trimmed = target.trim();
    if (trimmed) targets = [{ url: trimmed, mention: 'everyone' }];
  } else if (Array.isArray(target)) {
    targets = target.map((t) => (typeof t === 'string' ? { url: t.trim(), mention: 'everyone' } : t)).filter((t) => t && t.url);
  } else if (typeof target === 'object' && target !== null) {
    if (target.url) {
      targets = [target];
    } else if (Array.isArray(target.webhooks) && target.webhooks.length > 0) {
      targets = target.webhooks.filter((w) => w && w.url);
    } else if (target.webhookUrl) {
      targets = [{ url: target.webhookUrl.trim(), mention: 'everyone' }];
    }
  }

  if (targets.length === 0) {
    lastWebhookError = 'URL webhook Discord tidak ditemukan atau kosong';
    return false;
  }

  return await dispatchDiscordPayload(targets, (t) => {
    const mentionTag = formatMentionTag(t.mention, t.mentionRole);
    return {
      content: mentionTag ? `${mentionTag} 🧪 **Tes Webhook**` : undefined,
      username: 'VCStudios Bot',
      avatar_url: 'https://sf16-website-login.neutral.ttwstatic.com/obj/tiktok_web_login_static/favicon.ico',
      embeds: [
        {
          title: '🧪 Webhook Connected Successfully!',
          description: `Webhook Discord untuk grup **${groupName}** berhasil terhubung dan siap menerima notifikasi otomatis.`,
          color: 0x25f4ee,
          fields: [
            { name: '📁 Grup Saluran', value: `\`${groupName}\``, inline: true },
            { name: '⚡ Status', value: '✅ Aktif & Terverifikasi', inline: true },
            { name: '📢 Pengaturan Mention', value: mentionTag ? `\`${mentionTag}\`` : '🔕 *Hening (Tanpa Mention)*', inline: true }
          ],
          footer: {
            text: 'VCStudios • TikTok Notifier',
            icon_url: 'https://sf16-website-login.neutral.ttwstatic.com/obj/tiktok_web_login_static/favicon.ico'
          },
          timestamp: new Date().toISOString()
        }
      ]
    };
  }, 'Tes Webhook Ping');
}

