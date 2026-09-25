let currentStatus = null;
let activeGroupId = null;
let countdownSeconds = 0;
let pollTimer = null;
let currentUserRole = localStorage.getItem('vcstudios_role') || sessionStorage.getItem('vcstudios_role') || 'Admin';
let currentUsername = localStorage.getItem('vcstudios_username') || sessionStorage.getItem('vcstudios_username') || '';
let currentMainView = 'report';

function escapeHtml(text) {
  if (!text) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// Auth State Management
function getToken() {
  return localStorage.getItem('vcstudios_token') || sessionStorage.getItem('vcstudios_token');
}

function setToken(token, remember = true, role = 'Admin', username = '') {
  currentUserRole = role || 'Admin';
  currentUsername = username || '';
  if (remember) {
    localStorage.setItem('vcstudios_token', token);
    localStorage.setItem('vcstudios_role', currentUserRole);
    localStorage.setItem('vcstudios_username', currentUsername);
  } else {
    sessionStorage.setItem('vcstudios_token', token);
    sessionStorage.setItem('vcstudios_role', currentUserRole);
    sessionStorage.setItem('vcstudios_username', currentUsername);
  }
}

function clearToken() {
  currentUserRole = 'Admin';
  currentUsername = '';
  localStorage.removeItem('vcstudios_token');
  localStorage.removeItem('vcstudios_role');
  localStorage.removeItem('vcstudios_username');
  sessionStorage.removeItem('vcstudios_token');
  sessionStorage.removeItem('vcstudios_role');
  sessionStorage.removeItem('vcstudios_username');
}

// Authenticated fetch wrapper
async function authFetch(url, options = {}) {
  const token = getToken();
  const headers = {
    ...(options.headers || {}),
    Authorization: token ? `Bearer ${token}` : ''
  };

  const response = await fetch(url, { ...options, headers });

  if (response.status === 401 && !url.includes('/api/auth/')) {
    clearToken();
    showLoginView();
    showToast('Sesi Anda telah berakhir. Silakan login kembali.', true);
    throw new Error('Unauthorized');
  }

  // Safe JSON wrapper to prevent "The string did not match the expected pattern" in WebKit/Safari
  response.json = async () => {
    try {
      const text = await response.text();
      try {
        return JSON.parse(text);
      } catch {
        return {
          success: response.ok,
          error: text || `HTTP ${response.status}`,
          message: text || `HTTP ${response.status}`
        };
      }
    } catch (e) {
      return { success: false, error: e.message, message: e.message };
    }
  };

  return response;
}

// View Toggles
function showLoginView() {
  document.getElementById('login-screen').style.display = 'flex';
  document.getElementById('dashboard-view').style.display = 'none';
  if (pollTimer) clearInterval(pollTimer);
}

function showDashboardView() {
  document.getElementById('login-screen').style.display = 'none';
  document.getElementById('dashboard-view').style.display = 'block';

  // 1. INSTANT ZERO-SECOND HYDRATION:
  // Instantly render previously cached status from browser storage on refresh
  try {
    const cachedRaw = localStorage.getItem('vcstudios_last_status');
    if (cachedRaw) {
      const cachedData = JSON.parse(cachedRaw);
      if (cachedData && cachedData.config) {
        currentStatus = cachedData;
        renderDashboard(cachedData);
      }
    }
  } catch (err) {
    console.warn('Gagal membaca cache status instan:', err);
  }

  fetchStatus();
  if (!pollTimer) {
    pollTimer = setInterval(fetchStatus, 3000);
  }
}

// Toast helper
function showToast(message, isError = false) {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.style.borderColor = isError ? '#ef4444' : '#10b981';
  toast.classList.add('show');
  setTimeout(() => {
    toast.classList.remove('show');
  }, 3500);
}

function formatRelativeTime(timestampMs) {
  if (!timestampMs) return 'Belum pernah';
  const diffSec = Math.floor((Date.now() - timestampMs) / 1000);
  if (diffSec < 10) return 'Baru saja';
  if (diffSec < 60) return `${diffSec}s lalu`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m lalu`;
  return new Date(timestampMs).toLocaleTimeString('id-ID');
}

// Fetch dashboard state
async function fetchStatus() {
  try {
    const res = await authFetch('/api/status');
    if (!res.ok) throw new Error('Gagal memuat status');
    currentStatus = await res.json();

    // Persist latest status to browser localStorage for instant 0ms reload
    try {
      localStorage.setItem('vcstudios_last_status', JSON.stringify(currentStatus));
    } catch {}

    renderDashboard(currentStatus);

    // Auto-trigger initial scan in background if cache is empty & no scan is running
    const hasCache = currentStatus.runtime?.accountCache && Object.keys(currentStatus.runtime.accountCache).length > 0;
    const isScanning = currentStatus.runtime?.isScanning;
    if (!hasCache && !isScanning) {
      authFetch('/api/check-now', { method: 'POST' }).catch(() => {});
    }
  } catch (err) {
    console.error('Error fetching status:', err);
  }
}

// Update DOM with state
function renderDashboard(data) {
  const { config, runtime, state } = data;
  const groups = config.groups || [];

  // Default active group: prioritize group that actually has accounts
  const savedGroupId = localStorage.getItem('activeGroupId');
  const validSavedGroup = groups.find((g) => g.id === savedGroupId);

  if (validSavedGroup && (validSavedGroup.accounts?.length || 0) > 0) {
    activeGroupId = savedGroupId;
  } else {
    // Pick the first group that has accounts
    const groupWithAccounts = groups.find((g) => (g.accounts?.length || 0) > 0);
    activeGroupId = groupWithAccounts ? groupWithAccounts.id : (groups[0]?.id || null);
    if (activeGroupId) {
      localStorage.setItem('activeGroupId', activeGroupId);
    }
  }

  // Update top metrics
  const totalAccounts = groups.reduce((acc, g) => acc + (g.accounts?.length || 0), 0);
  document.getElementById('metric-groups-count').textContent = groups.length;
  document.getElementById('metric-accounts-count').textContent = totalAccounts;
  document.getElementById('metric-interval').textContent = `${config.checkIntervalSeconds}s`;
  document.getElementById('metric-delay').textContent = `${((config.delayBetweenAccountsMs || 2000) / 1000).toFixed(1)}s`;

  // Database indicator
  const dbChip = document.getElementById('db-status');
  const dbText = document.getElementById('db-status-text');
  if (data.isSupabase) {
    dbChip.classList.add('active');
    dbText.textContent = '⚡ Supabase';
    dbChip.title = 'Terhubung ke Supabase Cloud Database';
  } else {
    dbChip.classList.remove('active');
    dbText.textContent = '📁 File Lokal';
    dbChip.title = 'Data disimpan di file lokal. Klik Pengaturan untuk menghubungkan Supabase.';
  }

  // Update Countdown / Scanning status
  const countdownEl = document.getElementById('countdown-val');
  const btnManual = document.getElementById('btn-manual-check');

  if (runtime.isScanning) {
    const prog = runtime.scanProgress;
    const currentAcc = prog?.currentAccount ? `@${prog.currentAccount}` : '';
    countdownEl.innerHTML = `<span style="color:var(--brand-primary); font-size:12px; font-weight:700;">🔄 Scan (${prog?.current || 0}/${prog?.total || 0}) ${currentAcc}</span>`;
    if (btnManual && !btnManual.disabled) {
      btnManual.disabled = true;
      btnManual.innerHTML = `
        <span class="status-pulse" style="background:#fff"></span>
        Memindai...
      `;
    }
  } else {
    if (btnManual && btnManual.disabled) {
      btnManual.disabled = false;
      btnManual.innerHTML = `
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/>
        </svg>
        Scan Semua
      `;
    }

    if (runtime.nextPollTime) {
      const remaining = Math.max(0, Math.floor((runtime.nextPollTime - Date.now()) / 1000));
      countdownSeconds = remaining;
      updateCountdownDisplay();
    }
  }

  // Render Group Tabs for both views
  renderGroupTabs(groups);
  renderReportGroupTabs(groups);

  // Render Active Group Banner
  const activeGroup = groups.find((g) => g.id === activeGroupId) || groups[0];
  renderGroupBanner(activeGroup);

  // Render Daily Report Card for active group
  renderDailyReportCard(activeGroup, runtime.accountCache);

  // Render Creators Grid for active group
  renderCreators(activeGroup, runtime.accountCache, state);

  // Render Logs
  renderLogs(runtime.logs);

  // Update Role UI restrictions
  updateRoleUI();
}

function updateCountdownDisplay() {
  if (currentStatus?.runtime?.isScanning) return;
  const mins = Math.floor(countdownSeconds / 60).toString().padStart(2, '0');
  const secs = (countdownSeconds % 60).toString().padStart(2, '0');
  const el = document.getElementById('countdown-val');
  if (el) el.textContent = `${mins}:${secs}`;
}

setInterval(() => {
  if (countdownSeconds > 0 && !currentStatus?.runtime?.isScanning) {
    countdownSeconds--;
    updateCountdownDisplay();
  }
}, 1000);

// View Switching: Report vs Manage
function switchMainView(viewName) {
  const isViewer = currentUserRole === 'Viewer';
  if (isViewer && viewName !== 'report') {
    viewName = 'report';
  }
  currentMainView = viewName;

  const btnReport = document.getElementById('tab-btn-report');
  const btnManage = document.getElementById('tab-btn-manage');
  const viewReport = document.getElementById('view-report-section');
  const viewManage = document.getElementById('view-manage-section');

  if (viewName === 'report') {
    if (btnReport) btnReport.classList.add('active');
    if (btnManage) btnManage.classList.remove('active');
    if (viewReport) viewReport.style.display = 'block';
    if (viewManage) viewManage.style.display = 'none';
  } else {
    if (btnReport) btnReport.classList.remove('active');
    if (btnManage) btnManage.classList.add('active');
    if (viewReport) viewReport.style.display = 'none';
    if (viewManage) viewManage.style.display = 'block';
  }
}
window.switchMainView = switchMainView;

function updateRoleUI() {
  const isViewer = currentUserRole === 'Viewer';
  const roleBadge = document.getElementById('nav-role-badge');
  const usernameEl = document.getElementById('nav-username');
  const tabManage = document.getElementById('tab-btn-manage');
  const btnCreateGroup = document.getElementById('btn-create-group');
  const btnSettings = document.getElementById('btn-open-settings');
  const btnManualCheck = document.getElementById('btn-manual-check');
  const adminActions = document.getElementById('report-admin-actions');
  const bannerActions = document.querySelector('.group-banner-actions');

  if (usernameEl) {
    usernameEl.textContent = currentUsername || (isViewer ? 'Viewer' : 'Admin');
  }

  if (roleBadge) {
    if (isViewer) {
      roleBadge.textContent = '👁️ Viewer';
      roleBadge.className = 'group-badge';
      roleBadge.style.background = 'rgba(245, 158, 11, 0.15)';
      roleBadge.style.borderColor = 'rgba(245, 158, 11, 0.4)';
      roleBadge.style.color = '#f59e0b';
    } else {
      roleBadge.textContent = '👑 Admin';
      roleBadge.className = 'group-badge';
      roleBadge.style.background = 'rgba(37, 244, 238, 0.15)';
      roleBadge.style.borderColor = 'rgba(37, 244, 238, 0.4)';
      roleBadge.style.color = 'var(--tiktok-cyan)';
    }
  }

  if (isViewer) {
    if (tabManage) tabManage.style.display = 'none';
    if (btnCreateGroup) btnCreateGroup.style.display = 'none';
    if (btnSettings) btnSettings.style.display = 'none';
    if (btnManualCheck) btnManualCheck.style.display = 'none';
    if (adminActions) adminActions.style.display = 'none';
    if (bannerActions) bannerActions.style.display = 'none';
    switchMainView('report');
  } else {
    if (tabManage) tabManage.style.display = 'inline-flex';
    if (btnCreateGroup) btnCreateGroup.style.display = 'inline-flex';
    if (btnSettings) btnSettings.style.display = 'inline-flex';
    if (btnManualCheck) btnManualCheck.style.display = 'inline-flex';
    if (adminActions) adminActions.style.display = 'flex';
    if (bannerActions) bannerActions.style.display = 'flex';
  }
}

// Render Group Tabs for Management View
function renderGroupTabs(groups) {
  const container = document.getElementById('group-tabs-container');
  if (!container) return;
  if (!groups || groups.length === 0) {
    container.innerHTML = '<span style="color:var(--text-muted)">Belum ada grup.</span>';
    return;
  }

  container.innerHTML = groups.map((g) => `
    <button type="button" class="group-tab ${g.id === activeGroupId ? 'active' : ''}" data-group-id="${g.id}" onclick="selectGroup('${g.id}')">
      <span>${escapeHtml(g.name)}</span>
      <span class="group-tab-badge">${g.accounts?.length || 0}</span>
    </button>
  `).join('');
}

// Render Group Tabs for Daily Report View
function renderReportGroupTabs(groups) {
  const container = document.getElementById('report-group-tabs-container');
  if (!container) return;
  if (!groups || groups.length === 0) {
    container.innerHTML = '<span style="color:var(--text-muted)">Belum ada grup terdaftar.</span>';
    return;
  }

  container.innerHTML = groups.map((g) => `
    <button type="button" class="group-tab ${g.id === activeGroupId ? 'active' : ''}" onclick="selectGroup('${g.id}')">
      <span>${escapeHtml(g.name)}</span>
      <span class="group-tab-badge">${g.accounts?.length || 0} Akun</span>
    </button>
  `).join('');
}

function selectGroup(groupId) {
  if (!groupId) return;
  activeGroupId = groupId;
  localStorage.setItem('activeGroupId', groupId);
  if (currentStatus) {
    renderDashboard(currentStatus);
  }
}
window.selectGroup = selectGroup;

// Render Active Group Banner
function renderGroupBanner(group) {
  const banner = document.getElementById('group-banner');
  if (!group) {
    banner.style.display = 'none';
    return;
  }
  banner.style.display = 'flex';

  document.getElementById('banner-group-name').textContent = group.name;
  document.getElementById('banner-group-count').textContent = `${group.accounts?.length || 0} Akun`;

  // Render Webhooks List in Banner
  const webhooksContainer = document.getElementById('banner-webhooks-list');
  if (webhooksContainer) {
    let webhooks = Array.isArray(group.webhooks) && group.webhooks.length > 0 ? group.webhooks : [];
    if (webhooks.length === 0 && group.webhookUrl) {
      webhooks = [{ url: group.webhookUrl, name: 'Default', events: ['new_video', 'task_warning', 'double_upload', 'daily_report', 'account_not_found'] }];
    }

    if (webhooks.length === 0) {
      webhooksContainer.innerHTML = `
        <div style="font-size: 0.8rem; color: var(--text-muted); font-style: italic;">
          (Belum ada webhook diatur untuk grup ini)
        </div>
      `;
    } else {
      const allEventsList = ['new_video', 'task_warning', 'double_upload', 'daily_report', 'account_not_found'];
      webhooksContainer.innerHTML = webhooks.map((wh, idx) => {
        const masked = wh.url ? wh.url.replace(/(webhooks\/\d+\/)[a-zA-Z0-9_-]{8,}/, '$1••••••••') : '(Belum diatur)';
        const evts = Array.isArray(wh.events) && wh.events.length > 0 ? wh.events : allEventsList;
        const isAll = allEventsList.every((e) => evts.includes(e));

        let badgesHtml = '';
        if (isAll) {
          badgesHtml = '<span class="webhook-event-badge badge-all" title="Menerima semua jenis notifikasi">⚡ Semua Notif</span>';
        } else {
          if (evts.includes('task_warning')) badgesHtml += '<span class="webhook-event-badge badge-task" title="Peringatan jika target 14 akun belum selesai">⚠️ Task</span>';
          if (evts.includes('new_video')) badgesHtml += '<span class="webhook-event-badge badge-video" title="Notifikasi postingan video baru">🎬 Video</span>';
          if (evts.includes('double_upload')) badgesHtml += '<span class="webhook-event-badge badge-double" title="Peringatan upload > 1 video sehari">🔁 Double</span>';
          if (evts.includes('daily_report')) badgesHtml += '<span class="webhook-event-badge badge-report" title="Laporan harian lengkap">📊 Report</span>';
          if (evts.includes('account_not_found')) badgesHtml += '<span class="webhook-event-badge badge-account" title="Peringatan akun tiktok tidak ditemukan">🔍 Akun</span>';
        }

        const mType = wh.mention || 'everyone';
        if (mType === 'everyone') {
          badgesHtml += '<span class="webhook-event-badge badge-mention" title="Mention Discord: @everyone">🔔 @everyone</span>';
        } else if (mType === 'here') {
          badgesHtml += '<span class="webhook-event-badge badge-mention" title="Mention Discord: @here">🔔 @here</span>';
        } else if (mType === 'user') {
          const userDisplay = wh.mentionRole ? (wh.mentionRole.startsWith('@') ? wh.mentionRole : `@${wh.mentionRole}`) : '@User';
          badgesHtml += `<span class="webhook-event-badge badge-mention-user" title="Mention User Discord: ${escapeHtml(wh.mentionRole || '')}">👤 ${escapeHtml(userDisplay)}</span>`;
        } else if (mType === 'role') {
          const roleDisplay = wh.mentionRole ? `@Role (${wh.mentionRole})` : '@Role';
          badgesHtml += `<span class="webhook-event-badge badge-mention" title="Mention Discord Role">🏷️ ${escapeHtml(roleDisplay)}</span>`;
        } else if (mType === 'custom') {
          const customDisplay = wh.mentionRole ? wh.mentionRole : 'Custom';
          badgesHtml += `<span class="webhook-event-badge badge-mention" title="Custom Mention">✍️ ${escapeHtml(customDisplay)}</span>`;
        } else if (mType === 'none') {
          badgesHtml += '<span class="webhook-event-badge badge-mention-none" title="Tanpa Mention (Hening)">🔕 Tanpa Tag</span>';
        }

        const displayName = wh.name ? wh.name : (webhooks.length > 1 ? `Webhook #${idx + 1}` : 'Discord Webhook');

        return `
          <div class="banner-webhook-item">
            <div class="banner-webhook-left">
              <span class="banner-webhook-name">📌 ${escapeHtml(displayName)}:</span>
              <span class="banner-webhook-url">${escapeHtml(masked)}</span>
              <div class="banner-webhook-badges">${badgesHtml}</div>
            </div>
            <div style="display: flex; gap: 6px; align-items: center;">
              <button type="button" class="btn btn-xs btn-outline" style="padding: 2px 8px; font-size: 0.72rem; gap: 4px;" onclick="testSingleWebhook('${group.id}', '${encodeURIComponent(wh.url)}', null, '${wh.mention || 'everyone'}', '${encodeURIComponent(wh.mentionRole || '')}')">
                <span>🧪 Tes</span>
              </button>
            </div>
          </div>
        `;
      }).join('');
    }
  }

  // Calculate Group Video Upload Summary (1 Hari, 1 Minggu, 1 Bulan)
  const stats = calculateGroupVideoStats(group, currentStatus?.runtime?.accountCache || {}, currentStatus?.state || {});
  const todayEl = document.getElementById('summary-today');
  const weekEl = document.getElementById('summary-week');
  const monthEl = document.getElementById('summary-month');
  const warnPill = document.getElementById('summary-warning-pill');
  const warnCountEl = document.getElementById('summary-invalid');

  if (todayEl) todayEl.textContent = `${stats.today} Video`;
  if (weekEl) weekEl.textContent = `${stats.week} Video`;
  if (monthEl) monthEl.textContent = `${stats.month} Video`;

  if (warnPill && warnCountEl) {
    if (stats.invalidAccounts > 0) {
      warnPill.style.display = 'flex';
      warnCountEl.textContent = `${stats.invalidAccounts} Akun`;
    } else {
      warnPill.style.display = 'none';
    }
  }

  // Render Task Deadline & Reminder Indicator
  const deadlineEl = document.getElementById('banner-deadline-time');
  const deadlinePill = document.getElementById('banner-deadline-status-pill');
  if (deadlineEl && deadlinePill) {
    const deadlineStr = group.taskDeadline || '22:00';
    deadlineEl.textContent = `${deadlineStr} WIB`;

    if (group.taskReminderEnabled === false) {
      deadlinePill.textContent = '⚪ Reminder Nonaktif';
      deadlinePill.style.background = 'rgba(255, 255, 255, 0.05)';
      deadlinePill.style.color = 'var(--text-muted)';
      deadlinePill.style.borderColor = 'rgba(255, 255, 255, 0.1)';
    } else {
      const warningIntervalMins = group.taskWarningIntervalMinutes !== undefined ? Number(group.taskWarningIntervalMinutes) : 30;
      const isIntervalOn = group.taskWarningIntervalEnabled !== false;
      const startTimeStr = group.taskReminderStartTime || '10:00';
      const [sH, sM] = startTimeStr.split(':');
      const sTotalMin = (parseInt(sH, 10) || 10) * 60 + (parseInt(sM, 10) || 0);

      const now = new Date();
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: 'Asia/Jakarta',
        hour: 'numeric',
        minute: 'numeric',
        hour12: false
      }).formatToParts(now);
      const curHour = Number(parts.find((p) => p.type === 'hour')?.value || 0);
      const curMin = Number(parts.find((p) => p.type === 'minute')?.value || 0);
      const curTotalMin = curHour * 60 + curMin;

      const [dH, dM] = deadlineStr.split(':');
      const dTotalMin = (parseInt(dH, 10) || 22) * 60 + (parseInt(dM, 10) || 0);
      const reminderStartMin = Math.max(sTotalMin, dTotalMin - 10);

      const targetCount = group.accounts?.length > 0 ? Math.min(14, group.accounts.length) : 14;
      const isCompleted = stats.today >= targetCount;

      if (isCompleted) {
        deadlinePill.textContent = '✅ Target Tuntas (Reminder Berhenti)';
        deadlinePill.style.background = 'rgba(16, 185, 129, 0.15)';
        deadlinePill.style.color = '#34d399';
        deadlinePill.style.borderColor = 'rgba(16, 185, 129, 0.3)';
      } else if (curTotalMin < sTotalMin) {
        deadlinePill.textContent = `⏳ Reminder Mulai Jam ${startTimeStr} WIB`;
        deadlinePill.style.background = 'rgba(255, 255, 255, 0.05)';
        deadlinePill.style.color = 'var(--text-muted)';
        deadlinePill.style.borderColor = 'rgba(255, 255, 255, 0.1)';
      } else if (curTotalMin >= reminderStartMin && curTotalMin < dTotalMin) {
        deadlinePill.textContent = `🚨 Peringatan Terakhir (${dTotalMin - curTotalMin}m menuju deadline)`;
        deadlinePill.style.background = 'rgba(239, 68, 68, 0.18)';
        deadlinePill.style.color = '#f87171';
        deadlinePill.style.borderColor = 'rgba(239, 68, 68, 0.4)';
      } else if (curTotalMin >= dTotalMin) {
        deadlinePill.textContent = '🚨 Batas Waktu Terlewati (Reminder Berakhir)';
        deadlinePill.style.background = 'rgba(239, 68, 68, 0.18)';
        deadlinePill.style.color = '#f87171';
        deadlinePill.style.borderColor = 'rgba(239, 68, 68, 0.4)';
      } else {
        if (isIntervalOn) {
          deadlinePill.textContent = `⏰ Reminder Aktif (${startTimeStr} - ${deadlineStr} WIB, Tiap ${warningIntervalMins}m)`;
        } else {
          deadlinePill.textContent = `⏰ Reminder Aktif (${startTimeStr} & 12:00 WIB, Berkala Nonaktif)`;
        }
        deadlinePill.style.background = 'rgba(37, 244, 238, 0.12)';
        deadlinePill.style.color = 'var(--tiktok-cyan)';
        deadlinePill.style.borderColor = 'rgba(37, 244, 238, 0.3)';
      }
    }
  }
}

