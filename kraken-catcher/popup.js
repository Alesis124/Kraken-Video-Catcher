function getType(url, ct) {
  const u=url.toLowerCase(), c=(ct||'').toLowerCase();
  if (u.includes('.m3u8')||c.includes('mpegurl')) return 'm3u8';
  if (u.includes('.mpd') ||c.includes('dash'))    return 'mpd';
  if (u.includes('.mp4') ||c.includes('video/mp4'))return 'mp4';
  return 'other';
}
function formatBytes(b) {
  if (!b||b<=0) return '?';
  if (b<1024*1024) return (b/1024).toFixed(1)+' KB';
  if (b<1024*1024*1024) return (b/(1024*1024)).toFixed(1)+' MB';
  return (b/(1024*1024*1024)).toFixed(2)+' GB';
}
function flash(btn, label) {
  btn.classList.add('ok'); btn.textContent='✓ Copiado';
  setTimeout(()=>{btn.classList.remove('ok');btn.innerHTML=label;},2000);
}

const dlElements={}, dlStartTimes={};

chrome.runtime.onMessage.addListener((msg)=>{
  if(msg.type==='DOWNLOAD_PROGRESS') updateProgress(msg);
});

function updateProgress(msg) {
  const el=dlElements[msg.dlId]; if(!el) return;
  const {loaded,total,done,error,cancelled,statusText}=msg;
  const wrap=el.querySelector('.progress-wrap');
  const fill=el.querySelector('.progress-bar-fill');
  const pLeft=el.querySelector('.progress-left');
  const pRight=el.querySelector('.progress-right');
  const status=el.querySelector('.progress-status');
  const btnDl=el.querySelector('.btn-dl');
  const btnCancel=el.querySelector('.btn-cancel');

  wrap.classList.add('active');

  if(error||cancelled){
    fill.style.width='100%'; fill.style.background='#742a2a';
    status.textContent=cancelled?'⛔ Cancelado':'❌ '+error;
    status.className='progress-status error';
    btnDl.disabled=false; btnDl.textContent='⬇ Reintentar';
    if(btnCancel) btnCancel.style.display='none';
    return;
  }
  if(done){
    fill.style.width='100%'; fill.style.background='linear-gradient(90deg,#38a169,#68d391)';
    pLeft.textContent=''; pRight.textContent='100%';
    btnDl.disabled=false; btnDl.textContent='⬇ Descargar de nuevo';
    if(btnCancel) btnCancel.style.display='none';
    status.className='progress-status done';
    if (msg.ffmpegCmd) {
      status.innerHTML='✅ Guardado como .zip — ';
      if (msg.extractHint) {
        const exBtn=document.createElement('button');
        const exLabel=`📋 Comando extraer (${msg.extractLabel||'PowerShell'})`;
        exBtn.textContent=exLabel;
        exBtn.style.cssText='margin-left:4px;font-size:11px;padding:2px 6px;cursor:pointer;background:#2d3748;color:#cbd5e0;border:1px solid #4a5568;border-radius:4px';
        exBtn.addEventListener('click',(ev)=>{
          ev.stopPropagation();
          navigator.clipboard.writeText(msg.extractHint).then(()=>{
            exBtn.textContent='✓ Copiado'; setTimeout(()=>{exBtn.textContent=exLabel;},1800);
          });
        });
        status.appendChild(exBtn);
      }
      const copyBtn=document.createElement('button');
      copyBtn.textContent='📋 Comando ffmpeg';
      copyBtn.style.cssText='margin-left:4px;font-size:11px;padding:2px 6px;cursor:pointer;background:#2d3748;color:#cbd5e0;border:1px solid #4a5568;border-radius:4px';
      copyBtn.addEventListener('click',(ev)=>{
        ev.stopPropagation();
        navigator.clipboard.writeText(msg.ffmpegCmd).then(()=>{
          copyBtn.textContent='✓ Copiado'; setTimeout(()=>{copyBtn.textContent='📋 Comando ffmpeg';},1800);
        });
      });
      status.appendChild(copyBtn);
    } else {
      status.textContent='✅ ¡Guardado en disco!'+(msg.localPath?` (${msg.localPath})`:'');
    }
    return;
  }

  const now=Date.now();
  if(!dlStartTimes[msg.dlId]) dlStartTimes[msg.dlId]=now;
  const elapsed=(now-dlStartTimes[msg.dlId])/1000;

  // HLS: total=nº segmentos (pequeño), Direct: total=bytes (grande)
  const isHLS=total>0&&total<100000;
  const pct=total>0?Math.min(99,Math.round((loaded/total)*100)):null;

  fill.style.width=(pct!=null?pct:20)+'%';
  fill.style.background='linear-gradient(90deg,#3182ce,#63b3ed)';

  if(isHLS){
    pLeft.textContent=`Seg ${loaded} / ${total}`;
    pRight.textContent=pct+'%';
    let eta='';
    if(elapsed>2&&loaded>0){
      const spd=loaded/elapsed;
      const rem=(total-loaded)/spd;
      eta=rem<60?` · ${Math.round(rem)}s`:` · ${Math.round(rem/60)}min`;
    }
    status.textContent=(statusText||'Descargando...')+eta;
  } else {
    const speed=elapsed>0&&loaded>0?loaded/elapsed:0;
    pLeft.textContent=total>0?`${formatBytes(loaded)} / ${formatBytes(total)}`:formatBytes(loaded);
    pRight.textContent=pct!=null?pct+'%':'…';
    let eta='';
    if(speed>0&&total>0){const rem=(total-loaded)/speed;eta=rem<60?` · ${Math.round(rem)}s`:` · ${Math.round(rem/60)}min`;}
    status.textContent=speed>0?`${formatBytes(speed)}/s${eta}`:(statusText||'Descargando...');
  }
  status.className='progress-status loading';
  if(btnCancel) btnCancel.style.display='';
}

