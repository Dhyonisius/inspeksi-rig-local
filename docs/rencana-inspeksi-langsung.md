# Rencana inspeksi langsung dan pengembangan dataset

**Status: Tahap dataset, evaluasi, inspeksi kamera berkala, dan tracking area fokus telah diimplementasikan pada sumber aplikasi. Aktivasi memerlukan restart server dan migrasi SQL.**

Disimpan dan dilanjutkan atas permintaan pengguna pada 4 Oktober 2026. Petunjuk memakai fitur yang tersedia ada di README. Pengujian kamera fisik dan evaluasi model belum dijalankan dalam pengerjaan ini.

## Tujuan dan kondisi sekarang

Pengguna mengarahkan kamera ke kondisi kerja, melihat indikasi bahaya beserta deskripsi AI, lalu memilih bukti yang ingin disimpan dan mengoreksi hasil bila diperlukan. Penggunaan tetap memakai model visi Ollama lokal; tidak memerlukan peran petugas K3 khusus.

Fitur foto tunggal tetap tersedia. Menu Inspeksi langsung menambahkan kamera berkala dengan pilihan model, fokus gambar, penanda waktu, dan simpan bukti. Area fokus dapat diikuti melalui pencocokan pola antarframe; ini belum menjadi detector objek atau pengenalan kejadian gerakan. Detail hasil dapat dikurasi ke dataset, lalu dataset disetujui dapat diekspor JSONL/YOLO atau dievaluasi pada pembagian TEST.

## Tampilan yang direncanakan

Gunakan tema biru lembut, latar terang, dan teks biru tua seperti antarmuka sekarang. Status selalu disertai teks. Pada layar laptop, letakkan kamera di kiri dan hasil AI di kanan; pada layar kecil, susun keduanya secara vertikal.

Kontrol utama:

- Pilih kamera laptop atau USB, area kerja, dan model visi lokal.
- **Mulai** untuk mengaktifkan inspeksi langsung dan **Berhenti** untuk menghentikan kamera serta permintaan berikutnya.
- Tampilkan waktu frame yang diperiksa, waktu hasil diterima, durasi analisis, dan status menunggu model.
- Tampilkan deskripsi, indikasi bahaya atau hasil ragu, lalu tombol **Simpan bukti** dan koreksi label.
- Jika hasil sudah lama atau tidak sesuai frame terbaru, tampilkan penanda hasil kedaluwarsa. Hasil lama tidak boleh terlihat seolah menggambarkan kondisi kamera saat ini.

Tahap awal dapat memakai klik atau drag pada pratinjau untuk memilih bagian gambar yang ingin diperiksa. Pengenalan jari atau gesture menunjuk menjadi pengembangan berikutnya.

## Alur kamera dan inferensi

1. Kamera menampilkan pratinjau langsung. Pengambilan frame untuk AI berjalan berkala sesuai kemampuan laptop yang sudah diukur.
2. Batasi antrean menjadi **satu inferensi aktif**. Bila model masih bekerja, lewati frame baru atau ganti kandidat dengan frame terbaru; jangan menumpuk permintaan.
3. Setiap frame membawa ID sesi, nomor frame, dan waktu pengambilan. Hasil harus dicocokkan dengan identitas tersebut sebelum ditampilkan.
4. Ketika kamera, model, atau sesi berubah, abaikan respons dari sesi sebelumnya. Setelah **Berhenti**, tidak ada hasil tertunda yang memperbarui layar aktif.
5. Gunakan alur inferensi sementara yang tidak otomatis menulis setiap frame ke database atau folder unggahan. Terapkan jeda pemberitahuan agar indikasi yang sama tidak menghasilkan peringatan berulang.
6. Simpan hanya bukti yang dipilih pengguna: frame, hasil model, model dan versi prompt, waktu pengambilan, area, serta identitas sesi. Bukti tersebut dapat masuk ke riwayat dan alur koreksi yang sudah tersedia.

Status **Tidak tampak bahaya** tetap berarti tidak ada indikasi yang dikenali pada frame tersebut. Foto buram, bagian terhalang, hasil terlalu lama, atau konteks kurang perlu ditampilkan sebagai belum pasti.

## Koreksi menjadi dataset yang dapat dipakai

Tambahkan alur dari hasil pemeriksaan ke dataset. Pengguna memilih foto, label akhir, alasan koreksi, kategori bahaya, dan kotak lokasi bila diperlukan. Simpan asal data: analisis, prediksi model, koreksi yang dipilih, peninjau, sesi kamera, dan waktu frame. Label yang masuk dataset merupakan hasil kurasi yang dapat ditelusuri.

