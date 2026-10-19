# Deploy Inspeksi Rig dari GitHub ke OpenShift perusahaan

## Status dan arsitektur yang benar

Ini **bukan aplikasi Python S2I**. Server utama adalah **Node.js**, entry point `server.js`, dijalankan dengan `node server.js` / `npm start`. Python membantu dekode gambar, ekstraksi PDF, dan opsi model detektor. Database tetap **Microsoft SQL Server** (`K3VisionLocal`), bukan PostgreSQL/MySQL. SSMS adalah klien pengelolaan database, tidak dipasang pada pod aplikasi.

```text
GitHub private -> OpenShift BuildConfig (Dockerfile) -> image aplikasi
Browser --HTTPS--> Route -> Service -> 1 pod Node.js + Python
                                      |-> SQL Server perusahaan
                                      |-> Ollama + model vision perusahaan
                                      |-> PVC: foto, anotasi, hasil, model lokal
```

Konfigurasi ini tidak memasang SQL Server atau Ollama secara otomatis. Keduanya belum tersedia dalam lingkungan tujuan. **Build image dapat disiapkan lebih dulu. Inspeksi dan penyimpanan belum dapat digunakan sebelum layanan tersebut disediakan dan dapat diakses pod.** Jangan menggunakan `localhost`, `127.0.0.1`, atau `.\SQLEXPRESS` laptop sebagai alamat layanan cluster.

Gambar About yang tersedia menampilkan Kubernetes `v1.33.6`, bukan nomor rilis OpenShift. Pastikan rilis sebenarnya melalui `oc version` atau administrator. Manifest memakai BuildConfig, ImageStream, Template, Deployment, PVC, dan Route untuk OpenShift 4.x; dukungan versi dan kebijakan cluster harus diperiksa di perusahaan.

Tidak ada namespace perusahaan yang ditulis dalam manifest. Semua resource masuk **project aktif pada sesi oc di remote desktop perusahaan**. Persiapan di laptop/GitHub tidak memberi akses ke cluster tersebut.

## Tahap A — yang diperlukan untuk build saja

Minta administrator memberikan project latihan, akses BuildConfig/ImageStream, registry image internal aktif, kuota build, dan izin keluar ke GitHub serta sumber paket/image. Tidak perlu meminta akses administrator cluster atau SCC `anyuid` untuk image aplikasi ini. Image disiapkan untuk UID acak/non-root. Database terpisah memiliki persyaratan deployment sendiri.

Dockerfile memakai Node 22 Debian Bookworm, Microsoft ODBC/sqlcmd 18, dan virtualenv Python dengan Pillow/PyMuPDF. Builder membutuhkan akses registry Docker Hub, repositori Debian, `packages.microsoft.com`, dan PyPI beserta host unduhan paketnya. Untuk jaringan terisolasi, administrator harus menyediakan mirror/base image yang disetujui dan CA perusahaan. Jangan menonaktifkan validasi TLS untuk mengatasi proxy/sertifikat perusahaan.

SQL tools memerlukan persetujuan lisensi Microsoft. Build sengaja tidak berjalan dengan `ACCEPT_SQLTOOLS_EULA=N`. Terapkan patch persetujuan di bawah hanya jika perusahaan mengizinkannya. Dependensi rentang versi perlu dikunci ke versi/digest hasil build yang disetujui setelah validasi perusahaan.

### 1. Siapkan akses GitHub baca saja

Gunakan fine-grained PAT yang **hanya** mencakup `Dhyonisius/inspeksi-rig-local`, izin **Contents: Read-only**, masa berlaku terbatas. Token ini terpisah dari autentikasi Git Credential Manager laptop. Jangan gunakan token OAuth laptop sebagai secret build.

Di OpenShift console pada project tujuan: **Workloads -> Secrets -> Create -> Source secret** (nama menu dapat berbeda). Buat secret bernama **`github-inspeksi-read`** dengan autentikasi basic/HTTPS: `username` = akun GitHub, `password` = PAT. Tipe Kubernetes `kubernetes.io/basic-auth`. Jika UI meminta Git URL, gunakan URL repository HTTPS di bawah tanpa token. Alternatif deploy key SSH memerlukan penyesuaian URI BuildConfig dan known_hosts sesuai prosedur admin.

Jangan menaruh PAT di URL repository, berkas yang di-commit, buildArgs, chat, atau tangkapan layar. Project, secret Git, dan BuildConfig harus berada pada namespace yang sama.

### 2. Di remote desktop perusahaan, login dan pilih project

Pasang CLI `oc` yang sesuai dari **Command line tools** pada console OpenShift. Gunakan **Copy login command** lalu jalankan sendiri di PowerShell perusahaan; jangan kirim perintah yang berisi token ke chat.

