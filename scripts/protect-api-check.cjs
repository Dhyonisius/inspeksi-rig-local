// One-shot check from the CRSSC Postman collection. No token/password logging.
// Credentials must come from an approved account via OpenShift Secret env refs.
const BASE = 'https://apps.phr.pertamina.com/APIGW';
async function check({env=process.env,fetchImpl=fetch,log=console.log}={}) {
  if(!env.PROTECT_USERNAME||!env.PROTECT_PASSWORD){log('BELUM SIAP: isi PROTECT_USERNAME dan PROTECT_PASSWORD melalui Secret.');return 2;}
  const headers={'Content-Type':'application/json',Accept:'application/json','Ocp-Apim-Subscription-Key':'NULL'};
  const request=(endpoint,options={})=>fetchImpl(BASE+endpoint,{...options,redirect:'manual',signal:AbortSignal.timeout(30000)});
  try {
    const login=await request('/Account/Login',{method:'POST',headers,body:JSON.stringify({username:env.PROTECT_USERNAME.trim().toLowerCase(),password:env.PROTECT_PASSWORD,DeviceToken:'',AppVersion:'6.3.6'})});
    log('Login HTTP: '+login.status);
    if(!login.ok){await login.body?.cancel();log('GAGAL: login ditolak. Tidak dicoba ulang otomatis; periksa akun/akses dengan pengelola.');return 1;}
    let auth;try{auth=await login.json();}catch{log('GAGAL: respons login bukan JSON.');return 1;}
    if(auth.mfacode){log('BERHENTI: respons meminta MFA. Perlu alur resmi penyedia sebelum melanjutkan.');return 2;}
    if(typeof auth.jwtToken!=='string'||!auth.jwtToken.trim()){log('GAGAL: jwtToken tidak ditemukan pada respons login.');return 1;}
    const rigs=await request('/protect/GetRigs',{headers:{Accept:'application/json','Ocp-Apim-Subscription-Key':'NULL',Authorization:'Bearer '+auth.jwtToken}});
    log('GetRigs HTTP: '+rigs.status);
    if(!rigs.ok){await rigs.body?.cancel();log('GAGAL: daftar rig tidak dapat diakses.');return 1;}
    let data;try{data=await rigs.json();}catch{log('GAGAL: respons daftar rig bukan JSON.');return 1;}
    if(data.status!=='success'||!Array.isArray(data.data)){log('GAGAL: bentuk/status respons daftar rig tidak sesuai dokumentasi.');return 1;}
    log('BERHASIL: API dapat dibaca. Jumlah rig pada respons: '+data.data.length+'. Nama dan data pribadi tidak ditampilkan.');
    log('Token hanya dipakai di memori untuk tes ini; tidak disimpan ke file.');
    return 0;
  }catch(error){log('GAGAL: '+(error.name==='TimeoutError'?'permintaan melewati 30 detik.':error.name==='TypeError'?'koneksi jaringan/TLS gagal. Periksa akses pod dan CA perusahaan.':'pemeriksaan tidak selesai.'));return 1;}
}
module.exports={check};
if(require.main===module)check().then(code=>{process.exitCode=code;});
