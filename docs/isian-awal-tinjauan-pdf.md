# Isian awal Tinjau contoh pelatihan dari PDF dan AI yang tersedia

Pada dialog **Tinjau contoh pelatihan**, foto PDF yang belum ditinjau memperoleh isian awal:

- **Area/peralatan yang difoto:** judul bagian bertanda kotak biru, dipetakan ke katalog area aktif aplikasi.
- **Deskripsi yang telah diperiksa:** nama item checklist, frekuensi/waktu yang tercantum, rig dan halaman asal; dilengkapi deskripsi usulan AI yang sudah tersedia untuk checksum foto tersebut.

Deskripsi memakai penanda **PDF** dan **AI — perlu crosscheck**, agar sumber keduanya terlihat. Tidak ada permintaan AI baru yang dijalankan untuk pengisian ini.

## Cara penggunaan

1. Buka **Belajar dari foto → Periksa foto** pada foto PDF.
2. Area dan deskripsi langsung terisi jika konteksnya dapat dicocokkan.
3. Periksa gambar, area, deskripsi, label, kategori, dan posisi kotak. Anda dapat mengubah semua isian yang tersedia.
4. Konfirmasikan izin pemakaian foto, lalu **Simpan label**.
5. Lakukan verifikasi secara terpisah setelah pemeriksaan.

Jika satu foto identik digunakan pada beberapa item checklist, dialog menampilkan **Pilih item checklist asal foto**. Area otomatis dipilih hanya ketika semua sumber cocok dengan area aktif yang sama; pada sumber lintas area, pengguna memilih konteks yang tepat. Pemilihan sumber mengisi ulang area/deskripsi, sehingga gunakan sebelum melakukan koreksi manual.

Area yang sebelumnya sudah dipilih serta deskripsi yang sudah disimpan pengguna dipertahankan. Isian awal tampil di formulir; tidak menimpa label, deskripsi, atau status verifikasi dalam database secara massal. Nilai yang diperiksa disimpan melalui tombol Simpan label yang sudah ada.

## Metode pencocokan sumber

`scripts/prepare-rig-review-context.py` membaca PDF asli secara lokal dengan pdfplumber dan pypdf. Checksum setiap PDF harus sesuai dengan manifest impor. Posisi vertikal judul, item checklist, caption nama foto, dan objek gambar digunakan untuk mencari hubungan antar elemen. Konteks dibawa antar halaman, sehingga foto yang berlanjut pada halaman berikutnya tidak menggunakan judul item yang kebetulan berada di bawahnya.

Indeks objek gambar tetap mengikuti pypdf seperti ekstraksi sebelumnya. Hubungan foto dicocokkan melalui identitas PDF, nomor halaman, dan indeks objek, lalu dihubungkan dengan checksum foto lokal. File foto, PDF, dan manifest impor tetap dipertahankan.

Hasil metadata disimpan pada `data/private/rig-pdf/review-context.json`. Seluruh 536 foto memiliki konteks caption/checklist yang ditemukan. Enam foto digunakan pada lebih dari satu area PDF; dialog tetap memberi pilihan sumber untuk konteks yang berbeda. Hasil pencocokan otomatis ini belum merupakan verifikasi manusia terhadap isi foto.

`scripts/rig-review-context.js` memeriksa checksum manifest, memetakan judul PDF ke area aktif, dan menggabungkan deskripsi AI yang sudah ada. Usulan AI tetap hanya usulan, termasuk kesimpulan yang mungkin keliru. Tanda centang checklist tidak menjadi label keselamatan atau verifikasi otomatis.

Untuk menyiapkan kembali metadata setelah penambahan PDF, jalankan pada folder proyek dengan Python yang menyediakan pdfplumber/pypdf:

```powershell
python scripts/prepare-rig-review-context.py "C:\lokasi\folder\Protect"
```

Jalankan persiapan sesudah manifest/foto baru tersedia. Aplikasi menolak memakai metadata konteks bila checksum manifest berubah dan metadata belum disiapkan ulang.