// Daily Report State & Renderer
let currentDailyReport = null;
let currentDailyReportOffset = 0; // 0 = Hari Ini, -1 = Hari Sebelumnya (Kemarin)

function switchDashboardDate(offset) {
  currentDailyReportOffset = Number(offset);
  const btnToday = document.getElementById('btn-dash-date-today');
  const btnYesterday = document.getElementById('btn-dash-date-yesterday');
  if (btnToday) btnToday.classList.toggle('active', currentDailyReportOffset === 0);
  if (btnYesterday) btnYesterday.classList.toggle('active', currentDailyReportOffset === -1);

  const activeGroup = currentConfig?.groups?.find((g) => g.id === activeGroupId) || currentConfig?.groups?.[0];
  if (activeGroup) {
    renderDailyReportCard(activeGroup, runtimeState.accountCache);
  }
}
window.switchDashboardDate = switchDashboardDate;

function renderDailyReportCard(group, cache = {}) {
  const card = document.getElementById('daily-report-card');
  if (!card) return;

  if (!group || !group.accounts || group.accounts.length === 0) {
    card.style.display = 'none';
    const tbody = document.getElementById('report-table-body');
    if (tbody) {
      tbody.innerHTML = '<tr><td colspan="6" style="text-align:center; padding:30px; color:var(--text-muted);">Tidak ada akun pada grup ini.</td></tr>';
    }
    currentDailyReport = null;
    return;
  }
  card.style.display = 'block';

  // Calculate WIB date start & end based on currentDailyReportOffset
  const numOffset = currentDailyReportOffset || 0;
  const now = new Date();
  const targetDate = new Date(now.getTime() + (numOffset * 86400 * 1000));
  const dateStr = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta' }).format(targetDate);
  const startOfDayWIB = Math.floor(new Date(`${dateStr}T00:00:00+07:00`).getTime() / 1000);
  const endOfDayWIB = startOfDayWIB + 86400;
  const formattedDate = new Intl.DateTimeFormat('id-ID', { dateStyle: 'full', timeZone: 'Asia/Jakarta' }).format(targetDate);
  const isToday = numOffset === 0;
  const dayLabel = isToday ? 'Hari Ini' : (numOffset === -1 ? 'Kemarin' : `${Math.abs(numOffset)} hari lalu`);

  const target = 14; // Kuota target: 1 video di 14 akun = SELESAI
  const accounts = group.accounts || [];
  const uploaded = [];
  const missing = [];
  const doubles = [];

  for (const rawAcc of accounts) {
    const acc = rawAcc.toLowerCase();
    const cached = cache[acc];
    const videos = cached?.recentVideos || (cached?.latestVideo ? [cached.latestVideo] : []);

    const targetVideos = videos.filter(
      (v) => v && v.createTime && v.createTime >= startOfDayWIB && v.createTime < endOfDayWIB
    );

    if (targetVideos.length > 0) {
      const topVideo = targetVideos[0];
      const videoUrl = topVideo.url || `https://www.tiktok.com/@${acc}/video/${topVideo.id}`;
      const item = {
        account: acc,
        videoUrl,
        videoId: topVideo.id,
        uploadCountToday: targetVideos.length,
        todayVideos: targetVideos,
        topVideo,
        createTime: topVideo.createTime
      };
      uploaded.push(item);

      if (targetVideos.length > 1) {
        doubles.push(item);
      }
    } else {
      missing.push(acc);
    }
  }

  const uploadedCount = uploaded.length;
  // ATURAN KUOTA: Jika group sudah upload 1 video di 14 akun = SELESAI
  const isCompleted = uploadedCount >= target;
  const remainingNeeded = Math.max(0, target - uploadedCount);
  const percentage = Math.min(100, Math.round((uploadedCount / target) * 100));

  currentDailyReport = {
    groupId: group.id,
    groupName: group.name,
    dateStr,
    formattedDate,
    offsetDays: numOffset,
    isToday,
    dayLabel,
    target,
    uploadedCount,
    remainingNeeded,
    percentage,
    isCompleted,
    uploaded,
    missing,
    doubles
  };

  // Update DOM elements
  const dashDateActiveLabel = document.getElementById('dash-date-active-label');
  const dateBadge = document.getElementById('report-date-badge');
  const statusBadge = document.getElementById('report-status-badge');
  const progressText = document.getElementById('report-progress-text');
  const progressBar = document.getElementById('report-progress-bar');
  const doubleBox = document.getElementById('report-double-upload-box');
  const doubleList = document.getElementById('report-double-upload-list');
  const incompleteBox = document.getElementById('report-incomplete-box');
  const incompleteDesc = document.getElementById('report-incomplete-desc');
  const subDesc = document.getElementById('daily-report-sub-desc');

  if (dashDateActiveLabel) dashDateActiveLabel.textContent = `${formattedDate} (${dayLabel})`;
  if (dateBadge) dateBadge.textContent = `${dateStr} (${dayLabel})`;
  if (subDesc) {
    subDesc.textContent = `Sistem secara otomatis menghitung akun unik yang mengunggah minimal 1 video ${isToday ? 'hari ini' : 'kemarin'}.`;
  }

  if (statusBadge) {
    if (isCompleted) {
      statusBadge.className = 'report-status-badge status-completed';
      statusBadge.textContent = `✅ SELESAI (${uploadedCount}/${target} Akun)`;
    } else {
      statusBadge.className = 'report-status-badge status-incomplete';
      statusBadge.textContent = `⚠️ BELUM TUNTAS (${remainingNeeded} Akun Lagi)`;
    }
  }

  if (progressText) {
    progressText.textContent = `${uploadedCount} / ${target} Akun (${percentage}%)`;
  }
  if (progressBar) {
    progressBar.style.width = `${percentage}%`;
  }

  // Double upload box
  if (doubleBox && doubleList) {
    if (doubles.length > 0) {
      doubleBox.style.display = 'flex';
      doubleList.innerHTML = doubles
        .map((d) => `<span class="double-tag-item">@${escapeHtml(d.account)} (${d.uploadCountToday} video ${isToday ? 'hari ini' : 'kemarin'})</span>`)
        .join('');
    } else {
      doubleBox.style.display = 'none';
    }
  }

  // Incomplete warning box: HANYA jika target 14 belum selesai
  if (incompleteBox && incompleteDesc) {
    if (!isCompleted && remainingNeeded > 0) {
      incompleteBox.style.display = 'flex';
      const sampleMissing = missing.slice(0, 6).map((m) => `@${m}`).join(', ');
      const moreMissing = missing.length > 6 ? ` dan ${missing.length - 6} lainnya` : '';
      incompleteDesc.textContent = `${missing.length} akun tidak upload ${isToday ? 'hari ini' : 'kemarin'}: ${sampleMissing}${moreMissing}. Masih butuh ${remainingNeeded} akun lagi untuk memenuhi kuota 14 akun.`;
    } else {
      incompleteBox.style.display = 'none';
    }
  }

  // Update public share link URL for currently selected group
  if (typeof updatePublicLinkUrls === 'function') {
    updatePublicLinkUrls();
  }

  // Render the protected report table
  renderDailyReportTable(group, cache, uploaded, missing, doubles, isCompleted, target, isToday);
}

