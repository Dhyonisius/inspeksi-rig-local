# Menjalankan pengambilan PDF dan percobaan VLM belajar

## Yang tersedia di lokal

- Inspeksi Visual: <http://127.0.0.1:3180/>.
- Sumber dummy: <http://localhost:5091/>. Dashboard memuat **28 rig**, **5 rig per halaman**, **6 halaman**, dan satu tombol **Export PDF per rig**. Halaman terakhir memuat 3 rig. Pilihan 10/20 per halaman juga tersedia.
- API dummy opsional: <http://localhost:5091/api/reports>. Pengguna dapat tetap memakai tautan halaman biasa tanpa mengetahui API.
- Menu **AI Inspeksi Visual** memuat chatbot Gemma dan panel **VLM belajar · percobaan lokal**.

Kode ini mencakup fitur lokal terbaru. Deployment OpenShift yang sudah berjalan tidak otomatis diperbarui. Lihat PANDUAN-DEPLOY-OPENSHIFT-PERUSAHAAN.md untuk pemasangan perusahaan. Sumber dummy terpisah tidak termasuk paket deployment perusahaan dan tidak berjalan otomatis.

## Alur data dan penyimpanan

1. Administrator mengisi tautan halaman laporan atau API di **Alat lanjutan → Konfigurasi → Sumber PDF otomatis**.
2. **Mulai** menelusuri setiap halaman Next dan mengumpulkan seluruh tautan PDF. API JSON dengan array `data`, `reports`, atau `items`, kolom `pdf_url`/`download_url`/`export_pdf_url`, dan `pagination.next_url`/`next_url`/`links.next` juga didukung.
3. Setiap PDF diunduh dan diekstrak menjadi JPEG serta data terstruktur: kode SHA-256 foto, rig, tanggal, peralatan, butir pemeriksaan, peran, status sumber, catatan, halaman asal, hash PDF, dan provenance tautan. Metadata API ikut disimpan bila tersedia.
4. NA pada metadata/catatan dikecualikan. Untuk PDF CRSSC biasa, OCR lokal juga mendeteksi tulisan N/A besar pada foto. OCR dapat keliru pada foto buram atau format lain.
5. PDF identik tidak menggandakan dokumen. Kegagalan satu PDF dicatat dan tidak menghalangi rig lain; putaran yang gagal tidak dilaporkan lengkap. PDF gagal dicoba lagi pada putaran berikutnya.
6. Pengambilan diulang 15 menit **setelah putaran sebelumnya selesai**, tanpa pekerjaan tumpang tindih. **Stop** membatalkan pengunduhan aktif dan menghentikan jadwal sampai **Mulai** ditekan lagi.
7. **PDF unduhan dihapus setelah berumur 3 jam**, dengan pemeriksaan setiap menit. Pembersihan ini tetap berjalan ketika pengunduhan dihentikan. Hanya berkas `source.pdf` dalam penyimpanan modul ini yang dihapus; PDF asli pengguna di Downloads dan arsip server sumber tidak diubah.

Jika server asal hanya menyimpan metadata/tautan foto dan PDF hariannya akan hilang setelah 3 bulan, aplikasi ini mengambil bukti visual dari PDF sebelum arsip tersebut hilang. Menyimpan URL saja tidak cukup. Tautan asli, autentikasi, dan bentuk API server sebenarnya belum tersedia untuk diverifikasi; pengujian integrasi dilakukan memakai sumber dummy.

Batas saat ini: 50 halaman sumber, 200 tautan PDF per putaran, PDF 20 MiB, HTML/JSON 2 MiB, PDF maksimal 150 halaman, batas waktu per PDF 120 detik, dan per putaran 30 menit. Situs dengan login atau tombol JavaScript yang tidak menyediakan tautan PDF/Next memerlukan konektor khusus. Sistem tidak mengklaim berhasil mengambil semua rig bila jumlah yang ditemukan kurang dari jumlah pada halaman.

## VLM belajar dan penghapusan JPEG

**Gemma chatbot tidak otomatis berubah bobotnya.** Model belajar lokal yang ditambahkan adalah **HuggingFaceTB/SmolVLM-256M-Instruct**, dengan LoRA/adaptor tersimpan terpisah. Saat ini tugas yang divalidasi pada model kecil ini terbatas pada **klasifikasi READY / NOT_READY pada diagram dummy**. Ini bukan model keselamatan operasional dan tidak boleh dianggap sudah terlatih pada foto rig asli.