```powershell
oc version
oc project NAMA_PROJECT_DARI_ADMIN
git clone https://github.com/Dhyonisius/inspeksi-rig-local.git
Set-Location inspeksi-rig-local
oc apply -f deploy/openshift/build.yaml
```

Jika remote desktop tidak punya Git, unduh ZIP kode dari GitHub setelah login, ekstrak, lalu buka PowerShell pada folder yang memuat Dockerfile. BuildConfig tetap mengambil source langsung dari GitHub.

### 3. Jalankan build, setelah lisensi disetujui perusahaan

```powershell
oc patch bc/inspeksi-rig --type=merge --patch-file=deploy/openshift/build-license-approved.patch.yaml
oc start-build inspeksi-rig --follow --wait
oc get builds
oc get istag inspeksi-rig:latest
```

Di console juga dapat memakai **Import from Git**, URL `https://github.com/Dhyonisius/inspeksi-rig-local.git`, branch `main`, source secret `github-inspeksi-read`, metode **Dockerfile**, path `Dockerfile`. Jangan pilih builder Python. Manifest BuildConfig lebih terarah untuk build tanpa langsung membuat aplikasi yang belum mempunyai database. Jangan membuat resource duplikat dengan nama yang sama melalui kedua cara.

**Berhenti pada tahap build bila SQL Server dan Ollama belum tersedia.** Belum perlu Route, runtime Secret, atau pod aplikasi. Image hasil build saja belum menyediakan fungsi inspeksi.

## Tahap B — sediakan layanan pendukung bersama administrator

| Kebutuhan | Informasi yang harus disediakan |
|---|---|
| SQL Server | Endpoint TCP dan port tetap yang dapat dijangkau pod; database khusus `K3VisionLocal`, bukan database aplikasi perusahaan lain; SQL Authentication/login layanan yang diizinkan DBA atau rancangan Kerberos terpisah |
| Migrasi SQL | Login migrator khusus yang dapat mengakses master, membuat database bila belum ada, serta membuat/mengubah skema database aplikasi; hak ini tidak diberikan ke login runtime |
| Runtime SQL | Login + user pada `K3VisionLocal`, izin SELECT/INSERT/UPDATE/DELETE pada skema dbo sesuai aplikasi; tidak memerlukan hak membuat database. DBA dapat memakai db_datareader/db_datawriter untuk tahap latihan lalu memperketat grant |
| Sertifikat SQL | Sertifikat dengan nama host yang sesuai dan rantai CA tepercaya oleh container. Tambahkan CA internal ke base image yang disetujui admin. Default enkripsi mandatory dan validasi sertifikat aktif |
| Ollama | Endpoint internal yang dapat dijangkau pod, model vision terpasang (misalnya model yang sama dengan laptop). `llama3.2` teks tidak cukup untuk foto. Admin menentukan CPU/GPU, RAM/VRAM, model storage dan kuota |
| Penyimpanan | StorageClass default yang dapat membuat PVC ReadWriteOnce, izin tulis UID/fsGroup dari SCC, ukuran awal 10Gi yang disesuaikan volume foto, serta prosedur backup PVC dan SQL Server |
| Jaringan | Izin pod ke DNS, SQL TCP, dan Ollama; akses browser ke HTTPS Route internal yang diizinkan perusahaan |

SQL Server dan Ollama dapat berada di server perusahaan lain atau dipasang tim platform pada namespace tersendiri. Aplikasi ini tidak menentukan lisensi, SCC atau resource untuk layanan tersebut. Service Ollama tidak perlu diekspos sebagai Route publik. Jika Ollama dipasang pada server lain, administrator mengatur bind/listen dan firewall hanya untuk jaringan yang dibutuhkan. Endpoint Ollama dengan bearer-token/SSO belum didukung langsung oleh klien aplikasi; perlukan endpoint internal yang sesuai atau penyesuaian klien.

Ollama yang tidak tersedia tidak boleh dianggap sebagai hasil aman. SQL Server yang tidak tersedia membuat kesiapan pod gagal dan penyimpanan tidak dapat digunakan.

## Tahap C — jalankan aplikasi setelah dependency siap

Jalankan perintah berikut pada PowerShell perusahaan, di folder repository dan project yang benar.

### 1. Buat runtime Secret melalui console

Gunakan **Key/value secret**, tipe Opaque. Jangan menyimpan nilainya dalam repository:

