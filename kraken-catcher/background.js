// ── DETECTION ─────────────────────────────────────────────────────────────────
const SKIP_EXT  = /\.(jpg|jpeg|png|gif|webp|svg|ico|ttf|woff2?|eot|otf|css|map|html?)(\?.*)?$/i;
const SKIP_PATH = /\/(assets|fonts|css|images?|img|static|thumbnails?|thumb|favicon|recaptcha)\//i;
const SKIP_FILE = /\/(cover|poster|logo|banner|avatar|favicon)\./i;
const SKIP_CT   = ['text/html','text/css','text/javascript','application/javascript',
                   'application/json','application/xml','image/','font/'];
const VIDEO_CT  = ['video/','audio/','application/x-mpegurl','application/vnd.apple.mpegurl',
                   'application/dash+xml','application/octet-stream','binary/octet-stream'];
const STREAM_URL = [/\.m3u8/i,/\.mpd/i,/\.ts(\?|$)/i,/\.m4s(\?|$)/i,
                    /\/hls\//i,/\/dash\//i,/\/stream\//i,/\/play\/video\//i,
                    /krakencloud\.net/i,/tnmr\.org/i,/segment/i,/manifest/i];
const VIDEO_DOMAINS = ['krakencloud.net','tnmr.org'];

function shouldSkip(url) {
  return SKIP_EXT.test(url)||SKIP_PATH.test(url)||SKIP_FILE.test(url)||
         /\.js(\?|$)/i.test(url)||/\.json(\?|$)/i.test(url);
}
function isVideoCT(raw) {
  if (!raw) return false;
  const ct=raw.toLowerCase().split(';')[0].trim();
  if (SKIP_CT.some(s=>ct.startsWith(s))) return false;
  return VIDEO_CT.some(v=>ct.startsWith(v));
}
function isVideoDomain(url) {
  try{const h=new URL(url).hostname;return VIDEO_DOMAINS.some(d=>h===d||h.endsWith('.'+d));}
  catch{return false;}
}
function isTS(url){ return /\.ts(\?|$)/i.test(url); }
function isM3U8(url){ return /\.m3u8/i.test(url.split('?')[0]); }

// ── STATE ─────────────────────────────────────────────────────────────────────
let capturedByTab = {};
// Guardamos cookies por dominio a medida que el navegador las usa
let domainCookies = {};   // hostname -> cookie string
let domainHeaders = {};   // hostname -> {referer, origin, user-agent}

function saveCapture(tabId, url, contentType, requestType) {
  if (!capturedByTab[tabId]) capturedByTab[tabId]=[];
  if (isTS(url)) return;
  if (capturedByTab[tabId].some(e=>e.url===url)) return;
  const entry={url,contentType:contentType||'?',requestType,
               timestamp:Date.now(),time:new Date().toLocaleTimeString('es-ES')};
  capturedByTab[tabId].unshift(entry);
  if (capturedByTab[tabId].length>30) capturedByTab[tabId].pop();
  chrome.storage.local.set({[`tab_${tabId}`]:capturedByTab[tabId]});
  chrome.action.setBadgeText({text:String(capturedByTab[tabId].length),tabId});
  chrome.action.setBadgeBackgroundColor({color:'#e53e3e',tabId});
}

// Interceptar requests para capturar cookies y headers reales
chrome.webRequest.onSendHeaders.addListener(
  (details) => {
    if (details.tabId<0) return;
    const byMedia=details.type==='media';
    const byDomain=isVideoDomain(details.url);
    const byUrl=STREAM_URL.some(p=>p.test(details.url));
    if (!byMedia&&!byDomain&&!byUrl) return;
    if (shouldSkip(details.url)) return;

    try {
      const host=new URL(details.url).hostname;
      const hdrs={};
      (details.requestHeaders||[]).forEach(h=>{ hdrs[h.name.toLowerCase()]=h.value; });
      if (hdrs['cookie']) domainCookies[host]=hdrs['cookie'];
      domainHeaders[host]={
        referer: hdrs['referer']||'',
        origin:  hdrs['origin']||'',
        'user-agent': hdrs['user-agent']||'',
        'accept-language': hdrs['accept-language']||'',
      };
    } catch{}
  },
  {urls:['<all_urls>']},['requestHeaders','extraHeaders']
);

