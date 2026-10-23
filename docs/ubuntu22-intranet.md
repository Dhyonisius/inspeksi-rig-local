# Ubuntu 22.04, audit fitur, dan akses intranet

## Lingkungan yang disiapkan

Ubuntu 22.04 adalah OS akhir, bukan pengganti Node.js. Server tetap `node server.js` (Node 22). Stage `node:22-bookworm-slim` hanya menyumbangkan binary Node/npm dan CA publik; paket OS runtime berasal dari Ubuntu Jammy. Ini menghindari skrip pemasang NodeSource yang berubah dan tidak mengunduh paket Debian saat menyusun runtime. Kedua base image tetap perlu dapat ditarik; gunakan UBUNTU_IMAGE/NODE_IMAGE untuk mirror/digest yang disetujui.

| Fungsi | Kebutuhan/pengaruh migrasi | Penyesuaian |
|---|---|---|
| Server dan UI | Node 22; asset UI tidak berubah | Node/npm dipertahankan; bootstrap smoke memeriksa major Node |
| Login, riwayat, dataset, anotasi, evaluasi, konfigurasi | SQL Server, sqlcmd/ODBC, skema, login runtime | SQL tools wajib terpasang; tidak lagi diam-diam dilewatkan |
| Unggah, preview, sanitasi, resize | Python + Pillow | `/opt/venv/bin/python`, virtualenv terpisah |
| Impor foto PDF dan konteks checklist | Pillow, PyMuPDF, pypdf, pdfplumber | Dua dependensi PDF yang hilang ditambahkan; smoke memakai PDF sintetis |
| Inspeksi AI dan usulan label | Ollama dengan model yang mendukung vision | Endpoint aplikasi sudah dari OLLAMA_BASE_URL; helper anotasi lama sekarang juga menghormatinya |
| Worker anotasi lama | Lock proses Windows/Linux | Pemeriksaan PID lintas OS; PID hidup atau tidak dapat diakses tidak direbut |
| Training model rig | PyTorch CPU, torchvision, Ultralytics, bobot awal, dataset berizin/terverifikasi | Stack CPU kompatibel dipasang dalam `/opt/training`; jalur RIG_TRAINING_PYTHON_EXE dipulihkan |
| Ekspor/inferensi detektor | ONNX, ONNX Runtime, NumPy, model dan manifest valid | DETECTOR_PYTHON_EXE dipulihkan; helper persiapan memakai interpreter image dan tidak menginstal ulang ke PVC |
| Kamera laptop/USB | Browser dan izin pengguna | Kamera berada pada browser, bukan container; perlu localhost atau HTTPS tepercaya |
| Data dan model | PVC/volume persisten | Hanya `/app/data`, `/app/models` dan `/tmp` yang perlu dapat ditulis; kode/virtualenv tidak diberi group-write |
| Peluncur Windows langsung | start-local.cmd/ps1 dan instalasi laptop | Tetap dipertahankan; tidak memakai Dockerfile |

Profil penuh adalah default `INSTALL_RIG_TRAINING=true`. Profil ringan `false` sengaja tidak menyediakan training/ONNX. Tidak ada bobot, model Ollama, database, PDF/foto privat, atau dataset yang disisipkan ke image. Dependensi tersedia tidak berarti model sudah terlatih atau hasilnya layak digunakan tanpa pemeriksaan manusia.

## Membangun dan menguji image

Setelah persetujuan lisensi Microsoft SQL tools:

```sh
docker build --platform linux/amd64 --build-arg ACCEPT_SQLTOOLS_EULA=Y --build-arg INSTALL_RIG_TRAINING=true -t inspeksi-rig:ubuntu22 .
docker run --rm --entrypoint /opt/venv/bin/python inspeksi-rig:ubuntu22 /app/scripts/container-smoke.py
docker run --rm --entrypoint /opt/training/bin/python inspeksi-rig:ubuntu22 /app/scripts/container-smoke.py --training
docker run --rm --entrypoint sh inspeksi-rig:ubuntu22 -ec 'node --test /app/scripts/*.test.js'
```