let currentTabId=null;

function buildCard(entry){
  const type=getType(entry.url,entry.contentType);
  let name0='video';
  try{
    const parts=new URL(entry.url).pathname.split('/').filter(Boolean);
    const last=parts[parts.length-1];
    if(last&&last.length>3) name0=last.split('?')[0].split('.')[0].slice(0,50)||'video';
  } catch{}

  const card=document.createElement('div');
  card.className='card';
  card.innerHTML=`
    <div class="card-top">
      <span class="badge badge-${type}">${type.toUpperCase()}</span>
      <span class="card-ct">${entry.contentType}</span>
      <span class="card-time">${entry.time}</span>
    </div>
    <div class="url-pill" title="Clic para copiar URL">${entry.url}</div>
    <div class="name-row">
      <span class="name-label">Nombre:</span>
      <input class="name-input" type="text" value="${name0}" placeholder="nombre del archivo"/>
    </div>
    <div class="actions">
      <button class="btn-action btn-dl">⬇ Descargar</button>
      <button class="btn-action btn-cancel" style="display:none;background:#4a1515;color:#fc8181;border:1px solid #742a2a;flex:0 0 auto;padding:7px 10px">⛔</button>
      <button class="btn-action btn-url">📋 URL</button>
      <button class="btn-action btn-ffmpeg">⚡ ffmpeg</button>
    </div>
    <div class="progress-wrap">
      <div class="progress-bar-bg"><div class="progress-bar-fill" style="width:0%"></div></div>
      <div class="progress-text">
        <span class="progress-left"></span>
        <span class="progress-right">0%</span>
      </div>
      <span class="progress-status loading"></span>
    </div>
  `;

  const input=card.querySelector('.name-input');
  const urlPill=card.querySelector('.url-pill');
  const btnDl=card.querySelector('.btn-dl');
  const btnCancel=card.querySelector('.btn-cancel');
  const btnUrl=card.querySelector('.btn-url');
  const btnFfm=card.querySelector('.btn-ffmpeg');
  let activeDlId=null;

  function getFilename(){return (input.value.trim()||'video').replace(/\.(mp4|m3u8|ts)$/i,'')+'.mp4';}
  function getCmd(){
    const m=/\.m3u8/i.test(entry.url);
    if(m) {
      // POSIX shells need $'...' for the CRLF escapes; cmd/PowerShell keep the original form.
      const isWin=/win/i.test(navigator.platform||'');
      return isWin
        ? `ffmpeg -headers "Referer: https://krakenfiles.com/\r\n" -i "${entry.url}" -c copy "${getFilename()}"`
        : `ffmpeg -headers $'Referer: https://krakenfiles.com/\\r\\n' -i "${entry.url}" -c copy "${getFilename()}"`;
    }
    return `ffmpeg -i "${entry.url}" -c copy "${getFilename()}"`;
  }

  urlPill.addEventListener('click',()=>{
    navigator.clipboard.writeText(entry.url).then(()=>{
      urlPill.style.background='#0d2a1a'; urlPill.style.color='#9ae6b4';
      setTimeout(()=>{urlPill.style.background='';urlPill.style.color='';},1500);
    });
  });
  btnUrl.addEventListener('click',()=>navigator.clipboard.writeText(entry.url).then(()=>flash(btnUrl,'📋 URL')));
  btnFfm.addEventListener('click',()=>navigator.clipboard.writeText(getCmd()).then(()=>flash(btnFfm,'⚡ ffmpeg')));

  btnDl.addEventListener('click',()=>{
    activeDlId=`dl_${Date.now()}`;
    dlElements[activeDlId]=card;
    btnDl.disabled=true; btnDl.textContent='⏳ Descargando...';
    btnCancel.style.display='';
    chrome.runtime.sendMessage({
      type:'START_DOWNLOAD', tabId:currentTabId,
      url:entry.url, filename:getFilename(), dlId:activeDlId,
    });
  });

  btnCancel.addEventListener('click',()=>{
    if(activeDlId) chrome.runtime.sendMessage({type:'CANCEL_DOWNLOAD',dlId:activeDlId});
    btnCancel.style.display='none';
  });

  return card;
}

function render(captures){
  const list=document.getElementById('list');
  const bar=document.getElementById('statusbar');
  if(!captures||captures.length===0){
    bar.innerHTML='Sin vídeos detectados — dale play al vídeo';
    list.innerHTML=`<div class="empty"><div class="empty-icon">🎬</div>
      <div class="empty-title">Ningún stream detectado aún</div>
      <div class="empty-sub">Dale play al vídeo y aparecerá aquí</div></div>`;
    return;
  }
  bar.innerHTML=`<b>${captures.length}</b> stream${captures.length>1?'s':''} capturado${captures.length>1?'s':''}`;
  list.innerHTML='';
  captures.forEach(e=>list.appendChild(buildCard(e)));
}

chrome.tabs.query({active:true,currentWindow:true},([tab])=>{
  if(!tab) return;
  currentTabId=tab.id;
  chrome.runtime.sendMessage({type:'GET_CAPTURES',tabId:tab.id},(resp)=>render(resp?.captures||[]));
  document.getElementById('btn-clear').addEventListener('click',()=>{
    chrome.runtime.sendMessage({type:'CLEAR_TAB',tabId:tab.id},()=>render([]));
  });
});
