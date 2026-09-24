# TikTok Discord Notifier Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Membangun aplikasi pemantau aktivitas postingan TikTok ke Discord Webhook dengan reverse engineering TikTok embed & auto WAF solver.

**Architecture:** Node.js native scraper dengan SlardarWAF solver, Discord webhook notification engine, state store berbasis JSON, dan background poller dengan interval 2 menit.

**Tech Stack:** Node.js (v20+), Native `fetch`, `node:crypto`, `node:fs/promises`.

**Spec:** `docs/superpowers/specs/2026-09-24-tiktok-discord-notifier-design.md`

## Global Constraints
- Tanpa dependensi pihak ketiga berat (zero dependency / pure Node.js native APIs).
- Error handling tangguh: penanganan network retry, rate-limit, dan validasi JSON.

---

### Task 1: Project Scaffolding & Configuration
**Files:**
- Create: `package.json`
- Create: `config.json`
- Create: `.gitignore`

- [ ] **Step 1: Inisialisasi package.json**
- [ ] **Step 2: Buat config.json dengan webhook dan interval 2 menit**
- [ ] **Step 3: Tambahkan .gitignore**

### Task 2: Core TikTok Scraper Module
**Files:**
- Create: `src/scraper.js`

- [ ] **Step 1: Implementasi solveWafChallenge**
- [ ] **Step 2: Implementasi getTikTokProfile & extractVideos**
- [ ] **Step 3: Unit test fungsi scraper terhadap akun @varsatilevibes**

### Task 3: Discord Webhook Notifier Module
**Files:**
- Create: `src/notifier.js`

- [ ] **Step 1: Implementasi sendDiscordNotification dengan Rich Embed TikTok**
- [ ] **Step 2: Implementasi sendTestMessage**

### Task 4: State Management & Tracker Daemon
**Files:**
- Create: `src/tracker.js`
- Create: `src/index.js`

- [ ] **Step 1: Implementasi loadState & saveState**
- [ ] **Step 2: Implementasi checkAccount logic (perbandingan ID video baru)**
- [ ] **Step 3: Implementasi poller loop berkala**

### Task 5: Interactive Testing Script & Live Verification
**Files:**
- Create: `test.js`

- [ ] **Step 1: Buat script test.js untuk verifikasi scraping & pengiriman notifikasi ke Discord**
- [ ] **Step 2: Jalankan test.js untuk mengirim notifikasi sampel postingan terkini ke channel Discord pengguna**
- [ ] **Step 3: Verifikasi status respons Discord Webhook**
