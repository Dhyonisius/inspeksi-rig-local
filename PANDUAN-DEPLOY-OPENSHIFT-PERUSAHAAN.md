# Menjalankan Inspeksi Visual pada OpenShift perusahaan

Paket ini menempatkan **aplikasi dan SQL Server dalam project yang sama**, dengan penyimpanan terpisah. Gunakan project yang diberikan tim IT, misalnya `protect2-ai-dev`. Nama project dan domain perusahaan tidak dikunci dalam manifest.

**Status:** berkas disiapkan untuk deployment; belum diterapkan atau diuji di cluster perusahaan. Pengujian aplikasi dilakukan pada tahap berikutnya. Data, foto, password, dan model dari laptop tidak otomatis ikut ke server. Generator data dummy tidak dijalankan oleh paket ini.

## 1. Buka project dan periksa kebutuhan

1. Masuk ke console OpenShift perusahaan dan pilih project yang diberikan.
2. Gunakan menu **Administrator** jika ingin mengikuti nama menu di bawah. Perspektif Administrator tidak berarti akun memiliki hak cluster-admin.
3. Pastikan dapat membuat Deployment, Service, Route, ConfigMap, Secret, Job, BuildConfig, ImageStream, NetworkPolicy, dan PersistentVolumeClaim di project tersebut.
4. Minta tim IT menyebutkan StorageClass yang boleh dipakai, registry/image yang diizinkan, akses GitHub serta registry Microsoft/Node dan paket Python saat build, dan endpoint Ollama jika sudah disediakan. Proxy/mirror perusahaan mungkin diperlukan.
5. Untuk paket dasar, siapkan kapasitas SQL sampai 2 CPU/4 GiB RAM, aplikasi sampai 1 CPU/2 GiB RAM, serta ruang build sementara sampai 2 CPU/4 GiB. Kuota harus menampung proses yang berjalan bersamaan dan init container. Ini belum mencakup layanan AI.

Folder yang dipakai: [`deploy/openshift-company`](deploy/openshift-company). Berkas deployment lama di `deploy/openshift` tetap tersedia untuk skenario SQL eksternal.

## 2. Cara memasukkan YAML melalui console

Pada setiap langkah: pilih project yang benar → klik ikon **+ / Import YAML** di bagian atas → salin isi file yang ditunjuk → sesuaikan placeholder bila ada → **Create**. Untuk memperbarui objek yang sudah ada, buka objek → tab **YAML** → edit → **Save**, bukan membuat duplikat.

Manifest sengaja tidak mempunyai `metadata.namespace`; pastikan project yang aktif adalah project tujuan. Jika console menuntut namespace eksplisit, isi nama project yang diberikan pada setiap objek. Jangan menerapkan seluruh folder sekaligus: ada konfigurasi, sertifikat, dan image yang harus diisi dahulu.

## 3. Siapkan penyimpanan

1. Buka **Storage → PersistentVolumeClaims → Create PersistentVolumeClaim**.
2. Buat dua PVC berikut, pilih StorageClass yang disediakan IT, access mode **Single User (RWO / ReadWriteOnce)** dan volume mode **Filesystem**:

| Nama PVC | Ukuran awal | Isi |
|---|---:|---|
| `inspeksi-sql-storage` | 20 GiB | File database dan log SQL Server |
| `inspeksi-rig-storage` | 10 GiB | PDF sementara, metadata, artefak pembelajaran dan file aplikasi |

Alternatif: impor [`01-storage.yaml`](deploy/openshift-company/01-storage.yaml). Tambahkan `storageClassName: NAMA_DARI_IT` di bawah `spec` pada kedua PVC jika tidak ada default StorageClass. Jangan membuat PVC yang sama lagi jika sudah dibuat melalui form.

3. PVC biasanya berubah menjadi **Bound**. Bila StorageClass menggunakan `WaitForFirstConsumer`, status **Pending** sebelum ada pod pemakai adalah wajar. Jika tetap Pending setelah pod dibuat, lihat Events untuk kuota, kapasitas, atau provisioning.
4. Jika StorageClass tidak tersedia, minta administrator menyediakan storage untuk project. Tidak perlu membuat StorageClass/PersistentVolume sendiri.

