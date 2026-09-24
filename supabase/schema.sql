-- ========================================================
-- VCStudios • TikTok Notifier Supabase Database Schema
-- Jalankan query ini di SQL Editor dashboard Supabase Anda.
-- ========================================================

-- 1. Tabel Grup Channel Webhook
CREATE TABLE IF NOT EXISTS public.groups (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    webhook_url TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. Tabel Akun TikTok yang Dipantau
CREATE TABLE IF NOT EXISTS public.tracked_accounts (
    username TEXT PRIMARY KEY,
    group_id TEXT NOT NULL REFERENCES public.groups(id) ON DELETE CASCADE,
    nickname TEXT,
    avatar_url TEXT,
    last_video_id TEXT,
    last_post_time BIGINT,
    last_check_time BIGINT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3. Tabel Pengaturan Global
CREATE TABLE IF NOT EXISTS public.app_settings (
    id TEXT PRIMARY KEY DEFAULT 'global',
    check_interval_seconds INT DEFAULT 120,
    delay_between_accounts_ms INT DEFAULT 2000,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 4. Keamanan: Pendaftaran Ditutup Permanen (Hanya 1 Administrator Master)
-- DROP TABLE IF EXISTS public.app_users CASCADE;

-- Inisialisasi baris pengaturan default jika belum ada
INSERT INTO public.app_settings (id, check_interval_seconds, delay_between_accounts_ms)
VALUES ('global', 120, 2000)
ON CONFLICT (id) DO NOTHING;

-- RLS Configuration untuk grup dan akun
ALTER TABLE public.groups DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.tracked_accounts DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.app_settings DISABLE ROW LEVEL SECURITY;