| Nama Secret | Key |
|---|---|
| `inspeksi-rig-sql` | `SQL_USER`, `SQL_PASSWORD` untuk login runtime dari DBA |
| `inspeksi-rig-sql-migrator` | `SQL_USER`, `SQL_PASSWORD` untuk login migrator dari DBA |
| `inspeksi-rig-admin-bootstrap` | `BOOTSTRAP_ADMIN_EMAIL`, `BOOTSTRAP_ADMIN_PASSWORD` (unik, 16–160 karakter) |

### 2. Buat konfigurasi, storage, dan Deployment yang masih berhenti

Ganti nilai contoh dengan endpoint dari admin, bukan alamat laptop:

```powershell
$appImage = (oc get istag inspeksi-rig:latest -o 'jsonpath={.image.dockerImageReference}').Trim()
$sqlEndpoint = 'tcp:SQL_SERVER_DARI_ADMIN,1433'
$ollamaEndpoint = 'http://OLLAMA_DARI_ADMIN:11434'
oc process -f deploy/openshift/runtime-template.yaml -p "IMAGE=$appImage" -p "SQL_SERVER=$sqlEndpoint" -p "OLLAMA_BASE_URL=$ollamaEndpoint" | oc apply -f -
oc get pvc inspeksi-rig-storage
```

Deployment sengaja mempunyai `replicas: 0`. Jangan jalankan perintah dengan endpoint contoh. Jika perusahaan tidak memakai StorageClass default, administrator perlu menyesuaikan PVC sebelum apply. Volume disiapkan init container non-root, kemudian dipasang ke `/app/data` dan `/app/models`. Jangan mengganti ini dengan emptyDir untuk data permanen.

### 3. Inisialisasi skema dan admin

Untuk database aplikasi baru, jalankan:

```powershell
oc process -f deploy/openshift/bootstrap-template.yaml -p "IMAGE=$appImage" | oc apply -f -
oc logs -f job/inspeksi-rig-bootstrap
oc wait --for=condition=complete job/inspeksi-rig-bootstrap --timeout=1800s
```

Job menjalankan skema aplikasi secara eksplisit, membuat satu admin, dan menonaktifkan akun dengan hash kata sandi demo bawaan. Login runtime tidak menjalankan migrasi otomatis. Bootstrap menolak menimpa akun admin yang sudah ada. Untuk database existing, buat backup dan tinjau migrasi bersama DBA; gunakan `-p MODE=--migrate-only` bila admin sudah ada. Jangan menjalankan bootstrap pada database perusahaan yang tidak ditujukan untuk aplikasi ini.

Setelah berhasil, hapus secret admin awal dan Job agar password awal tidak dipertahankan sebagai konfigurasi pekerjaan. Secret migrator dapat dihapus lalu dibuat kembali saat upgrade sesuai aturan perusahaan:

```powershell
oc delete job inspeksi-rig-bootstrap
oc delete secret inspeksi-rig-admin-bootstrap
oc delete secret inspeksi-rig-sql-migrator
```

### 4. Buat HTTPS Route internal dan mulai satu pod

Route berikut memakai ingress/router project yang tersedia. Pastikan admin menyatakan hostname/ingress tersebut sesuai untuk aplikasi internal. Jika ingress default terbuka ke internet, jangan jalankan tahap ini sebelum admin menyediakan pembatasan akses/ingress internal.

```powershell
oc create route edge inspeksi-rig --service=inspeksi-rig --port=http --insecure-policy=Redirect
oc annotate route inspeksi-rig haproxy.router.openshift.io/timeout=300s --overwrite
$routeHost = (oc get route inspeksi-rig -o 'jsonpath={.spec.host}').Trim()
oc set env deployment/inspeksi-rig "APP_ORIGIN=https://$routeHost"
oc scale deployment/inspeksi-rig --replicas=1
oc rollout status deployment/inspeksi-rig --timeout=1800s
oc logs deployment/inspeksi-rig --tail=100
Write-Output "https://$routeHost"
```

Gunakan sertifikat Route tepercaya dari perusahaan. HTTPS diperlukan untuk cookie login server dan fitur kamera browser. `APP_ORIGIN` harus tepat `https://hostname` tanpa path atau slash akhir; konfigurasi ini memvalidasi Origin pada POST/DELETE. Route timeout diperpanjang untuk inferensi yang lama, namun model tetap perlu disesuaikan dengan resource Ollama.

Login memakai admin yang baru dibuat. Kata sandi demo tidak dapat digunakan dalam mode production. Akun pengguna berikutnya dibuat admin melalui aplikasi. Data lokal laptop tidak otomatis dipindahkan; migrasi foto/PDF/database harus dikerjakan terpisah sesuai izin perusahaan dan menjaga konsistensi SQL + PVC.