function renderDailyReportTable(group, cache, uploaded, missing, doubles, isCompleted, target, isToday = true) {
  const tbody = document.getElementById('report-table-body');
  const countBadge = document.getElementById('report-table-count-badge');
  if (!tbody) return;

  const totalAccounts = group.accounts?.length || 0;
  if (countBadge) {
    countBadge.textContent = `${uploaded.length}/${totalAccounts} Akun Upload (${isCompleted ? 'Target Selesai' : 'Belum Tuntas'})`;
  }

  const uploadedMap = new Map();
  uploaded.forEach((u) => uploadedMap.set(u.account, u));

  // Sort: uploaded first (doubles at top), then missing
  const sortedAccounts = [...(group.accounts || [])].sort((a, b) => {
    const aUp = uploadedMap.get(a.toLowerCase());
    const bUp = uploadedMap.get(b.toLowerCase());
    if (aUp && !bUp) return -1;
    if (!aUp && bUp) return 1;
    if (aUp && bUp) {
      return (bUp.uploadCountToday || 0) - (aUp.uploadCountToday || 0);
    }
    return a.localeCompare(b);
  });

  if (sortedAccounts.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" style="text-align:center; padding:30px; color:var(--text-muted);">Tidak ada akun pada grup ini.</td></tr>';
    return;
  }

  tbody.innerHTML = sortedAccounts.map((rawAcc, idx) => {
    const acc = rawAcc.toLowerCase();
    const upData = uploadedMap.get(acc);
    const cached = cache[acc];
    const nickname = cached?.nickname || `@${acc}`;
    const avatar = cached?.avatar || '';

    let statusPill = '';
    let timeStr = '<span style="color:var(--text-muted)">-</span>';
    let captionHtml = `<span style="color:var(--text-muted); font-style:italic;">Belum ada video ${isToday ? 'hari ini' : 'kemarin'}</span>`;
    let actionsHtml = '<span style="color:var(--text-muted); font-size:0.75rem;">-</span>';

    if (upData) {
      if (upData.uploadCountToday > 1) {
        statusPill = `<span class="table-status-pill status-double">⚠️ Double (${upData.uploadCountToday} Video)</span>`;
      } else {
        statusPill = `<span class="table-status-pill status-done">✅ Selesai (1 Video)</span>`;
      }

      if (upData.createTime) {
        const d = new Date(upData.createTime * 1000);
        timeStr = new Intl.DateTimeFormat('id-ID', {
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
          timeZone: 'Asia/Jakarta'
        }).format(d) + ' WIB';
      }

      const descText = upData.topVideo?.desc || '(Tanpa caption)';
      const shortDesc = descText.length > 55 ? descText.substring(0, 52) + '...' : descText;
      captionHtml = `<span title="${escapeHtml(descText)}" style="color: #cbd5e1; font-size: 0.82rem;">${escapeHtml(shortDesc)}</span>`;

      actionsHtml = `
        <div style="display: flex; align-items: center; gap: 6px;">
          <a href="${escapeHtml(upData.videoUrl)}" target="_blank" rel="noopener noreferrer" class="btn btn-xs btn-outline" style="text-decoration:none;" title="Buka video di TikTok">
            🔗 Buka
          </a>
          <button type="button" class="btn btn-xs btn-cyan" onclick="copyOnlyTikTokLink('${escapeHtml(upData.videoUrl)}', '${escapeHtml(acc)}')" title="Salin hanya tautan video TikTok ke clipboard">
            📋 Salin Link
          </button>
        </div>
      `;
    } else {
      statusPill = `<span class="table-status-pill status-pending">⏳ ${isToday ? 'Belum Upload' : 'Tidak Ada Upload'}</span>`;
    }

    const avatarHtml = avatar
      ? `<img src="${escapeHtml(avatar)}" alt="${escapeHtml(acc)}" class="clippers-avatar" onerror="this.style.display='none'">`
      : `<div class="clippers-avatar-placeholder">${acc.charAt(0).toUpperCase()}</div>`;

    return `
      <tr>
        <td style="text-align: center; color: var(--text-muted); font-size: 0.8rem;">${idx + 1}</td>
        <td>
          <div class="clippers-cell">
            ${avatarHtml}
            <div>
              <div class="clippers-handle">@${escapeHtml(acc)}</div>
              <div class="clippers-name">${escapeHtml(nickname)}</div>
            </div>
          </div>
        </td>
        <td>${statusPill}</td>
        <td style="font-size: 0.8rem; font-family: monospace;">${timeStr}</td>
        <td>${captionHtml}</td>
        <td>${actionsHtml}</td>
      </tr>
    `;
  }).join('');
}

