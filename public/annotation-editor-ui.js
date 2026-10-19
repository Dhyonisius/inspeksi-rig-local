(() => {
  'use strict';
  const clamp=(value,min,max)=>Math.max(min,Math.min(max,value));
  function transform(box,dx,dy,resize=false) {
    return resize ? {...box,width:clamp(box.width+dx,.009,1-box.x),height:clamp(box.height+dy,.009,1-box.y)}
      : {...box,x:clamp(box.x+dx,0,1-box.width),y:clamp(box.y+dy,0,1-box.height)};
  }
  function attach({container,canvas,boxes,draw,isBusy,getHazards}) {
    const panel=document.createElement('section');panel.className='annotation-editor';
    panel.innerHTML='<div class="annotation-mode" role="group" aria-label="Cara mengoreksi kotak"><button type="button" class="btn btn-secondary" data-box-mode="draw">+ Gambar kotak</button><button type="button" class="btn btn-secondary" data-box-mode="edit">Geser / ubah ukuran</button></div><p class="dt-muted" data-box-help></p><div data-box-inspector><label>Kotak yang dikoreksi<select class="select-field" data-box-selection></select></label><label>Kategori kotak<select class="select-field" data-box-category></select></label><details><summary>Atur posisi dengan angka</summary><div class="annotation-coordinates">'+[['x','Dari kiri'],['y','Dari atas'],['width','Lebar'],['height','Tinggi']].map(([key,title])=>`<label>${title} (%)<input class="field" type="number" data-box-coordinate="${key}" min="0" max="100" step="0.1"></label>`).join('')+'</div></details><button type="button" class="quiet-link" data-box-delete>Hapus kotak terpilih</button></div><p data-box-message class="dt-error" role="alert"></p>';
    container.after(panel);
    let mode=boxes.length?'edit':'draw',selected=boxes.length?0:-1,drag=null;
    const selection=panel.querySelector('[data-box-selection]'),category=panel.querySelector('[data-box-category]');
    const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    function refresh() {
      if(selected>=boxes.length)selected=boxes.length-1;
      if(selected<0 && boxes.length)selected=boxes.length-1;
      const hazards=getHazards();
      selection.innerHTML=boxes.map((box,i)=>`<option value="${i}">${i+1}. ${esc(hazards.find(h=>Number(h.hazard_type_id)===box.hazard_type_id)?.name||'Periksa kategori')}</option>`).join('');
      selection.value=String(selected);
      category.innerHTML='<option value="">Pilih kategori…</option>'+hazards.map(h=>`<option value="${h.hazard_type_id}">${esc(h.name)}</option>`).join('');
      const box=boxes[selected];if(box)category.value=String(box.hazard_type_id);
      panel.querySelector('[data-box-inspector]').classList.toggle('is-hidden',!box);
      panel.querySelectorAll('[data-box-coordinate]').forEach(input=>{if(box)input.value=String(Math.round(box[input.dataset.boxCoordinate]*1000)/10);});
      panel.querySelectorAll('[data-box-mode]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.boxMode===mode)));
      panel.querySelector('[data-box-help]').textContent=mode==='draw'?'Pilih kategori bahaya di formulir, lalu tarik kotak pada foto.':'Pilih kotak pada foto lalu geser. Tarik sudut kanan bawah untuk mengubah ukurannya. Posisi juga dapat diatur dengan angka.';
      canvas.style.cursor=mode==='draw'?'crosshair':'move';draw();
    }
    function replace(box) {boxes[selected]=box;refresh();}
    panel.addEventListener('click',event=>{
      if(isBusy())return;
      const button=event.target.closest('[data-box-mode]');
      if(button){mode=button.dataset.boxMode;refresh();}
      if(event.target.closest('[data-box-delete]') && selected>=0){boxes.splice(selected,1);refresh();}
    });
    selection.addEventListener('change',()=>{if(!isBusy()){selected=Number(selection.value);refresh();}});
    category.addEventListener('change',()=>{if(!isBusy() && boxes[selected] && category.value)replace({...boxes[selected],hazard_type_id:Number(category.value)});});
    panel.addEventListener('change',event=>{
      const key=event.target.dataset.boxCoordinate;if(!key || isBusy() || !boxes[selected])return;
      const value=Number(event.target.value)/100,box={...boxes[selected],[key]:value};
      if(event.target.value==='' || !Number.isFinite(value) || box.x<0 || box.y<0 || box.width<.009 || box.height<.009 || box.x+box.width>1.000001 || box.y+box.height>1.000001) {
        panel.querySelector('[data-box-message]').textContent='Kotak harus tetap berada di dalam foto dan memiliki ukuran lebih dari 0,8%.';refresh();return;
      }
      panel.querySelector('[data-box-message]').textContent='';replace(box);
    });
    function point(event){const r=canvas.getBoundingClientRect();return{x:clamp((event.clientX-r.left)/r.width,0,1),y:clamp((event.clientY-r.top)/r.height,0,1)};}
    canvas.addEventListener('pointerdown',event=>{
      if(mode!=='edit')return;
      event.stopImmediatePropagation();if(isBusy())return;
      const p=point(event),r=canvas.getBoundingClientRect(),tx=12/r.width,ty=12/r.height;
      let index=boxes.findLastIndex(box=>Math.abs(p.x-box.x-box.width)<=tx && Math.abs(p.y-box.y-box.height)<=ty);
      const resize=index>=0;
      if(index<0)index=boxes.findLastIndex(box=>p.x>=box.x && p.y>=box.y && p.x<=box.x+box.width && p.y<=box.y+box.height);
      if(index<0)return;
      selected=index;drag={point:p,box:{...boxes[index]},resize};canvas.setPointerCapture(event.pointerId);refresh();
    },true);
    canvas.addEventListener('pointermove',event=>{
      if(mode!=='edit')return;
      event.stopImmediatePropagation();if(!drag || isBusy())return;
      const p=point(event);boxes[selected]=transform(drag.box,p.x-drag.point.x,p.y-drag.point.y,drag.resize);draw();
    },true);
    for(const name of ['pointerup','pointercancel'])canvas.addEventListener(name,event=>{
      if(mode!=='edit')return;event.stopImmediatePropagation();
      if(name==='pointercancel' && drag)boxes[selected]=drag.box;drag=null;refresh();
    },true);
    refresh();
    return {refresh,selectedIndex:()=>mode==='edit'?selected:-1};
  }
  window.AnnotationEditorUI=Object.freeze({attach,transform});
})();