Kedua Deployment memakai strategi **Recreate** dan satu pod. Data pada PVC bertahan ketika pod diganti. PVC bukan backup: minta jadwal backup database SQL ke penyimpanan lain dan snapshot/backup file aplikasi sebelum memakai data penting. Jangan menghapus PVC untuk mengatasi pod error. Retensi PDF aplikasi tidak menghapus database/PVC/model; penyimpanan tetap perlu dipantau.

## 4. Siapkan password, sertifikat, dan konfigurasi

### Secret melalui console

Buka **Workloads → Secrets → Create → Key/value secret** (nama menu dapat sedikit berbeda menurut versi). Buat nama dan key persis seperti tabel. Isi nilai asli hanya di console perusahaan.

| Nama Secret | Key | Nilai yang Anda isi |
|---|---|---|
| `inspeksi-sql-admin` | `SQL_USER` | `sa` |
| `inspeksi-sql-admin` | `SQL_PASSWORD` | Password SQL administrator yang kuat dan unik, 20–128 karakter |
| `inspeksi-rig-sql` | `SQL_USER` | `inspeksi_app` |
| `inspeksi-rig-sql` | `SQL_PASSWORD` | Password SQL aplikasi yang berbeda, 20–128 karakter |
| `inspeksi-rig-admin-bootstrap` | `BOOTSTRAP_ADMIN_EMAIL` | Email admin untuk login aplikasi |
| `inspeksi-rig-admin-bootstrap` | `BOOTSTRAP_ADMIN_PASSWORD` | Password login aplikasi yang berbeda, 16–160 karakter |

Gunakan kombinasi huruf besar/kecil, angka, dan simbol untuk password SQL sesuai kebijakan SQL Server. Hindari karakter kontrol/baris baru. Jangan memakai placeholder sebagai password. Login aplikasi memakai email/password pada Secret bootstrap, bukan akun `sa`.

Secret SQL aplikasi belum membuat login di database; Job tahap 5 yang membuatnya. Aplikasi web hanya memperoleh login `inspeksi_app` dengan `db_datareader` dan `db_datawriter`. Akses `sa` hanya dipakai SQL dan Job inisialisasi.

### Sertifikat SQL

Minta tim IT/PKI memberikan sertifikat server beserta private key PEM untuk DNS Service SQL. Sertifikat harus valid untuk nama `inspeksi-sql` yang dipakai pada konfigurasi; sertakan juga SAN `inspeksi-sql.NAMA_PROJECT.svc` dan DNS lengkap cluster bila dibutuhkan. Bila CA perusahaan hanya menerbitkan untuk FQDN, pakai nama yang tercantum pada sertifikat di `SQL_SERVER` (misalnya `tcp:inspeksi-sql.NAMA_PROJECT.svc,1433`).

1. Buat Secret TLS bernama **`inspeksi-sql-tls`**, key **`tls.crt`** (sertifikat dan intermediate chain) serta **`tls.key`** (private key tanpa password agar server dapat start otomatis).
2. Buka **Workloads → ConfigMaps → Create ConfigMap**, buat **`inspeksi-sql-ca`**, key **`ca.crt`**, isi root/intermediate CA penerbit dalam format PEM. CA ini akan digabungkan dengan trust store bawaan container aplikasi dan Job.
3. Impor [`03-config.yaml`](deploy/openshift-company/03-config.yaml). Biarkan `SQL_ENCRYPT=mandatory` dan `SQL_TRUST_SERVER_CERTIFICATE=false`. Jika sertifikat gagal diverifikasi, perbaiki nama DNS/chain CA; jangan menonaktifkan validasi.
4. Isi `OLLAMA_BASE_URL` pada ConfigMap `inspeksi-rig-config` dengan alamat layanan Ollama yang dapat dijangkau pod. `localhost` di dalam pod menunjuk pod itu sendiri, bukan laptop. Endpoint dummy `CHANGE_ME.invalid` harus diganti sebelum fungsi AI digunakan. Sesuaikan autentikasi/network policy dengan IT bila layanan perusahaan tidak langsung kompatibel dengan API Ollama.
5. `APP_ORIGIN` diisi setelah Route tersedia pada tahap 5.