// Dedicated copy function: ONLY copies the specific TikTok video URL
async function copyOnlyTikTokLink(url, account) {
  if (!url) return;
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(url);
    } else {
      const temp = document.createElement('input');
      temp.value = url;
      document.body.appendChild(temp);
      temp.select();
      document.execCommand('copy');
      document.body.removeChild(temp);
    }
    showToast(`📋 Link video @${account} berhasil disalin!`);
  } catch (err) {
    showToast(`Gagal menyalin link: ${err.message}`, true);
  }
}
window.copyOnlyTikTokLink = copyOnlyTikTokLink;

// Setup copy protection for Daily Report page (Anti-tamper: user cannot copy whole report text)
function setupReportCopyProtection() {
  const protectedElements = document.querySelectorAll('.report-protected-page');
  protectedElements.forEach((el) => {
    el.addEventListener('copy', (e) => {
      e.preventDefault();
      showToast('🔒 Teks laporan diproteksi anti-edit. Hanya link video yang dapat disalin melalui tombol "Salin Link".', true);
    });
    el.addEventListener('cut', (e) => {
      e.preventDefault();
    });
  });
}

function calculateGroupVideoStats(group, cache, state) {
  if (!group || !group.accounts || group.accounts.length === 0) {
    return { today: 0, week: 0, month: 0, invalidAccounts: 0 };
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const oneDayAgo = nowSec - 24 * 3600;
  const oneWeekAgo = nowSec - 7 * 24 * 3600;
  const oneMonthAgo = nowSec - 30 * 24 * 3600;

  let todayCount = 0;
  let weekCount = 0;
  let monthCount = 0;
  let invalidCount = 0;
  const countedVideos = new Set();

  for (const account of group.accounts) {
    const cleanUser = account.toLowerCase();
    const cached = cache[cleanUser];

    if (cached?.isNotFound) {
      invalidCount++;
    }

    // Collect all known videos for this account
    const vList = [];
    if (cached?.recentVideos && Array.isArray(cached.recentVideos)) {
      vList.push(...cached.recentVideos);
    }
    if (cached?.latestVideo) {
      vList.push(cached.latestVideo);
    }
    // Also check state.json / Supabase state timestamp
    if (state?.[cleanUser]?.lastPostTime) {
      vList.push({
        id: state[cleanUser].lastVideoId || cleanUser,
        createTime: state[cleanUser].lastPostTime
      });
    }

    for (const v of vList) {
      if (!v || !v.id || countedVideos.has(v.id)) continue;
      countedVideos.add(v.id);

      const t = v.createTime || 0;
      if (t >= oneDayAgo) todayCount++;
      if (t >= oneWeekAgo) weekCount++;
      if (t >= oneMonthAgo) monthCount++;
    }
  }

  return { today: todayCount, week: weekCount, month: monthCount, invalidAccounts: invalidCount };
}

// Render Creators Grid
function renderCreators(group, cache, state) {
  const container = document.getElementById('creators-container');
  if (!group || !group.accounts || group.accounts.length === 0) {
    container.innerHTML = `
      <div style="grid-column: 1/-1; text-align: center; padding: 40px 20px; color: var(--text-muted);">
        Belum ada akun di grup <strong>"${group?.name || 'ini'}"</strong>.<br>
        Tambahkan username TikTok di kolom atas untuk mulai memantau!
      </div>
    `;
    const countBadge = document.getElementById('search-result-count');
    if (countBadge) countBadge.textContent = '';
    return;
  }

  const searchInput = document.getElementById('search-creators');
  const query = searchInput ? searchInput.value.trim().toLowerCase() : '';

  const filteredAccounts = group.accounts.filter((username) => {
    if (!query) return true;
    const cleanUser = username.toLowerCase();
    const cached = cache[cleanUser] || {};
    const nick = (cached.user?.nickname || '').toLowerCase();
    return cleanUser.includes(query) || nick.includes(query);
  });

  const countBadge = document.getElementById('search-result-count');
  if (countBadge) {
    countBadge.textContent = query
      ? `${filteredAccounts.length} dari ${group.accounts.length} akun`
      : `${group.accounts.length} Akun`;
  }

  if (filteredAccounts.length === 0) {
    container.innerHTML = `
      <div style="grid-column: 1/-1; text-align: center; padding: 40px 20px; color: var(--text-muted);">
        Tidak ditemukan akun dengan kata kunci "<strong>${query}</strong>".
      </div>
    `;
    return;
  }

  container.innerHTML = filteredAccounts.map((username) => {
    const cached = cache[username.toLowerCase()] || {};
    const isNotFound = cached.isNotFound === true;

    if (isNotFound) {
      return `
        <div class="creator-card card-warning-state" id="card-${username}">
          <div class="creator-header" style="border-bottom: 1px solid rgba(239, 68, 68, 0.25); padding-bottom: 10px;">
            <div class="creator-avatar warning-avatar">⚠️</div>
            <div class="creator-info">
              <h3 class="creator-name" style="color: #ef4444;">Akun Tidak Ditemukan</h3>
              <span class="creator-handle" style="color: #f87171;">@${username}</span>
            </div>
            <div style="display: flex; align-items: center; gap: 4px;">
              <button class="btn-edit-account" onclick="openEditAccountModal('${group.id}', '${username}')" title="Koreksi username ini">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
                  <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
                </svg>
              </button>
              <button class="btn-remove-account" onclick="removeAccount('${group.id}', '${username}')" title="Hapus akun salah ini">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <line x1="18" y1="6" x2="6" y2="18"></line>
                  <line x1="6" y1="6" x2="18" y2="18"></line>
                </svg>
              </button>
            </div>
          </div>

          <div class="warning-card-body">
            <div class="warning-badge-pill">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
                <line x1="12" y1="9" x2="12" y2="13"/>
                <line x1="12" y1="17" x2="12.01" y2="17"/>
              </svg>
              SALAH USERNAME / TIDAK ADA
            </div>
            <p class="warning-card-text">
              Username <strong>@${username}</strong> tidak ditemukan di TikTok. Kemungkinan ada salah ketik (typo), akun berganti nama, atau sudah dihapus.
            </p>
          </div>

          <div class="creator-actions" style="display: flex; gap: 8px;">
            <button class="btn btn-primary" onclick="openEditAccountModal('${group.id}', '${username}')" style="flex: 1; justify-content: center; font-size: 0.82rem; padding: 9px 12px;">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
                <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
              </svg>
              Koreksi Username
            </button>
            <button class="btn btn-danger-action" onclick="removeAccount('${group.id}', '${username}')" title="Hapus Akun Salah Ini" style="padding: 9px 12px;">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="3 6 5 6 21 6"></polyline>
                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
              </svg>
            </button>
          </div>
        </div>
      `;
    }

    const user = cached.user || {
      nickname: username,
      uniqueId: username,
      avatar: 'https://sf16-website-login.neutral.ttwstatic.com/obj/tiktok_web_login_static/favicon.ico'
    };
    const video = cached.latestVideo || null;

    return `
      <div class="creator-card" id="card-${username}">
        <div class="creator-header">
          <img src="${user.avatar || 'https://sf16-website-login.neutral.ttwstatic.com/obj/tiktok_web_login_static/favicon.ico'}" 
               alt="${user.nickname}" 
               class="creator-avatar" 
               loading="lazy"
               decoding="async"
               onerror="this.src='https://sf16-website-login.neutral.ttwstatic.com/obj/tiktok_web_login_static/favicon.ico'">
          <div class="creator-info">
            <h3 class="creator-name">${user.nickname}</h3>
            <a href="https://www.tiktok.com/@${user.uniqueId}" target="_blank" rel="noreferrer" class="creator-handle">
              @${user.uniqueId} ↗
            </a>
          </div>
          <div style="display: flex; align-items: center; gap: 4px;">
            <button class="btn-edit-account" onclick="openEditAccountModal('${group.id}', '${username}')" title="Edit username TikTok">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
                <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
              </svg>
            </button>
            <button class="btn-remove-account" onclick="removeAccount('${group.id}', '${username}')" title="Hapus dari grup ini">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <line x1="18" y1="6" x2="6" y2="18"></line>
                <line x1="6" y1="6" x2="18" y2="18"></line>
              </svg>
            </button>
          </div>
        </div>

        <div class="video-preview-box">
          ${video ? `
            <img src="${video.cover}" class="video-thumb" alt="Thumbnail" loading="lazy" decoding="async" onerror="this.style.display='none'">
            <div class="video-overlay">
              <p class="video-caption">${video.desc || '*(Video tanpa caption)*'}</p>
              <div class="video-meta">
                <span>🕒 ${new Date(video.createTime * 1000).toLocaleDateString('id-ID', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>
                <span>ID: ${video.id.slice(-6)}</span>
              </div>
            </div>
          ` : `
            <div style="height:100%; display:flex; align-items:center; justify-content:center; color: var(--text-muted); font-size: 0.85rem;">
              Sedang memuat data video...
            </div>
          `}
        </div>

        <div class="creator-actions">
          <button class="btn btn-secondary" onclick="testAccountWebhook('${group.id}', '${username}')" id="btn-test-${username}">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z"/>
            </svg>
            Tes Webhook
          </button>
          ${video ? `
            <a href="${video.url}" target="_blank" rel="noreferrer" class="btn btn-glass">
              Buka Video ↗
            </a>
          ` : ''}
        </div>
      </div>
    `;
  }).join('');
}

function renderLogs(logs) {
  const container = document.getElementById('terminal-logs-container');
  if (!logs || logs.length === 0) return;

  container.innerHTML = logs.map((log) => `
    <div class="log-entry ${log.type || 'info'}">
      <span class="log-time">[${log.timestamp}]</span>
      <span class="log-msg">${log.message}</span>
    </div>
  `).join('');
}

// Actions
async function manualCheck() {
  const btn = document.getElementById('btn-manual-check');
  const original = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = `<span class="status-pulse" style="background:#fff"></span> Scanning...`;

  try {
    const res = await authFetch('/api/check-now', { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      showToast('Pemeriksaan akun TikTok dimulai!');
      setTimeout(fetchStatus, 1500);
    } else {
      showToast(data.message || 'Gagal memulai scan', true);
    }
  } catch (err) {
    showToast(err.message, true);
  } finally {
    setTimeout(() => {
      btn.disabled = false;
      btn.innerHTML = original;
    }, 2000);
  }
}

async function testAccountWebhook(groupId, username) {
  const btn = document.getElementById(`btn-test-${username}`);
  if (btn) btn.disabled = true;

  try {
    showToast(`Mengirim notifikasi tes untuk @${username}...`);
    const res = await authFetch('/api/test-webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ groupId, username })
    });
    const data = await res.json();
    if (data.success) {
      showToast(`✅ Berhasil terkirim ke Discord!`);
    } else {
      showToast(`❌ Gagal: ${data.error || data.message}`, true);
    }
  } catch (err) {
    showToast(err.message, true);
  } finally {
    if (btn) btn.disabled = false;
    fetchStatus();
  }
}

async function removeAccount(groupId, username) {
  if (!confirm(`Hapus @${username} dari grup ini?`)) return;

  try {
    const res = await authFetch(`/api/groups/${groupId}/accounts/${username}`, { method: 'DELETE' });
    const data = await res.json();
    if (data.success) {
      showToast(`@${username} berhasil dihapus.`);
      fetchStatus();
    } else {
      showToast(data.error || 'Gagal menghapus', true);
    }
  } catch (err) {
    showToast(err.message, true);
  }
}

// Edit Account Modal Logic
window.openEditAccountModal = function(groupId, username) {
  document.getElementById('edit-account-group-id').value = groupId;
  document.getElementById('edit-account-old-username').value = username;
  document.getElementById('edit-account-current-display').value = `@${username}`;
  const inputNew = document.getElementById('edit-account-new-input');
  inputNew.value = username;
  document.getElementById('modal-edit-account').classList.add('active');
  setTimeout(() => inputNew.focus(), 150);
};

function closeEditAccountModal() {
  document.getElementById('modal-edit-account').classList.remove('active');
}

const btnCloseEditAccount = document.getElementById('btn-close-edit-account');
if (btnCloseEditAccount) btnCloseEditAccount.addEventListener('click', closeEditAccountModal);

const btnCancelEditAccount = document.getElementById('btn-cancel-edit-account');
if (btnCancelEditAccount) btnCancelEditAccount.addEventListener('click', closeEditAccountModal);

document.getElementById('form-edit-account').addEventListener('submit', async (e) => {
  e.preventDefault();
  const groupId = document.getElementById('edit-account-group-id').value;
  const oldUsername = document.getElementById('edit-account-old-username').value;
  const newUsername = document.getElementById('edit-account-new-input').value.trim().replace(/^@/, '');
  const btn = document.getElementById('btn-submit-edit-account');

  if (!newUsername) {
    showToast('Username baru tidak boleh kosong!', true);
    return;
  }

  const originalText = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = `<span class="status-pulse" style="background:#fff"></span> Memverifikasi...`;

  try {
    const res = await authFetch(`/api/groups/${groupId}/accounts/${oldUsername}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ newUsername })
    });
    const data = await res.json();

    if (data.success) {
      showToast(`✅ Username @${oldUsername} berhasil diubah menjadi @${data.newUsername}!`);
      closeEditAccountModal();
      fetchStatus();
    } else {
      if (data.isNotFound) {
        showToast(`⚠️ Username @${newUsername} TIDAK DITEMUKAN di TikTok!`, true);
        alert(`⚠️ PERINGATAN:\n\nUsername TikTok @${newUsername} TIDAK DITEMUKAN di TikTok!\n\nPastikan ejaan username benar (tidak typo) dan akun tersebut aktif.`);
      } else {
        showToast(data.error || 'Gagal mengubah username', true);
      }
    }
  } catch (err) {
    showToast(err.message, true);
  } finally {
    btn.disabled = false;
    btn.innerHTML = originalText;
  }
});

// Add Account Handler
document.getElementById('form-add-account').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!activeGroupId) {
    showToast('Pilih grup terlebih dahulu!', true);
    return;
  }

  const input = document.getElementById('input-new-username');
  const btn = document.getElementById('btn-submit-account');
  const username = input.value.trim();
  if (!username) return;

  const originalText = btn.innerHTML;
  btn.disabled = true;
  btn.textContent = 'Memverifikasi...';

  try {
    const res = await authFetch(`/api/groups/${activeGroupId}/accounts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username })
    });
    const data = await res.json();
    if (data.success) {
      showToast(`Akun @${username} berhasil ditambahkan!`);
      input.value = '';
      fetchStatus();
    } else {
      if (data.isNotFound) {
        showToast(`⚠️ Akun TikTok @${username} TIDAK DITEMUKAN (salah username)!`, true);
        alert(`⚠️ PERINGATAN:\n\nAkun TikTok @${username} TIDAK DITEMUKAN di TikTok!\n\nPastikan ejaan username benar (tidak ada salah ketik / typo) dan akun tersebut aktif.`);
      } else {
        showToast(`Gagal: ${data.error}`, true);
      }
    }
  } catch (err) {
    showToast(err.message, true);
  } finally {
    btn.disabled = false;
    btn.innerHTML = originalText;
  }
});

