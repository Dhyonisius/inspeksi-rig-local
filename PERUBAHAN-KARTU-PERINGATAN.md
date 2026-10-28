# Kartu peringatan peralatan — 28 Oktober 2026

Pesan pembuka pada AI Inspeksi Visual diganti dengan ringkasan dan kartu peringatan dari laporan terbaru setiap rig.

- Ringkasan NOT_READY, kebutuhan penggantian, dan jumlah catatan tindak lanjut.
- Kartu menampilkan peralatan, butir pemeriksaan, remark sumber, rig, tanggal, peran, dan halaman asal.
- Penanda penggantian mengikuti kolom penggantian eksplisit atau remark yang menyebut kebutuhan penggantian. NOT_READY saja tidak dianggap perlu diganti. Negasi dan catatan bahwa penggantian sudah selesai tidak ditandai sebagai kebutuhan penggantian baru.
- Item NA dikecualikan. Peringatan dari versi laporan lama tidak ditampilkan lagi jika versi terbaru sudah READY.
- Filter rig dan kategori, pagination empat kartu per halaman, tombol Perbarui, serta penyegaran otomatis setiap menit saat tab terlihat.
- Pesan yang jelas ditampilkan untuk dataset kosong, filter tanpa hasil, dan kesalahan pemuatan.
- Data dummy tetap ditandai sebagai simulasi.

API baru: `GET /api/pdf-hub/warnings`, memerlukan sesi masuk seperti endpoint data lainnya. Hasil disimpan sementara 30 detik agar tidak membaca seluruh arsip pada setiap permintaan.

Verifikasi: enam pengujian aturan lulus, mencakup remark, penanda penggantian, NA, negasi, penggantian selesai, versi terbaru, dan provenance. Filter kategori serta rig juga diperiksa melalui browser pada aplikasi lokal. Pada snapshot pengujian terdapat 56 catatan NOT_READY dan 0 kebutuhan penggantian dari 28 rig; angka ini akan berubah mengikuti dataset terbaru.

Perubahan tersedia pada kode sumber ini. Deployment OpenShift memerlukan build dan rollout baru sesuai panduan perusahaan.
