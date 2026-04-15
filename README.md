# Metabase Signed Embed Starter (Node.js)

Starter ini menyiapkan cara aman untuk publish dashboard Metabase menggunakan signed embedding.

## Kenapa aman?
- Secret key disimpan di environment variable (`METABASE_SECRET_KEY`), bukan hardcoded.
- JWT dibuat di backend (`/api/metabase/dashboard-token`), bukan di frontend.
- Token punya masa aktif pendek (5 menit).
- Ada allowlist dashboard (`DASHBOARD_ALLOWLIST`) agar user tidak bisa minta token untuk dashboard lain.
- Ada pembatasan origin (`ALLOWED_ORIGINS`) dan rate limit request token.
- Endpoint token hanya menerima `GET` dan `OPTIONS`.
- Security headers aktif via `helmet`.
- Ada audit log request token (tanpa mencetak JWT).
- Opsional guard API key internal (`INTERNAL_API_KEY`) untuk melindungi endpoint token.

## Setup
1. Install dependency:
   ```bash
   npm install
   ```
2. Salin env:
   ```bash
   copy .env.example .env
   ```
3. Isi `.env`:
   - `METABASE_SECRET_KEY`: embed secret dari Metabase (pakai secret baru/rotated).
   - `METABASE_SITE_URL`: contoh `https://metabase.perusahaan.com`
   - `DASHBOARD_ALLOWLIST`: daftar ID dashboard yang boleh di-embed, pisahkan dengan koma. Contoh `2,5,7`
   - `ALLOWED_ORIGINS`: daftar origin yang boleh mengakses endpoint token. Contoh `https://app.domain.com,http://localhost:3000`
   - `TOKEN_RATE_WINDOW_MS` dan `TOKEN_RATE_MAX`: konfigurasi rate limit endpoint token.
   - `TRUST_PROXY`: isi `true` jika aplikasi berjalan di belakang reverse proxy dan Anda ingin IP client real dibaca dari header proxy.
   - `INTERNAL_API_KEY`: jika diisi, request ke endpoint token wajib menyertakan `X-Embed-Key` atau `Authorization: Bearer <key>`.
4. Jalankan server:
   ```bash
   npm start
   ```
5. Buka:
   - `http://localhost:3000`

## Endpoint penting
- `GET /api/metabase/dashboard-token?dashboardId=2`
- `GET /health` (cek kesehatan service + probe ke `METABASE_SITE_URL/api/health`)

## Audit log
- Log audit hanya mencatat `ip`, `origin`, dan `dashboardId`.
- JWT tidak pernah dicetak ke log.

## Internal API key (opsional)
- Cocok untuk arsitektur server-to-server (misalnya frontend Anda memanggil backend internal dulu).
- Jika frontend browser memanggil endpoint token secara langsung, jangan isi `INTERNAL_API_KEY` di browser publik.
- Header yang didukung:
   - `X-Embed-Key: <key>`
   - `Authorization: Bearer <key>`

## Deploy ke Vercel

Proyék ini siap deploy ke Vercel dengan minimal setup (sudah include `vercel.json`).

### Langkah deploy:
1. Push kode ke GitHub repo (pastikan `.env` tidak tercakup dalam `.gitignore`).
2. Buka https://vercel.com/import
3. Import repo GitHub Anda.
4. Di step "Environment Variables", isi:
   - `METABASE_SECRET_KEY` - dari Metabase Settings
   - `METABASE_SITE_URL` - URL Metabase production
   - `DASHBOARD_ALLOWLIST` - ID dashboard yang boleh di-embed
   - `ALLOWED_ORIGINS` - domain app Anda yang boleh akses token (atau kosongkan untuk public)
   - `TRUST_PROXY` - biarkan default `true` (Vercel pakai proxy)
5. Deploy → Vercel akan auto-build dan launch.
6. Buka URL deployment (misalnya `https://project-abc.vercel.app`).

### Catatan Vercel:
- **Cold Start**: Request pertama kali bisa delay 1s karena serverless, request selanjutnya cepat.
- **Health Check**: Endpoint `/health` akan mencoba terhubung ke Metabase Anda. Pastikan Metabase bisa diakses dari Vercel (tidak firewall tertutup).
- **Rate Limit**: Dijalankan per function instance. Untuk load tinggi, Vercel akan spawn instance baru.
- **Logs**: Lihat di Vercel Dashboard → Function Logs untuk audit token request.

## Rekomendasi production
- Untuk self-hosted (Nginx/dedicated server): lihat bagian sebelumnya, contoh di `nginx.conf.example`.
- Untuk Vercel: pastikan METABASE_SITE_URL accessible dari internet (bukan internal IP).
- Simpan `.env` hanya lokal, jangan commit (sudah di `.gitignore`).
- Rotate secret Metabase lama sebelum publish.

## Catatan publish
- Jika dashboard benar-benar untuk publik internet, pastikan tidak ada data sensitif.
- Secret yang pernah dibagikan di chat/repo harus dianggap bocor dan wajib di-rotate di Metabase.
- Untuk kebutuhan tanpa kontrol akses aplikasi, pertimbangkan fitur Public Sharing bawaan Metabase.