## Upgrade dari Git berikutnya

Build tidak berjalan otomatis setiap push. Setelah perubahan kode sudah ada di branch main, jalankan `oc start-build inspeksi-rig --follow --wait`. Ambil digest image baru ke `$appImage` seperti sebelumnya. Untuk perubahan skema, backup data, hentikan pod aplikasi, buat kembali secret migrator, jalankan bootstrap-template dengan `MODE=--migrate-only`, dan tunggu sukses. Lalu:

```powershell
oc set image deployment/inspeksi-rig "app=$appImage" "prepare-storage=$appImage"
oc scale deployment/inspeksi-rig --replicas=1
oc rollout status deployment/inspeksi-rig --timeout=1800s
```

Jangan apply ulang runtime-template saat upgrade tanpa meninjau resource: template mengembalikan replicas ke 0 dan nilai ConfigMap. Image memakai digest hasil build agar rollback jelas. Rollback image tidak membalik perubahan skema database; DBA perlu menilai kompatibilitas/backup.

## Batasan paket ini

- Persiapan kode dan manifest belum membuktikan build/rollout berhasil di cluster perusahaan. Belum dilakukan build container, uji cluster, koneksi SQL, atau inferensi Ollama di lingkungan tujuan.
- Jalankan **satu replica**. Session login, batas percobaan login, serta penguncian proses AI masih disimpan pada satu proses Node. Restart mengakhiri sesi; beberapa replica memerlukan rancangan session/queue terpusat. Ini belum merupakan integrasi SSO perusahaan.
- Image ringan menyediakan fitur gambar/PDF dan klien Ollama. Training YOLO dan detektor ONNX tidak dipasang secara default. Jika diperlukan, ubah buildArg `INSTALL_RIG_TRAINING=true` dengan persetujuan admin dan build ulang. Ini mengunduh PyTorch CPU/Ultralytics/ONNX; persyaratan lisensi dan versi dependensi juga perlu disetujui. Resource build dan runtime perlu dinaikkan berdasarkan ukuran dataset; 1Gi runtime default ditujukan untuk aplikasi ringan tanpa training.
- Bobot awal `models/sh17-yolov8n/source-yolo8n.pt` dan model terlatih tidak ada di Git/image. Pasang berkas yang sah dan tervalidasi ke PVC bila fitur training diaktifkan; kode tidak mengunduh bobot secara otomatis. Lisensi paket/model harus sesuai penggunaan perusahaan.
- PVC bukan backup. Simpan backup SQL dan file secara konsisten, serta uji pemulihannya sesuai prosedur perusahaan.
- Base image Debian adalah rancangan awal. Bila perusahaan mewajibkan UBI/registry internal atau pin versi tertentu, Dockerfile harus disesuaikan sebelum build.

## Diagnosis singkat

| Gejala | Yang diperiksa |
|---|---|
| Clone Git 401/403 | Source secret di project yang sama, PAT read-only repo yang benar, masa berlaku dan kebijakan organisasi |
| Build gagal awal | Persetujuan lisensi/buildArg, Dockerfile strategy, akses registry/paket, CA/proxy perusahaan |
| Pod Pending | PVC Bound, storage class, kuota dan izin SCC/fsGroup; jangan langsung meminta root/anyuid |
| ImagePullBackOff | Digest image benar, build selesai, registry internal dan izin pull dalam project |
| Pod berjalan tetapi tidak Ready | Log SQL, endpoint TCP/port, firewall, CA, login runtime, skema hasil Job migrasi |
| POST/login 403 | APP_ORIGIN sama persis dengan origin URL browser |
| Login demo ditolak | Gunakan admin bootstrap; demo memang diblokir di production |
| Foto tersimpan, AI gagal | Endpoint Ollama dapat diakses pod, model vision tersedia, waktu inferensi/resource cukup |
| Training belum tersedia | Image opsi training, bobot awal, data terverifikasi, resource dan PVC |

## Referensi resmi

- [Red Hat: Git source dan source clone secret](https://docs.redhat.com/en/documentation/openshift_container_platform/4.20/html/builds_using_buildconfig/creating-build-inputs)
- [Red Hat: image untuk arbitrary user ID](https://docs.redhat.com/en/documentation/openshift_container_platform/4.11/html/images/creating-images)
- [Microsoft: instalasi SQL tools di Linux](https://learn.microsoft.com/en-us/sql/linux/install-upgrade/setup-tools?view=sql-server-ver17)
- [Microsoft: opsi autentikasi dan TLS sqlcmd](https://learn.microsoft.com/en-us/sql/tools/sqlcmd/sqlcmd-utility?view=sql-server-ver17)
