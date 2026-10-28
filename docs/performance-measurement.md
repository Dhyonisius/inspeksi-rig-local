# Pengukuran lokal — 5 Oktober 2026

Pengukuran ini memakai Gemma3:4b yang sudah terpasang pada Ollama, dua foto pemeriksaan yang sudah tersimpan, serta katalog dan area aplikasi. Foto asli hanya dibaca. Hasil pengukuran tidak dimasukkan ke riwayat, dataset, atau koreksi pengguna. Tidak ada pelatihan bobot model.

## Waktu yang diamati

| Foto pemeriksaan | Mode | Salinan AI | Waktu seluruh proses | Waktu VLM | Pemuatan model |
|---|---|---|---|---|---|
| #7 | Hemat | 576 × 768 | 67,1 detik | 64,9 detik | 14,3 detik |
| #7 | Detail | 768 × 1.024 | 46,9 detik | 46,5 detik | 0,012 detik |
| #5 | Hemat | 768 × 576 | 54,6 detik | 53,8 detik | 0,014 detik |
| #5 | Detail | 1.024 × 768 | 38,0 detik | 37,6 detik | 0,016 detik |

Urutan pengukuran adalah Hemat lalu Detail untuk tiap foto. Pengukuran pertama mencakup pemuatan model. Jawaban tiap mode berbeda panjangnya: masing-masing 280, 217, 312, dan 136 token keluaran. Pada sampel ini Detail lebih cepat. Hasil ini tidak membuktikan bahwa Detail selalu lebih cepat atau Hemat selalu lebih lambat. Resolusi kecil mengurangi ukuran masukan; durasi juga dipengaruhi pemuatan model, panjang jawaban, dan beban perangkat.

Keempat jawaban menghasilkan status Perlu perhatian. Tidak ada label acuan manusia yang dibandingkan, sehingga pengukuran ini tidak menilai akurasi. Kerusakan kecil tetap perlu diperiksa dengan foto tajam dan Mode Detail bila perlu.

## Memori dan detektor

Pembacaan sesudah analisis menunjukkan RAM perangkat tersedia sekitar 0,3–0,6 GiB dan GPU NVIDIA sekitar 648–660 MiB terpakai. Angka ini adalah kondisi seluruh perangkat ketika dibaca, bukan puncak memori Gemma dan bukan konsumsi khusus aplikasi. Metrik GPU memiliki cache 10 detik. Banyak aplikasi yang terbuka dapat memengaruhi hasil.

Detektor CPU juga dipanggil terpisah pada salinan foto, tetapi petunjuk detektor tidak dimasukkan ke prompt selama perbandingan profil ini. Detektor SH17 tersendiri pada tiga foto VALIDATION membutuhkan sekitar 99–107 ms setelah pemanasan, dengan RAM worker sekitar 109–123 MiB. Angka detektor tidak mewakili waktu total Gemma.

## Cara mengukur lagi

1. Hentikan Inspeksi langsung dan pastikan tidak ada analisis lain.
2. Masuk sebagai admin dan buka Performa.
3. Pilih model dan 1–3 foto yang sama, lalu tekan Ukur foto terpilih.
4. Periksa waktu tiap profil dan gunakan Hentikan pengukuran bila diperlukan.

Jeda kamera dihitung setelah hasil selesai. Dengan analisis 50 detik dan jeda 10 detik, satu siklus memerlukan sekitar 60 detik. Kamera tetap menyediakan pratinjau, tetapi penilaian Gemma merupakan pemeriksaan foto berkala, bukan keputusan keselamatan video setiap frame.

Hasil rinci lokal: `performance-measurement.json`. Script manual: `scripts/benchmark-vision.mjs` (kredensial akun lokal melalui variabel lingkungan). Metrik server dan benchmark UI disimpan di RAM; riwayat maksimal lima pekerjaan dan 100 sampel, sehingga reset saat server dimulai ulang.
