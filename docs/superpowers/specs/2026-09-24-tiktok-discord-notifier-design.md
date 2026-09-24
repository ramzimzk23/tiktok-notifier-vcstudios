# TikTok Post Monitor to Discord Webhook Design

## 1. Overview
Sebuah aplikasi Node.js mandiri yang memantau akun TikTok publik secara berkala (polling interval, default: 2 menit). Ketika akun target mengunggah video baru, aplikasi akan memicu notifikasi ke Discord Webhook dalam format Rich Embed (nama akun, avatar, judul/caption, cover video resolusi tinggi, direct link, dan timestamp).

## 2. Core Components

### 2.1 TikTok Scraper Engine (`src/scraper.js`)
- **Metode**: Ekstraksi SSR dari endpoint `https://www.tiktok.com/embed/@username`.
- **WAF Auto-Solver**: Menyelesaikan challenge `_wafchallengeid` (ByteDance SlardarWAF) menggunakan algoritma SHA-256 (`node:crypto`) tanpa membutuhkan browser headless (Puppeteer/Playwright).
- **Data Extractor**: Mengurai state JSON `__FRONTITY_CONNECT_STATE__` untuk mendapatkan detail user dan `videoList`.
- **Snowflake Parser**: Menghitung waktu pembuatan video riil melalui bitwise operator: `Number(BigInt(videoId) >> 32n)`.

### 2.2 Notifier (`src/notifier.js`)
- Mengirim payload Rich Embed ke Discord Webhook via native `fetch`.
- Format embed mencakup:
  - Author: Nama Akun + Avatar TikTok + Link Profil
  - Title: Notifikasi Video Baru
  - Description: Caption video (atau fallback jika kosong)
  - Image: Cover / thumbnail video
  - Fields: Direct URL, Tanggal & Jam rilis
  - Color: TikTok Pink-Red (`#FE2C55` / `16657493`)

### 2.3 State Management & Poller (`src/tracker.js` & `src/index.js`)
- **`config.json`**:
  - `webhookUrl`: URL Discord Webhook
  - `checkIntervalSeconds`: 120 (2 menit)
  - `accounts`: `["varsatilevibes"]`
- **`state.json`**:
  - Menyimpan map `{ [username]: { lastVideoId, lastCheckTime, lastKnownTitle } }`
  - Memastikan saat pertama kali dijalankan, sistem dapat diatur apakah ingin mengabarkan video terkini sebagai baseline atau langsung mengirim test notifikasi.

### 2.4 CLI & Test Script (`test.js`)
- Menyediakan pengujian instan:
  1. Tes scraping akun TikTok (`varsatilevibes`).
  2. Tes pengiriman pesan notifikasi ke Discord Webhook pengguna.
