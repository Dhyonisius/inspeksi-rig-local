# Chatbot dengan API PROTECT (CRSSC)

Konektor menggunakan skema koleksi Postman CRSSC yang diberikan pengelola pada 6 November 2026. File dokumentasi/credential asli tidak dimasukkan ke repository.

## Mengaktifkan setelah image baru terpasang

1. Pertahankan Secret `protect-api-auth`, dengan key `username` dan `password`. Pada Deployment aplikasi `inspeksi-rig`, environment `PROTECT_USERNAME` dan `PROTECT_PASSWORD` harus merujuk key tersebut. Jangan memasukkan credential ke YAML yang di-commit.
2. Build image aplikasi dari `main`. Gunakan digest hasil build pada app dan init container sesuai deployment perusahaan. Jangan menghapus PVC, Secret, konfigurasi SQL, atau mengubah layanan `llm-bridge` yang sudah berhasil.
3. Tambahkan environment aplikasi `PROTECT_API_ENABLED=1`. Tidak perlu mengaktifkannya pada bridge. Simpan dan tunggu pod aplikasi baru Ready. Endpoint API dikunci ke `https://apps.phr.pertamina.com/APIGW`, dengan header subscription literal `NULL` sesuai dokumentasi.
4. Masuk menggunakan akun administrator aplikasi. Tahap ini menolak akses API dari operator karena pemetaan izin rig per pengguna belum tersedia. Akun layanan PROTECT dibagi pada sisi server; jangan memperluas akses tanpa pemetaan izin.
5. Buka AI Inspeksi Visual, Ctrl+F5, lalu tanyakan `Daftar kode rig`. Pilih kode dari respons dan tanyakan `Equipment mana yang NOT_READY di rig KODE?`, kemudian `Jelaskan detail temuan rig KODE`.
6. Buka tombol sumber berwarna biru. Status equipment dan rincian inspection ID tampil dalam pop-up. Respons API bukan PDF dan tidak memiliki nomor halaman PDF.

## Cara kerja dan cakupan awal

- Login dan token dipakai di server; token hanya disimpan dalam memori sampai mendekati masa kedaluwarsa. Saat kedaluwarsa proses melakukan login lagi menggunakan Secret. Endpoint refresh belum digunakan karena request lengkapnya belum ada dalam koleksi. Kegagalan login/401 diberi jeda 5 menit untuk mengurangi risiko penguncian akun. Bila Secret diubah, restart rollout aplikasi.
- MFA tidak dilewati. Jika respons meminta MFA, konektor berhenti dan menyampaikan bahwa perlu alur resmi penyedia.
- Daftar rig dibaca melalui `GetRigs`. Pertanyaan status memerlukan satu rig yang cocok. Endpoint equipment tanpa kode rig adalah daftar master, bukan status agregat semua rig, sehingga tidak digunakan untuk menyimpulkan kondisi seluruh rig.
- `GetEquipmentStatus?rigCode=...` dibaca ulang pada setiap pertanyaan; tidak ada salinan data API yang ditulis ke dataset/PVC. Token login saja yang digunakan ulang. Ini bukan sinkronisasi terjadwal tiap 15 menit.
- Detail temuan menggunakan maksimal 30 entri `GetSubmissionHistory`, memilih inspeksi terbaru per peran (maksimal 7), kemudian `GetSubmissionHistoryDetail`. Detail bisa memiliki waktu berbeda dari snapshot equipment. Catatan menjelaskan batas cakupannya; hasil bukan seluruh arsip historis.
- Pemilihan periode/tanggal belum didukung. Permintaan tanggal/kemarin ditolak secara jelas, bukan dijawab dengan snapshot terbaru.
- Sumber LLM hanya menerima kode rig, status equipment, peran, waktu/ID inspeksi dan catatan temuan yang relevan. Username/password/token, daftar pengguna, submitter dan file foto tidak dikirim ke LLM melalui konektor ini.
- `ReadFile` dan foto API belum diunduh/dianalisis oleh konektor ini. Fitur foto dan PDF lama tetap terpisah. Tidak ada klaim diagnosis foto dari teks status.
- Hitungan status berasal dari seluruh respons equipment. Konteks LLM dibatasi 80 equipment dan 28.000 karakter; respons besar diberi ringkasan deterministik. PDF tidak digunakan sebagai fallback ketika API aktif dan gagal.

## Pengujian dan pemulihan

Tes menggunakan respons sintetis, tidak memakai password/token/data produksi: `node --test scripts/protect-chat-source.test.js scripts/protect-api-check.test.cjs scripts/pdf-hub.test.js`.

Pengguna sudah membuktikan Login dan GetRigs HTTP 200 dari pod, dengan 67 rig pada respons. GetEquipmentStatus dan GetSubmissionHistoryDetail konektor baru tetap harus diuji di staging dengan akun dan rig yang diizinkan.

Untuk kembali ke sumber PDF, ubah `PROTECT_API_ENABLED=0`, simpan dan tunggu rollout. Dataset PDF yang sudah ada tidak dihapus. Pengunduhan PDF otomatis dari URL halaman PROTECT tetap membutuhkan autentikasi tersendiri; flag ini tidak membuat sesi login browser tersedia pada crawler PDF.
