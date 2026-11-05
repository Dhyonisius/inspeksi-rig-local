# Update chatbot dari Git ke OpenShift dengan LLM internal perusahaan

## Konfigurasi utama: LLM internal

Alur chat: aplikasi → `INSPECTION_CHAT_BASE_URL` → `llm-bridge` → gateway LLM perusahaan. Jalur foto tetap memakai `OLLAMA_BASE_URL` dan model vision yang sudah digunakan. Jika endpoint chat terpisah kosong, aplikasi memakai `OLLAMA_BASE_URL` seperti versi sebelumnya.

ConfigMap perusahaan kini menyiapkan `INSPECTION_CHAT_BASE_URL=http://llm-bridge:8080` dan `INSPECTION_CHAT_MODEL=company-inspection`. Alias tersebut harus sama dengan `PUBLIC_MODEL` pada bridge. Isi `UPSTREAM_MODEL` dengan ID model sebenarnya dari tim IT; isi `UPSTREAM_BASE_URL` dengan endpoint OpenAI-compatible perusahaan. Token hanya disimpan melalui Secret. Pertahankan konfigurasi DPoP, volume kunci dan device yang sudah disetujui jika gateway memerlukannya. Panduan detail: [llm-bridge](../llm-bridge/README.md).

Bridge dibangun terpisah menggunakan `llm-bridge/Dockerfile`; ia tidak otomatis berjalan di dalam image aplikasi. Manifest contoh bridge masih memerlukan image dan `CHANGE_ME_COMPANY_MODEL`. Jangan menimpa konfigurasi bridge yang sudah berjalan dengan placeholder ini. Nama alias bukan nama bobot; model sebenarnya mengikuti `UPSTREAM_MODEL`. Jika gateway bukan OpenAI-compatible, protokolnya perlu ditinjau terlebih dahulu.

Untuk aplikasi yang memakai Service dan alias di atas:

```sh
oc set env deployment/inspeksi-rig INSPECTION_CHAT_BASE_URL=http://llm-bridge:8080 INSPECTION_CHAT_MODEL=company-inspection
```

Qwen lokal tidak wajib dipasang pada server perusahaan. Uji staging tetap diperlukan terhadap model internal, karena perilakunya dapat berbeda dari model pengujian lokal. Pengujian konektor memakai upstream buatan; endpoint perusahaan sebenarnya belum diakses.

Repository public: `https://github.com/Dhyonisius/inspeksi-rig-local.git`, branch `main`. Dockerfile berada di root. BuildConfig pada `deploy/openshift-company/02-build.yaml` sudah menunjuk sumber tersebut; tidak membutuhkan token GitHub untuk clone repository public.

## Jika aplikasi perusahaan sudah berjalan

1. Gunakan project dan BuildConfig milik aplikasi yang memang sudah terpasang. Catat image digest dan konfigurasi yang sedang berjalan untuk rollback. Jangan menimpa ConfigMap perusahaan dengan manifest contoh: contoh berisi placeholder.
2. Pastikan Git URI dan ref BuildConfig mengarah ke repository di atas dan `main`. Jika sebelumnya memakai fork/private repo, tinjau sumber dan clone secret yang sesuai. Menarik Git saja belum memperbarui pod; perlu build image dan rollout.
3. Jalankan build dengan pengaturan lisensi/buildArgs yang sebelumnya sudah disetujui administrator. Tidak ada persetujuan lisensi otomatis pada perubahan ini.

   ```sh
   oc start-build inspeksi-rig --follow
   ```