Foto dan label melewati review serta verifikasi sebelum disertakan dalam versi dataset yang disetujui. Koreksi pengguna dan penambahan dataset **tidak otomatis mengubah bobot model**. Pelatihan atau penggunaan contoh dalam prompt memerlukan alur tersendiri yang ditentukan setelah format data dan hasil evaluasi jelas.

Rencanakan ekspor paket foto dengan manifest versi, kategori, sumber/lisensi, checksum, label final, dan pembagian data:

- **JSONL** untuk contoh gambar, deskripsi yang telah dikoreksi, dan label bagi pengembangan atau evaluasi VLM.
- **YOLO** untuk detector dengan kotak yang sudah diverifikasi. Koordinat yang disimpan sekarang adalah `x, y` pojok kiri atas serta lebar dan tinggi relatif; ekspor perlu mengubahnya menjadi pusat `x + lebar/2, y + tinggi/2`. Gunakan pemetaan kategori ke nomor kelas yang stabil di dalam versi ekspor.
- Kelompokkan frame dari sesi, klip, atau kejadian yang sama ke satu split. Jangan membagi frame berdekatan dari kejadian yang sama ke TRAIN dan TEST. Pembagian perlu mempertimbangkan kemiripan gambar, karena checksum saat ini hanya mengenali duplikat yang identik.

## Evaluasi sebelum memilih model

Bangun evaluasi batch pada kumpulan TEST yang tetap dan tidak dipakai untuk menyetel prompt atau melatih model. Bandingkan model serta versi prompt berdasarkan bahaya yang terlewat, peringatan keliru, hasil ragu, dan latensi. Simpan hasil evaluasi bersama versi dataset dan konfigurasi model agar perbandingan dapat diulang.

Utamakan contoh yang mewakili tempat kerja, pencahayaan, sudut kamera, objek terhalang, dan jenis bahaya yang ditargetkan. Registrasi metadata model yang tersedia sekarang belum merupakan proses pelatihan atau aktivasi model baru.

## Pelacakan gerakan pada tahap berikutnya

Untuk kotak objek, identitas objek lintas frame, dan kejadian berbasis gerakan, tambahkan detector serta tracker temporal. VLM dapat membantu menjelaskan konteks atau menilai frame terpilih. Alur VLM saat ini memeriksa satu gambar dan tidak menghasilkan koordinat kotak.

Dataset tahap ini perlu ID objek, rentang waktu kejadian, hubungan antarframe, dan label gerakan yang dapat diamati. Pengenalan gesture menunjuk memerlukan pendeteksian tangan atau pose serta aturan pemilihan bagian gambar; fitur itu belum menjadi bagian implementasi saat ini.

## Perangkat dan pengukuran

Mulai dari kamera laptop atau USB melalui browser pada laptop yang menjalankan aplikasi. Akses dari ponsel menjadi tahap berikutnya karena server sekarang hanya membuka `127.0.0.1`; penggunaan melalui Wi-Fi memerlukan rancangan akses LAN, HTTPS, autentikasi, dan izin kamera.

Ukur kemampuan perangkat sebelum menentukan interval frame, resolusi, ukuran model, atau optimasi: waktu pemuatan model, latensi median dan persentil tinggi, pemakaian RAM/VRAM, serta perbedaan CPU dan GPU bila tersedia. Tidak ada janji kecepatan atau jumlah frame per detik sebelum pengukuran tersebut dilakukan.

## Urutan pengembangan yang dicatat

1. Ekspor dataset, hubungan koreksi ke dataset, dan evaluasi model.
2. Inspeksi kamera berulang dengan antrean satu inferensi, penjagaan waktu hasil, serta penyimpanan bukti terpilih.
3. Detector/tracker dan label kejadian temporal berdasarkan kebutuhan yang sudah dinilai.
4. Gesture menunjuk dan akses ponsel setelah tahap sebelumnya siap.

Tahap 1 dan 2 tersedia dalam sumber aplikasi. Tahap 3 baru mencakup tracking pola pada area fokus manual, tanpa detector semantik atau label kejadian gerakan. Tahap 4 dan pelatihan model masih berupa rencana. Aktivasi fitur saat ini dilakukan melalui restart server; dokumen ini tidak menjalankan pelatihan atau membuka akses LAN.