chrome.webRequest.onResponseStarted.addListener(
  (details) => {
    if (details.tabId<0) return;
    if (details.statusCode<200||details.statusCode>299) return;
    const url=details.url;
    if (shouldSkip(url)) return;
    const headers=details.responseHeaders||[];
    const ctRaw=headers.find(h=>h.name.toLowerCase()==='content-type')?.value||'';
    const ct=ctRaw.toLowerCase().split(';')[0].trim();
    if (ct&&SKIP_CT.some(s=>ct.startsWith(s))) return;
    const byMedia=details.type==='media';
    const byDomain=isVideoDomain(url);
    const byUrl=STREAM_URL.some(p=>p.test(url));
    const byCT=isVideoCT(ctRaw);
    if (ct==='application/octet-stream'&&!byUrl&&!byMedia) return;
    if (byMedia||(byDomain&&!shouldSkip(url))||byUrl||byCT) {
      saveCapture(details.tabId,url,ctRaw||'?',details.type);
    }
  },
  {urls:['<all_urls>']},['responseHeaders','extraHeaders']
);

function getHeaders(url, extra={}) {
  try {
    const host=new URL(url).hostname;
    const cookies=domainCookies[host]||'';
    const hdrs=domainHeaders[host]||{};
    const out={...hdrs};
    if (cookies) out['cookie']=cookies;
    return {...out,...extra};
  } catch{ return extra; }
}

async function bgFetch(url, extra={}) {
  const headers=getHeaders(url,extra);
  return fetch(url,{headers,credentials:'include'});
}

