# Pembaruan chatbot inspeksi rig — 5 November 2026

Cakupan: tampilan halaman AI Inspeksi Visual, pembacaan teks PDF dan percakapan Qwen. Login, database, pengambilan PDF, retensi, vision dan pelatihan VLM tetap memakai alur aplikasi yang sudah ada.

## Perubahan

- Percakapan memakai `qwen3:4b-instruct` melalui Ollama. Atur `INSPECTION_CHAT_MODEL` jika tag yang tersedia berbeda. Model Qwen ini menerima teks, bukan foto. Model vision lama tetap diperlukan untuk analisis foto.
- Instruksi berfokus pada equipment, temuan, tindakan tertulis, sumber rig/halaman, dan membedakan RECORDED dari kesimpulan aman.
- PDF teks tanpa foto dapat diimpor. Nomor halaman dan teks disimpan saat ekstraksi baru. Laporan lama tetap terbaca dari teks/item yang sudah tersimpan; rincian halaman lama mungkin memerlukan impor ulang.
- Pencarian konteks melihat seluruh potongan teks yang tersimpan, memilih bagian relevan dengan batas ukuran. Ini bukan jaminan seluruh PDF masuk ke konteks sekaligus.
- Chat memiliki balas, penilaian polos, tombol chat terbaru, dan pop-up rincian sumber. Penilaian disimpan per pengguna dalam `data/private/pdf-hub/feedback-*.json`, maksimal 500 entri per pengguna. Penilaian bukan pelatihan ulang otomatis. Percakapan UI hanya bertahan selama halaman terpasang.
- PDF scan tanpa teks belum otomatis di-OCR satu halaman penuh. OCR foto yang sudah ada tetap berfungsi; Qwen tidak menyimpulkan gambar secara langsung.

## File runtime yang perlu diperbarui

1. `scripts/pdf-hub.js`
2. `scripts/inspection-chat-context.js` (baru, wajib disalin)
3. `scripts/extract-report-library.py`
4. `public/inspection-ai-ui.js`
5. `public/inspection-ai.css`

Tidak ada migrasi SQL dan tidak perlu mengganti `server.js`. Jangan menimpa folder `data`, model vision, sertifikat, atau konfigurasi perusahaan dengan folder dari laptop.

## Persiapan server perusahaan

1. Cocokkan versi sumber aplikasi di server dengan basis lokal ini. Jika berbeda, tinjau diff kelima file, jangan langsung menimpa kode perusahaan.
2. Cadangkan kelima file lama serta konfigurasi layanan yang relevan. Catat nilai `INSPECTION_CHAT_MODEL` sebelumnya untuk rollback.
3. Pada host/container Ollama yang digunakan aplikasi, pastikan `ollama list` menampilkan `qwen3:4b-instruct`. Jika belum, administrator menjalankan `ollama pull qwen3:4b-instruct`.
4. Pada konfigurasi environment layanan aplikasi, set `INSPECTION_CHAT_MODEL=qwen3:4b-instruct`. Pertahankan `OLLAMA_BASE_URL` sesuai jaringan server; localhost container dapat berbeda dari localhost host. Jangan membuka Ollama ke internet.
5. Pasang lima file runtime. Pertahankan `PYTHON_EXE` dan dependensi dari `deploy/container/requirements.txt`. Tidak ada dependensi baru pada pembaruan ini.
6. Restart layanan aplikasi dengan mekanisme yang memang digunakan perusahaan (systemd, container, atau Windows service). Refresh browser dengan Ctrl+F5.
7. Uji lewat akun yang berwenang: impor satu PDF teks yang sudah diizinkan pada `PDF_SOURCE_ALLOWED_HOSTS`, tanyakan satu temuan yang diketahui, cocokkan rig/halaman, buka rincian sumber, balas jawaban, dan berikan penilaian. Uji juga PDF tanpa teks agar tidak diberi jawaban rekaan. Periksa fitur foto melalui model vision lama.

Host sumber PDF tetap mengikuti allowlist yang dikelola administrator. Jangan menambahkan wildcard atau mengubah otorisasi hanya untuk melewati kegagalan akses.

## Validasi lokal

`node --test scripts/inspection-chat-context.test.js scripts/pdf-hub.test.js scripts/inspection-warnings.test.js scripts/vlm-learning.test.js`

23 pemeriksaan lulus: impor PDF teks, pembaruan laporan, konteks halaman panjang, request Qwen tanpa gambar, riwayat/reply, feedback, batas host dan peran, scheduler, deduplikasi, retensi, peringatan dan VLM lama.

Uji Qwen nyata dengan laporan sintetis menyebut Mud Pump NOT_READY, seal bocor, perlu diperbaiki, dan halaman 2; tidak menilai Accumulator aman dari RECORDED. Pengujian browser dilakukan pada pratinjau lokal dengan data sintetis; login/database/server perusahaan belum diuji pada pembaruan ini.

## Rollback

Hentikan layanan dengan mekanisme normal, kembalikan file runtime cadangan dan nilai environment lama, lalu mulai ulang. Data inspeksi tidak perlu dihapus. Modul baru `inspection-chat-context.js` boleh tetap tersimpan karena tidak dimuat oleh versi lama.
