# Lampiran PDF pada chatbot

Buka chatbot, pilih PDF pada bagian Lampirkan PDF, tulis pertanyaan, lalu Kirim. Lampiran tetap digunakan untuk pertanyaan berikutnya sampai dihapus atau halaman ditutup. Mengganti lampiran mengosongkan konteks percakapan yang dikirim ke model.

Batas: satu PDF, maksimal 8 MB dan 8 halaman, tidak diproteksi sandi. Semua halaman dikirim sebagai gambar JPEG (sisi terpanjang maksimal 1400 piksel) beserta teks yang diekstrak. Ini mendukung PDF hasil pindai; kualitas bacaan mengikuti kualitas gambar. Jawaban meminta rujukan nomor halaman dan tetap perlu diverifikasi.

PDF dan hasil render hanya diproses di memori aplikasi; fitur ini tidak menambahkan file ke dataset, database, atau penyimpanan PDF. Isi dokumen dikirim ke penyedia model yang dikonfigurasi, sehingga kebijakan pencatatan penyedia tetap berlaku. Riwayat jawaban berada pada sesi halaman browser.

## OpenShift

Setelah build kode terbaru, gunakan image hasil build pada container `app` di Deployment `inspeksi-rig`, bukan hanya initContainer. Di Environment atau ConfigMap tambahkan:

```
INSPECTION_PDF_BASE_URL=http://llm-bridge:8080
INSPECTION_PDF_MODEL=<nama model publik vision yang dilayani bridge>
```

Gunakan nama model yang benar dari pengelola layanan. Token tetap dikelola bridge melalui Secret yang sudah ada. Model harus menerima gambar melalui `/api/chat`; mengganti nama konfigurasi tidak menambahkan kemampuan vision pada model teks. Jangan menambahkan `/v1` pada URL bridge Ollama ini.

Jika variabel khusus PDF tidak disetel, endpoint mengikuti INSPECTION_CHAT_BASE_URL atau OLLAMA_BASE_URL. Model mengikuti INSPECTION_CHAT_MODEL bila ada; jika tidak, dicari dari daftar model vision. Disarankan menetapkan kedua variabel PDF secara eksplisit di perusahaan agar terpisah dari model chatbot teks.

Dependensi PyMuPDF sudah tercantum pada deploy/container/requirements.txt. Restart rollout setelah mengubah variabel lingkungan. PDF menggunakan model vision langsung, tidak melalui pencarian endpoint PROTECT. Checkbox penjelasan AI hanya berlaku untuk pertanyaan tanpa lampiran; lampiran selalu membutuhkan vision.

## Validasi

`node --test scripts/chat-pdf.test.js`

Uji lokal model gemma3:4b berhasil menjawab judul dan nomor halaman dari halaman pertama contoh CRSSC. Render seluruh delapan halaman contoh juga berhasil. Layanan internal perusahaan tetap perlu diuji setelah deploy karena tidak dapat diakses dari localhost ini.
