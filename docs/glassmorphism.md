# Tema glassmorphism

Tema menggunakan public/glass-theme.css yang dimuat setelah microinteractions.css. Latar gradasi biru–teal, panel transparan, blur pada shell/dialog, garis terang, sudut membulat, serta warna teks gelap diterapkan pada navigasi, dashboard, kartu, formulir, tabel, login, chatbot, dan dialog diagnostik.

Foto, video, dan canvas anotasi tidak diberi filter. Warna peringatan tetap kuning/merah dan tombol hapus tetap merah. Browser tanpa backdrop-filter menggunakan permukaan solid. prefers-reduced-transparency, forced-colors, dan cetak memiliki fallback.

Pemeriksaan visual lokal dilakukan pada viewport desktop 1440 x 900 serta ponsel 390 x 844: dashboard, panel chatbot, dan dialog diagnostik. Tidak ada overflow horizontal pada pemeriksaan ponsel. Koreksi posisi brand desktop disertakan karena backdrop-filter membuat containing block baru.

Pratinjau pengujian tersedia di http://127.0.0.1:3184. Untuk kembali ke tema sebelumnya, hapus pemuatan glass-theme.css dari public/index.html.

## Latar login dari slide 3

Gambar asli slide 3 digunakan sebagai public/login-slide3.png. Enam titik cahaya dengan warna, jalur gerak, durasi 2,8 detik, dan jeda pasangan 1,1 detik diekstrak dari XML slide lalu direkonstruksi dalam SVG animateMotion pada public/login-scene.js. Ini animasi browser, bukan pemutaran PowerPoint/video. SVG menggunakan preserveAspectRatio slice agar latar memenuhi viewport tanpa meregangkan proporsi.

Hanya lapisan latar diberi blur 7px serta overlay gelap. Kartu login tetap terang dan memakai backdrop blur. Lapisan dekorasi tidak menerima klik serta disembunyikan dari pembaca layar. Mode reduced motion menyembunyikan partikel bergerak dan mempertahankan gambar statis. Aset hanya dimuat ketika formulir login dibuat; latar hilang bersama login setelah masuk.

Verifikasi browser: keenam elemen gerak tersedia, posisi titik cahaya berubah antarpengamatan, blur 7px aktif, lebar halaman tidak melebihi viewport 790px. Pratinjau lokal tersedia di port 3184.

## Kartu kesiapan dan peringatan

Kartu diberi padding serta jarak terpisah. Saat belum ada laporan, angka tampil sebagai tanda — dan filter disembunyikan; status kesiapan tetap Belum dapat dinilai. Setelah laporan tersedia, angka dan filter menggunakan data sumber seperti sebelumnya. Tidak ada perubahan skema SQL atau kontrak API.

## Pengemasan OpenShift

Seluruh aset memakai URL relatif terhadap origin aplikasi dan berada di public/. Dockerfile menyalin direktori public secara utuh dan .dockerignore mengizinkannya, sehingga gambar PNG, skrip animasi, dan CSS masuk ke image tanpa CDN atau dependensi tambahan. Tidak diperlukan variabel lingkungan baru. Bangun ulang image dan lakukan rollout sesuai [panduan pembaruan UI](update-openshift-ui.md).