`container-smoke.py` memeriksa JPEG, teks PDF, operator NMS torchvision dan inferensi ONNX sintetis. Ini tidak membutuhkan foto privat atau mengunduh bobot. Workflow **Build image for OpenShift** menjalankan pemeriksaan tersebut, uji non-root UID acak/read-only, dan pemeriksaan dependency sebelum publish; jalankan secara manual pada ref Ubuntu dengan `include_training=true`. Lisensi paket/model harus sesuai penggunaan organisasi. Bobot SH17 bawaan helper mencantumkan CC BY-NC-SA; jangan otomatis menganggap bobot tersebut berizin untuk pemakaian perusahaan. Gunakan bobot/dataset yang telah disetujui atau model organisasi sendiri.

## Menjalankan di laptop

Jika langsung di Windows, gunakan `start-local.cmd` seperti sebelumnya; SQL Express, SQLCMD, Python dan Ollama harus tersedia pada laptop. Perubahan Dockerfile tidak memigrasikan atau menghapus database laptop.

Untuk mencoba image Ubuntu di Docker Desktop:

1. Salin `deploy/container/local.env.example` ke `.env` pada root repo dan isi login SQL khusus. Jangan commit `.env`.
2. SQL harus memiliki alamat TCP dan port tetap yang disetujui. `.\\SQLEXPRESS`/Windows Authentication dari laptop tidak otomatis berlaku di container Linux.
3. Endpoint laptop dari Docker Desktop ialah `host.docker.internal`; `localhost` di dalam container mengarah ke container itu sendiri. SQL/Ollama harus mendengarkan pada interface yang dapat dijangkau container sesuai pengaturan yang disetujui administrator.
4. Tambahkan CA publik SQL/proxy yang disetujui sebagai `.crt` di `deploy/container/ca`, lalu build. Sertifikat SQL harus cocok dengan hostname endpoint. TLS tetap mandatory dan validasi sertifikat tetap aktif.
5. Untuk database **baru khusus demo**, inisialisasikan dengan Job bootstrap OpenShift atau perintah bootstrap container di bawah. Login migrator harus terpisah dari login runtime. Database existing harus ditinjau/di-backup sebelum migrasi.

```sh
docker compose --env-file .env -f deploy/container/compose.local.yaml build
# Sebelum up: jalankan bootstrap dengan kredensial migrator terpisah.
docker run --rm --env-file .env.bootstrap --entrypoint node inspeksi-rig:ubuntu22-local scripts/openshift-bootstrap.js
docker compose --env-file .env -f deploy/container/compose.local.yaml up -d
```

`.env.bootstrap` dibuat lokal dan diabaikan Git. Isinya SQL_SERVER, SQL_USER/SQL_PASSWORD migrator, BOOTSTRAP_ADMIN_EMAIL, BOOTSTRAP_ADMIN_PASSWORD unik minimal 16 karakter. Gunakan SQL_ENCRYPT=mandatory dan SQL_TRUST_SERVER_CERTIFICATE=false. Jangan gunakan akun runtime untuk CREATE DATABASE/skema. Default image lokal bernama `inspeksi-rig:ubuntu22-local`, sesuai Compose.

Buka `http://localhost:3180`. Compose memakai NODE_ENV=development hanya karena port dipublikasikan ke **127.0.0.1 laptop** dan menggunakan HTTP. Jangan gunakan profil tersebut untuk akses LAN Pertamina. Data/model memakai named volume; tidak berisi data laptop secara otomatis. Jalur pelatihan/SH17 memerlukan bobot dan manifest sah dipasang pada volume models secara terpisah.

## Akses dari jaringan lokal Pertamina melalui OpenShift

Arsitektur target: browser di jaringan/VPN perusahaan → HTTPS hostname internal → router OpenShift internal → Service → satu pod aplikasi → SQL dan Ollama internal; foto/model berada pada PVC.

