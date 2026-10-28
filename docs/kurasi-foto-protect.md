# Kurasi foto Protect sebelum pelatihan

Menu utama **Kurasi foto Protect** memisahkan foto hasil impor PDF dari antrean pembelajaran. Pembaruan ini menyediakan fitur seleksi; tidak memilih, mengecualikan, atau menghapus foto secara otomatis.

## Memilih foto yang dipakai

1. Buka **Kurasi foto Protect**, pilih dataset.
2. Gunakan filter rig, PDF asal, halaman PDF, dan nama foto. Filter asal memeriksa seluruh kemunculan foto, termasuk foto yang muncul pada beberapa PDF.
3. Tekan gambar untuk melihat foto penuh. Buka Asal PDF untuk memeriksa halaman sumbernya.
4. Centang foto satu per satu, atau **Pilih semua di halaman ini** (maksimal 24 foto pada satu halaman). Pilihan dibersihkan saat filter, halaman, atau dataset berubah.
5. Pilih alasan pengecualian, misalnya foto dokumen, kondisi alat tidak terlihat, foto buram, atau foto berulang. Catatan tambahan tersedia untuk penjelasan.
6. Tekan **Pindahkan ke Dikecualikan**. Foto dan label lama tetap tersimpan.
7. Foto yang masih Dipakai dapat dilanjutkan pada **Belajar dari foto → Periksa foto**.

Foto yang dikecualikan tidak muncul pada antrean belajar maupun daftar foto dataset biasa, tidak menjadi contoh visual Gemma, dan tidak masuk snapshot ekspor, evaluasi baru, atau pelatihan YOLO. Persetujuan dataset dan angka kesiapan menghitung hanya foto yang dipakai. Snapshot evaluasi/model yang dibuat sebelumnya tetap dipertahankan.

## Mengembalikan foto

1. Pilih tab **Dikecualikan**.
2. Centang foto yang ingin dipakai kembali.
3. Tekan **Kembalikan ke Dipakai**. Label, anotasi, dan status verifikasi sebelumnya tetap ada.

Perubahan kurasi hanya tersedia pada dataset **Draft**. Dataset Tinjauan dapat dikembalikan ke Draft oleh admin melalui pengelolaan dataset sebelum dikurasi. Dataset Disetujui dibekukan untuk menjaga acuan pelatihan dan evaluasi.

## Menghapus foto permanen

Penghapusan hanya tersedia untuk admin. Pengguna/operator dapat mengecualikan dan memulihkan foto.

1. Pindahkan foto yang tidak diperlukan ke **Dikecualikan** dan periksa terlebih dahulu.
2. Pada tab Dikecualikan, centang foto yang ingin dihapus.
3. Tekan **Hapus permanen pilihan** untuk melihat daftar nama foto serta jumlah berkas yang masih dipakai di tempat lain.
4. Ketik konfirmasi yang ditampilkan, misalnya **HAPUS 3 FOTO**, lalu centang pernyataan bahwa daftar telah diperiksa.
5. Tekan tombol penghapusan pada dialog untuk menyelesaikan tindakan. **Batal** menutup dialog tanpa menghapus.

Penghapusan menghilangkan item dan anotasinya dari dataset Protect. Berkas unggahan dan salinan hasil ekstraksi di folder privat dibersihkan hanya setelah transaksi database terkonfirmasi dan aset tidak memiliki referensi dataset, pemeriksaan, atau evaluasi lain. Foto yang masih dipakai di tempat lain dipertahankan. Lokasi penyimpanan dan checksum salinan ekstraksi diperiksa sebelum penghapusan berkas; PDF asli tidak dihapus.

Jika transaksi belum dapat dikonfirmasi, aplikasi tidak menghapus berkas. Jika pembersihan berkas gagal setelah transaksi berhasil, pesan menjelaskan bahwa item dataset telah dihapus tetapi ada berkas yang belum dibersihkan. Catatan checksum penghapusan mencegah impor PDF yang dilanjutkan memasukkan foto itu kembali secara otomatis.

## Penyimpanan dan API

- Kolom `DatasetItem.is_excluded`, `exclusion_reason`, `excluded_at`, dan `excluded_by_user_id` menyimpan keputusan kurasi.
- `RigPdfItemSuppression` menyimpan checksum serta audit asal foto yang dihapus dari dataset Protect.
- Tindakan mengecualikan, memulihkan, dan menghapus dicatat pada `AuditEvent`.
- Proses kurasi menunggu ekspor/persiapan evaluasi/peninjauan yang sedang memakai dataset. Impor PDF yang belum selesai dan evaluasi aktif menghalangi perubahan.

| Metode | Endpoint | Fungsi |
| --- | --- | --- |
| GET | `/api/protect-curation` | Daftar dataset hasil impor PDF |
| GET | `/api/protect-curation/{dataset_id}` | Galeri, statistik, filter sumber, dan paginasi |
| PATCH | `/api/protect-curation/{dataset_id}/selection` | `item_ids`, `excluded`, dan `reason` |
| POST | `/api/protect-curation/{dataset_id}/delete-preview` | Daftar foto yang akan dihapus dan token konfirmasi |
| DELETE | `/api/protect-curation/{dataset_id}` | Admin; ID foto dikecualikan, token pratinjau, konfirmasi teks, dan `permanent: true` |

Pengujian tindakan pengecualian/pemulihan/penghapusan belum dijalankan pada foto pengguna. Sintaks kode dan pemuatan tampilan diperiksa tanpa mengubah status foto. Uji fungsi dapat dilakukan terpisah atas permintaan pengguna.
