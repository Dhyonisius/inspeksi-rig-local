# llm-bridge

Jembatan kecil yang membuat aplikasi **Inspeksi Visual** (yang berbicara protokol Ollama)
bisa memakai **LLM internal perusahaan** yang OpenAI-compatible. Tanpa mengubah kode aplikasi.

## Kenapa perlu

Aplikasi memanggil:

| Endpoint | Dipakai untuk |
|---|---|
| `GET /api/tags` | daftar model + `capabilities` (harus memuat `vision`) |
| `POST /api/show` | detail capability per model |
| `POST /api/chat` | inferensi: `{model, messages:[{role, content, images:[base64]}], format, options}` |

Gateway internal (vLLM / LiteLLM / Azure OpenAI) memakai `/v1/chat/completions` dengan
format `content: [{type:'image_url', ...}]` dan `response_format`. Jembatan ini menerjemahkan
keduanya, termasuk **fallback** ke `json_object` bila gateway menolak `json_schema`.

## Konfigurasi

| Env | Wajib | Contoh |
|---|---|---|
| `UPSTREAM_BASE_URL` | ya | `https://llm.internal/v1` |
| `UPSTREAM_MODEL` | ya | `qwen2.5-vl-7b` |
| `PUBLIC_MODEL` | tidak | nama yang dilihat aplikasi (default = `UPSTREAM_MODEL`) |
| `UPSTREAM_API_KEY` | tidak | diisi lewat Secret, dikirim sebagai `Authorization: Bearer` |
| `UPSTREAM_TIMEOUT_MS` | tidak | default `240000` (aplikasi sendiri menunggu 180–300 detik) |
| `IMAGE_MIME` | tidak | default `image/jpeg` |
| `PORT` | tidak | default `8080` |

## Jalankan lokal

```bash
node server.js                      # butuh env di atas
node --test test.js                 # 4 tes, memakai kode discovery asli aplikasi
```

## Deploy ke OpenShift

```powershell
oc apply -f deploy/openshift/llm-bridge.yaml
oc get pods -l app=llm-bridge
oc expose service llm-bridge        # tidak perlu; cukup Service internal
```

Lalu arahkan aplikasi ke jembatan:

```powershell
oc set env deployment/inspeksi-rig OLLAMA_BASE_URL=http://llm-bridge:8080
```

## Verifikasi

```bash
curl -s http://llm-bridge:8080/healthz
curl -s http://llm-bridge:8080/api/tags
curl -s -X POST http://llm-bridge:8080/api/chat \
  -H 'Content-Type: application/json' \
  -d '{"model":"qwen2.5-vl-7b","messages":[{"role":"user","content":"uji","images":["<base64>"]}],"stream":false}'
```

## Batasan yang jujur

- Jembatan ini **belum** diuji terhadap gateway perusahaan Anda yang sebenarnya — hanya
  terhadap upstream palsu yang meniru OpenAI. Perbedaan nyata bisa muncul di: nama field
  `response_format`, dukungan `max_tokens` vs `max_completion_tokens`, dan batas ukuran gambar.
- Streaming tidak diterjemahkan (aplikasi selalu `stream:false`, jadi aman).
- `/api/generate` belum didukung (aplikasi tidak memakainya).
- Jika gateway memakai skema auth selain `Bearer`, sesuaikan satu baris di `server.js`.
- Kualitas hasil bergantung pada model: model vision 7B ke atas lebih layak untuk inspeksi
  dibanding model kecil.