Tim platform perlu menyediakan project/kuota, DNS/hostname internal, router yang mengizinkan host itu, sertifikat HTTPS tepercaya browser, endpoint SQL/Ollama yang dapat dijangkau pod, dan storage. Nama DNS saja **tidak membuat Route privat**. Pemilihan router internal dan pembatasan jaringan dilakukan tim platform pada infrastruktur yang disetujui; template repo tidak mengubah DNS, firewall, proxy, atau SCC.

1. Build dari ref yang memuat perbaikan Ubuntu (`fix/ubuntu22-runtime-complete` sebelum merge). `build.yaml` sekarang menunjuk ref tersebut dan profil penuh. Setelah merge, sesuaikan ref ke main. Izin lisensi tetap eksplisit melalui patch persetujuan; jangan menaruh token/password pada buildArgs.
2. Tambahkan CA publik perusahaan saat build; untuk jaringan terisolasi gunakan mirror image/paket yang dikelola IT. Node, Python/pip/requests dan SQL tools memakai trust store yang disiapkan image. Tetap verifikasi koneksi SQL dengan sertifikat hostname yang sesuai.
3. Sediakan Secret runtime, migrator dan bootstrap sesuai `deploy-openshift.md`. SQL Server dan Ollama merupakan layanan terpisah; Dockerfile aplikasi tidak memasang keduanya.
4. Buat runtime-template dengan digest image, endpoint yang benar, PVC, serta resource yang sesuai. Deployment mulai pada replicas=0. Batas awal profil penuh CPU=2 dan memori=6Gi dapat diubah melalui APP_CPU_LIMIT/APP_MEMORY_LIMIT; lakukan sizing memakai dataset nyata. Jangan menaikkan replica sebelum session/queue terpusat tersedia.
5. Jalankan bootstrap, tunggu sukses, lalu buat Route dengan hostname yang telah disetujui tim platform. Router harus menyediakan sertifikat default yang valid untuk host itu, atau tim platform memasang sertifikat sesuai prosedurnya.

```powershell
$internalHost = 'HOST_INTERNAL_DARI_TIM_PLATFORM'
oc process -f deploy/openshift/route-template.yaml -p "HOSTNAME=$internalHost" | oc apply -f -
oc set env deployment/inspeksi-rig "APP_ORIGIN=https://$internalHost"
oc scale deployment/inspeksi-rig --replicas=1
oc rollout status deployment/inspeksi-rig --timeout=1800s
```

Jangan menjalankan dengan hostname contoh. Uji dari browser Pertamina: sertifikat HTTPS valid, login admin bootstrap, `/readyz` sukses, unggah foto uji berizin, inferensi vision, riwayat, koreksi, impor PDF, training dan aktivasi model pada dataset uji. Restart pod lalu cek data tetap ada. Uji kamera memerlukan izin browser pengguna. Jangan menganggap build sukses membuktikan seluruh pengujian integrasi tersebut lulus.

## Status verifikasi perubahan ini

Test JavaScript dan helper lintas OS dapat dijalankan tanpa cluster. Tiga test halaman performa dilaporkan skipped karena asset `public/performance-ui.js` memang tidak ada pada branch ini; halaman tersebut tidak dibuat ulang oleh migrasi Ubuntu. Test yang memerlukan runtime Python tertentu dapat memiliki skip tersendiri. Pengujian image Ubuntu, SQL/Ollama nyata, training dengan bobot dan akses intranet harus dicatat terpisah saat benar-benar dijalankan. Lihat hasil workflow build sebelum menggunakan image untuk rollout perusahaan.

Referensi: [SQL tools Ubuntu](https://learn.microsoft.com/en-us/sql/linux/install-upgrade/setup-tools), [aturan image OpenShift](https://docs.redhat.com/en/documentation/openshift_container_platform/4.20/html/images/creating-images).
