# Panduan memasukkan foto dan melatih model rig

Pembaruan 11 Oktober 2026. Aplikasi lokal tersedia di http://127.0.0.1:3181 pada sesi ini. Peluncur `start-local.cmd` dapat memilih port lain jika alamat tersebut sudah dipakai.

## Hasil yang sekarang tersedia

Menu **Belajar dari foto** menyediakan penambahan foto, pemeriksaan label, verifikasi, pemeriksaan kesiapan, tombol pelatihan YOLO lokal, riwayat proses, hasil TEST, pemilihan kandidat oleh admin, serta percobaan model terlatih. OpenShift tidak diperlukan untuk menjalankan alur lokal ini.

Pelatihan menggunakan foto dan kotak kategori bahaya yang ditentukan manusia. Bobot detektor YOLO berubah setelah pelatihan. Bobot Gemma tidak berubah: pemeriksaan biasa pada **Periksa foto** tetap menggunakan Gemma/Ollama beserta contoh visual yang memenuhi syarat. Detektor rig hasil pelatihan digunakan melalui **Periksa foto dengan model rig terlatih** pada halaman pembelajaran.

## 1 Mulai dari foto yang sudah ada

1. Masuk sebagai pengguna atau admin. Untuk pembagian kelompok dan pemilihan kandidat, gunakan akun admin.
2. Buka **Belajar dari foto**. Foto hasil ekstraksi PDF sudah ada pada dataset **Rig Protect - calon pelatihan**; foto tersebut tidak perlu diunggah ulang.
3. Pada tab **Belum ditinjau**, pilih **Periksa foto** pada satu foto. Alternatifnya, buka **Kesiapan pelatihan model → Buka dataset**, lalu **Tinjau calon pelatihan**.
4. Baca konteks sumber PDF jika tersedia, tetapi tentukan label berdasarkan foto dan informasi yang sudah diperiksa. Tanda centang dalam laporan PDF tidak otomatis membuktikan bahwa foto aman.

Pada pemeriksaan tanggal 11 Oktober 2026, dataset Rig Protect berisi **536 foto**, dengan **1 foto terverifikasi dan 535 foto belum ditinjau**. Data ini belum siap dilatih. Angka pada aplikasi dapat berubah setelah pengguna mengerjakan label.

## 2 Menambahkan foto dari folder komputer

1. Pada **Belajar dari foto → Tambah foto baru**, pilih dataset yang masih **Draft**.
2. Pilih **Area / peralatan yang difoto**.
3. Isi **Kelompok pengambilan**, misalnya `AU-15 inspeksi pagi 11 Oktober 2026`. Gunakan nama kelompok yang sama untuk foto dari rig dan kejadian yang sama. Jangan mengganti nama kelompok untuk memisahkan foto yang sebenarnya berkaitan.
4. Pilih satu foto JPG, PNG, atau WebP dengan ukuran maksimal 8 MB.
5. Konfirmasikan izin penggunaan foto, lalu tekan **Tambah ke antrean**.
6. Foto masuk sebagai **Belum pasti / Belum ditinjau**. Lanjutkan pemeriksaan label pada tahap berikutnya.

Jika ingin membuat kumpulan tersendiri, gunakan **Kelola / buat dataset**, isi nama dan versi, lalu pilih dataset itu saat menambahkan foto. Dataset baru memerlukan foto dari kelompok terpisah untuk TRAIN, VALIDATION, dan TEST.

## 3 Memberi label dan kotak penanda

1. Tekan **Periksa foto** atau **Ubah label / anotasi**.
2. Pilih area/peralatan yang benar.
3. Tentukan **Label yang benar**:
   - **Ada indikasi bahaya**: pilih kategori, lalu tarik kotak mengelilingi bagian yang memperlihatkan bahaya. Bila ada beberapa bahaya, tandai masing-masing dan pilih kategori yang sesuai.
   - **Tidak tampak bahaya**: gunakan hanya jika kategori yang dinilai memang tidak terlihat pada foto. Tidak ada kotak bahaya pada label ini. Label tersebut bukan sertifikat aman.
   - **Belum yakin**: pilih jika foto buram, hanya menunjukkan tulisan/dokumen, atau konteks belum cukup untuk menetapkan label. Foto ini tidak digunakan dalam pelatihan YOLO.