4. Pastikan Service bridge dan gateway perusahaan tersedia sebagaimana konfigurasi utama di atas. Model vision lama tetap diperlukan untuk foto. Untuk pengujian lokal alternatif, model Ollama `qwen3:4b-instruct` dapat dipasang terpisah; model tidak dibundel ke image aplikasi.
5. Sesuaikan konfigurasi layanan aplikasi untuk bridge perusahaan:

   ```sh
   oc set env deployment/inspeksi-rig INSPECTION_CHAT_BASE_URL=http://llm-bridge:8080 INSPECTION_CHAT_MODEL=company-inspection
   ```

   Pertahankan `OLLAMA_BASE_URL` perusahaan. Jika diarahkan ke `llm-bridge`, gunakan nilai `INSPECTION_CHAT_MODEL` yang sama dengan `PUBLIC_MODEL` bridge, dan pastikan `UPSTREAM_MODEL` adalah model yang disetujui perusahaan. Nama model saja tidak mengganti bobot yang disediakan gateway.

   Pertahankan atau atur `PDF_SOURCE_ALLOWED_HOSTS` hanya ke hostname sumber PDF yang diizinkan (sertakan port nonstandar bila ada). Pengambilan mengikuti konfigurasi sumber lama; host sumber tetap diperiksa pada redirect. Tidak ada wildcard otomatis atau perubahan login/DPoP.
6. Ambil digest image hasil build dari OpenShift, lalu perbarui image **container app dan kedua init container** bersama-sama melalui YAML Deployment. Pertahankan volume, SQL, CA, Secret, Route, satu replika dan strategi Recreate yang sudah ada. Jangan hanya mengubah container app sementara init masih memakai image lama.
7. Tunggu rollout dan uji di staging:

   ```sh
   oc rollout status deployment/inspeksi-rig
   ```

   Login; buka AI Inspeksi Visual; impor satu PDF yang disetujui; tanyakan equipment dan cocokkan halaman; buka rincian sumber; coba Balas dan jempol; verifikasi data tetap ada setelah restart; periksa foto dengan model vision lama. Ctrl+F5 untuk memuat aset baru.

BuildConfig tetap tanpa trigger otomatis. Push ke GitHub tidak menjalankan perubahan pada server perusahaan. Image hasil build juga tidak otomatis diterapkan jika Deployment menggunakan digest tetap. Ini memberi kesempatan menguji staging sebelum mengganti production.

## Instalasi baru

Ikuti [panduan perusahaan](../PANDUAN-DEPLOY-OPENSHIFT-PERUSAHAAN.md), mulai dari storage, Secret/TLS SQL, bootstrap dan Route. ConfigMap perusahaan menyertakan endpoint chat bridge dan alias `company-inspection`; endpoint vision dan APP_ORIGIN masih harus diisi sesuai lingkungan. Paket SQL eksternal juga menyediakan parameter model dan endpoint chat terpisah pada runtime Template.

## Validasi dan batasan

- Pengujian lokal: 32 pemeriksaan regresi chatbot/PDF, peringatan, VLM, bridge dan DPoP, serta permintaan Qwen nyata dengan laporan simulasi. Workflow build image yang sudah ada tetap manual; workflow regresi baru belum dipasang karena kredensial unggah tidak memiliki scope workflow.
- PDF teks tanpa foto didukung. PDF scan satu halaman penuh masih memerlukan OCR tambahan; Qwen teks tidak menilai foto langsung.
- Hasil chatbot memakai potongan teks relevan, bukan seluruh PDF sekaligus. Feedback tersimpan untuk evaluasi dan tidak melatih ulang model otomatis.
- Tidak ada migrasi SQL, perubahan autentikasi atau penggantian konektor bridge/DPoP pada pembaruan ini.
- Build image dan rollout pada cluster perusahaan belum dijalankan dalam pengujian lokal. Akses proxy, registry, kuota, CA, PVC dan endpoint AI harus diuji di cluster tujuan.

Rollback: kembalikan image digest (termasuk init container) dan nilai model sebelumnya, lalu rollout. Jangan menghapus PVC atau dataset untuk rollback kode.

Referensi Git source BuildConfig: [Red Hat](https://docs.redhat.com/en/documentation/openshift_container_platform/4.20/html/builds_using_buildconfig/creating-build-inputs).
