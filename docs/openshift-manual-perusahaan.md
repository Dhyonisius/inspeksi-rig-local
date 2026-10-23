# Deployment manual Ubuntu 22.04 di OpenShift perusahaan

Paket ini disiapkan tanpa mengakses OpenShift, remote desktop, SQL Server, Ollama,
atau jaringan perusahaan. Semua tindakan di cluster dilakukan manual oleh Anda.
Gunakan hanya branch `fix/ubuntu22-runtime-complete`; jangan merge ke main.
Tidak ada perubahan startup Windows, konfigurasi layanan lokal, atau data produksi.

## Urutan dan batas keberhasilan

1. Sertifikat dan sumber paket disetujui perusahaan.
2. Build image Ubuntu selesai, termasuk pemeriksaan paket otomatis.
3. Job preflight selesai dengan 0 kegagalan.
4. Deployment satu pod Ready; kemudian satu inspeksi dengan foto uji yang diizinkan.

Build sukses bukan bukti koneksi SQL/Ollama atau inspeksi berhasil. Preflight tidak
menjalankan inferensi, sehingga hasil inspeksi dan kapasitas training tetap harus
diuji manual. Jangan mengirim password, PAT, token login, atau isi Secret ke chat.

## A. Sertifikat CA: perbaiki error build yang terlihat

Log sebelumnya menunjukkan `certificate issuer is unknown` saat APT mengunduh
Microsoft SQL Tools melalui `pmc-geofence.trafficmanager.net`. Ini bukan error
password SQL. Log itu belum membuktikan apakah penyebabnya proxy inspeksi TLS,
CA organisasi yang hilang, atau rantai sertifikat server yang tidak lengkap.

Minta IT memeriksa sertifikat yang diterima oleh builder pada host yang gagal.
Jika ada CA perusahaan, minta root/intermediate CA publik resmi berformat PEM,
satu sertifikat per file dengan ekstensi `.crt`. Verifikasi fingerprint melalui
IT. Jangan memakai sertifikat leaf server sebagai CA dan jangan menyalin private
key. CA tetap di OpenShift; tidak perlu diunggah ke GitHub atau ke chat.

Di project `protect2-ai-dev`, buat ConfigMap **inspeksi-rig-build-ca** lewat console.
Isikan key seperti `company-root.crt` dan, jika diperlukan, `company-intermediate.crt`;
value adalah isi sertifikat PEM resmi. Jangan memasukkan placeholder sebagai CA.
Nama key harus berakhiran `.crt` karena Dockerfile dan .dockerignore hanya menerima
sertifikat dengan ekstensi ini. Isi ConfigMap akan masuk trust store image; tim IT
perlu menyetujui CA mana yang dipercaya image aplikasi, termasuk koneksi runtime.

Lalu buka **BuildConfigs > inspeksi-rig-ubuntu-test > YAML**, bukan Build `...-5`.
Gabungkan bagian berikut ke `spec.source` tanpa menghapus uri/sourceSecret atau
konfigurasi lain yang masih diperlukan:

```yaml
git:
  uri: https://github.com/Dhyonisius/inspeksi-rig-local.git
  ref: fix/ubuntu22-runtime-complete
configMaps:
  - configMap:
      name: inspeksi-rig-build-ca
    destinationDir: deploy/container/ca
```

Di `spec.strategy.dockerStrategy` pastikan `dockerfilePath: Dockerfile` dan
`forcePull: true`. Pertahankan `ACCEPT_SQLTOOLS_EULA: 'Y'` hanya bila persetujuan
perusahaan memang sudah diberikan. `INSTALL_RIG_TRAINING: 'true'` adalah profil
lengkap; bila belum dicantumkan, Dockerfile memakai true secara default.

Alternatif CLI di remote desktop: berkas berikut adalah **merge patch**, bukan
resource untuk tombol Import YAML. Patch tidak mengubah daftar buildArgs/EULA:

