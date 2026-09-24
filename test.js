import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getTikTokUserVideos } from './src/scraper.js';
import { sendDiscordNotification } from './src/notifier.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_FILE = path.resolve(__dirname, 'config.json');

async function runTest() {
  console.log('🧪 Memulai Uji Coba VCStudios Notifier ke Discord Webhook...');
  console.log('-'.repeat(55));

  let config;
  try {
    const raw = await fs.readFile(CONFIG_FILE, 'utf-8');
    config = JSON.parse(raw);
  } catch (err) {
    console.error('❌ Gagal memuat config.json:', err.message);
    process.exit(1);
  }

  // Allow passing target via argument or fallback to config
  const targetUser = process.argv[2] || config.accounts[0] || 'varsatilevibes';
  console.log(`🔍 Mengambil data postingan TikTok untuk: @${targetUser}`);

  const startTime = Date.now();
  const result = await getTikTokUserVideos(targetUser);
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);

  if (!result.success) {
    console.error(`❌ Gagal mengambil data TikTok: ${result.error}`);
    process.exit(1);
  }

  const { user, videos } = result;
  console.log(`✅ Data berhasil diekstrak dalam ${elapsed} detik!`);
  console.log(`   • Nama Akun   : ${user.nickname} (@${user.uniqueId})`);
  console.log(`   • Total Video : ${videos.length} video terdeteksi`);

  if (videos.length === 0) {
    console.log('⚠️ Akun ini belum memiliki video publik.');
    process.exit(0);
  }

  const latest = videos[0];
  console.log(`   • Video ID    : ${latest.id}`);
  console.log(`   • Caption     : ${latest.desc || '(Tidak ada caption)'}`);
  console.log(`   • Diunggah    : ${latest.createdAt}`);
  console.log(`   • Link Video  : ${latest.url}`);
  console.log('-'.repeat(55));

  const webhookUrl = config.groups?.[0]?.webhookUrl || config.webhookUrl;
  const groupName = config.groups?.[0]?.name || null;

  console.log('📤 Mengirim notifikasi uji coba ke Discord Webhook...');
  const sent = await sendDiscordNotification(webhookUrl, user, latest, groupName);

  if (sent) {
    console.log('🎉 SUKSES! Notifikasi berhasil dikirimkan ke channel Discord Anda.');
    console.log('Silakan periksa channel Discord Anda sekarang!');
  } else {
    console.error('❌ Gagal mengirim notifikasi ke Discord Webhook.');
  }
}

runTest();
