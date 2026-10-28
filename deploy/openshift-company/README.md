# Deployment dalam project perusahaan

Ikuti [panduan console lengkap](../../PANDUAN-DEPLOY-OPENSHIFT-PERUSAHAAN.md).

Urutan: `01-storage.yaml` → Secret/TLS → `03-config.yaml` → build `02-build.yaml` → SQL `04-sql.yaml` → bootstrap `05-bootstrap.yaml` → aplikasi `06-application.yaml` → Route `07-route.yaml`.

Ganti placeholder image pada bootstrap dan aplikasi dengan digest hasil build. Lisensi SQL tools dan SQL Server harus disetujui sebelum mengubah nilai EULA `N` ke `Y`. Deployment awalnya nol replika; jalankan satu replika setelah konfigurasi lengkap. Jangan menerapkan seluruh direktori sekaligus.

Tidak ada password, private key atau endpoint perusahaan di folder ini. Belum diuji pada cluster tujuan.