// Multi-Webhook Helpers & Management
const ALL_EVENT_KEYS = ['new_video', 'task_warning', 'double_upload', 'daily_report', 'account_not_found'];
let modalWebhooks = [];

async function testSingleWebhook(groupId, encodedUrl, passedEvents = null, passedMention = null, passedMentionRole = null) {
  const webhookUrl = decodeURIComponent(encodedUrl || '');
  if (!webhookUrl) {
    showToast('URL Webhook tidak valid', true);
    return;
  }

  let events = passedEvents;
  let mention = passedMention;
  let mentionRole = passedMentionRole ? decodeURIComponent(passedMentionRole) : null;

  if (groupId && currentStatus?.config?.groups) {
    const grp = currentStatus.config.groups.find((g) => g.id === groupId);
    const whObj = grp?.webhooks?.find((w) => w.url === webhookUrl);
    if (whObj) {
      if (!events && whObj.events) events = whObj.events;
      if (!mention && whObj.mention) mention = whObj.mention;
      if (mentionRole === null && whObj.mentionRole) mentionRole = whObj.mentionRole;
    }
  }

  const isTaskOnly = Array.isArray(events) && events.includes('task_warning') && !events.includes('new_video');

  try {
    showToast(isTaskOnly ? 'Mengirim tes peringatan task ke webhook Discord...' : 'Mengirim pesan tes ke webhook Discord...');
    const bodyPayload = {
      groupId,
      webhookUrl,
      events: Array.isArray(events) ? events : undefined,
      isTaskWarningOnly: isTaskOnly
    };
    if (mention) bodyPayload.mention = mention;
    if (mentionRole) bodyPayload.mentionRole = mentionRole;

    const res = await authFetch('/api/test-webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(bodyPayload)
    });
    const data = await res.json();
    if (data.success) {
      showToast(data.message || '✅ Berhasil terkirim ke Discord!');
    } else {
      showToast(`❌ Gagal: ${data.error || data.message}`, true);
    }
  } catch (err) {
    showToast(err.message, true);
  }
}
window.testSingleWebhook = testSingleWebhook;