```powershell
oc project protect2-ai-dev
oc patch bc/inspeksi-rig-ubuntu-test --type=merge --patch-file=deploy/openshift/build-ca.merge-patch.json
```

Patch mengganti daftar `spec.source.configMaps`; bila sudah ada input ConfigMap
lain, gabungkan daftar tersebut terlebih dahulu. Jika tidak diperlukan CA khusus,
jangan menambahkan referensi ConfigMap yang tidak ada. Untuk runtime dengan CA
SQL/Ollama internal, masukkan CA resminya melalui mekanisme yang sama saat build.
Perubahan CA memerlukan rebuild image.

## B. Sumber paket dan build

Dockerfile hanya memakai `FROM ubuntu:22.04`. Node.js 22 dipasang dari arsip resmi
dengan pemeriksaan SHA-256 melalui HTTPS, bukan dari image Debian. Paket
ca-certificates awal berasal dari repository Ubuntu dengan tanda tangan APT tetap
aktif, lalu sumber Ubuntu dialihkan ke HTTPS. Bila akses bootstrap bawaan tidak
diizinkan perusahaan, IT harus menyediakan base Ubuntu dengan CA terpasang atau
mirror yang disetujui. Paket ini tidak mengubah DNS, firewall, router, atau proxy.

Sumber yang perlu diperiksa IT sesuai log: registry Ubuntu/Docker Hub, GitHub,
nodejs.org, archive.ubuntu.com, security.ubuntu.com, packages.microsoft.com dan
redirect unduhan Microsoft, pypi.org/files.pythonhosted.org, download.pytorch.org.
Daftar ini bukan instruksi mengubah allowlist sendiri. Jika sumber publik tidak
diizinkan, gunakan mirror perusahaan melalui perubahan terkontrol dan rebuild.
Jangan menggunakan curl -k, trusted=yes, atau mematikan Verify-Peer.

Pilih **Actions > Start Build**, buka Logs, lalu tunggu Complete. Pemeriksaan
paket otomatis harus lulus. Jangan menganggap image lama sudah terganti hanya
karena build baru selesai. Catat commit sumber dari Details dan ambil image
**dengan digest @sha256**, bukan hanya tag latest:

```powershell
oc get istag inspeksi-rig-ubuntu-test:latest -o 'jsonpath={.image.dockerImageReference}'
```

Gunakan hasil lengkap itu di semua placeholder image. Jika registry mensyaratkan
izin pull, gunakan mekanisme service account/imagePullSecret dari tim platform;
jangan mengubah visibilitas image menjadi public untuk mengatasi izin.

## C. Deployment uji terpisah, belum aktif

Manifest baru memakai nama **inspeksi-rig-ubuntu-deploy**, berbeda dari Knative
`inspeksi-rig-ubuntu-test`, layanan lama, SQL Server, dan Ollama. Jangan menghapus
atau mengganti resource lama. Pastikan nama resource baru belum dipakai; jika
sudah ada, tinjau resource tersebut sebelum apply.

Salin `deploy/openshift/manual-runtime.json`, lalu ganti semua placeholder:

| Placeholder | Nilai dari lingkungan perusahaan |
|---|---|
| REPLACE_WITH_IMAGE_AT_SHA256 | Referensi image lengkap hasil build, berakhiran @sha256:... |
| REPLACE_WITH_SQL_TCP_ENDPOINT | Endpoint SQL yang dapat dijangkau pod, misalnya tcp:nama-service,1433 |
| REPLACE_WITH_OLLAMA_HTTP_URL | Endpoint Ollama internal lengkap, tanpa slash terakhir |
| REPLACE_WITH_APPROVED_HOST | Hostname HTTPS internal yang disetujui IT, tanpa https:// atau path |

Jangan menggunakan localhost laptop. Jangan menebak nama Service SQL/Ollama dari
nama Deployment; periksa Services dan port yang benar di project bersama admin.
Ollama harus menyediakan model dengan kemampuan vision; endpoint autentikasi
SSO/bearer token belum didukung langsung oleh aplikasi ini.

