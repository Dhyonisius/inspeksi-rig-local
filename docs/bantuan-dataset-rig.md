# Bantuan dataset untuk meninjau foto rig

Pembaruan 12 Oktober 2026 menggunakan model **SH17 YOLOv8n** yang sudah tersedia di laptop untuk membantu kurasi foto PDF dan unggahan baru. Tidak ada dataset baru yang diunduh dan tidak ada pelatihan bobot baru pada pembaruan ini. Manfaat ketepatan pada foto rig belum diukur.

## Mengapa SH17 dipilih

- SH17 mempunyai katalog 17 kelas dan bobot resmi, sudah disiapkan sebagai ONNX CPU lokal. Aplikasi dapat memakainya segera untuk bantuan pengenalan orang, helm, sarung tangan, kacamata, dan APD lain.
- [Safety in oil rigs](https://universe.roboflow.com/safetyoil/safety-in-oil-rigs) menjadi kandidat lanjutan, tetapi label Safe/Unsafe belum mempunyai definisi yang dipublikasikan di halaman proyek. Definisi tersebut harus dicocokkan dengan kategori perusahaan sebelum menjadi acuan.
- [Drilling Rig PPE](https://universe.roboflow.com/ahmad-aladwani/drilling-rig-ppe) memuat beberapa kelas angka dan unlabeled yang belum jelas artinya. Label itu belum dipetakan otomatis.
- Dataset pipa pengeboran berfokus pada pipa/celah sambungan; bukan acuan kondisi bahaya seluruh komponen rig. Foto internal berlabel tetap dibutuhkan untuk BOP, mud pump, mast, accumulator, dan bahaya visual lainnya.

## Meninjau foto PDF yang sudah ada

1. Masuk sebagai admin/operator, buka **Belajar dari foto**.
2. Pilih **Periksa foto** pada foto di antrean. Foto PDF yang sudah diimpor tidak perlu diunggah ulang.
3. Tekan **Kenali objek/APD** pada panel SH17 di bawah gambar.
4. Periksa daftar objek dan kotak dengan garis putus-putus. Angka persentase adalah skor deteksi objek, bukan peluang gambar aman.
5. Jika suatu bagian benar-benar menunjukkan bahaya, pilih area/peralatan dan kategori bahaya. Tombol **Gunakan kotak setelah diperiksa** menyalin lokasi objek sebagai awal anotasi manual dan memilih label Ada indikasi bahaya. Kotak tersebut bisa dihapus dan digambar ulang untuk memperbaiki posisinya.
6. Jika kotak objek tidak relevan, cukup abaikan. Gambar sendiri kotak pada kerusakan atau kondisi bahaya yang terlihat. Kehadiran helm, orang, atau APD tidak otomatis menjadi bahaya.
7. Isi deskripsi yang telah diperiksa, konfirmasikan izin penggunaan foto, lalu **Simpan label**.
8. Lakukan **Verifikasi** pada tahap berikutnya setelah label diperiksa. Bantuan SH17 tidak melakukan verifikasi ini.
9. Untuk pelatihan rig, pisahkan kelompok ke TRAIN/VALIDATION/TEST, ajukan dan setujui dataset sesuai alur yang sudah ada, lalu jalankan pelatihan. [Panduan pelatihan rig](panduan-pelatihan-rig.md) menjelaskan tahap tersebut.

Usulan objek tidak disimpan sebagai anotasi bahaya atau menjadi acuan TEST. Hanya kotak yang dipilih/disusun dan label yang disimpan pengguna mengikuti alur kurasi. Setiap label hasil bantuan model tetap harus diperiksa manusia, khususnya pada VALIDATION dan TEST.

## Memindai foto sementara sebelum model rig dilatih

1. Pada **Belajar dari foto**, tekan **Coba detektor APD**.
2. Pilih **SH17 · bantuan objek/APD**.
3. Pilih JPG, PNG, atau WebP maksimal 8 MB, lalu tekan **Periksa objek/APD**.
4. Foto dikirim sebagai byte ke server lokal dan diproses di RAM. Tidak ada penulisan foto/hasil ke riwayat, database, atau dataset melalui endpoint scan ini. Pratinjau pada browser berasal dari berkas yang dipilih pengguna.
5. Baca objek yang terdeteksi, posisi kotak, dan panduan peninjauan manual. Hasil selalu Belum pasti untuk penilaian keselamatan, termasuk ketika tidak ada deteksi.

Foto dataset yang ditinjau menggunakan tombol Kenali objek/APD sudah tersimpan sebelumnya; endpoint ini tidak membuat salinan baru. Foto baru untuk pelatihan tetap harus diunggah melalui formulir Tambah foto baru dan diberi label.

## API lokal

Seluruh endpoint membutuhkan sesi aplikasi admin/operator. Server masih terikat localhost; autentikasi seluler dan akses jaringan perusahaan perlu disiapkan pada tahap integrasi mobile. Tidak ada perubahan OpenShift dalam pembaruan ini.

| Metode | Endpoint | Fungsi |
| --- | --- | --- |
| GET | `/api/ppe-assistance/status` | Kesiapan runtime, sumber, lisensi, katalog kelas |
| POST | `/api/dataset-items/{id}/ppe-assistance` | Bantuan objek/APD dari foto dataset internal yang sudah tersimpan; tanpa perubahan label |
| POST | `/api/ppe-assistance/scan` | Multipart dengan satu kolom `image`; pemindaian sementara tanpa penyimpanan |

Respons scan mencakup `model_name`, `scope: objects_only`, `status: TIDAK_PASTI`, `detections` (kelas, nama Indonesia, skor dan kotak 0–1), `object_counts`, `review_questions`, `limitations`, `latency_ms`, `image_saved: false`, `dataset_added: false`, dan `label_changed: false`.

Pemindaian berbagi antrean inferensi dengan Gemma dan pelatihan rig. Ketika proses lain memakai antrean, aplikasi mengembalikan pesan sibuk agar pengguna dapat mencoba kembali. Worker CPU dilepas setelah dua menit tidak digunakan. Tidak ada API pihak luar yang menerima foto.

## Sumber, lisensi, dan batas penerapan

- Penulis SH17: Hafiz Mughees Ahmad dan Afshin Rahimi; [repositori resmi](https://github.com/ahmadmughees/SH17dataset), [bobot rilis v1](https://github.com/ahmadmughees/SH17dataset/releases/tag/v1).
- Dataset SH17 mencantumkan CC BY-NC-SA 4.0. Paket lokal mencatat perangkat lunak Ultralytics AGPL-3.0. Penerapan perusahaan perlu menyesuaikan ketentuan lisensi atau menggunakan data internal/bobot dengan izin yang sesuai. Integrasi ini ditujukan untuk pembelajaran dan penelitian lokal.
- Kotak objek membantu menemukan bagian foto yang perlu diperiksa; bukan bukti bahwa APD dipakai dengan benar. APD kecil atau tertutup dapat tidak terdeteksi.
- SH17 tidak mengenali komponen rig lengkap dan tidak menilai tekanan, fungsi mekanis, kondisi internal, sertifikasi, atau kelayakan alat.
- Foto internal/PDF tetap menjadi dataset utama untuk kategori bahaya perusahaan setelah izin, anotasi, dan verifikasi manusia.
- Peningkatan akurasi belum dapat diklaim. Uji ketepatan pada foto rig yang ditinjau mentor perlu diminta dan dilakukan terpisah.
