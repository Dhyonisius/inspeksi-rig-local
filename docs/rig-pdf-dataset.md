# PDF rig dan calon pelatihan

Sumber yang disetujui pengguna: folder Protect pada Magang, Pertamina Batch 9. Lima PDF laporan CRSSC tanggal 5 Oktober 2026 telah diekstrak secara lokal. PDF sumber dipertahankan.

| Rig | Halaman | Foto unik baru | Kemunculan duplikat |
|---|---:|---:|---:|
| AU-15 | 69 | 98 | 40 |
| BDSI-19 | 55 | 104 | 2 |
| BMS-05 | 61 | 120 | 0 |
| BMS-20 | 55 | 103 | 17 |
| GW-363 | 55 | 111 | 1 |
| Total | 295 | 536 | 60 |

536 foto unik disiapkan pada `data/private/rig-pdf/prepared`. Manifest menyimpan checksum foto dan PDF, asal rig, halaman, indeks gambar, ukuran, dan teks halaman sekitar. Duplikat berdasarkan piksel digabung beserta seluruh kemunculannya. Ekstraksi tanpa error. Sebagian foto memperlihatkan tulisan “BELUM DI GUNAKAN”, bukan komponen yang hendak diperiksa. Foto tersebut perlu dinilai kegunaannya oleh kurator.

Status checklist “complete” adalah konteks laporan, bukan label keselamatan gambar. Semua foto masuk sebagai `UNCERTAIN` dan `DRAFT`. Izin penggunaan internal dan isi label harus dikonfirmasi pada dialog tinjauan. Foto belum ditinjau tidak dapat diverifikasi. Lisensi internal ini adalah pernyataan pengguna, bukan verifikasi hak dari penerbit.

## Menggunakan aplikasi

Dialog **Tinjau contoh pelatihan** kini mengisi area dan deskripsi awal berdasarkan posisi item checklist/caption foto di PDF, serta menyertakan deskripsi AI yang sudah tersedia. Pengguna tetap crosscheck dan menyimpan sendiri; isian yang pernah diperiksa tidak ditimpa. [Panduan isian awal](isian-awal-tinjauan-pdf.md) menjelaskan penanganan foto yang memiliki beberapa konteks asal.

1. Jalankan ulang `start-local.cmd` menggunakan akun Windows yang memiliki akses SQL Server. Migrasi `sql/rig-dataset.sql` dijalankan setelah migrasi yang sudah ada. Setelah database siap, server memasukkan foto PDF yang telah disiapkan ke dataset **Rig Protect - calon pelatihan** secara bertahap. Progres terlihat pada Dataset foto → Buka calon pelatihan.
2. Buka **Tinjau foto**, kemudian **Tinjau calon pelatihan** pada kartu. Periksa foto, baca asal PDF, tentukan label, isi deskripsi, dan gambar kotak jika labelnya berbahaya. Konfirmasi izin penggunaan, lalu simpan.
3. Setelah tinjauan, tekan **Verifikasi label**. Untuk foto tidak jelas, gunakan Belum pasti; foto ini dikecualikan dari paket YOLO agar tidak menjadi contoh negatif yang keliru.
4. Pada halaman PDF rig, admin mengatur pembagian **Latih / Validasi / Uji** per kelompok dokumen. Seluruh foto satu kelompok berubah bersama. Dokumen yang berbagi foto identik digabung menjadi satu kelompok. Pembagian awal seluruhnya TRAIN; tentukan kelompok validasi dan uji sebelum evaluasi.
5. Setelah label terverifikasi dan izin lengkap, ajukan tinjauan, setujui dataset, lalu ekspor JSONL atau YOLO. Paket mempertahankan metadata sumber dan pembagian kelompok.
6. Foto pemeriksaan baru dapat ditambahkan lewat **Tandai calon pelatihan** pada detail pemeriksaan. Pilih dataset Draft dan konfirmasi izin foto. Label awal selalu Belum pasti, dengan hasil AI sebelumnya hanya sebagai sumber. Tinjau sebelum verifikasi.

## Pelatihan dan batasan

### Anotasi awal lokal

`scripts/annotate-rig-drafts.py` memproses 536 foto secara berurutan memakai `gemma3:4b`, dengan salinan maksimal 768 piksel dan jeda tiga detik antarfoto. Hasil disimpan privat di `data/private/rig-pdf/ai-drafts`, per checksum foto. Dataset SQL, izin penggunaan, status REVIEWED/VERIFIED, dan bobot model tidak diubah oleh pekerja ini.

Halaman PDF rig menampilkan progresnya. Dialog **Tinjau calon pelatihan** mengisi usulan label, deskripsi, serta kotak jika model memberikan lokasi yang valid. Kotak model adalah perkiraan dan harus diperiksa. Hasil tanpa kotak valid tetapi diklaim RISK diturunkan menjadi UNCERTAIN. Hasil AI tidak membuktikan foto aman. Setelah pengguna memeriksa dan menyimpan, alur tinjauan/verifikasi biasa berlaku. Admin dapat mengembalikan dataset REVIEW ke Draft untuk koreksi; dataset APPROVED tidak dapat dibuka ulang melalui tombol tersebut.

Pekerja melanjutkan hasil yang tersimpan bila dijalankan ulang; checksum gambar dan versi model/prompt dicatat. Jika aplikasi ditutup, proses Python tetap berjalan selama komputer menyala. Untuk menjeda, buat berkas kosong `data/private/rig-pdf/ai-drafts/STOP`; proses berhenti setelah foto aktif selesai. Untuk melanjutkan, hapus berkas STOP lalu jalankan skrip Python tersebut kembali. Jangan menghapus worker.lock selama proses Python masih aktif. Foto yang gagal dicatat di errors.jsonl dan dapat dicoba ulang pada run berikutnya. Waktu seluruh batch dapat beberapa jam sesuai kecepatan laptop; proses ini bukan pelatihan model.

Tahap ini menyediakan data dan alur kurasi. Gemma tetap memakai bobot Ollama yang terpasang. Belum ada model rig baru yang dilatih atau diaktifkan. Model detektor berikutnya memerlukan kelas yang jelas, kotak konsisten, contoh kondisi normal/bahaya, serta evaluasi pada kelompok rig yang terpisah. Jumlah 536 foto belum membuktikan bahwa setiap kelas memiliki contoh memadai. Checklist maupun tanda centang tidak dipakai sebagai label otomatis.

Area RIG dan kategori awal indikasi selang rusak, kebocoran, pelindung rusak, serta kabel/sling rusak ditambahkan untuk pemeriksaan berikutnya. Penilaian tekanan, kekuatan sling, pengencangan baut, atau kelayakan operasi tidak dapat dipastikan dari foto. Katalog visi disaring sesuai jenis area agar kategori rig tidak memenuhi prompt pemeriksaan kantor.

Impor berulang menggunakan checkpoint dan checksum. Dataset yang sudah dihapus admin tidak dibuat kembali saat restart. SQL yang hasil commit-nya tidak terkonfirmasi mempertahankan berkas calon sampai pemeriksaan ulang. Foto asli PDF tetap tersedia; foto hasil ekstraksi disimpan privat. Pipeline berjalan lokal, tanpa mengirim laporan atau foto ke cloud.

Backup kode sebelum perubahan PDF berada pada `outputs/backups/sistem-inspeksi-k3-sebelum-pdf-rig-20261007-105024`. Backup ini berisi kode, SQL, dan dokumentasi; database SQL eksternal tidak termasuk.
