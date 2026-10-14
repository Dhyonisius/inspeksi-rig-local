# Inspeksi Rig Lokal

Aplikasi inspeksi visual berbahasa Indonesia untuk foto rig, menggunakan model visi Ollama pada perangkat lokal dan SQL Server Express.

## Fitur

- Pemeriksaan foto dari file atau kamera dengan model visi lokal.
- Deskripsi serta indikasi visual awal, koreksi label, dan riwayat pemeriksaan.
- Impor foto PDF privat, kurasi, anotasi kotak, dan verifikasi contoh rig.
- Pemisahan kelompok foto untuk TRAIN, VALIDATION, dan TEST.
- Pelatihan, evaluasi, dan percobaan detektor bahaya rig lokal.
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

## Batasan

Hasil AI adalah indikasi visual awal, bukan keputusan kelayakan operasi. Usulan AI tidak otomatis terverifikasi. Foto yang buram atau tidak cukup jelas perlu ditinjau. Contoh terverifikasi dapat membantu Gemma, tetapi tidak mengubah bobot Gemma. Pelatihan model rig dilakukan terpisah setelah data siap.

Akun demonstrasi yang dibuat skema adalah data contoh untuk penggunaan lokal. Ganti atau nonaktifkan akun demo sebelum penggunaan di luar lingkungan demonstrasi. Aplikasi mendengarkan hanya pada localhost.