Jika Ollama belum tersedia, UI dan fitur berbasis database dapat dipasang terlebih dahulu, tetapi analisis foto dan jawaban generatif belum berfungsi. Mintalah endpoint dan model visi yang sesuai kepada tim AI/IT; model yang dipilih melalui aplikasi harus tersedia di endpoint itu. Pelatihan VLM percobaan dinonaktifkan dalam build perusahaan ini; instalasi model dan worker pelatihan memerlukan penyiapan terpisah.

Jangan mengunggah password, private key, ekspor Secret, atau konfigurasi internal ke GitHub. Semua contoh repository berisi nama referensi, bukan nilai rahasia.

## 5. Build lalu jalankan aplikasi dan SQL

### A. Build aplikasi dari GitHub

1. Impor [`02-build.yaml`](deploy/openshift-company/02-build.yaml). Sumbernya repository ini, branch `main`. Untuk repo privat, tambahkan source Secret read-only pada BuildConfig melalui console; repo publik tidak memerlukan Secret GitHub.
2. Buka **Builds → BuildConfigs → inspeksi-rig → YAML**. Setelah pihak berwenang menyetujui lisensi Microsoft SQL tools, ubah build argument `ACCEPT_SQLTOOLS_EULA` dari `N` ke `Y`. Build sengaja menolak jika masih `N`.
3. Pertahankan `INSTALL_RIG_TRAINING=false` dan `INSTALL_VLM_TRAINING=false` untuk paket awal ini.
4. **Actions → Start Build**. Pantau tab **Logs** sampai **Complete**. Build belum menjalankan aplikasi.
5. Buka hasil **Build → YAML**, catat `status.output.to.imageDigest`. Gabungkan dengan repository image dari ImageStream, misalnya `image-registry.openshift-image-registry.svc:5000/NAMA_PROJECT/inspeksi-rig@sha256:DIGEST`. Gunakan hasil build sebenarnya; jangan menyalin digest contoh.
6. Ganti **semua** `CHANGE_ME_APP_IMAGE_DIGEST` di `05-bootstrap.yaml` dan `06-application.yaml` dengan image tersebut (termasuk init container). Bisa melalui editor lokal sebelum salin atau editor Import YAML. Bila registry internal tidak tersedia, gunakan registry yang diberikan tim IT dan sesuaikan output BuildConfig/image pull Secret.

### B. Jalankan SQL Server dalam project

1. Impor [`04-sql.yaml`](deploy/openshift-company/04-sql.yaml). SQL awalnya **0 pod** agar pengaturan belum lengkap tidak dijalankan.
2. Buka **Workloads → Deployments → inspeksi-sql → YAML**. Sesudah lisensi SQL Server disetujui, ubah env `ACCEPT_EULA` menjadi `Y`.
3. `MSSQL_PID=Developer` hanya untuk pengembangan/pengujian. Untuk produksi, tim IT harus menetapkan edisi/lisensi yang sesuai sebelum menjalankan SQL. Ganti image Microsoft dengan image/tag/digest yang disetujui perusahaan jika registry dibatasi.
4. Ubah `spec.replicas: 0` menjadi `1`, lalu **Save**. Tunggu pod SQL Ready dan periksa log bahwa SQL dapat menerima koneksi. Probe TCP hanya memeriksa listener; keberhasilan koneksi SQL sebenarnya diperiksa Job berikutnya.
5. SQL diakses lewat Service `inspeksi-sql:1433` dalam project. Tidak dibuat Route publik untuk SQL. NetworkPolicy mengizinkan masuk dari pod aplikasi dan bootstrap dalam namespace yang sama.

Manifest menggunakan non-root, `allowPrivilegeEscalation=false`, `drop: ALL`, dan hanya `NET_BIND_SERVICE` tambahan pada SQL sesuai contoh Microsoft. Jika SCC perusahaan menolak, minta IT meninjau Events dan kebijakan yang berlaku; jangan menambahkan privileged/anyuid secara otomatis. Storage harus mendukung akses tulis oleh UID/grup yang diberikan OpenShift.

### C. Buat database dan admin aplikasi