Di console pilih **+ / Import YAML**, lalu tempel JSON yang telah disesuaikan.
OpenShift menerima JSON sebagai manifest. Berkas berisi List resource siap apply,
bukan Template yang memerlukan oc process. Alternatif: `oc apply -f FILE.json`.
Deployment sengaja **replicas: 0**. Image hanya dijadwalkan ke Linux AMD64,
non-root, root filesystem read-only; hanya PVC data/model dan /tmp yang ditulis.
Tidak memerlukan SCC anyuid atau privileged.

Buat Secret Opaque **inspeksi-rig-ubuntu-deploy-sql** melalui console dengan key
`SQL_USER` dan `SQL_PASSWORD`, memakai login runtime khusus dari DBA. Jangan beri
login migrator/sysadmin. Jangan masukkan Secret ke Git atau ZIP ini. Deployment
secara eksplisit menonaktifkan migrasi dan memvalidasi sertifikat SQL.

PVC baru **inspeksi-rig-ubuntu-deploy-storage** harus Bound. Ukuran awal 10Gi;
sesuaikan sebelum pembuatan bila perlu. Jika tidak ada default StorageClass, tim
platform menentukan storageClassName sebelum apply. Izin UID/fsGroup mengikuti
SCC dan storage driver perusahaan; jangan mengubah izin volume menjadi 777.
Tidak ada foto/model/database laptop yang dipindahkan otomatis.

## D. Pemeriksaan sebelum aplikasi berjalan

Gunakan `manual-preflight.json`, ganti placeholder image yang sama dengan runtime.
Secret/ConfigMap/PVC pada tahap C harus tersedia. Deployment tetap 0 selama Job
memakai PVC. Import manifest Job ini ke project yang sama, lalu lihat Logs
container **check**. Alternatif:

```powershell
oc apply -f deploy/openshift/manual-preflight.json
oc logs -f job/inspeksi-rig-ubuntu-deploy-preflight -c check
oc wait --for=condition=complete job/inspeksi-rig-ubuntu-deploy-preflight --timeout=600s
```

Jangan menjalankan contoh CLI sebelum mengganti placeholder di berkas. Job
memeriksa OS, Node, Python, sqlcmd, CPU/ONNX, izin tulis/rename pada direktori
probe baru, login SQL baca-saja, tabel AppUser existing, metadata model vision,
dan APP_ORIGIN. Hanya berkas probe milik Job yang dibersihkan; data inspeksi tidak
dibaca/dihapus. Skrip tidak menampilkan kredensial atau output query.

Jika database/skema belum tersedia, hentikan tahap ini. Minta DBA menyiapkan
database aplikasi dan meninjau migrasi secara terpisah. Paket ini **tidak menjalankan
bootstrap, CREATE/ALTER/DROP, INSERT/UPDATE/DELETE, atau reset akun**. Jangan
mengarahkan aplikasi ke database perusahaan lain hanya untuk meloloskan tes.
Preflight lulus belum membuktikan seluruh tabel, izin tulis SQL, atau data aplikasi
lengkap; DBA dan uji aplikasi berikutnya harus memverifikasi itu.

Untuk menjalankan ulang Job setelah perbaikan, gunakan nama baru, misalnya
`inspeksi-rig-ubuntu-deploy-preflight-2`, pada metadata.name. Jangan mengedit spec
Job yang sudah selesai; spec tersebut immutable. Jangan jalankan dua Job sekaligus.
Jika profil training sengaja dimatikan saat build, hapus `--training` dari command
Job dan catat bahwa fitur training/detektor tidak tersedia.

## E. Route internal, kemudian satu pod

