# Mode hemat, pengukuran, dan detektor APD

## Detektor yang digunakan

Detektor tambahan menggunakan **YOLOv8n SH17**, bobot nano yang diterbitkan langsung oleh Hafiz Mughees Ahmad dan Afshin Rahimi pada [rilis resmi SH17 v1](https://github.com/ahmadmughees/SH17dataset/releases/tag/v1). Bobot sumber `yolo8n.pt` sekitar 5,96 MB, dengan 3,2 juta parameter menurut [tabel penerbit](https://github.com/ahmadmughees/SH17dataset#models). Model ini sudah dilatih oleh penerbit pada objek/APD SH17. Penambahan ini tidak melatih ulang Gemma maupun dataset internal pengguna.

Peta 17 kelas mengikuti [sh17.yaml resmi](https://github.com/ahmadmughees/SH17dataset/blob/master/sh17.yaml): person, ear, ear-mufs, face, face-guard, face-mask, foot, tool, glasses, gloves, helmet, hands, head, medical-suit, shoes, safety-suit, safety-vest. Model COCO umum yang tidak mempunyai kelas helm/rompi tidak dipakai sebagai pengganti SH17.

Model diekspor satu kali ke ONNX FP32, ukuran input tetap 640×640 dan batch 1. Runtime memakai **ONNX Runtime CPU**, dua thread, satu permintaan sekaligus, dan maksimum 20 kotak. Worker hanya dimuat saat detektor diaktifkan dan menerima foto. Setelah tidak dipakai dua menit, prosesnya dihentikan agar RAM kembali tersedia. CUDA/PyTorch tidak dimuat pada pemantauan kamera; Gemma tetap memakai Ollama secara terpisah.

Keberadaan objek adalah petunjuk tambahan. **Tidak ada objek terdeteksi bukan berarti aman.** Ada helm juga tidak memastikan helm sedang dipakai dengan benar. Detektor tidak menetapkan label aman/bahaya sendiri dan tidak menggantikan penjelasan Gemma atau koreksi pengguna.

## Persiapan terpisah dari server

`scripts/prepare-detector.py` tidak dipanggil otomatis oleh server. Instalasi, unduhan, dan ekspor harus dimulai secara eksplisit:

```powershell
python scripts/prepare-detector.py --install --download --export --check
```

Python pemanggil hanya membuat lingkungan virtual. Dependensi tidak dipasang ke Python bawaan Codex atau Python global:

| Folder | Isi | Dipakai saat kamera aktif? |
|---|---|---|
| `data/private/detector-export-env` | PyTorch CPU 2.8.0, torchvision 0.23.0, Ultralytics 8.3.203, ONNX 1.19.0 dan dependensi ekspor | Tidak |
| `data/private/detector-runtime` | ONNX Runtime 1.23.2, NumPy 2.2.6, Pillow 11.3.0 dan dependensi runtime | Hanya bila detektor dipilih |
| `models/sh17-yolov8n` | Bobot sumber, peta kelas, ONNX, manifest checksum, dan hasil pengukuran | ONNX dimuat sesuai kebutuhan |

Indeks CPU resmi PyTorch digunakan agar persiapan tidak memasang paket CUDA besar. [Pasangan versi PyTorch/torchvision](https://pytorch.org/get-started/previous-versions/#v280), [ekspor ONNX Ultralytics](https://docs.ultralytics.com/modes/export/), dan [instalasi ONNX Runtime CPU](https://onnxruntime.ai/docs/install/) menjadi acuan persiapan. Auto-install Ultralytics dinonaktifkan untuk ekspor; aplikasi tidak mengunduh model atau dependensi saat menerima foto.

Runtime memilih `data/private/detector-runtime/Scripts/python.exe` pada Windows. Variabel `DETECTOR_PYTHON_EXE` dapat dipakai untuk menunjuk Python lain yang memiliki dependensi runtime. `PYTHON_EXE` sanitizer tetap terpisah.

Manifest mencatat URL sumber, SHA256 bobot yang diunduh, SHA256 ONNX, urutan kelas, dan versi dependensi. Checksum lokal mendeteksi perubahan setelah persiapan. Penerbit tidak menyediakan checksum independen; keaslian sumber mengandalkan unduhan HTTPS dari rilis resmi. Worker memeriksa checksum dan bentuk model sebelum memuatnya.

## Pengukuran performa

`createPerformanceMonitor` menyimpan paling banyak 100 sampel waktu di RAM dan 20 sampel terakhir pada tampilan respons. Tidak ada foto, prompt, atau hasil deskripsi privat yang dicatat di metrik.

- **RAM server:** RSS proses Node.js, bukan total RAM Gemma atau worker detektor.
- **RAM laptop:** memori sistem tersedia dan total.
- **VRAM:** penggunaan keseluruhan perangkat NVIDIA, termasuk aplikasi lain; diperiksa maksimal sekali per 10 detik, timeout 2 detik.
- **Waktu VLM:** durasi, median, dan p95 untuk analisis berhasil, dipisah per profil. Pembatalan dan error dicatat terpisah.
- **Detektor:** waktu preprocessing+inferensi+NMS, RAM worker jika tersedia, jumlah objek dan nama kelas.

Metrik direset ketika server dimulai ulang. Median/p95 dari sedikit foto tidak membuktikan ketepatan model. Jalankan foto yang sama pada Mode Hemat dan Mode Detail untuk membandingkan waktu dan hasil. Turunnya resolusi/frekuensi dapat menghilangkan objek kecil, termasuk kerusakan kabel.

Pengukuran sampel SH17 tanpa mengubah database:

```powershell
node scripts/prepare-detector.benchmark.mjs --count=3 --repeats=2
```

Hasil ditulis ke `models/sh17-yolov8n/benchmark.json`. Sampel berasal dari VALIDATION penerbit. Ini hanya pengukuran waktu, bukan perhitungan mAP atau sertifikasi keselamatan. Bobot penerbit pernah melihat TRAIN resmi, sehingga TEST lokal yang diambil dari TRAIN resmi tidak independen untuk mengevaluasi akurasi bobot penerbit.

### Hasil sampel pada laptop ini, 5 Oktober 2026

Ekspor ONNX berhasil, berukuran **12.251.096 byte** (11,68 MiB). SHA256 artefak:

```
0639446f39092cebf0d9304db17b37ba296eb8222cc9756939e2e111b3e339ce
```

Tiga foto VALIDATION dianalisis dua kali melalui Node → worker ONNX CPU yang sebenarnya:

| Metrik | Hasil sampel |
|---|---|
| Permintaan pertama, termasuk memuat worker | 711 ms |
| Permintaan berikutnya, seluruh perjalanan worker | 99–107 ms |
| Preprocessing, inferensi, dan NMS setelah pemanasan | 91,9–100,5 ms |
| RAM worker terukur | Sekitar 109–123 MiB |
| Objek yang muncul pada sampel | Orang, sarung tangan, helm, rompi, tangan, kepala, telinga, masker |

Pengukuran ini memakai CPU Ryzen 5 7535HS, dua thread, dan tidak menjalankan Gemma secara bersamaan. Beban aplikasi lain dan ukuran foto dapat mengubah waktu; pembacaan tersebut tidak menjamin frekuensi video maupun akurasi pada lokasi pengguna.

## Lisensi dan atribusi

[SH17](https://github.com/ahmadmughees/SH17dataset#license) menyatakan lisensi dataset **CC BY-NC-SA4.0**. Ikuti atribusi penulis dan batas penggunaan yang diterbitkan. Perangkat lunak Ultralytics memakai **AGPL-3.0** menurut metadata paket yang digunakan; ONNX Runtime memakai MIT. Jangan menganggap tambahan model ini sebagai izin penggunaan komersial. Lisensi sumber foto tetap mengikuti ketentuan penerbit yang tercatat dalam dokumentasi dataset.
