# Microinteraction aplikasi dan chatbot

Pembaruan ini menambahkan respons tekan pada tombol, glow hover, fokus keyboard, dan efek terangkat pada kartu yang memiliki aksi. Area kamera, canvas anotasi, dan formulir tetap stabil.

Skeleton shimmer menggantikan placeholder pemuatan pada navigasi halaman, foto anotasi, konfigurasi sumber PDF, pustaka laporan, galeri kurasi, pilihan dataset, kelompok PDF, dan riwayat evaluasi. Status kemajuan analisis, impor, dan pelatihan tetap terlihat.

Chatbot menampilkan transisi panel/pesan serta skeleton selama menunggu respons. Indikator dibersihkan pada sukses maupun gagal. Fitur koreksi jawaban, ID diagnostik, serta ekspor diagnostik admin tetap tersedia.

Hover digunakan pada perangkat dengan kursor. Respons tekan tersedia di layar sentuh. Pengaturan prefers-reduced-motion menonaktifkan gerakan dan shimmer. Label pemuatan tetap tersedia untuk pembaca layar.

Implementasi: public/microinteractions.css dan public/microinteractions.js, dimuat dari public/index.html sebelum modul aplikasi. Tidak ada dependensi baru.

Validasi: seluruh JavaScript frontend lolos pemeriksaan sintaks; 60 tes kamera, chatbot, diagnostik, sumber laporan PDF, VLM, dan llm-bridge lulus. Uji browser lokal sebelumnya mencakup login, dashboard, dan respons chatbot pada dataset kosong. Uji produksi dengan data privat dan model perusahaan tetap diperlukan.