Alur percobaannya:

1. Foto non-NA masuk antrean; kode foto dan metadata tetap disimpan.
2. Worker mengambil paling banyak 12 contoh per batch. Dua contoh dari kelas berbeda disisihkan untuk evaluasi; contoh yang disisihkan mendapat giliran pelatihan pada batch berikutnya ketika data baru tersedia.
3. Pelatihan benar-benar mengubah bobot LoRA. Dataset dummy dan data asli dipisahkan.
4. Sebelum JPEG boleh dihapus, worker harus membuktikan perubahan bobot, penurunan validation loss, jawaban benar pada dua kelas evaluasi, checkpoint tersimpan dengan hash yang cocok, serta hasil muat ulang checkpoint yang konsisten.
5. Jika pemeriksaan lulus, hanya JPEG untuk contoh yang benar-benar dilatih yang dihapus. Kode, metadata, receipt checkpoint, model dasar, adaptor dan versi model tetap disimpan. Galeri menampilkan kode pengganti foto.
6. Jika pelatihan gagal, dihentikan, melewati batas sumber daya, atau hasil jawaban tidak lulus, JPEG tetap tersedia. Foto asli belum diizinkan dibersihkan oleh model percobaan ini; foto asli menunggu trainer dan evaluasi yang sesuai.

Pengujian awal menunjukkan bahwa penurunan loss saja belum cukup: model bisa menghasilkan jawaban berulang. Oleh karena itu, syarat penerimaan memasukkan evaluasi jawaban visual. Foto batch percobaan awal yang sempat dibersihkan telah dipulihkan dari PDF sebelum syarat baru diterapkan.

Menyimpan bobot/adaptor adalah cara mempertahankan hasil pelatihan setelah foto dihapus. Namun model tidak menyimpan salinan sempurna setiap foto, akurasi tidak dijamin hanya dari dua contoh evaluasi, dan pelatihan berkelanjutan dapat menyebabkan model lupa. Versi checkpoint lama dipertahankan untuk pemulihan. Untuk penggunaan lapangan diperlukan evaluasi lebih luas dan model/trainer yang memadai; jangan menghapus bukti lapangan berdasarkan hasil percobaan dummy.

## Pembatasan beban laptop

- Worker memakai **CPU, maksimal 2 thread**, tanpa memaksa pelatihan Gemma pada GPU RTX 2050 4 GB.
- Satu pekerjaan maksimal 15 menit. Proses dihentikan jika penggunaan RAM worker melampaui sekitar 2,3 GiB, RAM tersedia turun di bawah sekitar 650 MiB, atau server induk berhenti. Pembatas ini mengurangi risiko beban berlebih, bukan jaminan mutlak penggunaan sumber daya.
- **Hentikan pelatihan** menghentikan worker dan menonaktifkan pelatihan otomatis. Pengaturan pengunduhan dan pelatihan terpisah.
- Mode otomatis memeriksa antrean tiap 15 menit. Antrean dapat bertambah bila data masuk lebih cepat daripada pelatihan; data yang belum lulus tidak dihapus untuk mengejar ruang kosong.
- Dataset dummy yang berubah setiap 15 menit adalah beban simulasi; server lapangan yang menerbitkan PDF harian memiliki laju data berbeda.

## Memakai panel belajar

1. Buka **AI Inspeksi Visual**, lalu gulir ke **VLM belajar · percobaan lokal**.
2. Lihat antrean, tahap proses, checkpoint, dan jumlah JPEG yang dibersihkan.
3. **Latih batch dummy** menjalankan satu batch percobaan. Sakelar otomatis mengatur pemeriksaan antrean berikutnya.
4. **Uji diagram dummy baru** menerima JPG/PNG/WebP maksimal 3 MiB, menggunakan checkpoint model belajar, dan menampilkan label prediksinya. Masukan uji dihapus setelah proses selesai.
5. Tombol data asli dinonaktifkan sampai model/trainer untuk foto asli divalidasi. Chatbot Gemma tetap dapat menjawab dari metadata laporan yang tersimpan, termasuk setelah JPEG foto latihan dibersihkan.

## Menjalankan ulang di komputer ini

Untuk aplikasi inspeksi, gunakan `start-local.ps1` pada proyek lokal yang sudah memiliki SQL Server dan databasenya. Salinan sumber bersih ada dalam folder `ai-inspeksi-visual`; data aplikasi aktif tetap berada pada proyek lokal sebelumnya.

