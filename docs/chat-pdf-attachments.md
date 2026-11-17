# PDF besar: model vision dan model bahasa

Chatbot menerima satu PDF maksimal 50 MB / 500 halaman, termasuk laporan CRSSC 219 halaman. Klik + atau jatuhkan PDF/folder berisi satu PDF pada kotak pesan. Lampiran diunggah sekali ketika pertanyaan pertama dikirim. Teks seluruh halaman diindeks terlebih dahulu.

Secara default, aplikasi mencari maksimal tiga halaman relevan. Menyebut `halaman 219` akan memilih halaman itu. Gemma membaca gambar halaman terpilih satu per satu; deskripsinya disimpan, model vision dilepas dari memori, lalu Qwen menerima teks dan deskripsi gambar untuk menyusun jawaban. Ini tidak melatih bobot model. Halaman pindai tanpa teks juga masuk pembacaan vision.

Aktifkan **Baca seluruh gambar bertahap** untuk memeriksa setiap halaman bergambar. Ini bisa memerlukan waktu lama pada CPU/laptop. Progres menunjukkan halaman yang dibaca. Tombol kirim berubah menjadi Stop; hasil halaman yang sudah selesai tetap digunakan pada permintaan selanjutnya. Halaman yang sedang diproses ketika Stop ditekan diulang saat dilanjutkan. Jawaban tetap menggunakan pilihan bukti yang dibatasi agar muat dalam konteks Qwen, dan tidak boleh dianggap pemeriksaan kelayakan operasi seluruh rig.

Satu model dipanggil pada satu waktu. Model vision menggunakan konteks 4096 dan gambar maksimal 1200 piksel; Qwen memakai konteks 8192. Beralih model dapat menambah waktu tunggu. Stop membatalkan proses ekstraksi/permintaan model aktif, tetapi backend penyedia juga harus mendukung penghentian koneksi.

## Penyimpanan

PDF sumber, indeks teks, dan deskripsi visual disimpan privat per akun pada `data/private/chat-pdf`, dengan masa akses 3 jam sejak impor. Pembersih berjalan setiap 10 menit ketika server hidup; direktori yang sedang diproses tidak dihapus. Setelah kedaluwarsa, pilih kembali PDF. Gambar render tidak disimpan sebagai file permanen. Tidak ada unggahan ke GitHub atau penambahan ke dataset pelatihan.

Isi PDF dikirim ke layanan model yang Anda konfigurasikan. Kebijakan penyimpanan/log layanan tersebut tetap berlaku. Pada lokal, defaultnya Ollama laptop.

## Konfigurasi perusahaan / OpenShift

```
INSPECTION_PDF_BASE_URL=http://ollama-vlm:11434
INSPECTION_PDF_MODEL=gemma3:4b
INSPECTION_PDF_TEXT_BASE_URL=http://llm-bridge:8080
INSPECTION_PDF_TEXT_MODEL=<nama model bahasa publik perusahaan>
```

Jika vision dan bahasa memakai bridge yang sama, set kedua BASE_URL ke bridge tersebut. Gunakan nama model yang benar dari pengelola layanan. Token tetap pada Secret bridge; tidak ditambahkan ke browser. Bridge memakai protokol Ollama `/api/chat`, bukan URL `/v1` langsung.

Lokal default model bahasa `qwen3:4b-instruct`; model vision ditemukan dari `/api/tags` atau diatur melalui INSPECTION_PDF_MODEL. Model teks tidak memperoleh kemampuan vision hanya dengan perubahan nama konfigurasi.

Setelah kode di-build di OpenShift, perbarui image container `app` Deployment inspeksi-rig (bukan hanya initContainer). Mount penyimpanan privat aplikasi pada PVC. Dependensi PyMuPDF sudah tersedia di requirements container. Tidak perlu mengubah batas unggahan foto 8 MB; batas 50 MB hanya untuk endpoint impor PDF. Proxy perusahaan juga harus mengizinkan ukuran unggahan tersebut.

## Uji

`node --test scripts/chat-pdf.test.js`

Pengujian mencakup indeks 219 halaman, pemilihan halaman terakhir, pemisahan payload vision/bahasa, cache deskripsi, isolasi akun, pembatalan, serta kedaluwarsa/pembersihan.

## Foto langsung pada chatbot

Tombol +, drag-and-drop, dan paste gambar (Ctrl+V) menerima satu JPG, PNG, atau WebP maksimal 8 MB / 40 megapiksel. Foto tampil sebagai thumbnail dalam textbox dan pada pesan yang dikirim. Klik × untuk menghapus/mengganti lampiran. Satu lampiran aktif per percakapan; menggantinya mereset konteks yang dikirim ke model.

Server memvalidasi dan mendekode gambar dengan Pillow, memperbaiki orientasi, menghapus metadata kamera, serta memperkecil sisi terpanjang menjadi maksimal 1600 piksel. Foto dinormalisasi menjadi sumber satu halaman privat untuk memakai pipeline Gemma → Qwen dan penyimpanan sementara 3 jam yang sama. Tidak masuk dataset pelatihan atau riwayat pemeriksaan foto secara otomatis.

Gemma membaca foto terlebih dahulu; Qwen menerima deskripsi visual untuk menjawab dan menanggapi pertanyaan lanjutan. Tombol Stop tetap membatalkan proses. Pengaturan model/endpoint sama seperti PDF di atas. Opsi membaca semua halaman hanya ditampilkan untuk PDF.
