(() => {
  const escape = text => String(text).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  window.InspectionMotion = {
    skeleton(label = 'Memuat data…') {
      return `<div class="motion-skeleton" role="status"><span class="motion-sr">${escape(label)}</span><div aria-hidden="true"><span class="motion-bar motion-title"></span><span class="motion-bar"></span><span class="motion-bar motion-short"></span></div></div>`;
    }
  };
})();