1. Setelah SQL siap, impor [`05-bootstrap.yaml`](deploy/openshift-company/05-bootstrap.yaml) yang placeholder image-nya sudah diganti.
2. Buka **Workloads → Jobs → inspeksi-rig-bootstrap → Pods → Logs**. Tunggu Job **Complete**. Job membuat skema, admin aplikasi, menonaktifkan akun demo, membuat login SQL aplikasi dan memvalidasi login tersebut.
3. Jika gagal, periksa TLS, nama/key Secret, password policy dan Events. Job tidak otomatis mencoba berulang kali.
4. Bila admin sudah sempat dibuat tetapi tahap akhir gagal, perbaiki penyebab, buat Job baru dengan nama berbeda dan tambahkan `args: ["--migrate-only"]` pada container bootstrap. Ini mengulang migrasi dan pemeriksaan login tanpa menimpa admin. Jika password login SQL yang sudah ada berbeda, sinkronkan Secret melalui admin database; Job tidak merotasinya diam-diam.
5. Setelah berhasil dan akses admin sudah dipastikan pada sesi pengujian nanti, hapus Secret `inspeksi-rig-admin-bootstrap` yang tidak diperlukan lagi. Simpan kredensial di pengelola password perusahaan. Secret `inspeksi-sql-admin` tetap diperlukan oleh Deployment SQL.

### D. Pasang aplikasi dan alamat HTTPS

1. Impor [`06-application.yaml`](deploy/openshift-company/06-application.yaml) dengan image yang sama. Aplikasi awalnya **0 pod**.
2. Impor [`07-route.yaml`](deploy/openshift-company/07-route.yaml). OpenShift mengisi hostname Route. Route ini memakai sertifikat wildcard router perusahaan dan mengalihkan HTTP ke HTTPS. Tim IT perlu menyesuaikan host/sertifikat atau ingress apabila kebijakan project mewajibkannya.
3. Buka **Networking → Routes → inspeksi-rig**, salin alamat HTTPS-nya.
4. Buka ConfigMap `inspeksi-rig-config`, ubah `APP_ORIGIN` menjadi `https://HOST_ROUTE` tanpa slash akhir. Cookie sesi produksi memakai HTTPS.
5. Buka Deployment `inspeksi-rig`, ubah `spec.replicas: 0` ke `1`. Pertahankan satu replika dan strategi Recreate karena sesi serta pekerjaan file belum dirancang untuk banyak replika.
6. Untuk perubahan ConfigMap/Secret berikutnya, lakukan restart rollout agar nilai env baru terbaca. Penggantian CA/sertifikat juga memerlukan restart pod terkait karena init container menyalinnya saat startup. Perubahan image dilakukan pada container aplikasi dan init container bersama-sama.

## 6. Pengujian dilakukan nanti

Saat sesi pengujian disetujui, periksa login admin, koneksi SQL, penyimpanan setelah restart pod, akses AI, impor dataset, kartu NOT_READY, serta sumber PDF yang benar. Jangan mengaktifkan pengunduhan terjadwal dari sumber asli sebelum alamat dan aksesnya diketahui. Dataset lokal tidak otomatis tersedia pada instalasi baru.

Jika aplikasi belum Ready, buka **Pods → Events / Logs**. `Pending` biasanya terkait kuota/storage, `ImagePullBackOff` terkait registry, `CrashLoopBackOff` memerlukan log container, dan `database_pending` memerlukan pemeriksaan koneksi/migrasi SQL. Jangan menghapus PVC sebagai langkah pemulihan.

## Referensi

- [Microsoft: SQL Server pada Kubernetes/OpenShift](https://learn.microsoft.com/en-us/sql/linux/install-upgrade/quickstart-containers-azure?view=sql-server-ver17)
- [Microsoft: koneksi TLS SQL Server Linux](https://learn.microsoft.com/en-us/sql/linux/security/encrypted-connections?view=sql-server-ver17)
- [Red Hat: persistent storage](https://docs.redhat.com/en/documentation/openshift_container_platform/4.20/html/storage/understanding-persistent-storage)

Nama menu mengikuti console OpenShift umum; sesuaikan dengan versi dan hak akses cluster perusahaan.