Jika memiliki paket sumber dummy lokal terpisah, buka PowerShell di folder `crssc-dummy` (paket tersebut tidak disertakan dalam repository ini):

```powershell
python -m pip install -r requirements.txt
.\start-dummy.ps1
```

Dependensi PDF/OCR aplikasi utama berada di `deploy/container/requirements.txt`. Worker belajar adalah dependensi **opsional** yang cukup besar; pada komputer lain dapat disiapkan dengan:

```powershell
.\scripts\setup-vlm-learning.ps1
```

Peluncur memerlukan Node.js, Python, SQL Server/sqlcmd; chatbot memerlukan Ollama dengan `gemma3:4b`. Pengunduhan model dasar SmolVLM pertama memerlukan internet. Pelatihan dan inferensi gambar berjalan lokal; foto tidak dikirim ke Hugging Face. Adaptor memerlukan model dasar yang sesuai untuk digunakan kembali.

## Direktori data penting

- `data/private/pdf-hub/documents/<hash>/report.json`: metadata, kode, dan receipt pelatihan.
- `data/private/pdf-hub/documents/<hash>/source.pdf`: PDF sementara, dibersihkan setelah 3 jam.
- `data/private/pdf-hub/documents/<hash>/images/<kode>.jpg`: JPEG yang belum selesai dilatih/evaluasi.
- `data/private/vlm-learning/base-model-cache/`: model dasar.
- `data/private/vlm-learning/jobs/<job>/adapter/`: adaptor/checkpoint.
- `data/private/vlm-learning/registry.json`: model aktif dan catatan hasil belajar.

Direktori data harus disimpan pada PVC saat digunakan di OpenShift. Jangan menghapus model dasar/adaptor/registry bila ingin mempertahankan hasil belajar. Paket sumber tidak menyertakan foto asli atau kredensial pengguna.

## OpenShift

Dockerfile aplikasi utama mempertahankan dukungan deployment sebelumnya. Worker percobaan CPU bisa disertakan melalui build argument `INSTALL_VLM_TRAINING=true`; default `false`. Ini belum dibangun atau diuji pada cluster untuk versi fitur ini. Worker membutuhkan alokasi memori lebih besar daripada aplikasi web saja; evaluasi quota sebelum diaktifkan. Untuk pelatihan VLM lapangan yang lebih besar, gunakan worker terpisah dengan sumber daya yang sesuai.

Sumber dummy mempunyai Dockerfile dan manifest `openshift-pdf-dummy.yaml`. Set `PDF_SOURCE_ALLOWED_HOSTS` dengan host route sumber, kemudian masukkan tautan HTTPS route di Konfigurasi. Untuk koneksi internal namespace yang sama dapat memakai `http://crssc-dummy:8080/`, `PDF_SOURCE_ALLOWED_HOSTS=crssc-dummy:8080`, dan `PDF_SOURCE_ALLOW_HTTP=1`. `localhost:5091` pada pod tidak mengarah ke laptop.

Pertahankan koneksi SQL, secret, `APP_ORIGIN`, `OLLAMA_BASE_URL`, dan PVC deployment lama. Scheduler berbasis berkas ini memerlukan **satu replica** aplikasi; belum ada distributed lock. Otomasi browser yang perlu login tidak disiapkan tanpa halaman sumber sebenarnya.

## Menjalankan pengujian

```powershell
node --test scripts/pdf-hub.test.js scripts/vlm-learning.test.js
```

Pengujian mencakup pagination, 28 tautan PDF, deduplikasi, kegagalan sebagian, Stop, validasi host/redirect, API metadata, TTL 3 jam dengan jam simulasi, receipt model, serta perlindungan foto saat checkpoint/evaluasi gagal. Pengujian terisolasi tidak membutuhkan GPU atau menghapus foto pengguna.

Sumber teknis: [model SmolVLM](https://huggingface.co/HuggingFaceTB/SmolVLM-256M-Instruct), [pelatihan VLM dengan TRL](https://huggingface.co/docs/trl/sft_trainer), [impor model Ollama](https://docs.ollama.com/import).

Pembaruan 28 Oktober 2026: pesan pembuka AI Inspeksi Visual diganti dengan kartu NOT_READY dan penggantian berdasarkan remark laporan terbaru. Tersedia filter rig/kategori dan pagination. Lihat PERUBAHAN-KARTU-PERINGATAN.md.
