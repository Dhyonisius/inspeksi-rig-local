# Dataset SH17 lokal

SH17 ditambahkan sebagai dataset **objek dan APD**. Paket lokal berisi 8.099 foto, 75.994 kotak anotasi, dan 17 kelas. Foto diambil dari tautan yang diterbitkan penulis, dengan label dari arsip Kaggle versi 1. Foto yang tautannya sudah tidak tersedia diambil dari arsip versi yang sama.

## Membuka dalam aplikasi

1. Hentikan server lama dengan Ctrl+C dan jalankan `start-local.cmd` pada akun Windows yang memiliki akses SQL Server.
2. Bootstrap menjalankan `sql/public-datasets.sql`, lalu mengimpor manifest lokal secara otomatis. Proses berlangsung di latar belakang dengan transaksi per batch. Jangan menutup terminal sebelum impor selesai.
3. Masuk sebagai admin dan buka **Dataset foto → Buka dataset publik**. Jumlah foto serta kotak lokal dan database ditampilkan secara terpisah.
4. Setelah tercatat, buka dataset **SH17 · Objek/APD → Lihat foto**. Pilih TRAIN, VALIDATION, atau TEST. Klik foto untuk melihat kotak anotasi dan menyaring kelas yang ditampilkan.
5. Jika impor terputus, nyalakan kembali server atau gunakan **Impor ke database**. ID sumber yang sudah tersimpan dilewati. Kandidat foto dipertahankan bila hasil commit SQL belum diketahui.

Foto tetap privat melalui sesi aplikasi. Database mencatat aset foto, kelas, koordinat kotak, pembagian data, lisensi, checksum, dan ID sumber. Berkas foto berada di folder lokal, bukan di kolom BLOB SQL.

## Sumber dan lisensi

- Penulis: Hafiz Mughees Ahmad dan Afshin Rahimi.
- [Repositori resmi](https://github.com/ahmadmughees/SH17dataset).
- [Dataset Kaggle](https://www.kaggle.com/datasets/mugheesahmad/sh17-dataset-for-ppe-detection), versi 1.
- [Publikasi](https://doi.org/10.1016/j.jnlssr.2024.09.002).
- [Lisensi CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/): atribusi, penggunaan nonkomersial, serta pembagian turunan dengan lisensi serupa. Foto asal juga mengikuti ketentuan Pexels yang dirujuk penerbit.

Publikasi menjelaskan anotasi awal, koreksi oleh ketua tim, dan verifikasi akhir oleh mahasiswa pascasarjana. Pemeriksaan penerbit dicatat sebagai asal data. Item SQL tetap DRAFT karena belum ditinjau untuk lingkungan lokal. Dataset ini tidak merupakan sertifikasi keselamatan.

Indeks kelas mengikuti **sh17.yaml resmi**, bukan urutan daftar di README: person, ear, ear-mufs, face, face-guard, face-mask, foot, tool, glasses, gloves, helmet, hands, head, medical-suit, shoes, safety-suit, safety-vest.

## Paket pelatihan yang tersedia

Direktori di dalam proyek:

```
data/private/public-datasets/sh17/prepared/
  images/train/, images/validation/, images/test/
  labels/train/, labels/validation/, labels/test/
  training/data.yaml
  training/train.txt
  training/validation.txt
  training/test.txt
  manifest.json
```

Paket menggunakan format YOLO: `class_id center_x center_y width height` dengan koordinat relatif 0–1. Konfigurasi menggunakan jalur absolut laptop ini; jalankan kembali persiapan bila folder dipindahkan. Lokasi `data.yaml` dapat disalin dari katalog aplikasi.

Pembagian lokal:

| Pembagian | Foto | Asal |
|---|---:|---|
| TRAIN | 5.831 | Data TRAIN penerbit setelah pemisahan TEST lokal |
| VALIDATION | 1.620 | `val_files.txt` penerbit, dipertahankan |
| TEST | 648 | 10% TRAIN penerbit dengan urutan hash tetap `sh17-test-1` |

TEST lokal untuk model baru jangan dipakai melatih atau menyetel parameter. Bobot yang pernah dilatih pada seluruh TRAIN resmi sudah pernah melihat sebagian TEST lokal ini, sehingga evaluasi bobot tersebut harus menggunakan pembagian acuan penerbit. Foto mirip dari sesi pemotretan yang sama tetap perlu ditinjau sebelum klaim generalisasi ke tempat kerja Anda.

Foto lokal dibatasi sisi terpanjang 2.560 piksel, diubah ke JPEG kualitas 90, dan metadata EXIF dihilangkan. Kotak disesuaikan bila orientasi berubah. Identitas sumber, checksum CSV, commit penerbit, ukuran foto, checksum foto lokal, dan kebijakan pembagian dicatat pada manifest/receipt. Arsip penuh 14 GB tidak diperlukan untuk menggunakan paket ini. Resolusi yang lebih kecil dapat memengaruhi pengenalan objek kecil; ini bukan salinan piksel yang identik dengan benchmark penerbit.

Untuk melanjutkan atau membangun kembali paket dengan Python yang menyediakan Pillow:

```powershell
python scripts/prepare-sh17.py --source-images --workers 8 --max-edge 2560
```

## Pelatihan berikutnya

SH17 cocok untuk melatih **detektor objek/APD seperti YOLO**. Dataset ini tidak menyediakan deskripsi aman/bahaya yang telah dikurasi untuk fine-tuning Gemma. Helm yang terlihat, misalnya, adalah objek; kehadirannya tidak otomatis menjadi label bahaya. Penilaian kondisi tempat kerja memerlukan aturan konteks dan contoh lokal berlabel yang dapat disusun melalui fitur koreksi dan dataset inspeksi.

Jika tahap pelatihan dimulai nanti, siapkan lingkungan Python terpisah, pasang PyTorch sesuai perangkat dan Ultralytics, lalu gunakan `training/data.yaml`. [Dokumentasi instalasi Ultralytics](https://docs.ultralytics.com/quickstart/) dan [pelatihan](https://docs.ultralytics.com/modes/train/) menjelaskan dependensi serta parameter. Contoh berikut dijalankan hanya ketika Anda memang ingin memulai pelatihan; model awal dapat diunduh oleh Ultralytics bila belum tersedia.

```powershell
yolo detect train model=yolov8n.pt data="data/private/public-datasets/sh17/prepared/training/data.yaml" epochs=50 imgsz=640 batch=2 device=0 workers=0 project="models/sh17-runs" name="baseline"
```

Batch 2 dan ukuran 640 adalah titik awal konservatif untuk RTX 2050 4 GB, belum diukur pada laptop ini. Tutup pekerjaan Ollama yang memakai GPU saat pelatihan. Jika kehabisan VRAM, turunkan batch; `device=cpu` tersedia jika lingkungan PyTorch belum menyediakan CUDA. Catat versi dependensi dan parameter run.

Hasil bobot biasanya berada pada `models/sh17-runs/baseline/weights/best.pt`. Setelah parameter dipilih menggunakan VALIDATION, gunakan TEST untuk evaluasi akhir model baru:

```powershell
yolo detect val model="models/sh17-runs/baseline/weights/best.pt" data="data/private/public-datasets/sh17/prepared/training/data.yaml" split=test imgsz=640 batch=1 device=0
```

Pelatihan, pemasangan dependensi GPU, dan integrasi bobot detektor ke kamera belum dijalankan pada tahap penambahan dataset ini. Gemma/Ollama tetap memakai bobot yang telah terpasang.
