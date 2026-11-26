/* AI extraction is optional; all existing manual payment and Drive flows stay available. */
(() => {
  'use strict';
  const config = window.CORNU_AI_CONFIG || {};
  const el = id => document.getElementById(id);
  const panel = el('aiUploadPanel'), status = el('aiStatus');
  const fields = ['paymentDate', 'paymentBeneficiary', 'paymentDescription', 'paymentCategory',
    'paymentSubcategory', 'paymentAmount', 'paymentCurrency', 'paymentInvoiceNumber', 'paymentNotes', 'paymentRate'];
  let credential = null, controller = null, generation = 0, before = null, initialized = false;
  const say = text => { status.textContent = text; };
  const snapshot = () => Object.fromEntries(fields.map(id => [id, el(id).value]));
  function cancel() {
    generation++;
    controller?.abort();
    controller = null;
    el('aiAnalyze').disabled = false;
    el('aiFile').disabled = false;
  }
  function reset() {
    cancel(); before = null;
    el('aiFile').value = '';
    el('aiUndo').hidden = true;
    el('aiWarnings').replaceChildren();
    panel.hidden = !!el('paymentId').value;
    say(config.enabled ? 'Selectează un document, apoi apasă Analizează.' : 'Analiza AI nu este încă activată. Poți completa plata manual.');
    el('aiActions').hidden = !config.enabled;
  }
  window.CornuAI = {reset};
  el('paymentDialog').addEventListener('close', reset);
  el('aiCancel').addEventListener('click', () => { cancel(); say('Analiză anulată. Formularul nu a fost modificat.'); });
  el('aiSignOut').addEventListener('click', () => {
    cancel(); credential = null;
    window.google?.accounts?.id?.disableAutoSelect();
    say('Deconectat de la analiza AI. Conectarea Google Drive este separată.');
  });
  el('aiConnect').addEventListener('click', () => {
    const googleId = window.google?.accounts?.id;
    if (!googleId) { say('Conectarea Google nu s-a încărcat. Verifică internetul și reîncearcă.'); return; }
    if (!initialized) {
      googleId.initialize({client_id: config.googleClientId, auto_select: false,
        callback: response => {
          credential = response.credential || null; // Memory only; never saved to backups/localStorage.
          say(credential ? 'Conectat. Poți analiza documentul selectat.' : 'Conectarea nu a reușit.');
        }});
      googleId.renderButton(el('aiGoogleButton'), {theme: 'outline', size: 'large', text: 'signin_with', width: 240});
      initialized = true;
    }
    say('Folosește butonul Google de mai jos pentru conectare.');
  });
  function restore(values) {
    for (const id of fields) {
      if (id === 'paymentSubcategory') renderPaymentSubcategoryOptions(el('paymentCategory').value);
      el(id).value = values[id];
    }
    updateConversionPreview(); checkDuplicate();
  }
  el('aiUndo').addEventListener('click', () => {
    if (!before) return;
    restore(before); before = null;
    el('aiUndo').hidden = true;
    say('Formularul de dinaintea analizei a fost restaurat.');
  });
  el('aiAnalyze').addEventListener('click', async () => {
    if (!config.enabled) return;
    let endpoint;
    try {
      endpoint = new URL(config.apiUrl);
      if (endpoint.protocol !== 'https:' || !endpoint.hostname.endsWith('.run.app') || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw Error();
    } catch { say('Serviciul de analiză nu este configurat corect.'); return; }
    if (!credential) { say('Conectează-te cu Google pentru a analiza documentul.'); return; }
    const file = el('aiFile').files[0];
    if (!file || !/\.(pdf|docx|jpe?g|png|webp)$/i.test(file.name)) {
      say('Selectează un fișier PDF, DOCX, JPG, PNG sau WEBP.'); return;
    }
    if (!file.size || file.size > 10 * 1024 * 1024) { say('Documentul trebuie să aibă cel mult 10 MB.'); return; }
    const original = snapshot(), revision = ++generation;
    controller = new AbortController();
    const activeController = controller;
    const timer = setTimeout(() => activeController.abort(), 95_000);
    el('aiAnalyze').disabled = true; el('aiFile').disabled = true;
    el('aiWarnings').replaceChildren();
    say('Se analizează documentul… Poți anula oricând.');
    try {
      const form = new FormData();
      form.append('document', file);
      form.append('categories', JSON.stringify(getSortedCategories().map(c => ({id: c.id, name: c.name,
        subcategories: (c.subcategories || []).map(s => ({id: s.id, name: s.name}))}))));
      const response = await fetch(new URL('/analyze', endpoint), {method: 'POST',
        headers: {Authorization: 'Bearer ' + credential}, body: form, signal: activeController.signal,
        credentials: 'omit', cache: 'no-store'});
      const body = await response.json();
      if (revision !== generation || !el('paymentDialog').open) return;
      if (response.status === 401) credential = null;
      if (!response.ok) throw new Error(body.error || 'Analiza nu a reușit. Reîncearcă.');
      const p = body.payment;
      if (!p || typeof p !== 'object') throw new Error('Răspuns AI invalid.');
      if (JSON.stringify(original) !== JSON.stringify(snapshot())) {
        say('Ai modificat formularul în timpul analizei. Am păstrat modificările tale; reia analiza dacă este necesar.'); return;
      }
      before = original;
      const mapping = {paymentDate: 'paymentDate', paymentBeneficiary: 'beneficiary', paymentDescription: 'description',
        paymentInvoiceNumber: 'invoiceNumber'};
      for (const [id, key] of Object.entries(mapping)) el(id).value = typeof p[key] === 'string' ? p[key] : '';
      el('paymentAmount').value = typeof p.amount === 'number' && p.amount > 0 ? p.amount.toFixed(2) : '';
      el('paymentCurrency').value = ['RON', 'EUR'].includes(p.currency) ? p.currency : '';
      const category = getCategory(p.categoryId);
      el('paymentCategory').value = category?.id || '';
      renderPaymentSubcategoryOptions(category?.id, p.subcategoryId);
      // Preserve existing notes and exchange rate. Invoice date is never silently used as payment date.
      el('rateStatus').textContent = 'Verifică data plății și cursul EUR → RON; cursul nu a fost extras din document.';
      const notes = Array.isArray(p.warnings) ? p.warnings.filter(x => typeof x === 'string') : [];
      if (p.invoiceDate) notes.push('Data facturii: ' + p.invoiceDate + '.');
      notes.push('Verifică toate câmpurile înainte de salvare. Analiza AI poate greși.');
      for (const note of notes) { const item = document.createElement('li'); item.textContent = note; el('aiWarnings').appendChild(item); }
      el('aiUndo').hidden = false;
      updateConversionPreview(); checkDuplicate();
      say('Formular completat cu sugestii. Câmpurile neclare au rămas goale. Plata nu a fost salvată.');
    } catch (error) {
      if (revision === generation) say(error.name === 'AbortError' ? 'Analiza a expirat sau a fost anulată. Poți reîncerca.' : error.message);
    } finally {
      clearTimeout(timer);
      if (revision === generation) { controller = null; el('aiAnalyze').disabled = false; el('aiFile').disabled = false; }
    }
  });
  reset();
})();