function parseM3U8(text, baseUrl) {
  const lines=text.split('\n').map(l=>l.trim()).filter(l=>l);
  const segments=[]; // {url, duration}
  let isMaster=false,bestVariantUrl=null,bestBandwidth=-1;
  let key=null; // {method, uri, iv}
  let pendingDuration=null;
  for (let i=0;i<lines.length;i++) {
    const line=lines[i];
    if (line.startsWith('#EXT-X-STREAM-INF')) {
      isMaster=true;
      const bw=parseInt((line.match(/BANDWIDTH=(\d+)/i)||[])[1]||'0');
      const next=lines[i+1];
      if (next&&!next.startsWith('#')&&bw>bestBandwidth) {
        bestBandwidth=bw;
        bestVariantUrl=next.startsWith('http')?next:new URL(next,baseUrl).href;
      }
    }
    if (line.startsWith('#EXT-X-KEY')) {
      const method=(line.match(/METHOD=([^,]+)/i)||[])[1];
      const uriRaw=(line.match(/URI="([^"]+)"/i)||[])[1];
      const iv=(line.match(/IV=(0[xX][0-9a-fA-F]+)/i)||[])[1];
      if (method && method.toUpperCase()!=='NONE' && uriRaw) key={method,uri:uriRaw,iv};
    }
    if (line.startsWith('#EXTINF')) {
      const m=line.match(/#EXTINF:([\d.]+)/);
      pendingDuration=m?parseFloat(m[1]):null;
    }
    if (!line.startsWith('#')) {
      const ext=line.split('?')[0].toLowerCase();
      if (['.ts','.aac','.mp4','.m4s','.m4a','.fmp4'].some(e=>ext.endsWith(e))) {
        segments.push({url: line.startsWith('http')?line:new URL(line,baseUrl).href, duration: pendingDuration});
        pendingDuration=null;
      }
    }
  }
  return {isMaster,bestVariantUrl,segments,key};
}

function safeName(s){ return (s||'video').replace(/[\\/:*?"<>|]/g,'_').trim().slice(0,80)||'video'; }

function bytesToBase64(bytes) {
  let binary='';
  const chunk=0x8000;
  for (let i=0;i<bytes.length;i+=chunk) binary+=String.fromCharCode(...bytes.subarray(i,i+chunk));
  return btoa(binary);
}
function bytesToDataUrl(bytes, mime='application/zip') { return `data:${mime};base64,${bytesToBase64(bytes)}`; }

const pendingDownloads=new Map();
chrome.downloads.onChanged.addListener((delta)=>{
  const p=pendingDownloads.get(delta.id);
  if (!p) return;
  if (delta.state?.current==='complete') { pendingDownloads.delete(delta.id); p.resolve(delta.id); }
  else if (delta.state?.current==='interrupted') { pendingDownloads.delete(delta.id); p.reject(new Error('Descarga interrumpida: '+(delta.error?.current||'?'))); }
});
function downloadToFile(url, filename, opts={}) {
  return new Promise((resolve,reject)=>{
    chrome.downloads.download({url,filename,saveAs:false,conflictAction:'overwrite',...opts},(id)=>{
      if (chrome.runtime.lastError || id===undefined) { reject(new Error(chrome.runtime.lastError?.message||'No se pudo iniciar la descarga')); return; }
      pendingDownloads.set(id,{resolve,reject});
    });
  });
}

const CRC_TABLE=(()=>{
  const t=new Uint32Array(256);
  for (let n=0;n<256;n++){ let c=n; for (let k=0;k<8;k++) c=(c&1)?(0xEDB88320^(c>>>1)):(c>>>1); t[n]=c>>>0; }
  return t;
})();
function crc32(bytes){
  let c=0xFFFFFFFF;
  for (let i=0;i<bytes.length;i++) c=CRC_TABLE[(c^bytes[i])&0xFF]^(c>>>8);
  return (c^0xFFFFFFFF)>>>0;
}
function dosDateTime(d=new Date()){
  return {
    time:((d.getHours()&0x1F)<<11)|((d.getMinutes()&0x3F)<<5)|((d.getSeconds()>>1)&0x1F),
    date:(((d.getFullYear()-1980)&0x7F)<<9)|(((d.getMonth()+1)&0xF)<<5)|(d.getDate()&0x1F),
  };
}

function buildZip(files){
  const {time,date}=dosDateTime();
  const enc=new TextEncoder();
  const items=files.map(f=>({name:enc.encode(f.name),data:f.data,crc:crc32(f.data)}));

  let localSize=0,centralSize=0;
  items.forEach(it=>{ localSize+=30+it.name.length+it.data.length; centralSize+=46+it.name.length; });
  const buf=new Uint8Array(localSize+centralSize+22);
  const dv=new DataView(buf.buffer);
  let off=0; const offsets=[];

  items.forEach(it=>{
    offsets.push(off);
    dv.setUint32(off,0x04034b50,true); off+=4;
    dv.setUint16(off,20,true); off+=2;
    dv.setUint16(off,0,true); off+=2;
    dv.setUint16(off,0,true); off+=2;
    dv.setUint16(off,time,true); off+=2;
    dv.setUint16(off,date,true); off+=2;
    dv.setUint32(off,it.crc,true); off+=4;
    dv.setUint32(off,it.data.length,true); off+=4;
    dv.setUint32(off,it.data.length,true); off+=4;
    dv.setUint16(off,it.name.length,true); off+=2;
    dv.setUint16(off,0,true); off+=2;
    buf.set(it.name,off); off+=it.name.length;
    buf.set(it.data,off); off+=it.data.length;
  });

  const cdStart=off;
  items.forEach((it,i)=>{
    dv.setUint32(off,0x02014b50,true); off+=4;
    dv.setUint16(off,20,true); off+=2;
    dv.setUint16(off,20,true); off+=2;
    dv.setUint16(off,0,true); off+=2;
    dv.setUint16(off,0,true); off+=2;
    dv.setUint16(off,time,true); off+=2;
    dv.setUint16(off,date,true); off+=2;
    dv.setUint32(off,it.crc,true); off+=4;
    dv.setUint32(off,it.data.length,true); off+=4;
    dv.setUint32(off,it.data.length,true); off+=4;
    dv.setUint16(off,it.name.length,true); off+=2;
    dv.setUint16(off,0,true); off+=2;
    dv.setUint16(off,0,true); off+=2;
    dv.setUint16(off,0,true); off+=2;
    dv.setUint16(off,0,true); off+=2;
    dv.setUint32(off,0,true); off+=4;
    dv.setUint32(off,offsets[i],true); off+=4;
    buf.set(it.name,off); off+=it.name.length;
  });
  const cdSize=off-cdStart;

  dv.setUint32(off,0x06054b50,true); off+=4;
  dv.setUint16(off,0,true); off+=2;
  dv.setUint16(off,0,true); off+=2;
  dv.setUint16(off,items.length,true); off+=2;
  dv.setUint16(off,items.length,true); off+=2;
  dv.setUint32(off,cdSize,true); off+=4;
  dv.setUint32(off,cdStart,true); off+=4;
  dv.setUint16(off,0,true);

  return buf;
}

let cancelFlags={};
let activeDownloads={};

function notify(dlId,data) {
  if (activeDownloads[dlId]) Object.assign(activeDownloads[dlId],data);
  chrome.runtime.sendMessage({type:'DOWNLOAD_PROGRESS',dlId,...data}).catch(()=>{});
}

const ZIP_PART_BYTES=150*1024*1024;

async function downloadHLS(dlId, m3u8Url, tabId, filename) {
  notify(dlId,{loaded:0,total:0,statusText:'Leyendo playlist...',done:false});

  const r1=await bgFetch(m3u8Url);
  if (!r1.ok) throw new Error(`M3U8 HTTP ${r1.status}`);
  const text1=await r1.text();
  let parsed=parseM3U8(text1,m3u8Url);
  let variantUrl=m3u8Url;

  if (parsed.isMaster) {
    if (!parsed.bestVariantUrl) throw new Error('Master sin variantes');
    const r2=await bgFetch(parsed.bestVariantUrl);
    if (!r2.ok) throw new Error(`Variant HTTP ${r2.status}`);
    variantUrl=parsed.bestVariantUrl;
    parsed=parseM3U8(await r2.text(),variantUrl);
  }

  if (!parsed.segments.length) throw new Error('Sin segmentos');
  const total=parsed.segments.length;
  notify(dlId,{loaded:0,total,statusText:`0 / ${total} segmentos`,done:false});

  const folder=`KrakenCatcher/${safeName((filename||'video').replace(/\.mp4$/i,''))}`;
  const segFilenames=parsed.segments.map((s,i)=>`seg${String(i+1).padStart(5,'0')}.ts`);

  let keyEntry=null;
  if (parsed.key && parsed.key.uri) {
    try {
      const keyUrl=parsed.key.uri.startsWith('http')?parsed.key.uri:new URL(parsed.key.uri,variantUrl).href;
      const kr=await bgFetch(keyUrl);
      if (kr.ok) keyEntry={name:'key.bin',data:new Uint8Array(await kr.arrayBuffer())};
    } catch(e){ console.warn('[KC] No se pudo descargar la key de cifrado:',e); }
  }

  const durations=parsed.segments.map(s=>s.duration||10);
  const maxDur=Math.ceil(Math.max(...durations));
  const m3u8Lines=['#EXTM3U','#EXT-X-VERSION:3',`#EXT-X-TARGETDURATION:${maxDur||10}`,'#EXT-X-MEDIA-SEQUENCE:0'];
  if (parsed.key && keyEntry) {
    let keyLine=`#EXT-X-KEY:METHOD=${parsed.key.method||'AES-128'},URI="${keyEntry.name}"`;
    if (parsed.key.iv) keyLine+=`,IV=${parsed.key.iv}`;
    m3u8Lines.push(keyLine);
  }
  parsed.segments.forEach((s,i)=>{ m3u8Lines.push(`#EXTINF:${(s.duration||10).toFixed(3)},`); m3u8Lines.push(segFilenames[i]); });
  m3u8Lines.push('#EXT-X-ENDLIST');
  const playlistEntry={name:'playlist.m3u8',data:new TextEncoder().encode(m3u8Lines.join('\n'))};

  let batch=[], batchBytes=0, partNum=0, lastDlId=null;

  async function flushBatch(extraEntries=[]) {
    if (batch.length===0 && extraEntries.length===0) return;
    partNum++;
    notify(dlId,{loaded:Math.min(partNum*1,total),total,statusText:`Guardando parte ${partNum} (.zip)...`,done:false});
    const zipBytes=buildZip([...batch,...extraEntries]);
    const partName=`${folder}/parte_${String(partNum).padStart(2,'0')}.zip`;
    lastDlId=await downloadToFile(bytesToDataUrl(zipBytes),partName);
    batch=[]; batchBytes=0;
  }

  for (let i=0;i<parsed.segments.length;i++) {
    if (cancelFlags[dlId]) {
      notify(dlId,{loaded:i,total,cancelled:true,error:'Cancelado',done:false}); return;
    }

    let data=null,lastErr=null;
    for (let attempt=0;attempt<3;attempt++) {
      try {
        const resp=await bgFetch(parsed.segments[i].url);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        data=new Uint8Array(await resp.arrayBuffer());
        break;
      } catch(e){lastErr=e;if(attempt<2)await new Promise(r=>setTimeout(r,800*(attempt+1)));}
    }
    if (!data) throw new Error(`Seg ${i+1}: ${lastErr?.message}`);

    batch.push({name:segFilenames[i],data});
    batchBytes+=data.byteLength;
    notify(dlId,{loaded:i+1,total,statusText:`${i+1}/${total} segmentos · parte ${partNum+1}`,done:false});

    if (batchBytes>=ZIP_PART_BYTES) await flushBatch();
  }

  const extras=[playlistEntry]; if (keyEntry) extras.push(keyEntry);
  await flushBatch(extras);

  let folderPath=folder;
  try {
    const [item]=await chrome.downloads.search({id:lastDlId});
    if (item?.filename) folderPath=item.filename.replace(/[\\/][^\\/]+$/,'');
  } catch{}

  const isWindowsPath=folderPath.includes('\\');
  const sep=isWindowsPath?'\\':'/';
  const playlistPath=`${folderPath}${sep}playlist.m3u8`;
  const outName=(filename||'video').replace(/\.mp4$/i,'')+'.mp4';
  const ffmpegCmd=`ffmpeg -allowed_extensions ALL -i "${playlistPath}" -c copy "${outName}"`;
  // Windows: PowerShell. Linux/macOS: POSIX shell with unzip.
  const extractHint=isWindowsPath
    ? `Get-ChildItem "${folderPath}" -Filter parte_*.zip | ForEach-Object { Expand-Archive $_.FullName -DestinationPath "${folderPath}" -Force }`
    : `cd "${folderPath}" && for f in parte_*.zip; do unzip -o "$f"; done`;
  const extractLabel=isWindowsPath?'PowerShell':'shell';

  notify(dlId,{loaded:total,total,done:true,statusText:`¡${partNum} parte(s) .zip guardada(s)!`,localPath:folderPath,ffmpegCmd,extractHint,extractLabel});
}

async function downloadDirect(dlId, url, tabId, filename) {
  notify(dlId,{loaded:0,total:0,statusText:'Iniciando descarga...',done:false});

  const HEADER_NAME_MAP={referer:'Referer',origin:'Origin','user-agent':'User-Agent','accept-language':'Accept-Language'};
  const hdrs=getHeaders(url);
  const headerArray=Object.entries(hdrs)
    .filter(([k,v])=>v && k.toLowerCase()!=='cookie') // cookie la maneja Chrome solo
    .map(([name,value])=>({name:HEADER_NAME_MAP[name]||name,value}));

  const downloadId=await new Promise((resolve,reject)=>{
    chrome.downloads.download({url,filename,headers:headerArray,saveAs:false,conflictAction:'overwrite'},(id)=>{
      if (chrome.runtime.lastError||id===undefined) reject(new Error(chrome.runtime.lastError?.message||'No se pudo iniciar la descarga'));
      else resolve(id);
    });
  });

  await new Promise((resolve,reject)=>{
    const poll=setInterval(async ()=>{
      if (cancelFlags[dlId]) {
        clearInterval(poll);
        try{ await chrome.downloads.cancel(downloadId); }catch{}
        notify(dlId,{cancelled:true,error:'Cancelado',done:false});
        resolve(); return;
      }
      try {
        const [item]=await chrome.downloads.search({id:downloadId});
        if (!item) return;
        if (item.state==='complete') {
          clearInterval(poll);
          notify(dlId,{loaded:item.totalBytes||item.fileSize||1,total:item.totalBytes||item.fileSize||1,done:true,statusText:'¡Completado!',localPath:item.filename});
          resolve();
        } else if (item.state==='interrupted') {
          clearInterval(poll);
          reject(new Error('Descarga interrumpida: '+(item.error||'?')));
        } else {
          notify(dlId,{loaded:item.bytesReceived||0,total:item.totalBytes||0,done:false,statusText:'Descargando...'});
        }
      } catch{}
    },600);
  });
}

const NATIVE_HOST_ID='com.krakencatcher.host';
let activeNativePorts={};

function tryNativeDownload(dlId, payload, onProgress) {
  return new Promise((resolve,reject)=>{
    let port;
    try { port=chrome.runtime.connectNative(NATIVE_HOST_ID); }
    catch(e){ reject(Object.assign(new Error('NO_NATIVE_HOST'),{code:'NO_NATIVE_HOST'})); return; }

    let gotAny=false, settled=false;
    function finish(fn,arg){ if(settled) return; settled=true; try{port.disconnect();}catch{} delete activeNativePorts[dlId]; fn(arg); }

    port.onMessage.addListener((m)=>{
      gotAny=true;
      if (m.type==='PROGRESS') onProgress(m);
      else if (m.type==='DONE') finish(resolve,m);
      else if (m.type==='ERROR') finish(reject,new Error(m.message||'Error en el host nativo'));
      else if (m.type==='CANCELLED') finish(reject,Object.assign(new Error('Cancelado'),{cancelled:true}));
    });
    port.onDisconnect.addListener(()=>{
      if (settled) return;
      const reason=chrome.runtime.lastError?.message||'';
      finish(reject, gotAny
        ? new Error('Se perdió la conexión con el host nativo: '+reason)
        : Object.assign(new Error('NO_NATIVE_HOST'),{code:'NO_NATIVE_HOST'}));
    });
    activeNativePorts[dlId]=port;
    port.postMessage(payload);
  });
}

async function startDownload(tabId,url,filename,dlId) {
  cancelFlags[dlId]=false;
  activeDownloads[dlId]={tabId,loaded:0,total:0,done:false};
  notify(dlId,{loaded:0,total:0,statusText:'Iniciando...',done:false});

  const isHLS=isM3U8(url);
  const hdrs=getHeaders(url);

  try {
    const result=await tryNativeDownload(dlId,{
      type: isHLS?'DOWNLOAD_HLS':'DOWNLOAD_DIRECT',
      jobId: dlId,
      m3u8Url: isHLS?url:undefined,
      url: isHLS?undefined:url,
      headers: hdrs,
      filename,
    },(m)=>{
      notify(dlId,{loaded:m.loaded,total:m.total,statusText:m.statusText,done:false});
    });
    notify(dlId,{loaded:1,total:1,done:true,statusText:'¡Completado!'+(result.note?` (${result.note})`:''),localPath:result.outputPath});
    return;
  } catch(e) {
    delete activeNativePorts[dlId];
    if (e.cancelled) { notify(dlId,{cancelled:true,error:'Cancelado',done:false}); return; }
    if (e.code!=='NO_NATIVE_HOST') {
      notify(dlId,{error:e.message,done:false});
      console.error('[KC] native host error:',e);
      return;
    }
    console.warn('[KC] Host nativo no encontrado, usando método zip de respaldo.');
  }

  try {
    if (isHLS) await downloadHLS(dlId,url,tabId,filename);
    else       await downloadDirect(dlId,url,tabId,filename);
  } catch(e) {
    const msg = e?.message || (e?.type==='error' ? 'Fallo de lectura/red (revisa la consola)' : String(e));
    notify(dlId,{error:msg,done:false});
    console.error('[KC]',e);
  }
}

// ── TABS ──────────────────────────────────────────────────────────────────────
chrome.tabs.onRemoved.addListener((tabId)=>{
  delete capturedByTab[tabId];
  chrome.storage.local.remove(`tab_${tabId}`);
});
chrome.tabs.onUpdated.addListener((tabId,changeInfo)=>{
  if(changeInfo.status==='loading'){
    delete capturedByTab[tabId];
    chrome.storage.local.remove(`tab_${tabId}`);
    chrome.action.setBadgeText({text:'',tabId});
  }
});

chrome.runtime.onMessage.addListener((msg,sender,sendResponse)=>{
  if(msg.type==='GET_CAPTURES'){sendResponse({captures:capturedByTab[msg.tabId]||[]});return true;}
  if(msg.type==='CLEAR_TAB'){
    delete capturedByTab[msg.tabId];
    chrome.storage.local.remove(`tab_${msg.tabId}`);
    chrome.action.setBadgeText({text:'',tabId:msg.tabId});
    sendResponse({ok:true});return true;
  }
  if(msg.type==='START_DOWNLOAD'){
    startDownload(msg.tabId,msg.url,msg.filename,msg.dlId).catch(console.error);
    sendResponse({ok:true});return true;
  }
  if(msg.type==='CANCEL_DOWNLOAD'){
    cancelFlags[msg.dlId]=true;
    const port=activeNativePorts[msg.dlId];
    if (port) { try{ port.postMessage({type:'CANCEL',jobId:msg.dlId}); }catch{} }
    sendResponse({ok:true});return true;
  }
  return true;
});
