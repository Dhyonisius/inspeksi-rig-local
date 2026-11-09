# Diagnostik dan koreksi chatbot inspeksi

Tidak membutuhkan GPU. Ini adalah pengumpulan contoh untuk evaluasi dan perbaikan prompt/kode, bukan fine-tuning atau perubahan bobot model internal.

## Deploy

Build dari commit terbaru main, terapkan image hasil build pada app dan init container aplikasi, tunggu Ready 1/1, lalu Ctrl+F5. Tidak ada environment baru atau migrasi SQL. Pertahankan koneksi LLM, PROTECT dan vision yang sudah bekerja. Data disimpan di privateDir/pdf-hub pada volume data aplikasi yang sudah ada; pastikan direktori ini persisten dan tidak dipublikasikan.

## Penggunaan admin

1. Tanyakan contoh nyata di popup atau halaman chat. Pencatatan dimulai setelah versi ini terpasang; percakapan lama tidak direkonstruksi.
2. Klik Koreksi pada jawaban dan tulis jawaban yang diharapkan, lalu Simpan koreksi. Penilaian down tersimpan bersama koreksi. Tombol jempol tetap tersedia.
3. Klik Diagnostik. Klik Buat pratinjau untuk metadata saja (model, engine, durasi, jumlah/jenis sumber, status dan kategori kegagalan).
4. Jika diperlukan dan diizinkan perusahaan, centang Sertakan percakapan, koreksi dan cuplikan fakta sumber. Buat ulang pratinjau. Ini menyertakan pertanyaan/jawaban, maksimal delapan pesan konteks, reply, koreksi, notice, dan cuplikan sumber terstruktur yang dikembalikan chat, bukan seluruh PDF/API. Snapshot dibatasi lima sumber, 80 equipment per sumber, tujuh detail inspeksi dan 30 item per detail. Data terpotong bukan seluruh sumber.
5. Baca dan sunting JSON untuk menyamarkan informasi sebelum menekan Unduh JSON yang ditinjau. Tidak ada pengiriman otomatis ke WhatsApp, GitHub atau layanan eksternal. Transfer hanya melalui kanal yang diizinkan lalu unggah ke percakapan bantuan. Jangan commit diagnostik perusahaan ke GitHub public.

Ekspor hanya milik akun admin yang sedang login, bukan seluruh pengguna. Operator tidak dapat mengekspor dan percakapannya tidak dicatat oleh diagnostik ini. Maksimal 100 entri, entri berusia lebih dari 30 hari dikeluarkan saat dibaca dan dibersihkan pada penulisan berikutnya; ini bukan penghapusan terjadwal tepat pada hari ke-30. Koreksi hanya mengubah catatan evaluasi, tidak otomatis disisipkan ke prompt berikutnya.

Tidak mengumpulkan environment, Secret, cookie, header, foto, dokumen mentah, atau body error upstream. Pola Bearer/JWT/password/api-key umum disamarkan; penyamaran bukan jaminan semua rahasia, nama dan informasi operasional terdeteksi. Wajib tinjau pratinjau. Error yang dilempar jalur chat dicatat sebagai kategori umum dan HTTP status bila tersedia, tanpa stack/isi error. Kegagalan yang sudah ditangani konektor dapat muncul melalui notice jawaban. Jika disk gagal ditulis, jawaban tetap dikirim tetapi mungkin tidak memiliki ID/koreksi diagnostik.

## Perbaikan berikutnya

Gunakan pertanyaan + jawaban salah + koreksi + fakta sumber untuk membuat tes sintetis, memperbaiki pengambilan konteks atau prompt, kemudian jalankan regresi dan deploy image baru. Koreksi manusia perlu diverifikasi terhadap sumber sebelum menjadi contoh pelatihan. Jangan menganggap jempol bawah sebagai jawaban benar.

Tes: node --test scripts/chat-diagnostics.test.js (juga diimpor suite pdf-hub yang berjalan di CI).