Setelah Job Complete dan melepaskan PVC, sesuaikan host pada `manual-route.json`.
Import hanya setelah IT memastikan hostname tersebut diterima oleh ingress
internal dengan sertifikat yang dipercaya. Manifest tidak membuat ingress menjadi
private; tidak mengganti DNS/router/sertifikat perusahaan. APP_ORIGIN di ConfigMap
harus tepat sama dengan https://hostname Route, tanpa slash akhir.

Di halaman Deployment **inspeksi-rig-ubuntu-deploy**, ubah jumlah pod dari 0 ke 1.
Alternatif:

```powershell
oc scale deployment/inspeksi-rig-ubuntu-deploy --replicas=1
oc rollout status deployment/inspeksi-rig-ubuntu-deploy --timeout=1800s
oc logs deployment/inspeksi-rig-ubuntu-deploy -c app --tail=100
```

Periksa /livez (proses hidup), /readyz (kesiapan SQL sesuai pemeriksaan aplikasi),
login admin existing, dan daftar model vision. Uji satu foto khusus pengujian
dengan izin perusahaan; uji inspeksi ini dapat menulis hasil ke database aplikasi,
jadi lakukan hanya pada lingkungan uji yang disepakati DBA. Jangan memakai data
produksi untuk latihan. Evaluasi hasil AI secara manual; sukses teknis bukan
jaminan penilaian keselamatan foto benar.

Tetap satu pod karena sesi dan penguncian pekerjaan masih lokal pada proses.
Limit 6Gi/2 CPU serta /tmp 1Gi adalah nilai awal, bukan jaminan cukup untuk
training. Model weights yang sah dan dataset tidak ada di image; penyediaannya
ke PVC harus dilakukan secara terpisah sesuai izin dan lisensi.

## Diagnosis dan pemulihan

| Gejala | Tindakan berikutnya |
|---|---|
| Build certificate issuer unknown | IT verifikasi chain/CA pada host gagal; periksa input ConfigMap .crt lalu rebuild |
| Node download 404 | Periksa versi/url resmi atau mirror yang disetujui; jangan menonaktifkan checksum |
| sqlcmd ENOENT pada pod | Cocokkan image/digest pod dengan build; pemeriksaan paket harus lulus |
| ImagePullBackOff | Periksa image digest dan hak pull dari platform |
| Pod Pending | Periksa node AMD64, kuota dan PVC/StorageClass |
| Permission denied data/models | Periksa SCC/fsGroup dan storage driver; jangan jalankan sebagai root |
| SQL TLS/login/schema gagal | DBA periksa nama host sertifikat, CA, login dan database K3VisionLocal |
| Ollama/model vision gagal | Periksa endpoint Service, port, model terpasang dan kebijakan akses yang berlaku |
| /readyz gagal | Periksa log database; restart saja tidak memperbaiki kredensial/skema |
| OOMKilled/evicted | Periksa memory, ephemeral storage dan ukuran beban bersama platform |

Jika deployment uji gagal, kembalikan replicas ke 0. Pertahankan PVC dan seluruh
data; jangan delete SQL Server/Ollama/layanan lama. Untuk upgrade berikutnya ambil
digest baru dan ubah image app **serta** init container prepare-storage; simpan
digest sebelumnya. Rollback image tidak membalik skema database.

## Referensi resmi

- [OpenShift build inputs dan ConfigMaps](https://docs.redhat.com/en/documentation/openshift_container_platform/4.19/html/builds_using_buildconfig/creating-build-inputs)
- [Build source configMaps dan destinationDir](https://docs.redhat.com/en/documentation/openshift_container_platform/4.13/html/workloads_apis/build-build-openshift-io-v1)
- [Ubuntu trust store](https://documentation.ubuntu.com/server/how-to/security/install-a-root-ca-certificate-in-the-trust-store/index.html)

Validasi cluster, CA resmi, akses sumber paket, SQL, Ollama, PVC dan inferensi belum
dilakukan oleh Codex. Berkas ini adalah paket konfigurasi untuk Anda terapkan dan
verifikasi secara manual di perusahaan.