4. Isi **Deskripsi yang telah diperiksa**: sebutkan objek, kondisi yang terlihat, dan alasan label. Contoh: `Kabel melintang pada jalur berjalan di sekitar mud pump; bagian kabel dan jalur terlihat jelas.`
5. Konfirmasikan izin, lalu **Simpan label**.
6. Buka tab **Menunggu verifikasi**, periksa kembali foto, label, kategori, kotak, dan deskripsi, lalu tekan **Verifikasi**. Jika belum benar, ubah label terlebih dahulu.

Ulangi untuk semua foto pada dataset yang akan disetujui. Menambah banyak foto tanpa label tidak membuat model otomatis belajar. Kotak harus menunjukkan bahaya yang tampak; jangan menandai seluruh peralatan sebagai bahaya hanya karena jenisnya tertentu.

## 4 Memisahkan foto untuk belajar dan menilai hasil

1. Masuk sebagai admin.
2. Pilih **Lihat PDF & pembagian rig** pada halaman pembelajaran.
3. Untuk setiap kelompok, pilih **Latih**, **Validasi**, atau **Uji**, lalu **Simpan pembagian**.
4. Pertahankan semua foto dari kelompok pengambilan, kejadian, atau sesi kamera yang sama pada satu pembagian. Foto identik tidak boleh muncul pada data latih dan uji.

| Pembagian | Tujuan |
| --- | --- |
| TRAIN / Latih | Mengubah bobot model dari foto dan kotak label. |
| VALIDATION / Validasi | Memeriksa hasil selama pelatihan dan memilih bobot terbaik. |
| TEST / Uji | Mengukur bobot terbaik pada foto terpisah setelah pelatihan. |

Masing-masing pembagian harus mempunyai foto bahaya yang terverifikasi beserta kotaknya. Setiap kategori yang muncul pada VALIDATION/TEST harus mempunyai contoh pada TRAIN. Sertakan juga foto tanpa indikasi bahaya untuk menilai alarm keliru. Keberadaan satu foto pada tiap pembagian hanya memenuhi syarat teknis minimum; mutu, variasi, dan jumlah contoh per kategori tetap perlu diperiksa.

Jangan menyalin foto yang sama ke tiga pembagian. Jika kelompok terpisah belum cukup, tambahkan foto dari kejadian atau rig lain. TEST sebaiknya tetap dibekukan; jangan terus mengubah model berdasarkan hasil TEST yang sama. Setelah beberapa putaran pengembangan, gunakan pengujian akhir yang belum dipakai untuk memilih model.

## 5 Menyetujui dataset

1. Buka **Buka dataset** untuk dataset yang dipilih.
2. Pastikan seluruh foto sudah **Terverifikasi** dan izin penggunaannya dikonfirmasi.
3. Tekan **Ajukan tinjauan**, lalu setelah peninjauan selesai tekan **Setujui dataset**.
4. Kembali ke **Belajar dari foto → Latih model rig di laptop** dan pilih dataset tersebut.
5. Selesaikan pesan pada bagian **Perlu diselesaikan sebelum melatih**. Periksa juga tabel kotak per kategori dan catatan mutu data.

Dataset yang sudah disetujui tidak dapat langsung ditambah atau diubah labelnya melalui alur Draft. Gunakan dataset versi baru untuk putaran pembelajaran berikutnya, dan tentukan kembali pemisahan kelompoknya.

## 6 Menjalankan pelatihan lokal

1. Pada **Latih model rig di laptop**, pilih dataset yang sudah disetujui.
2. Isi **Jumlah epoch**. Nilai bawaan adalah 20. Satu epoch adalah satu putaran belajar pada data TRAIN; jumlah epoch bukan ukuran akurasi.
3. Konfirmasikan bahwa label, pembagian kelompok, dan izin foto sudah diperiksa.
4. Tekan **Mulai pelatihan**. Tombol ini hanya aktif setelah prasyarat teknis terpenuhi.
5. Pantau **Riwayat pelatihan dan hasil TEST**. Anda dapat membuka menu lain dan kembali ke halaman ini. Tetap jalankan server dan laptop selama proses berlangsung.

Server membuat ZIP snapshot dari foto dan label terverifikasi, memeriksa checksum, melatih YOLOv8n pada CPU dengan bobot SH17 lokal sebagai awal, memilih `best.pt` menggunakan VALIDATION, mengevaluasi TEST, lalu mengekspor ONNX. Kelas model lokal hanya mencakup kategori yang mempunyai kotak contoh pada TRAIN. Urutan kelas disimpan bersama model agar tidak tertukar dengan katalog bahaya.

Pelatihan dapat berlangsung lama. Pemeriksaan dan evaluasi AI menggunakan satu antrean lokal sehingga tidak berjalan bersamaan dengan pelatihan. Gunakan **Hentikan pelatihan** jika perlu. Proses yang terputus karena server dimulai ulang ditandai **Terputus**; mulai pekerjaan baru setelah penyebabnya diselesaikan.

