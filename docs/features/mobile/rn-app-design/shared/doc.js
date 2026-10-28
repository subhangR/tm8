/* TM8 MOBILE design doc — document behaviour. No lane script runs; everything
   interactive is a data-attribute this file understands. */
(function () {
  'use strict';
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));

  // --- TOC ---------------------------------------------------------------
  const side = $('#toc');
  if (side) {
    const frag = document.createDocumentFragment();
    $$('section.doc-section').forEach((sec) => {
      const h2 = $('header h2', sec);
      if (!h2) return;
      const a = document.createElement('a');
      a.href = '#' + sec.id; a.className = 'l2';
      a.textContent = h2.textContent.trim();
      if (sec.dataset.lane) { const l = document.createElement('span'); l.className = 'lane'; l.textContent = sec.dataset.lane; a.appendChild(l); }
      frag.appendChild(a);
      $$(':scope > h3[id], :scope > div > h3[id]', sec).forEach((h3) => {
        const b = document.createElement('a'); b.href = '#' + h3.id; b.className = 'l3'; b.textContent = h3.textContent.trim(); frag.appendChild(b);
      });
    });
    side.appendChild(frag);
    // give h3s ids when missing (so lanes don't have to)
    $$('section.doc-section h3').forEach((h3, i) => { if (!h3.id) h3.id = (h3.closest('section').id || 's') + '-h3-' + i; });
    // scroll spy
    const links = $$('a', side);
    const byId = new Map(links.map((a) => [a.getAttribute('href').slice(1), a]));
    const targets = $$('section.doc-section');
    const io = new IntersectionObserver((entries) => {
      entries.forEach((e) => { if (e.isIntersecting) { links.forEach((a) => a.classList.remove('on')); const a = byId.get(e.target.id); if (a) a.classList.add('on'); } });
    }, { rootMargin: '-10% 0px -80% 0px' });
    targets.forEach((t) => io.observe(t));
  }

  // --- theme / os switches (document-wide, phones without data-lock) ------
  function setAll(attr, value) {
    $$('.phone').forEach((p) => { if (p.hasAttribute('data-lock')) return; if (value === 'auto') { if (p.dataset['orig' + attr] !== undefined) p.setAttribute('data-' + attr, p.dataset['orig' + attr]); } else { if (p.dataset['orig' + attr] === undefined) p.dataset['orig' + attr] = p.getAttribute('data-' + attr) || (attr === 'theme' ? 'light' : 'ios'); p.setAttribute('data-' + attr, value); } });
  }
  $$('[data-set]').forEach((btn) => btn.addEventListener('click', () => {
    const [attr, value] = btn.dataset.set.split(':');
    setAll(attr, value);
    $$('[data-set^="' + attr + ':"]').forEach((b) => b.classList.toggle('on', b === btn));
  }));

  // --- tabs: <div class="tabs"><div class="tabbtns"><button data-tab=a class=on>…</button></div><div data-panel=a class=on>…</div></div>
  $$('.tabs').forEach((box) => {
    $$('[data-tab]', box).forEach((btn) => btn.addEventListener('click', () => {
      $$('[data-tab]', box).forEach((b) => b.classList.toggle('on', b === btn));
      $$('[data-panel]', box).forEach((p) => p.classList.toggle('on', p.dataset.panel === btn.dataset.tab));
    }));
  });

  // --- copy-link on headers --------------------------------------------
  $$('section.doc-section header h2').forEach((h2) => { h2.style.cursor = 'pointer'; h2.title = 'Copy link'; h2.addEventListener('click', () => { const id = h2.closest('section').id; history.replaceState(null, '', '#' + id); try { navigator.clipboard.writeText(location.href); } catch (e) {} }); });
})();
