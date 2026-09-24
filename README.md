# TikTok Discord Notifier 🔔

Aplikasi pemantau postingan baru TikTok yang mengirimkan notifikasi instan ke Discord Webhook (hasil reverse engineering mekanisme `notify.me`).

## ✨ Fitur
- **Ekstraksi Cepat & Ringan**: Menggunakan endpoint embed SSR TikTok dengan auto-solver ByteDance `SlardarWAF` (SHA-256 via `node:crypto`) tanpa browser headless berat (seperti Puppeteer/Playwright).
- **TikTok Snowflake Time Parser**: Mengonversi ID video TikTok langsung menjadi timestamp rilis video yang akurat.
- **Discord Rich Embed**: Notifikasi visual lengkap dengan avatar kreator, cover video resolusi tinggi, caption, waktu posting, dan link tontonan.
- **State Persistence (`state.json`)**: Menyimpan ID video terakhir untuk mencegah notifikasi terkirim berulang kali.
- **Auto Retry & Backoff**: Menangani pembatasan sementara atau lonjakan trafik.

---

## 🚀 Cara Menjalankan

### 1. Menjalankan Web Dashboard & Poller (Localhost)
Jalankan aplikasi utama. Ini akan menjalankan **Web Dashboard Interaktif** di browser sekaligus **Daemon Poller** di background:

```bash
npm start
# atau
node src/index.js
```

Buka browser Anda di:
👉 **[http://localhost:3000](http://localhost:3000)**

#### 🔐 Akses Login:
Gunakan akun administrator yang telah dikonfigurasi di file `.env`.

Di dashboard ini Anda bisa:
- Melihat kartu kreator yang sedang dipantau beserta thumbnail video terbarunya.
- Melihat hitung mundur (*countdown*) menuju scan otomatis berikutnya (setiap 2 menit).
- Menambah atau menghapus akun TikTok langsung dari tampilan web.
- Melakukan "Scan Sekarang" (*manual trigger*).
- Menekan tombol "Tes Webhook" untuk langsung mengirim notifikasi sampel ke Discord.
- Memantau log aktivitas real-time (*scraping*, *WAF status*, dan webhook).

### 2. Uji Coba Cepat via CLI (Terminal Only)
```bash
# Mengetes akun default dari config.json (@varsatilevibes)
node test.js

# Mengetes akun lain secara langsung
node test.js khaby.lame
```

---

## ⚙️ Konfigurasi (`config.json`)

```json
{
  "webhookUrl": "https://discord.com/api/webhooks/...",
  "checkIntervalSeconds": 120,
  "accounts": [
    "varsatilevibes"
  ]
}
```

- **`webhookUrl`**: URL Discord Webhook channel Anda.
- **`checkIntervalSeconds`**: Jeda waktu antar pengecekan (default `120` detik / 2 menit).
- **`accounts`**: Daftar username TikTok yang ingin dipantau. Anda bisa menambahkan banyak akun sekaligus, contoh:
  ```json
  "accounts": [
    "varsatilevibes",
    "khaby.lame"
  ]
  ```