function renderModalWebhooks() {
  const container = document.getElementById('modal-webhooks-container');
  if (!container) return;

  if (!modalWebhooks || modalWebhooks.length === 0) {
    modalWebhooks = [{
      url: '',
      name: 'Webhook Utama',
      mention: 'everyone',
      mentionRole: '',
      events: [...ALL_EVENT_KEYS]
    }];
  }

  container.innerHTML = modalWebhooks.map((wh, idx) => {
    const events = Array.isArray(wh.events) && wh.events.length > 0 ? wh.events : [...ALL_EVENT_KEYS];
    const isNewVideo = events.includes('new_video');
    const isTaskWarning = events.includes('task_warning');
    const isDoubleUpload = events.includes('double_upload');
    const isDailyReport = events.includes('daily_report');
    const isAccountNotFound = events.includes('account_not_found');
    const mentionType = wh.mention || 'everyone';
    const showInput = ['user', 'role', 'custom'].includes(mentionType);

    let inputPlaceholder = 'Nama User / ID Discord (contoh: @budi atau 123456789)';
    if (mentionType === 'role') inputPlaceholder = 'ID / Nama Role (contoh: 123456789 atau @Admin)';
    if (mentionType === 'custom') inputPlaceholder = 'Ketik mention bebas (contoh: @user1 @user2)';

    return `
      <div class="wh-compact-card" data-idx="${idx}">
        <div class="wh-card-topbar">
          <div class="wh-label-badge">
            <svg class="wh-svg-icon" viewBox="0 0 24 24" fill="currentColor" width="13" height="13">
              <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.929 1.793 8.18 1.793 12.061 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.894.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.028zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z"/>
            </svg>
            <input type="text" class="wh-inline-name-input" placeholder="Label Webhook (misal: Khusus Peringatan)" value="${escapeHtml(wh.name || '')}" oninput="updateModalWebhookField(${idx}, 'name', this.value)">
          </div>
          <div class="wh-card-actions">
            ${wh.url ? `
              <button type="button" class="btn-wh-action btn-wh-test" onclick="testModalWebhook(${idx})" title="Tes Webhook Ini">
                <span>🧪 Tes</span>
              </button>
            ` : ''}
            ${modalWebhooks.length > 1 ? `
              <button type="button" class="btn-wh-action btn-wh-delete" onclick="removeModalWebhook(${idx})" title="Hapus Webhook">
                <span>✕</span>
              </button>
            ` : ''}
          </div>
        </div>

        <div class="wh-url-field-wrap">
          <input type="url" class="wh-url-input-compact" placeholder="https://discord.com/api/webhooks/..." value="${escapeHtml(wh.url || '')}" oninput="updateModalWebhookField(${idx}, 'url', this.value)" required>
        </div>

        <div class="wh-mention-row">
          <div class="wh-mention-left">
            <span class="wh-mention-label">📢 Mention:</span>
            <select class="wh-mention-select" onchange="updateModalWebhookMentionType(${idx}, this.value)">
              <option value="everyone" ${mentionType === 'everyone' ? 'selected' : ''}>@everyone (Default)</option>
              <option value="here" ${mentionType === 'here' ? 'selected' : ''}>@here (Online)</option>
              <option value="user" ${mentionType === 'user' ? 'selected' : ''}>👤 Mention User (Ketik Nama / ID)</option>
              <option value="role" ${mentionType === 'role' ? 'selected' : ''}>🏷️ Mention Role (ID / Nama Role)</option>
              <option value="custom" ${mentionType === 'custom' ? 'selected' : ''}>✍️ Custom Mention (Bebas)</option>
              <option value="none" ${mentionType === 'none' ? 'selected' : ''}>🔕 Tanpa Mention (Hening)</option>
            </select>
          </div>
          ${showInput ? `
            <div class="wh-mention-role-wrap">
              <input type="text" class="wh-mention-role-input" placeholder="${inputPlaceholder}" value="${escapeHtml(wh.mentionRole || '')}" oninput="updateModalWebhookField(${idx}, 'mentionRole', this.value)" title="${inputPlaceholder}">
            </div>
          ` : ''}
        </div>

        <div class="wh-events-toolbar">
          <div class="wh-presets-strip">
            <span class="wh-preset-label">Preset:</span>
            <button type="button" class="wh-preset-btn" onclick="applyWebhookPreset(${idx}, 'all')">Semua</button>
            <button type="button" class="wh-preset-btn" onclick="applyWebhookPreset(${idx}, 'task_only')">⚠️ Khusus Peringatan</button>
            <button type="button" class="wh-preset-btn" onclick="applyWebhookPreset(${idx}, 'video_only')">🎬 Video</button>
            <button type="button" class="wh-preset-btn" onclick="applyWebhookPreset(${idx}, 'report_only')">📊 Report</button>
          </div>

          <div class="wh-chips-group">
            <button type="button" class="wh-chip-item ${isTaskWarning ? 'chip-active chip-task' : ''}" onclick="toggleModalWebhookEvent(${idx}, 'task_warning', !${isTaskWarning})">
              <span class="chip-dot"></span>
              <span>⚠️ Target Belum Tuntas</span>
            </button>
            <button type="button" class="wh-chip-item ${isNewVideo ? 'chip-active chip-video' : ''}" onclick="toggleModalWebhookEvent(${idx}, 'new_video', !${isNewVideo})">
              <span class="chip-dot"></span>
              <span>🎬 Video Baru</span>
            </button>
            <button type="button" class="wh-chip-item ${isDoubleUpload ? 'chip-active chip-double' : ''}" onclick="toggleModalWebhookEvent(${idx}, 'double_upload', !${isDoubleUpload})">
              <span class="chip-dot"></span>
              <span>🔁 Double Upload</span>
            </button>
            <button type="button" class="wh-chip-item ${isDailyReport ? 'chip-active chip-report' : ''}" onclick="toggleModalWebhookEvent(${idx}, 'daily_report', !${isDailyReport})">
              <span class="chip-dot"></span>
              <span>📊 Daily Report</span>
            </button>
            <button type="button" class="wh-chip-item ${isAccountNotFound ? 'chip-active chip-invalid' : ''}" onclick="toggleModalWebhookEvent(${idx}, 'account_not_found', !${isAccountNotFound})">
              <span class="chip-dot"></span>
              <span>🔍 Akun Typo</span>
            </button>
          </div>
        </div>
      </div>
    `;
  }).join('');
}
window.renderModalWebhooks = renderModalWebhooks;

function applyWebhookPreset(idx, type) {
  if (!modalWebhooks[idx]) return;
  if (type === 'all') {
    modalWebhooks[idx].events = [...ALL_EVENT_KEYS];
    if (!modalWebhooks[idx].name) modalWebhooks[idx].name = 'Semua Notifikasi';
  } else if (type === 'task_only') {
    modalWebhooks[idx].events = ['task_warning', 'double_upload', 'account_not_found'];
    if (!modalWebhooks[idx].name || modalWebhooks[idx].name === 'Semua Notifikasi') {
      modalWebhooks[idx].name = 'Khusus Peringatan';
    }
  } else if (type === 'video_only') {
    modalWebhooks[idx].events = ['new_video'];
    if (!modalWebhooks[idx].name || modalWebhooks[idx].name === 'Semua Notifikasi') {
      modalWebhooks[idx].name = 'Khusus Video Baru';
    }
  } else if (type === 'report_only') {
    modalWebhooks[idx].events = ['daily_report'];
    if (!modalWebhooks[idx].name || modalWebhooks[idx].name === 'Semua Notifikasi') {
      modalWebhooks[idx].name = 'Khusus Daily Report';
    }
  }
  renderModalWebhooks();
}
window.applyWebhookPreset = applyWebhookPreset;

function toggleModalWebhookEvent(idx, eventKey, isChecked) {
  if (!modalWebhooks[idx]) return;
  if (!Array.isArray(modalWebhooks[idx].events)) {
    modalWebhooks[idx].events = [...ALL_EVENT_KEYS];
  }
  if (isChecked) {
    if (!modalWebhooks[idx].events.includes(eventKey)) {
      modalWebhooks[idx].events.push(eventKey);
    }
  } else {
    modalWebhooks[idx].events = modalWebhooks[idx].events.filter((e) => e !== eventKey);
  }
  renderModalWebhooks();
}
window.toggleModalWebhookEvent = toggleModalWebhookEvent;

function updateModalWebhookMentionType(idx, type) {
  if (!modalWebhooks[idx]) return;
  modalWebhooks[idx].mention = type;
  renderModalWebhooks();
}
window.updateModalWebhookMentionType = updateModalWebhookMentionType;

function updateModalWebhookField(idx, field, value) {
  if (!modalWebhooks[idx]) return;
  modalWebhooks[idx][field] = value;
}
window.updateModalWebhookField = updateModalWebhookField;

function removeModalWebhook(idx) {
  if (modalWebhooks.length <= 1) return;
  modalWebhooks.splice(idx, 1);
  renderModalWebhooks();
}
window.removeModalWebhook = removeModalWebhook;

async function testModalWebhook(idx) {
  const wh = modalWebhooks[idx];
  if (!wh || !wh.url) {
    showToast('Masukkan URL Webhook Discord terlebih dahulu', true);
    return;
  }
  const groupId = document.getElementById('group-modal-id')?.value || activeGroupId;
  testSingleWebhook(groupId, encodeURIComponent(wh.url), wh.events, wh.mention || 'everyone', wh.mentionRole || '');
}
window.testModalWebhook = testModalWebhook;

// Group Modal (Create / Edit)
const groupModal = document.getElementById('group-modal');
const btnAddModalWebhook = document.getElementById('btn-add-modal-webhook');
if (btnAddModalWebhook) {
  btnAddModalWebhook.addEventListener('click', () => {
    modalWebhooks.push({
      url: '',
      name: `Webhook #${modalWebhooks.length + 1}`,
      mention: 'everyone',
      mentionRole: '',
      events: [...ALL_EVENT_KEYS]
    });
    renderModalWebhooks();
  });
}

document.getElementById('btn-create-group').addEventListener('click', () => {
  document.getElementById('group-modal-title').textContent = 'Buat Grup Channel Baru';
  document.getElementById('group-modal-id').value = '';
  document.getElementById('group-modal-name').value = '';
  const remStartEl = document.getElementById('group-modal-reminder-start');
  if (remStartEl) remStartEl.value = '10:00';
  document.getElementById('group-modal-deadline').value = '22:00';
  document.getElementById('group-modal-warning-interval').value = '30';
  const intervalChk = document.getElementById('group-modal-interval-enabled');
  if (intervalChk) {
    intervalChk.checked = true;
    const intervalTxt = document.getElementById('group-modal-interval-status');
    if (intervalTxt) intervalTxt.textContent = 'Aktif';
  }
  document.getElementById('group-modal-reminder-10m').checked = true;
  document.getElementById('group-modal-reminder-enabled').checked = true;
  modalWebhooks = [{
    url: '',
    name: 'Webhook Utama',
    mention: 'everyone',
    mentionRole: '',
    events: [...ALL_EVENT_KEYS]
  }];
  renderModalWebhooks();
  groupModal.classList.add('active');
});

