# Memperbarui tema dan halaman login di OpenShift

Paket mencakup glassmorphism, kartu login Inspeksi Visual, latar slide 3 dengan enam cahaya bergerak, serta susunan kesiapan rig dan peringatan peralatan. Akun demo tidak lagi ditampilkan sebagai bagian bantuan pada kartu login. Aset di public/ dibundel dalam image; tidak memerlukan CDN, PowerPoint, model AI baru, migrasi SQL, atau konfigurasi lingkungan baru.

## Aplikasi yang sudah berjalan

1. Gunakan namespace dan BuildConfig aplikasi yang benar. Catat digest image aktif beserta manifest Deployment untuk rollback. Pertahankan konfigurasi SQL, Secret, CA, volume/PVC, endpoint AI, Route, serta kebijakan perusahaan yang sudah digunakan.
2. Pastikan sumber BuildConfig menunjuk repository Dhyonisius/inspeksi-rig-local dan commit rilis yang ingin dipakai. BuildConfig contoh bernama inspeksi-rig dan memakai branch main. Untuk reproduksibilitas, pilih commit rilis yang terverifikasi; main dapat terus berubah.
3. Jalankan build dengan buildArgs/lisensi yang telah disetujui administrator sebelumnya:

   ```sh
   oc start-build inspeksi-rig --follow
   ```

4. Periksa revision sumber dan digest image hasil build. Uji image di staging. Perbarui digest container aplikasi **dan kedua init container** secara konsisten pada Deployment yang sudah ada. Jangan mengganti manifest perusahaan dengan contoh yang masih berisi placeholder.
5. Tunggu rollout:

   ```sh
   oc rollout status deployment/inspeksi-rig
   ```

6. Muat ulang browser dengan Ctrl+F5. Periksa login melalui Route HTTPS, latar buram dan cahaya bergerak, ketajaman formulir, menu, kamera/unggah foto, kesiapan/peringatan, chatbot, serta dialog diagnostik admin. Uji mode reduced motion: gambar tetap ada tanpa titik bergerak. Browser tanpa backdrop-filter memakai kartu solid.
7. Bila bermasalah, terapkan kembali digest image sebelumnya untuk container aplikasi dan init container, lalu periksa rollout. Pertahankan data/PVC dan konfigurasi perusahaan.

Push GitHub memperbarui kode sumber. Build image dan rollout ke cluster perusahaan tetap perlu dilakukan oleh pengelola OpenShift. Pembaruan ini belum diuji langsung di cluster perusahaan dan tidak memicu deployment otomatis.

Lihat juga [panduan chatbot dan konektor perusahaan](update-openshift-chatbot.md) untuk konfigurasi layanan AI yang sudah digunakan.
