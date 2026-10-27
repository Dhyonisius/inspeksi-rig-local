# Panduan Menjalankan — Lentera K3 / Inspeksi Visual Rig

Panduan ini menjelaskan cara menjalankan aplikasi dari repository GitHub pada Windows dan menyediakan jalur deployment OpenShift perusahaan.

**Repository:** [Dhyonisius/inspeksi-rig-local](https://github.com/Dhyonisius/inspeksi-rig-local)  
**Tanggal panduan:** 27 Oktober 2026  
**Tujuan:** membantu pengguna menyiapkan, menjalankan, dan menguji salinan kode dari GitHub.

> **Status pengujian:** aplikasi lokal pada laptop pengembang telah merespons HTTP 200. Panduan ini disusun dari kode repository dan konfigurasi lokal yang diperiksa. Instalasi baru pada komputer pengguna, build container, dan deployment OpenShift perusahaan belum divalidasi dalam penyusunan panduan ini.

## 1. Pilih cara menjalankan

| Keperluan pengguna | Yang dibuka atau dilakukan |
|---|---|
| Membaca gambaran proyek | Bagian 2 di bawah |
| Meninjau kode | [Server](server.js), [antarmuka](public/), [skrip pendukung](scripts/), dan [skema database](sql/) |
| Mencoba aplikasi pada Windows | Ikuti bagian 3–7 |
| Menjalankan pada OpenShift perusahaan | Baca [panduan deployment OpenShift](docs/deploy-openshift.md) |
| Meninjau alur pembelajaran foto | Baca [panduan pembelajaran berbantuan AI](docs/pembelajaran-berbantuan-ai.md) |

GitHub menyediakan kode dan panduan. Tautan GitHub ini belum merupakan alamat aplikasi yang sudah dihosting. Alamat `http://127.0.0.1:3180` menunjuk komputer yang membukanya; pengguna perlu menjalankan server di komputernya agar alamat tersebut berfungsi.

## 2. Gambaran proyek

Lentera K3 membantu meninjau foto rig menggunakan model visi lokal. Alurnya: masuk → pilih area → unggah/ambil foto → pilih model vision → analisis → tinjau hasil → periksa riwayat.

Fitur dalam kode mencakup pemeriksaan foto, deskripsi dan indikasi visual dari AI, koreksi pengguna, riwayat, serta kurasi dan anotasi calon data pelatihan. Pelatihan detektor rig memerlukan dependensi dan bobot model tambahan.

Komponen:

- **Node.js:** menjalankan aplikasi web dan API melalui `server.js`.
- **Microsoft SQL Server:** menyimpan akun, pemeriksaan, hasil, dan anotasi pada database `K3VisionLocal`.
- **Python:** memproses gambar/PDF.
- **Ollama + model vision:** menganalisis isi foto.
- **Folder data lokal:** menyimpan foto dan berkas aplikasi yang tidak disertakan di GitHub.

Hasil AI perlu ditinjau manusia; hasil tersebut merupakan indikasi visual awal dan tidak menetapkan kelayakan operasi rig.

## 3. Persiapan Windows

Bagian ini untuk uji lokal pada Windows dengan instance SQL Server Express `.\SQLEXPRESS` dan Windows Authentication.

| Kebutuhan | Persiapan |
|---|---|
| Git | Untuk `git clone`; alternatifnya gunakan **Code → Download ZIP** di GitHub |
| Node.js | Gunakan seri 22 sesuai Dockerfile proyek; [unduhan resmi](https://nodejs.org/en/download) |
| Python | Gunakan Python 64-bit, misalnya 3.12 atau 3.13, dengan perintah `python` tersedia; [unduhan Windows](https://www.python.org/downloads/windows/) |
| SQL Server Express | Pasang mesin database dengan instance `SQLEXPRESS`, pastikan layanannya berjalan, dan beri akun Windows penguji izin menyiapkan database aplikasi |
| SQLCMD berbasis ODBC | Gunakan SQLCMD ODBC generasi 18 beserta driver ODBC yang dibutuhkannya; [panduan Microsoft](https://learn.microsoft.com/en-us/sql/tools/sqlcmd/sqlcmd-utility?view=sql-server-ver17) |
| Ollama | Pasang [Ollama untuk Windows](https://ollama.com/download/windows), jalankan, lalu unduh model vision |
| Koneksi internet | Diperlukan saat mengunduh kode, paket, dan model |

SSMS dapat membantu pengelolaan SQL Server. Mesin SQL Server tetap perlu terpasang dan aktif. Bila database dikelola perusahaan, minta DBA menyediakan database khusus dan hak akses yang sesuai; konfigurasi perusahaan mengikuti panduan OpenShift.

Di PowerShell baru, cek instalasi:

```powershell
git --version
node --version
python --version
ollama --version
Get-Service -Name 'MSSQL$SQLEXPRESS'
```

Target: perintah ditemukan dan layanan SQL berstatus `Running`. Jika `python` belum ditemukan, sesuaikan PATH atau gunakan lokasi Python yang terpasang. Jika Git tidak dipasang, gunakan ZIP pada langkah berikutnya.

## 4. Unduh kode dan siapkan Python

Jalankan PowerShell pada folder tempat proyek ingin disimpan:

```powershell
git clone https://github.com/Dhyonisius/inspeksi-rig-local.git
Set-Location inspeksi-rig-local

python -m venv .venv
& .\.venv\Scripts\python.exe -m pip install -r deploy/container/requirements.txt
& .\.venv\Scripts\python.exe -c "from PIL import Image; import fitz; print('Dependensi gambar dan PDF siap')"
```

Alternatif ZIP: unduh **Code → Download ZIP**, ekstrak, lalu buka PowerShell di folder yang berisi `package.json` dan `server.js`. Jalankan perintah mulai dari `python -m venv .venv`.

Dependensi dasar Python adalah Pillow dan PyMuPDF. Pada versi kode yang diperiksa, `package.json` tidak mencantumkan dependensi npm eksternal; server dapat dimulai dengan `node server.js`.

## 5. Siapkan model vision

Pastikan Ollama sudah berjalan. Di PowerShell:

```powershell
ollama pull gemma3:4b
ollama list
ollama show gemma3:4b
```

`gemma3:4b` mendukung gambar dan merupakan salah satu model yang tersedia pada laptop pengembang. Lihat [keterangan resmi model](https://ollama.com/library/gemma3). Kebutuhan memori dan waktu analisis bergantung perangkat serta foto.

Jika layanan Ollama belum berjalan, buka aplikasi Ollama. Alternatifnya, jalankan `ollama serve` di terminal terpisah dan biarkan terminal tersebut tetap terbuka. Gunakan satu layanan pada port 11434.

Periksa endpoint lokal:

```powershell
Invoke-RestMethod http://127.0.0.1:11434/api/tags
```

Target: respons berisi daftar model, termasuk `gemma3:4b`. Daftar model teks saja belum cukup untuk analisis foto.

## 6. Atur konfigurasi dan jalankan

Gunakan PowerShell di folder repository. Perintah berikut memakai virtualenv yang dibuat di langkah 4 dan SQL Server Express lokal:

```powershell
$env:NODE_ENV = 'development'
$env:HOST = '127.0.0.1'
$env:PORT = '3180'
$env:SQL_SERVER = '.\SQLEXPRESS'
$env:SQLCMD_EXE = 'C:\Program Files\Microsoft SQL Server\Client SDK\ODBC\180\Tools\Binn\SQLCMD.EXE'
$env:PYTHON_EXE = (Resolve-Path -LiteralPath '.\.venv\Scripts\python.exe').Path
$env:OLLAMA_BASE_URL = 'http://127.0.0.1:11434'
$env:SQL_MIGRATE_ON_START = 'true'

if (-not (Test-Path -LiteralPath $env:SQLCMD_EXE)) {
    throw 'SQLCMD tidak ditemukan. Sesuaikan SQLCMD_EXE dengan lokasi SQLCMD ODBC pada komputer ini.'
}

# Uji koneksi Windows Authentication ke instance SQL lokal.
& $env:SQLCMD_EXE -S $env:SQL_SERVER -E -C -No -b -Q "SELECT @@SERVERNAME AS server_name;"
if ($LASTEXITCODE -ne 0) {
    throw 'Koneksi SQL gagal. Periksa layanan, nama instance, dan hak akun Windows sebelum melanjutkan.'
}

node server.js
```

Konfigurasi ini memakai Windows Authentication bawaan pada Windows. Gunakan terminal yang tidak mewarisi variabel `SQL_USER`/`SQL_PASSWORD` dari proyek lain. Opsi kepercayaan sertifikat pada uji SQL di atas mengikuti penggunaan SQL Express lokal; konfigurasi sertifikat perusahaan mengikuti panduan deployment.

Saat startup, aplikasi mencoba membuat/menyesuaikan database `K3VisionLocal` beserta skema fiturnya. Akun Windows penguji perlu memiliki hak yang diperlukan untuk penyiapan tersebut. Untuk pengujian awal, gunakan database khusus aplikasi.

Biarkan terminal tetap terbuka. Buka:

**http://127.0.0.1:3180**

Di terminal PowerShell kedua, periksa kesiapan:

```powershell
Invoke-RestMethod http://127.0.0.1:3180/api/health
```

Target: properti `database` bernilai `ready`. Halaman yang terbuka atau HTTP 200 saja belum membuktikan database dan analisis AI berfungsi.

**Catatan peluncur:** `start-local.cmd` dan `start-local.ps1` yang sudah ada masih mengandalkan struktur runtime laptop asal. Pada komputer pengguna, gunakan konfigurasi eksplisit di atas.

Untuk berhenti, tekan **Ctrl+C** pada terminal server. Untuk menjalankan kembali, buka PowerShell di folder repository dan ulangi konfigurasi bagian ini; variabel lingkungan tersebut berlaku untuk sesi terminal tersebut.

## 7. Login dan uji fungsi utama

Akun berikut disiapkan skema untuk demonstrasi lokal:

| Peran | Email | Kata sandi demo |
|---|---|---|
| Pengguna | `operator@k3.local` | `K3-demo-2026` |
| Admin | `admin@k3.local` | `K3-demo-2026` |

Mode production menggunakan admin bootstrap dan memblokir akun demo bawaan. Ikuti panduan OpenShift untuk penggunaan perusahaan.

Lakukan satu uji dengan foto rig yang diizinkan untuk pengujian:

1. Masuk sebagai pengguna.
2. Pilih menu pemeriksaan foto dan area yang sesuai.
3. Unggah foto; batas unggahan pemeriksaan adalah 8 MB.
4. Pilih model vision yang tersedia, misalnya `gemma3:4b`.
5. Jalankan analisis dan tunggu hasil atau pesan kesalahan.
6. Tinjau hasil serta koreksi bila diperlukan.
7. Buka riwayat dan pastikan hasil tersimpan.
8. Muat ulang halaman dan buka kembali hasil dari riwayat.

Gunakan tabel ini untuk mencatat pengujian aktual:

| Pemeriksaan | Hasil yang diharapkan | Hasil pengujian |
|---|---|---|
| Server aplikasi | Halaman login terbuka | Belum diuji |
| Database | `/api/health` menunjukkan `database: ready` | Belum diuji |
| Login lokal | Akun demo berhasil masuk | Belum diuji |
| Model vision | Model tersedia dalam pilihan analisis | Belum diuji |
| Analisis foto | Hasil AI muncul tanpa kesalahan layanan | Belum diuji |
| Penyimpanan | Hasil dapat dibuka kembali dari riwayat | Belum diuji |

Catat OS, versi Node/Python/SQLCMD, model AI, tanggal uji, serta pesan kesalahan bila ada. Ganti kolom “Belum diuji” berdasarkan hasil yang benar-benar diamati.

## 8. Apa yang disertakan di GitHub

**Disertakan:** kode aplikasi, aset antarmuka, skema database, skrip pendukung, dan konfigurasi deployment.

**Perlu disiapkan terpisah:** mesin SQL Server, isi database/riwayat laptop pengembang, foto inspeksi, PDF privat, anotasi, bobot/model AI, virtualenv Python, dan log/backup.

Salinan baru akan memakai data pada database yang dituju; data laptop pengembang tidak ikut berpindah melalui clone. Uji analisis foto dapat memakai foto baru yang diizinkan. Fitur pelatihan YOLO memerlukan paket tambahan, bobot awal yang sah, dan data terverifikasi; langkah dasar di atas belum menyiapkan pelatihan.

## 9. Jika terjadi kendala

| Gejala | Pemeriksaan |
|---|---|
| `node`, `python`, atau `ollama` tidak dikenal | Periksa instalasi/PATH, lalu buka terminal baru |
| SQLCMD tidak ditemukan | Pastikan SQLCMD ODBC terpasang dan koreksi `SQLCMD_EXE` |
| SQLCMD menolak `-No` | Periksa varian/versi SQLCMD; contoh ini mengikuti utilitas ODBC yang mendukung opsi tersebut |
| SQL Server tidak tersambung | Periksa layanan `MSSQL$SQLEXPRESS`, nama instance, dan hak akun Windows |
| Database belum siap | Periksa log startup dan `/api/health`; hak migrasi dan akses tulis harus tersedia |
| Model vision kosong | Periksa Ollama, `gemma3:4b`, dan endpoint `/api/tags` |
| Analisis lambat atau gagal | Periksa terminal server, layanan Ollama, memori, dan ukuran foto |
| Port 3180 sudah digunakan | Hentikan server lama; atau ubah `PORT` dan alamat browser secara konsisten |
| Dataset/riwayat kosong | Database baru tidak memuat data privat laptop pengembang |
| Kamera browser tidak tersedia | Coba unggah foto sebagai uji awal dan periksa izin kamera pada browser |

Log SQL aplikasi berada pada `data/private/logs/database-errors.log`. Saat mengirim bukti kendala, cukup sertakan pesan kesalahan yang relevan dan tutupi kredensial serta data privat.

## 10. Menjalankan pada OpenShift perusahaan

Ikuti [panduan OpenShift lengkap](docs/deploy-openshift.md), yang memuat build, konfigurasi SQL/Ollama, storage, bootstrap admin, Route HTTPS, dan diagnosis.

Ringkasan alurnya:

1. Administrator menyiapkan project, akses build/registry, jaringan, dan persetujuan dependensi/lisensi.
2. Build image menggunakan Dockerfile repository.
3. Sediakan endpoint SQL Server, Ollama dengan model vision, dan penyimpanan persisten.
4. Atur Secret dan konfigurasi lingkungan.
5. Jalankan bootstrap skema dan admin.
6. Jalankan satu replica, buat akses HTTPS sesuai kebijakan perusahaan, lalu uji login, analisis, dan riwayat.

Build image yang sukses belum membuktikan analisis dan penyimpanan berhasil. Pengujian fungsi tetap dilakukan setelah layanan pendukung tersedia.
