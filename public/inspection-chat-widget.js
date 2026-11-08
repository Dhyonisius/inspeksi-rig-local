(() => {
  const logo = '<svg viewBox="0 0 48 48" fill="none" aria-hidden="true"><rect x="6" y="10" width="36" height="27" rx="10" stroke="currentColor" stroke-width="3"/><path d="m13 37-3 7 12-7M24 4v6M2 21v8m44-8v8" stroke="currentColor" stroke-width="3" stroke-linecap="round"/><circle cx="17" cy="23" r="3" fill="currentColor"/><circle cx="31" cy="23" r="3" fill="currentColor"/><path d="M18 31h12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
  window.InspectionChatWidget = { mount({root, api, user, onModels}) {
    const host = document.createElement('div');
    host.className = 'inspection-chat-widget';
    host.innerHTML = `<button class="inspection-chat-launcher" type="button" aria-label="Buka chatbot" aria-expanded="false" aria-controls="inspection-chat-popup" title="AI Inspeksi · Klik untuk membuka, geser untuk memindahkan">${logo}<span>CHATBOT</span></button><section class="inspection-chat-popup" id="inspection-chat-popup" role="dialog" aria-modal="false" aria-labelledby="inspection-chat-title" hidden><header class="inspection-popup-header"><span class="inspection-popup-logo">${logo}</span><div><h2 id="inspection-chat-title">AI Inspeksi Visual</h2><p>Jamila · Asisten laporan rig</p></div><button type="button" data-view="pdf-library" aria-label="Pengaturan dataset chatbot" title="Pengaturan dataset PDF">⚙</button><button type="button" data-chat-minimize aria-label="Minimalkan chatbot" title="Minimalkan">−</button><button type="button" data-chat-close aria-label="Tutup chatbot" title="Tutup">×</button></header><div class="inspection-popup-content"></div></section>`;
    root.append(host);
    const launcher = host.querySelector('.inspection-chat-launcher');
    const panel = host.querySelector('.inspection-chat-popup');
    const content = host.querySelector('.inspection-popup-content');
    const events = new AbortController(), options = {signal: events.signal};
    let chat = null, opened = false, drag = null, suppressClick = false, position = {x:1,y:1};
    const storageKey = 'inspection-chat-position-v1';
    try { const saved=JSON.parse(localStorage.getItem(storageKey)); if(saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) position={x:Math.max(0,Math.min(1,saved.x)),y:Math.max(0,Math.min(1,saved.y))}; } catch {}
    const clamp=(n,min,max)=>Math.min(Math.max(min,max),Math.max(min,n));
    function bounds() {
      const v=window.visualViewport;
      return {left:v?.offsetLeft||0,top:v?.offsetTop||0,width:v?.width||innerWidth,height:v?.height||innerHeight};
    }
    function place() {
      const b=bounds(), margin=12, size=68;
      const x=b.left+margin+position.x*Math.max(0,b.width-size-margin*2);
      const y=b.top+margin+position.y*Math.max(0,b.height-size-margin*2);
      launcher.style.left=x+'px'; launcher.style.top=y+'px';
      if(opened) {
        const width=Math.min(430,b.width-margin*2), height=Math.min(640,b.height-size-margin*3);
        panel.style.width=width+'px'; panel.style.height=Math.max(180,height)+'px';
        panel.style.left=clamp(x+size-width,b.left+margin,b.left+b.width-width-margin)+'px';
        const preferred=y-height-12;
        panel.style.top=clamp(preferred>=b.top+margin?preferred:y+size+12,b.top+margin,b.top+b.height-height-margin)+'px';
      }
    }
    function save() { try {localStorage.setItem(storageKey,JSON.stringify(position));} catch {} }
    function open(value,focus=true) {
      opened=value;panel.hidden=!value;launcher.setAttribute('aria-expanded',String(value));
      launcher.setAttribute('aria-label',value?'Minimalkan chatbot':'Buka chatbot');
      if(value && !chat) chat=window.InspectionHub.mountChat({root:content,api,user,onModels,compact:true});
      place();
      if(focus) (value?content.querySelector('textarea'):launcher)?.focus({preventScroll:true});
    }
    launcher.addEventListener('click',()=>{if(suppressClick){suppressClick=false;return;}open(!opened);},options);
    launcher.addEventListener('pointerdown',e=>{
      if(e.button!==0 || !e.isPrimary)return;
      suppressClick=false;const r=launcher.getBoundingClientRect();
      drag={id:e.pointerId,startX:e.clientX,startY:e.clientY,x:r.left,y:r.top,moved:false};
      launcher.setPointerCapture(e.pointerId);
    },options);
    launcher.addEventListener('pointermove',e=>{
      if(!drag || drag.id!==e.pointerId)return;
      const dx=e.clientX-drag.startX,dy=e.clientY-drag.startY;
      if(!drag.moved && Math.hypot(dx,dy)<6)return;
      drag.moved=true;launcher.classList.add('is-dragging');
      const b=bounds();position={x:clamp((drag.x+dx-b.left-12)/Math.max(1,b.width-92),0,1),y:clamp((drag.y+dy-b.top-12)/Math.max(1,b.height-92),0,1)};place();
    },options);
    function endDrag(e) {
      if(!drag || e.pointerId!==drag.id)return;
      suppressClick=drag.moved;drag=null;launcher.classList.remove('is-dragging');
      if(launcher.hasPointerCapture(e.pointerId))launcher.releasePointerCapture(e.pointerId);save();
    }
    launcher.addEventListener('pointerup',endDrag,options);
    launcher.addEventListener('pointercancel',endDrag,options);
    launcher.addEventListener('lostpointercapture',endDrag,options);
    launcher.addEventListener('keydown',e=>{
      if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home'].includes(e.key))return;
      e.preventDefault();const b=bounds(),step=e.shiftKey?40:16;
      if(e.key==='Home')position={x:1,y:1};
      else {position.x=clamp(position.x+({'ArrowLeft':-step,'ArrowRight':step}[e.key]||0)/Math.max(1,b.width-92),0,1);position.y=clamp(position.y+({'ArrowUp':-step,'ArrowDown':step}[e.key]||0)/Math.max(1,b.height-92),0,1);}
      place();save();
    },options);
    host.addEventListener('click',e=>{if(e.target.closest('[data-chat-close],[data-chat-minimize]'))open(false);if(e.target.closest('[data-view]'))open(false,false);},options);
    host.addEventListener('keydown',e=>{if(e.key==='Escape' && opened && !content.querySelector('dialog[open]')){e.preventDefault();open(false);}},options);
    window.addEventListener('resize',place,options);
    window.visualViewport?.addEventListener('resize',place,options);
    window.visualViewport?.addEventListener('scroll',place,options);
    place();
    return {open:()=>open(true),destroy(){events.abort();chat?.destroy();host.remove();}};
  }};
})();