Hasil disimpan di `data/private/rig-training/<id-pekerjaan>/`, termasuk snapshot ZIP, foto/label hasil ekstraksi, bobot, manifest runtime, catatan pekerjaan, dan metrik. Foto pelatihan memang disimpan karena diperlukan untuk pembelajaran yang dapat ditelusuri.

## 7 Membaca hasil sebelum mencoba model

1. Periksa **Precision**: proporsi deteksi yang cocok dengan kotak acuan pada evaluasi.
2. Periksa **Recall**: kemampuan menemukan kotak acuan. Recall rendah menunjukkan banyak bagian berbahaya tidak ditemukan.
3. Periksa **mAP50** dan hasil per kategori. Kategori yang belum memiliki contoh TEST belum mempunyai pengukuran yang memadai.
4. Periksa **Foto bahaya tanpa deteksi** dan **Foto tanpa indikasi yang diberi alarm** pada ambang skor 0,35.
5. Lihat kembali contoh kegagalan sebelum menambah foto, memperbaiki label, atau melatih versi berikutnya. Jangan menyatakan model layak operasional hanya karena pelatihan selesai.

Hitungan per foto hanya memeriksa ada/tidaknya deteksi pada ambang yang sama dengan percobaan model. Deteksi kategori yang keliru masih dapat menghasilkan alarm pada foto bahaya; gunakan metrik kotak dan kategori untuk menilai kesalahan tersebut. Jika TEST tidak memiliki foto tanpa indikasi, alarm keliru belum dapat dinilai.

## 8 Menggunakan hasil pelatihan di aplikasi

1. Admin membuka hasil pekerjaan berstatus **Selesai · kandidat**.
2. Tinjau metrik TEST, lalu konfirmasikan pemilihan untuk percobaan lokal.
3. Tekan **Gunakan untuk percobaan lokal**. Pemilihan ini tidak menyatakan model sudah layak operasional.
4. Pada **Periksa foto dengan model rig terlatih**, pilih foto baru yang belum digunakan untuk belajar.
5. Tekan **Periksa dengan model rig**.
6. Aplikasi menampilkan kategori, skor deteksi, kotak pada foto, dan waktu analisis. Periksa hasilnya dengan kondisi sebenarnya.

Foto percobaan dikirim melalui API, diproses di memori server/worker, kemudian referensi data gambar dilepas. Endpoint ini tidak menulis foto ke penyimpanan, tidak membuat riwayat pemeriksaan SQL, dan tidak memasukkannya ke dataset. Jika ingin menjadikan foto tersebut bahan belajar, tambahkan secara terpisah melalui **Tambah foto baru**, lalu beri label dan verifikasi.

Jika tidak ada deteksi, hasilnya **Belum pasti**, bukan otomatis aman. Model hanya mengenali kategori yang dilatih dan tidak dapat memastikan tekanan, kekuatan sling, atau kondisi yang tidak terlihat.

## API lokal yang tersedia

Seluruh endpoint menggunakan sesi masuk aplikasi yang sama. Belum ada perubahan akses jaringan: server tetap menerima koneksi localhost. Aplikasi mobile pada HP memerlukan pengaturan jaringan dan autentikasi yang sesuai pada tahap integrasi berikutnya.

| Endpoint | Fungsi |
| --- | --- |
| GET `/api/rig-training` | Riwayat pelatihan dan model percobaan yang dipilih. |
| GET `/api/rig-training/readiness/<dataset_id>` | Prasyarat data, pembagian, dan kotak per kategori. |
| POST `/api/rig-training` | Memulai pelatihan dari dataset disetujui. JSON: `dataset_id`, `epochs`, `confirm_training: true`. |
| POST `/api/rig-training/<id>/cancel` | Meminta penghentian pekerjaan milik pengguna atau admin. |
| POST `/api/rig-training/<id>/activate` | Admin memilih kandidat untuk percobaan. JSON: `review_confirmed: true`. |
| POST `/api/rig-training/scan` | Memeriksa foto sementara dengan model terpilih. Multipart field: `image`. |

Jalur lokal untuk unggah, kurasi, pelatihan, evaluasi, dan inferensi model terlatih telah dihubungkan. Pelatihan pertama belum dijalankan karena dataset Rig Protect belum selesai dikurasi. Kemampuan dan kualitas model hasil pelatihan masih harus dibuktikan setelah label dan data uji siap.