document.getElementById('btn-edit-group').addEventListener('click', () => {
  const currentGroup = currentStatus?.config?.groups?.find((g) => g.id === activeGroupId);
  if (!currentGroup) return;

  document.getElementById('group-modal-title').textContent = 'Edit Grup Channel';
  document.getElementById('group-modal-id').value = currentGroup.id;
  document.getElementById('group-modal-name').value = currentGroup.name;
  const remStartEl = document.getElementById('group-modal-reminder-start');
  if (remStartEl) remStartEl.value = currentGroup.taskReminderStartTime || '10:00';
  document.getElementById('group-modal-deadline').value = currentGroup.taskDeadline || '22:00';
  document.getElementById('group-modal-warning-interval').value = String(currentGroup.taskWarningIntervalMinutes !== undefined ? currentGroup.taskWarningIntervalMinutes : 30);
  const intervalChk = document.getElementById('group-modal-interval-enabled');
  if (intervalChk) {
    intervalChk.checked = currentGroup.taskWarningIntervalEnabled !== false;
    const intervalTxt = document.getElementById('group-modal-interval-status');
    if (intervalTxt) intervalTxt.textContent = intervalChk.checked ? 'Aktif' : 'Nonaktif';
  }
  document.getElementById('group-modal-reminder-10m').checked = currentGroup.taskReminder10MinEnabled !== false;
  document.getElementById('group-modal-reminder-enabled').checked = currentGroup.taskReminderEnabled !== false;

  if (Array.isArray(currentGroup.webhooks) && currentGroup.webhooks.length > 0) {
    modalWebhooks = currentGroup.webhooks.map((w) => ({
      url: w.url || '',
      name: w.name || '',
      mention: w.mention || 'everyone',
      mentionRole: w.mentionRole || '',
      events: Array.isArray(w.events) && w.events.length > 0 ? [...w.events] : [...ALL_EVENT_KEYS]
    }));
  } else if (currentGroup.webhookUrl) {
    modalWebhooks = [{
      url: currentGroup.webhookUrl,
      name: 'Default',
      mention: currentGroup.mention || 'everyone',
      mentionRole: currentGroup.mentionRole || '',
      events: [...ALL_EVENT_KEYS]
    }];
  } else {
    modalWebhooks = [{
      url: '',
      name: 'Webhook Utama',
      mention: 'everyone',
      mentionRole: '',
      events: [...ALL_EVENT_KEYS]
    }];
  }
  renderModalWebhooks();
  groupModal.classList.add('active');
});

// Listener toggle status text modal
const intervalToggleInput = document.getElementById('group-modal-interval-enabled');
if (intervalToggleInput) {
  intervalToggleInput.addEventListener('change', () => {
    const statusTxt = document.getElementById('group-modal-interval-status');
    if (statusTxt) statusTxt.textContent = intervalToggleInput.checked ? 'Aktif' : 'Nonaktif';
  });
}

document.getElementById('btn-close-group-modal').addEventListener('click', () => {
  groupModal.classList.remove('active');
});
document.getElementById('btn-cancel-group').addEventListener('click', () => {
  groupModal.classList.remove('active');
});

document.getElementById('form-group').addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = document.getElementById('group-modal-id').value;
  const name = document.getElementById('group-modal-name').value.trim();

  // Validate webhooks
  const cleanedWebhooks = modalWebhooks
    .filter((w) => w && w.url && typeof w.url === 'string' && w.url.trim().startsWith('http'))
    .map((w) => ({
      url: w.url.trim(),
      name: (w.name || '').trim(),
      mention: (w.mention || 'everyone').trim(),
      mentionRole: (w.mentionRole || '').trim(),
      events: Array.isArray(w.events) && w.events.length > 0 ? w.events : [...ALL_EVENT_KEYS]
    }));

  if (cleanedWebhooks.length === 0) {
    showToast('Harap masukkan minimal 1 URL Discord Webhook yang valid (diawali https://)', true);
    return;
  }

  const isEdit = !!id;
  const url = isEdit ? `/api/groups/${id}` : '/api/groups';
  const method = isEdit ? 'PUT' : 'POST';

  const taskReminderStartTime = document.getElementById('group-modal-reminder-start')?.value || '10:00';
  const taskDeadline = document.getElementById('group-modal-deadline')?.value || '22:00';
  const taskWarningIntervalMinutes = Number(document.getElementById('group-modal-warning-interval')?.value || 30);
  const taskWarningIntervalEnabled = document.getElementById('group-modal-interval-enabled')?.checked ?? true;
  const taskReminder10MinEnabled = document.getElementById('group-modal-reminder-10m')?.checked ?? true;
  const taskReminderEnabled = document.getElementById('group-modal-reminder-enabled')?.checked ?? true;

  try {
    const res = await authFetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        webhooks: cleanedWebhooks,
        webhookUrl: cleanedWebhooks[0]?.url || '',
        taskReminderStartTime,
        taskDeadline,
        taskWarningIntervalMinutes,
        taskWarningIntervalEnabled,
        taskReminder10MinEnabled,
        taskReminderEnabled
      })
    });
    const data = await res.json();
    if (data.success) {
      showToast(isEdit ? 'Grup berhasil diperbarui!' : 'Grup baru berhasil dibuat!');
      groupModal.classList.remove('active');
      if (!isEdit && data.group) {
        activeGroupId = data.group.id;
      }
      fetchStatus();
    } else {
      showToast(data.error || 'Gagal menyimpan grup', true);
    }
  } catch (err) {
    showToast(err.message, true);
  }
});

// Test Task Reminder Button in Group Banner
const btnTestReminder = document.getElementById('btn-trigger-test-reminder');
if (btnTestReminder) {
  btnTestReminder.addEventListener('click', async () => {
    if (!activeGroupId) return;
    const group = currentStatus?.config?.groups?.find((g) => g.id === activeGroupId);
    if (!group) return;

    btnTestReminder.disabled = true;
    const originalText = btnTestReminder.innerHTML;
    btnTestReminder.innerHTML = '<span>⏳ Mengirim...</span>';

    try {
      showToast(`Mengirim simulasi reminder task untuk grup "${group.name}" ke Discord...`);
      const res = await authFetch('/api/daily-report/warn-incomplete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ groupId: group.id, reminderType: '10_min_reminder', isTest: true })
      });
      const data = await res.json();
      if (data.success) {
        showToast(data.message || '✅ Reminder task berhasil dikirim ke webhook Discord!');
      } else {
        showToast(`❌ Gagal: ${data.error || data.message}`, true);
      }
    } catch (err) {
      showToast(err.message, true);
    } finally {
      btnTestReminder.disabled = false;
      btnTestReminder.innerHTML = originalText;
    }
  });
}

// Delete Group
document.getElementById('btn-delete-group').addEventListener('click', async () => {
  if (!activeGroupId) return;
  const group = currentStatus?.config?.groups?.find((g) => g.id === activeGroupId);
  if (!group) return;

  if (!confirm(`Apakah Anda yakin ingin menghapus grup "${group.name}" beserta daftar akunnya?`)) return;

  try {
    const res = await authFetch(`/api/groups/${activeGroupId}`, { method: 'DELETE' });
    const data = await res.json();
    if (data.success) {
      showToast('Grup berhasil dihapus.');
      activeGroupId = null;
      fetchStatus();
    } else {
      showToast(data.error || 'Gagal menghapus grup', true);
    }
  } catch (err) {
    showToast(err.message, true);
  }
});

// Test Group Webhook Button
document.getElementById('btn-test-group-webhook').addEventListener('click', () => {
  if (!activeGroupId) return;
  const group = currentStatus?.config?.groups?.find((g) => g.id === activeGroupId);
  const firstAccount = group?.accounts?.[0];
  if (!firstAccount) {
    showToast('Tambahkan minimal 1 akun ke grup ini untuk mengetes webhook.', true);
    return;
  }
  testAccountWebhook(activeGroupId, firstAccount);
});

// Settings Modal
const settingsModal = document.getElementById('settings-modal');
document.getElementById('btn-open-settings').addEventListener('click', () => {
  if (currentStatus && currentStatus.config) {
    document.getElementById('setting-interval').value = currentStatus.config.checkIntervalSeconds || 120;
    document.getElementById('setting-delay').value = currentStatus.config.delayBetweenAccountsMs || 2000;
    const appUrlInput = document.getElementById('setting-app-url');
    if (appUrlInput) {
      appUrlInput.value = currentStatus.config.appUrl || '';
    }
  }
  settingsModal.classList.add('active');
});

document.getElementById('btn-close-settings').addEventListener('click', () => {
  settingsModal.classList.remove('active');
});
document.getElementById('btn-cancel-settings').addEventListener('click', () => {
  settingsModal.classList.remove('active');
});

document.getElementById('form-settings').addEventListener('submit', async (e) => {
  e.preventDefault();
  const checkIntervalSeconds = Number(document.getElementById('setting-interval').value);
  const delayBetweenAccountsMs = Number(document.getElementById('setting-delay').value);
  const appUrl = (document.getElementById('setting-app-url')?.value || '').trim();

  try {
    const res = await authFetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ checkIntervalSeconds, delayBetweenAccountsMs, appUrl })
    });
    const data = await res.json();
    if (data.success) {
      showToast('Pengaturan berhasil disimpan!');
      settingsModal.classList.remove('active');
      fetchStatus();
    } else {
      showToast('Gagal menyimpan pengaturan', true);
    }
  } catch (err) {
    showToast(err.message, true);
  }
});

document.getElementById('btn-manual-check').addEventListener('click', manualCheck);

const groupTabsContainer = document.getElementById('group-tabs-container');
if (groupTabsContainer) {
  groupTabsContainer.addEventListener('click', (e) => {
    const btn = e.target.closest('.group-tab');
    if (btn && btn.dataset.groupId) {
      selectGroup(btn.dataset.groupId);
    }
  });
}

const searchCreatorsInput = document.getElementById('search-creators');
if (searchCreatorsInput) {
  searchCreatorsInput.addEventListener('input', () => {
    if (currentStatus) {
      const activeGroup = currentStatus.config?.groups?.find((g) => g.id === activeGroupId) || currentStatus.config?.groups?.[0];
      renderCreators(activeGroup, currentStatus.runtime?.accountCache || {}, currentStatus.state || {});
    }
  });
}

