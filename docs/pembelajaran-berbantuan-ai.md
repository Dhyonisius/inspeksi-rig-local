# Pembelajaran foto berbantuan AI

Halaman **Belajar dari foto** menyatukan unggah banyak foto, pembuatan usulan, antrean koreksi, verifikasi, dan akses pelatihan. Foto dan model tetap diproses lokal.

## Alur penggunaan

1. Tekan **Tambah foto**, pilih dataset Draft, area, dan kelompok pengambilan. Pilih maksimal 50 foto, masing-masing maksimal 8 MB. Foto dari satu kejadian tetap memakai kelompok yang sama.
2. Biarkan **Buat usulan AI setelah foto tersimpan** aktif untuk memproses foto baru. Untuk foto yang sudah ada, pilih kartu atau **Pilih foto halaman ini**, lalu tekan **Buat usulan untuk pilihan**. Foto tanpa area ditinjau satu per satu terlebih dahulu.
3. Proses berjalan bergantian, menampilkan kemajuan, dan dapat dihentikan. Usulan yang sudah selesai tetap tersimpan. Saat aplikasi dimulai ulang, proses yang belum selesai ditandai terhenti; foto yang belum berhasil dapat dipilih kembali.
4. Buka **Periksa usulan**. Pada satu foto tanpa usulan, gunakan **Buat usulan AI**, lalu **Terapkan usulan**. Penerapan mengganti isian label, deskripsi, dan kotak di formulir; tidak menyimpan label manusia.
5. Gunakan **Geser / ubah ukuran** untuk menggeser kotak atau menarik sudut kanan bawahnya. Kategori kotak dapat diganti lewat pilihan di bawah foto. **Atur posisi dengan angka** menyediakan koreksi tanpa mouse. Gunakan **Gambar kotak** untuk menambah kotak, atau hapus kotak yang keliru.
6. Periksa deskripsi dan label, konfirmasikan izin penggunaan foto, lalu **Simpan label**. Hasil masuk **Menunggu verifikasi**. Verifikasi tetap dilakukan setelah manusia meninjau hasil.
7. Buka panel **Latih dan evaluasi model rig** setelah dataset disetujui serta kelompok TRAIN, VALIDATION, dan TEST tersedia. Aplikasi tetap memeriksa kelengkapan label, izin, dan pemisahan kelompok.

## Metode usulan

| Metode di UI | Perilaku |
|---|---|
| Gemma + model rig bila tersedia | VLM membaca kondisi foto. YOLO rig yang telah dipilih membantu lokasi hanya pada kategori dan wilayah yang disepakati kedua model. Bila model rig belum tersedia atau belum meliputi area terkait, VLM tetap dapat digunakan. |
| Gemma · tanpa pelatihan baru | VLM membuat usulan langsung dari foto dan katalog area. Tidak perlu melatih model proyek terlebih dahulu. |
| Model rig · usulan kotak | Pseudo-labeling dari model rig terlatih. Pilihan aktif setelah model rig dipilih. Tidak ada deteksi menghasilkan Belum yakin, bukan label aman. |

Usulan YOLO tidak pernah langsung menjadi label VERIFIED atau masuk training tanpa tinjauan manusia. Kotak AI yang tidak berada dalam gambar, kategori tidak dikenal, atau skor terlalu rendah dikeluarkan. RISK tanpa kotak valid menjadi UNCERTAIN. Batas skor ini adalah aturan penyaringan awal dan belum merupakan kalibrasi probabilitas kebenaran.

Jika AI menyatakan tidak tampak bahaya atau belum yakin tetapi tetap mengirim kotak bahaya, aplikasi menandai usulan sebagai **Belum yakin**. Label asli model dan alasan pertentangan dipertahankan untuk tinjauan. Alasan ditampilkan saat melihat/menerapkan usulan dan mendapat prioritas tinggi di antrean. Instruksi usulan versi `rig-proposal-on-demand-2` meminta kotak kosong untuk label tanpa bahaya atau ragu serta membedakan bukti visual dari dugaan fungsi alat.

## Urutan prioritas

Antrean mendahulukan perbedaan hasil Gemma–YOLO, jawaban ragu, kotak yang perlu pemeriksaan teliti, dan kategori dengan sedikit kotak TRAIN terverifikasi. Area yang belum memiliki contoh juga mendapat tambahan prioritas. Foto satu kelompok diselingi ketika nilai prioritas sama. Pencarian nama, filter area, serta urutan terbaru tetap tersedia.

Ini merupakan pemilihan sampel untuk active learning: manusia memberi perhatian pada contoh yang paling membantu pengembangan model. Pengurutan tidak melatih bobot model secara otomatis.

## Penyimpanan dan perlindungan label

- Usulan baru disimpan terpisah pada `dbo.DatasetAiProposal`, mencatat item, checksum foto, area, metode, model, waktu, prioritas, dan isi usulan. Usulan lama dari skrip PDF tetap dapat dibaca bila belum ada usulan baru.
- Label manusia berada pada tabel DatasetItem/Annotation. Membuat usulan tidak mengubahnya. Status foto dicek kembali setelah inferensi agar tinjauan manusia, pengecualian foto, atau persetujuan dataset yang terjadi selama AI bekerja tetap dihormati.
- Pekerjaan banyak foto dijurnal pada `data/private/annotation-jobs`. Akses mengikuti pemilik proses; admin dapat mengelola proses pengguna.
- Saat startup, area PDF yang kosong dapat diisi dari konteks dokumen yang cocok dengan checksum manifest dan menunjuk satu area yang tidak ambigu. Ini hanya isian awal area, tidak mengubah label, deskripsi manusia, atau status verifikasi. Konteks ambigu tetap perlu dipilih manusia.
- Foto VALIDATION/TEST tidak digunakan sebagai contoh visual Gemma. Pseudo-labeling tidak melewati persyaratan dataset APPROVED dan label VERIFIED untuk training.

## Penyederhanaan tampilan

Panel pelatihan dilipat agar pekerjaan sehari-hari berpusat pada antrean label. Ringkasan kesiapan yang berulang digabung ke panel pelatihan. Pemilih model scan yang hanya memiliki satu opsi dilepas. Skrip halaman belajar lama diganti dengan alur baru. Foto, riwayat, hasil tinjauan, dan model yang sudah tersimpan dipertahankan.

Grounding DINO tidak dipasang pada pembaruan ini. Alur zero-shot menggunakan VLM yang sudah tersedia; ketelitian kotak dapat dibantu YOLO rig setelah data siap. Menambahkan detektor teks baru memerlukan pengujian manfaat dan beban perangkat tersendiri. Pembaruan ini tidak menambahkan inspeksi video, pelacakan identitas objek, atau menu chat.

## Batas validasi

Tes otomatis memeriksa gabungan model, prioritas, pembatalan, perlindungan label, dan kegagalan AI. Tes browser memeriksa unggah banyak foto, pilihan batch, koreksi kotak, penyimpanan, serta ukuran desktop/ponsel. Uji satu foto nyata memastikan alur lokal bekerja, tetapi tidak mengukur akurasi dataset. Evaluasi akurasi memerlukan label test terverifikasi dan kelompok terpisah.
