# Inspeksi Rig Lokal

## Panduan menjalankan

**[Buka Panduan Menjalankan](PANDUAN-MENJALANKAN.md)** — gambaran proyek, langkah menjalankan dari GitHub pada Windows, konfigurasi SQL/Ollama, checklist pengujian, dan jalur deployment OpenShift.

Panduan dapat dibaca langsung di GitHub. Untuk memakai aplikasi, jalankan server beserta layanan pendukung pada perangkat penguji atau lingkungan perusahaan.

## Deployment OpenShift perusahaan

Mulai dari **[Panduan Deploy OpenShift Perusahaan](PANDUAN-DEPLOY-OPENSHIFT-PERUSAHAAN.md)** untuk menempatkan aplikasi dan SQL Server dalam satu project. Panduan memuat langkah console untuk dua PVC, Secret, TLS SQL, build Dockerfile, bootstrap admin, dan Route HTTPS. Paket belum diterapkan atau diuji di cluster perusahaan. Untuk SQL yang sudah dikelola di luar project, gunakan [panduan SQL eksternal](docs/deploy-openshift.md).

Menu **AI Inspeksi Visual** kini mencakup pengambilan dataset PDF dan kartu peralatan **NOT_READY / perlu diganti** berdasarkan laporan terbaru per rig. Baca [alur dataset PDF dan percobaan VLM](PANDUAN-ALUR-DATA-DAN-VLM.md). Trainer percobaan tidak diaktifkan pada build perusahaan dasar.

Alur terbaru: unggah banyak foto, usulan AI, koreksi kotak, antrean prioritas, dan model rig sebagai pendamping Gemma. Lihat [panduan pembelajaran berbantuan AI](docs/pembelajaran-berbantuan-ai.md).

Aplikasi inspeksi visual berbahasa Indonesia untuk foto rig, menggunakan model visi Ollama pada perangkat lokal dan SQL Server Express.

## Fitur

- Pemeriksaan foto dari file atau kamera dengan model visi lokal.
- Deskripsi serta indikasi visual awal, koreksi label, dan riwayat pemeriksaan.
- Impor foto PDF privat, kurasi, anotasi kotak, dan verifikasi contoh rig.
- Pemisahan kelompok foto untuk TRAIN, VALIDATION, dan TEST.
- Pelatihan, evaluasi, dan percobaan detektor bahaya rig lokal.
- Usulan label, deskripsi, dan kotak dari AI untuk foto calon pelatihan yang belum ditinjau.
- Autentikasi pengguna/admin dan penghapusan data dengan konfirmasi.

## Menjalankan pada laptop asal

Di PowerShell pada folder proyek:

```powershell
.\start-local.cmd
```

Buka alamat localhost yang dicetak dan biarkan terminal tetap terbuka. Peluncur memakai runtime Node/Python yang sudah tersedia pada laptop asal, SQLCMD, SQL Server Express, serta Ollama.

## Menjalankan pada instalasi lain

Sediakan Node.js, Python dengan dependensi yang digunakan skrip, SQLCMD, SQL Server Express dengan Windows Authentication, dan Ollama dengan model visi. Atur variabel lingkungan `PYTHON_EXE`, `SQLCMD_EXE`, `SQL_SERVER`, serta `PORT` sesuai instalasi, lalu jalankan `node server.js`. Server menjalankan migrasi SQL saat startup. Pelatihan detektor memerlukan lingkungan Python tersendiri yang ditunjuk `RIG_TRAINING_PYTHON_EXE` dan model awal lokal; paket model tidak disertakan.

Repository hanya memuat kode, skema database dan aset UI. Foto inspeksi, PDF privat, isi database, hasil anotasi/evaluasi, model AI, log, dan backup tidak disertakan. Salinan baru tidak memiliki dataset atau riwayat laptop asal. Font dan ikon menyertakan lisensi sumbernya pada `public/ads`.

## Membuat usulan label AI

Pada **Belajar dari foto**, buka **Periksa foto** untuk calon pelatihan yang belum ditinjau pada dataset Draft. Pilih area lalu tekan **Buat usulan AI**. Ollama lokal dengan model vision harus tersedia; proses dapat memerlukan hingga tiga menit. Usulan disimpan terpisah dari label manusia pada `data/private/rig-pdf/ai-drafts`.

Tekan **Terapkan usulan** untuk mengisi label, deskripsi, dan kotak di formulir. Tindakan ini mengganti isian formulir saat ini. Periksa foto, koreksi deskripsi atau label, dan hapus/gambar ulang kotak yang keliru sebelum menyimpan. Jika area berubah, buat usulan baru untuk area tersebut. Simpan hasil tinjauan lalu verifikasi melalui alur yang sudah tersedia. Membuat atau menerapkan usulan tidak memverifikasi label dan tidak melatih model. Jika AI tidak tersedia, formulir tetap dapat diisi manual.

## Batasan

Hasil AI adalah indikasi visual awal, bukan keputusan kelayakan operasi. Usulan AI tidak otomatis terverifikasi. Foto yang buram atau tidak cukup jelas perlu ditinjau. Contoh terverifikasi dapat membantu Gemma, tetapi tidak mengubah bobot Gemma. Pelatihan model rig dilakukan terpisah setelah data siap.

Akun demonstrasi yang dibuat skema adalah data contoh untuk penggunaan lokal. Ganti atau nonaktifkan akun demo sebelum penggunaan di luar lingkungan demonstrasi. Aplikasi mendengarkan hanya pada localhost.