// --- Batch Add Modal Functionality ---
function parseBatchUsernames(text) {
  if (!text) return [];
  const lines = text.split(/[\r\n,;]+/);
  const cleaned = lines.map((line) => {
    return line
      .trim()
      .replace(/^["'@]+|["']+$/g, '')
      .replace(/https?:\/\/(www\.)?tiktok\.com\/@/i, '')
      .replace(/[/?#].*$/, '')
      .toLowerCase();
  }).filter((line) => line.length > 0 && /^[a-zA-Z0-9_.-]+$/.test(line));

  return [...new Set(cleaned)];
}

const batchModal = document.getElementById('modal-batch-add');
const batchTextarea = document.getElementById('batch-usernames-text');
const batchGroupSelect = document.getElementById('batch-target-group');
const batchBadge = document.getElementById('batch-detected-badge');

function openBatchModal() {
  const groups = currentStatus?.config?.groups || [];
  if (groups.length === 0) {
    showToast('Buat grup saluran terlebih dahulu sebelum menambahkan akun!', true);
    return;
  }

  // Populate groups dropdown
  if (batchGroupSelect) {
    batchGroupSelect.innerHTML = groups.map((g) => `
      <option value="${g.id}" ${g.id === activeGroupId ? 'selected' : ''}>
        ${g.name} (${g.accounts?.length || 0} Akun)
      </option>
    `).join('');
  }

  if (batchTextarea) {
    batchTextarea.value = '';
  }
  if (batchBadge) {
    batchBadge.textContent = '0 akun valid';
  }
  if (batchModal) {
    batchModal.classList.add('active');
    if (batchTextarea) batchTextarea.focus();
  }
}

function closeBatchModal() {
  if (batchModal) {
    batchModal.classList.remove('active');
  }
}

const btnOpenBatch = document.getElementById('btn-open-batch-modal');
if (btnOpenBatch) {
  btnOpenBatch.addEventListener('click', openBatchModal);
}
const btnCloseBatch = document.getElementById('btn-close-batch');
if (btnCloseBatch) {
  btnCloseBatch.addEventListener('click', closeBatchModal);
}
const btnCancelBatch = document.getElementById('btn-cancel-batch');
if (btnCancelBatch) {
  btnCancelBatch.addEventListener('click', closeBatchModal);
}

if (batchTextarea) {
  batchTextarea.addEventListener('input', () => {
    const list = parseBatchUsernames(batchTextarea.value);
    if (batchBadge) {
      batchBadge.textContent = `${list.length} akun valid`;
    }
  });
}

const formBatchAdd = document.getElementById('form-batch-add');
if (formBatchAdd) {
  formBatchAdd.addEventListener('submit', async (e) => {
    e.preventDefault();
    const targetGroupId = batchGroupSelect.value;
    const usernames = parseBatchUsernames(batchTextarea.value);

    if (usernames.length === 0) {
      showToast('Tidak ada username TikTok yang valid terdeteksi!', true);
      return;
    }

    const btnSubmit = document.getElementById('btn-submit-batch');
    const originalText = btnSubmit.innerHTML;
    btnSubmit.disabled = true;
    btnSubmit.innerHTML = `<span class="status-pulse" style="background:#fff"></span> Menyimpan ${usernames.length} akun...`;

    try {
      const res = await authFetch(`/api/groups/${targetGroupId}/accounts/batch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ usernames })
      });
      const data = await res.json();

      if (data.success) {
        let msg = `✅ Berhasil menambahkan ${data.count} akun ke grup!`;
        if (data.skipped && data.skipped.length > 0) {
          msg += ` (${data.skipped.length} akun sudah terdaftar)`;
        }
        showToast(msg);
        closeBatchModal();
        activeGroupId = targetGroupId;
        localStorage.setItem('activeGroupId', targetGroupId);
        await fetchStatus();
      } else {
        showToast(data.error || 'Gagal menambahkan akun batch', true);
      }
    } catch (err) {
      showToast(err.message, true);
    } finally {
      btnSubmit.disabled = false;
      btnSubmit.innerHTML = originalText;
    }
  });
}

document.getElementById('btn-clear-logs').addEventListener('click', () => {
  document.getElementById('terminal-logs-container').innerHTML = `
    <div class="log-entry info">
      <span class="log-time">[${new Date().toLocaleTimeString('id-ID')}]</span>
      <span class="log-msg">Log dibersihkan oleh pengguna.</span>
    </div>
  `;
});

// Login Form Submit
document.getElementById('form-login').addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = document.getElementById('login-username').value.trim();
  const password = document.getElementById('login-password').value.trim();
  const remember = document.getElementById('remember-me').checked;
  const alertEl = document.getElementById('login-alert');
  const btn = document.getElementById('btn-submit-login');

  alertEl.style.display = 'none';
  btn.disabled = true;
  btn.innerHTML = `<span class="status-pulse" style="background:#fff"></span> Memeriksa...`;

  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    const data = await res.json();

    if (data.success && data.token) {
      setToken(data.token, remember, data.role || 'Admin', data.username || username);
      showToast(`Selamat datang, ${data.username || username}!`);
      updateRoleUI();
      showDashboardView();
    } else {
      alertEl.textContent = data.error || 'Username atau password salah!';
      alertEl.style.display = 'block';
    }
  } catch (err) {
    alertEl.textContent = 'Gagal menghubungi server. Jika server sedang bangun dari mode hemat daya (cold start), silakan tunggu 10 detik lalu coba lagi.';
    alertEl.style.display = 'block';
  } finally {
    btn.disabled = false;
    btn.innerHTML = `<span>Masuk ke Panel Kendali</span> <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="5" y1="12" x2="19" y2="12"></line><polyline points="12 5 19 12 12 19"></polyline></svg>`;
  }
});

// Toggle Password Visibility (Login Form)
document.getElementById('btn-toggle-pw').addEventListener('click', () => {
  const pwInput = document.getElementById('login-password');
  const isText = pwInput.type === 'text';
  pwInput.type = isText ? 'password' : 'text';
});

// Logout Button
document.getElementById('btn-logout').addEventListener('click', () => {
  if (confirm('Apakah Anda yakin ingin keluar?')) {
    clearToken();
    showLoginView();
    showToast('Anda telah keluar dari sistem.');
  }
});

// Reset Session Cache Button (Fixes any stuck/corrupted browser storage)
const resetCacheBtn = document.getElementById('btn-reset-cache');
if (resetCacheBtn) {
  resetCacheBtn.addEventListener('click', () => {
    clearToken();
    localStorage.clear();
    sessionStorage.clear();
    document.getElementById('login-username').value = '';
    document.getElementById('login-password').value = '';
    const alertEl = document.getElementById('login-alert');
    if (alertEl) alertEl.style.display = 'none';
    showToast('Sesi browser & cache telah dibersihkan secara total.');
  });
}

// Clipboard Copy Helper with Cross-Browser Fallback
async function copyTextToClipboard(text) {
  if (!text) return false;
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (err) {
    console.warn('Navigator clipboard error, falling back:', err);
  }

  try {
    const tempTextarea = document.createElement('textarea');
    tempTextarea.value = text;
    tempTextarea.style.position = 'fixed';
    tempTextarea.style.left = '-999999px';
    tempTextarea.style.top = '-999999px';
    document.body.appendChild(tempTextarea);
    tempTextarea.focus();
    tempTextarea.select();
    const successful = document.execCommand('copy');
    document.body.removeChild(tempTextarea);
    return successful;
  } catch (err) {
    console.error('Clipboard copy failed:', err);
    return false;
  }
}

// Daily Report Actions: 1-Click Copy
const copyReportBtn = document.getElementById('btn-copy-daily-report');
if (copyReportBtn) {
  copyReportBtn.addEventListener('click', async () => {
    if (!currentDailyReport || !currentDailyReport.copyText) {
      showToast('Belum ada data daily report untuk disalin.', true);
      return;
    }
    const ok = await copyTextToClipboard(currentDailyReport.copyText);
    if (ok) {
      showToast('📋 Daily Report berhasil disalin ke clipboard! Siap ditempel.');
    } else {
      showToast('Gagal menyalin otomatis. Buka Detail untuk menyalin manual.', true);
    }
  });
}

// Daily Report Actions: Send to Discord Webhook
const sendDiscordReportBtn = document.getElementById('btn-send-discord-report');
if (sendDiscordReportBtn) {
  sendDiscordReportBtn.addEventListener('click', async () => {
    if (!activeGroupId) {
      showToast('Pilih grup terlebih dahulu!', true);
      return;
    }

    sendDiscordReportBtn.disabled = true;
    const originalText = sendDiscordReportBtn.innerHTML;
    sendDiscordReportBtn.innerHTML = `<span class="status-pulse" style="background:#fff"></span> Mengirim...`;

    try {
      const res = await authFetch(`/api/groups/${activeGroupId}/daily-report/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ offsetDays: currentDailyReportOffset })
      });
      const data = await res.json();
      if (data.success) {
        showToast('🚀 Daily Report berhasil dikirim ke Discord Webhook (@everyone)!');
      } else {
        showToast(data.error || 'Gagal mengirim daily report ke Discord', true);
      }
    } catch (err) {
      showToast(`Error: ${err.message}`, true);
    } finally {
      sendDiscordReportBtn.disabled = false;
      sendDiscordReportBtn.innerHTML = originalText;
    }
  });
}

// Daily Report Actions: Push Incomplete Warning to Discord
const warnDiscordReportBtn = document.getElementById('btn-warn-discord-report');
if (warnDiscordReportBtn) {
  warnDiscordReportBtn.addEventListener('click', async () => {
    if (!activeGroupId) {
      showToast('Pilih grup terlebih dahulu!', true);
      return;
    }

    warnDiscordReportBtn.disabled = true;
    const originalText = warnDiscordReportBtn.innerHTML;
    warnDiscordReportBtn.innerHTML = `<span class="status-pulse" style="background:#fff"></span> Mengirim...`;

    try {
      const res = await authFetch(`/api/groups/${activeGroupId}/daily-report/warn-incomplete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isTest: true })
      });
      const data = await res.json();
      if (data.success) {
        showToast(data.message || '⚠️ Peringatan target belum tuntas berhasil dikirim ke Discord (@everyone)!');
      } else {
        showToast(data.error || 'Gagal mengirim peringatan ke Discord', true);
      }
    } catch (err) {
      showToast(`Error: ${err.message}`, true);
    } finally {
      warnDiscordReportBtn.disabled = false;
      warnDiscordReportBtn.innerHTML = originalText;
    }
  });
}

// Copy Public Report Link (Accessible by anyone without login)
const copyPublicLinkBtn = document.getElementById('btn-copy-public-link');
const openPublicLinkEl = document.getElementById('btn-open-public-link');

function updatePublicLinkUrls() {
  const url = activeGroupId
    ? `${window.location.origin}/report?group=${activeGroupId}`
    : `${window.location.origin}/report`;
  if (openPublicLinkEl) {
    openPublicLinkEl.href = activeGroupId ? `/report?group=${activeGroupId}` : '/report';
  }
  return url;
}

if (copyPublicLinkBtn) {
  copyPublicLinkBtn.addEventListener('click', async () => {
    const publicUrl = updatePublicLinkUrls();
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(publicUrl);
      } else {
        const temp = document.createElement('input');
        temp.value = publicUrl;
        document.body.appendChild(temp);
        temp.select();
        document.execCommand('copy');
        document.body.removeChild(temp);
      }
      showToast('🔗 Tautan Laporan Publik berhasil disalin! Siap dibagikan ke siapa saja tanpa perlu login.');
    } catch {
      showToast(`Tautan laporan: ${publicUrl}`);
    }
  });
}

// Initialize Daily Report Copy Protection on DOM
setupReportCopyProtection();

// Check Auth on Startup with Retry for Cold Starts
async function initAuth(retries = 2) {
  const token = getToken();
  if (!token) {
    showLoginView();
    return;
  }

  try {
    const res = await fetch('/api/auth/verify', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` }
    });
    const data = await res.json();
    if (data.valid) {
      currentUserRole = data.role || localStorage.getItem('vcstudios_role') || 'Admin';
      currentUsername = data.username || localStorage.getItem('vcstudios_username') || '';
      updateRoleUI();
      showDashboardView();
    } else {
      clearToken();
      showLoginView();
    }
  } catch (err) {
    // If server is cold-booting, wait and retry before abandoning session
    if (retries > 0) {
      console.log(`[Auth] Menghubungkan ke server (${retries} percobaan tersisa)...`);
      setTimeout(() => initAuth(retries - 1), 2000);
    } else {
      showLoginView();
    }
  }
}

initAuth();
