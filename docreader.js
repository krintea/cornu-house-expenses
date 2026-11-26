"use strict";
/*
 * Citire automată a datelor de plată din documente (factură, bon, chitanță).
 * - PDF: text din document (pdf.js); dacă e scanat, OCR pe primele pagini.
 * - DOCX: text cu mammoth.
 * - Imagine: OCR cu tesseract.js (limba română), totul local în browser.
 * - Opțional: Claude AI (cheie API proprie) pentru o citire mai precisă.
 * Expune window.DocReader.readDocument(file, options).
 */
(() => {
  const VENDOR = "vendor/";
  const OCR_MAX_SIDE = 2400, OCR_PDF_PAGES = 2, CLAUDE_IMAGE_MAX_SIDE = 2000;

  // ---------- library loading (lazy, only when a document is uploaded) ----------
  const loaded = {};
  function loadScript(src) {
    return loaded[src] ||= new Promise((res, rej) => { const s = document.createElement("script"); s.src = src; s.onload = res; s.onerror = () => { delete loaded[src]; rej(new Error(`Nu s-a putut încărca ${src}`)); }; document.head.appendChild(s); });
  }
  let pdfjsPromise = null;
  async function getPdfjs() {
    pdfjsPromise ||= import(`./${VENDOR}pdfjs/pdf.min.js`).then(m => { m.GlobalWorkerOptions.workerSrc = `${VENDOR}pdfjs/pdf.worker.min.js`; return m; }).catch(e => { pdfjsPromise = null; throw e; });
    return pdfjsPromise;
  }
  let ocrWorkerPromise = null, ocrProgress = null;
  async function getOcrWorker() {
    await loadScript(`${VENDOR}tesseract/tesseract.min.js`);
    ocrWorkerPromise ||= window.Tesseract.createWorker("ron", 1 /* LSTM only */, {
      workerPath: new URL(`${VENDOR}tesseract/worker.min.js`, location.href).href,
      corePath: new URL(`${VENDOR}tesseract/core/`, location.href).href,
      langPath: new URL(`${VENDOR}tesseract/lang/`, location.href).href,
      logger: m => { if (ocrProgress && m.status === "recognizing text") ocrProgress(m.progress); }
    }).catch(e => { ocrWorkerPromise = null; throw e; });
    return ocrWorkerPromise;
  }

  // ---------- helpers ----------
  const kindOf = f => {
    const n = (f.name || "").toLowerCase(), t = f.type || "";
    if (t === "application/pdf" || n.endsWith(".pdf")) return "pdf";
    if (n.endsWith(".docx") || t === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") return "docx";
    if (t.startsWith("image/") || /\.(jpe?g|png|webp|gif|bmp|heic|heif)$/.test(n)) return "image";
    if (n.endsWith(".doc")) return "doc";
    return "unknown";
  };
  const fold = s => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[șş]/g, "s").replace(/[țţ]/g, "t").replace(/[ȘŞ]/g, "S").replace(/[ȚŢ]/g, "T").toLowerCase();
  function toBase64(buf) { const u = new Uint8Array(buf); let s = ""; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(s); }

  async function loadImage(file) {
    if (window.createImageBitmap) { try { return await createImageBitmap(file, { imageOrientation: "from-image" }); } catch {} }
    const url = URL.createObjectURL(file);
    try { const img = new Image(); img.src = url; await img.decode(); return img; } finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
  }
  async function imageToCanvas(file, maxSide) {
    let img;
    try { img = await loadImage(file); } catch { throw new Error("Imaginea nu poate fi deschisă în acest browser (pentru HEIC, trimite-o ca JPG)."); }
    const w = img.width, h = img.height, k = Math.min(1, maxSide / Math.max(w, h));
    const c = document.createElement("canvas"); c.width = Math.round(w * k); c.height = Math.round(h * k);
    const ctx = c.getContext("2d"); ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height); ctx.drawImage(img, 0, 0, c.width, c.height);
    return c;
  }
  const canvasToBlob = (c, type = "image/png", q) => new Promise(r => c.toBlob(r, type, q));

  async function ocrCanvas(canvas, onProgress, label) {
    const worker = await getOcrWorker();
    ocrProgress = p => onProgress?.(`${label} ${Math.round(p * 100)}%`);
    try { const { data } = await worker.recognize(await canvasToBlob(canvas)); return data.text || ""; }
    finally { ocrProgress = null; }
  }

  // ---------- text extraction ----------
  async function pdfText(buf, onProgress) {
    const pdfjs = await getPdfjs();
    const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), isEvalSupported: false }).promise;
    const pages = [];
    for (let i = 1; i <= Math.min(doc.numPages, 10); i++) {
      const page = await doc.getPage(i), tc = await page.getTextContent();
      // Rebuild lines from positioned text items.
      const items = tc.items.filter(it => it.str && it.str.trim()).map(it => ({ s: it.str, x: it.transform[4], y: it.transform[5], w: it.width, h: Math.abs(it.transform[3]) || 8 }));
      items.sort((a, b) => b.y - a.y || a.x - b.x);
      const lines = [];
      for (const it of items) {
        const line = lines.find(l => Math.abs(l.y - it.y) <= Math.max(2, it.h * 0.4));
        if (line) line.items.push(it); else lines.push({ y: it.y, items: [it] });
      }
      lines.sort((a, b) => b.y - a.y);
      pages.push(lines.map(l => {
        const its = l.items.sort((a, b) => a.x - b.x); let out = "", prevEnd = null;
        for (const it of its) { const gap = prevEnd == null ? 0 : it.x - prevEnd; out += (prevEnd == null ? "" : gap > it.h * 3 ? " | " : " ") + it.s; prevEnd = it.x + (it.w || it.s.length * it.h * 0.5); }
        return out.replace(/[ \t]+/g, " ").trim();
      }).join("\n"));
    }
    let text = pages.join("\n");
    let ocr = false;
    if (text.replace(/\s/g, "").length < 40) { // scanned PDF: no text layer
      ocr = true; text = "";
      for (let i = 1; i <= Math.min(doc.numPages, OCR_PDF_PAGES); i++) {
        const page = await doc.getPage(i), vp0 = page.getViewport({ scale: 1 });
        const scale = Math.min(3, OCR_MAX_SIDE / Math.max(vp0.width, vp0.height)), vp = page.getViewport({ scale });
        const c = document.createElement("canvas"); c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
        const ctx = c.getContext("2d"); ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height);
        await page.render({ canvas: c, canvasContext: ctx, viewport: vp }).promise;
        text += (await ocrCanvas(c, onProgress, `Recunoaștere text, pagina ${i}:`)) + "\n";
      }
    }
    return { text, ocr };
  }
  async function docxText(buf) {
    await loadScript(`${VENDOR}mammoth/mammoth.browser.min.js`);
    const { value } = await window.mammoth.extractRawText({ arrayBuffer: buf });
    return { text: value.replace(/\n{3,}/g, "\n\n"), ocr: false };
  }
  async function imageText(file, onProgress) {
    const c = await imageToCanvas(file, OCR_MAX_SIDE);
    return { text: await ocrCanvas(c, onProgress, "Recunoaștere text:"), ocr: true };
  }

  // ---------- local field extraction (Romanian invoices / receipts) ----------
  const AMOUNT_RE = /(?<![\d.,])(\d{1,3}(?:[ . ]\d{3})+(?:[.,]\d{1,2})?|\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+[.,]\d{1,2})(?![\d])|(?<![\d.,])(\d+)(?=\s*(?:lei|ron|eur|€)\b)/gi;
  function parseAmount(raw) {
    let s = String(raw).replace(/[\s ]/g, "");
    const lastDot = s.lastIndexOf("."), lastComma = s.lastIndexOf(",");
    if (lastDot >= 0 && lastComma >= 0) { const dec = lastDot > lastComma ? "." : ","; s = s.replace(dec === "." ? /,/g : /\./g, "").replace(dec, "."); }
    else if (lastComma >= 0) { s = /,\d{1,2}$/.test(s) ? s.replace(/,(?=\d{1,2}$)/, ".").replace(/,/g, "") : s.replace(/,/g, ""); }
    else if (lastDot >= 0) { if (!/\.\d{1,2}$/.test(s)) s = s.replace(/\./g, ""); else if ((s.match(/\./g) || []).length > 1) s = s.replace(/\.(?=.*\.)/g, ""); }
    const n = Number(s);
    return Number.isFinite(n) ? n : NaN;
  }
  function amountsIn(line) {
    const out = []; let m; AMOUNT_RE.lastIndex = 0;
    while ((m = AMOUNT_RE.exec(line))) { const v = parseAmount(m[1] || m[2]); if (v > 0 && v < 1e9) out.push({ v, idx: m.index }); }
    return out;
  }
  const TOTAL_KEYS = [
    /total\s*(general\s*)?de\s*plat/, /rest\s*de\s*plat/, /suma\s*de\s*plat/, /\bde\s*plat[ai]\b/, /amount\s*due|balance\s*due|grand\s*total/,
    /total\s*factur/, /total\s*general/, /total\s*(cu|incl\w*)\s*tva/, /total\s*(lei|ron|eur)\b/, /\btotal\b/
  ];
  const TOTAL_EXCLUDE = /(fara|f\.)\s*tva|baza|subtotal|net\b|total\s*tva|tva\s*total|cantitat|buc\b|discount|reducer|achitat|plati\s*anterioare|avans/;
  function findTotal(lines, folded) {
    const cands = [];
    folded.forEach((fl, i) => {
      const p = TOTAL_KEYS.findIndex(re => re.test(fl));
      if (p < 0) return;
      if (TOTAL_EXCLUDE.test(fl) && p > 4) return;
      const keyAt = fl.search(TOTAL_KEYS[p]);
      let am = amountsIn(lines[i]).filter(a => a.idx >= keyAt - 2);
      let lineIdx = i;
      for (let k = 1; !am.length && k <= 2 && i + k < lines.length; k++) { am = amountsIn(lines[i + k]); lineIdx = i + k; }
      if (am.length) cands.push({ v: am[am.length - 1].v, p, line: lineIdx });
    });
    if (cands.length) {
      const best = Math.min(...cands.map(c => c.p));
      const top = cands.filter(c => c.p === best).sort((a, b) => b.v - a.v)[0];
      return { amount: top.v, line: top.line, sure: true };
    }
    // Fallback: largest amount in the document.
    let max = null;
    lines.forEach((l, i) => amountsIn(l).forEach(a => { if (!max || a.v > max.amount) max = { amount: a.v, line: i, sure: false }; }));
    return max;
  }
  function findCurrency(lines, folded, totalLine) {
    const near = totalLine == null ? "" : folded.slice(Math.max(0, totalLine - 1), totalLine + 2).join(" ");
    const hasEur = s => /\beur\b|€|\beuro\b/.test(s), hasRon = s => /\blei\b|\bron\b/.test(s);
    if (hasEur(near) && !hasRon(near)) return "EUR";
    if (hasRon(near)) return "RON";
    const all = folded.join(" "), e = (all.match(/\beur\b|€|\beuro\b/g) || []).length, r = (all.match(/\blei\b|\bron\b/g) || []).length;
    return e > r ? "EUR" : "RON";
  }
  const MONTHS = { ian: 1, feb: 2, mar: 3, apr: 4, mai: 5, iun: 6, iul: 7, aug: 8, sep: 9, oct: 10, noi: 11, nov: 11, dec: 12, jan: 1, may: 5, jun: 6, jul: 7 };
  function datesIn(fl) {
    const out = [], push = (y, m, d, idx) => { y = Number(y); m = Number(m); d = Number(d); if (y < 100) y += 2000; if (y >= 2000 && y <= 2100 && m >= 1 && m <= 12 && d >= 1 && d <= 31) { out.push({ iso: `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`, idx }); return true; } return false; };
    // Overlapping scan: an invalid match (e.g. "77 / 05.09") must not hide the real date right after it.
    const scan = (re, f) => { let m; re.lastIndex = 0; while ((m = re.exec(fl))) { if (!f(m)) re.lastIndex = m.index + 1; } };
    scan(/(?<!\d)(\d{1,2})\s*[./-]\s*(\d{1,2})\s*[./-]\s*(\d{4}|\d{2})(?!\d)/g, m => push(m[3], m[2], m[1], m.index));
    scan(/(?<!\d)(\d{4})-(\d{2})-(\d{2})(?!\d)/g, m => push(m[1], m[2], m[3], m.index));
    scan(/(?<!\d)(\d{1,2})\s+([a-z]{3})[a-z]*\.?\s+(\d{4})/g, m => MONTHS[m[2]] ? push(m[3], MONTHS[m[2]], m[1], m.index) : false);
    return out.sort((a, b) => a.idx - b.idx);
  }
  const DATE_KEYS = /data\s*(facturii|emiterii|emitere|documentului|factur|bonului)|din\s*data|invoice\s*date|issue\s*date|date\s*of\s*issue|\bdata\b|\bdin\b|\bdate\b/;
  const DATE_EXCLUDE = /scaden|termen|due|livrar|expir|valabil|perioad|pana\s*la|nastere/;
  function findDate(folded) {
    for (const strict of [true, false]) {
      for (let i = 0; i < folded.length; i++) {
        const fl = folded[i];
        if (DATE_EXCLUDE.test(fl)) continue;
        if (strict && !DATE_KEYS.test(fl)) continue;
        const d = datesIn(fl); if (d.length) return d[0].iso;
        if (strict && i + 1 < folded.length && !DATE_EXCLUDE.test(folded[i + 1])) { const n = datesIn(folded[i + 1]); if (n.length && /data|date/.test(fl)) return n[0].iso; }
      }
    }
    return null;
  }
  function findInvoiceNumber(lines, folded) {
    const bad = /reg\.?\s*com|registrul|\bcod\b|cont\b|iban|cif|cui|c\.u\.i|tel|fax|ord\.?\s*|aviz|comanda|contract|nr\.\s*crt|j\d{2}\//;
    for (const pri of [/factur|invoice|seria|serie/, /\bnr\b|numar|\bno\b/]) {
      for (let i = 0; i < folded.length; i++) {
        const fl = folded[i]; if (!pri.test(fl) || bad.test(fl)) continue;
        const raw = lines[i];
        let m = raw.match(/seri[ae]\s*[:.]?\s*([A-Z]{1,6}[A-Z0-9-]{0,6})\s*(?:nr\.?|num[aă]r(?:ul)?|no\.?)?\s*[:.]?\s*([0-9][0-9/-]*)/i);
        if (m) return `${m[1].toUpperCase()} ${m[2]}`;
        m = raw.match(/(?:nr\.?|num[aă]r(?:ul)?|no\.?|#)\s*(?:factur[aăi]+\s*)?[:.]?\s*([A-Z]{0,6}[\s-]?[0-9][0-9A-Z/-]{0,15})/i);
        if (m) return m[1].trim();
        m = raw.match(/factur[aăi]\s*(?:fiscal[aă])?\s*[:.]?\s*([A-Z]{1,6}[\s-]?[0-9][0-9/-]{1,15})/i);
        if (m) return m[1].trim();
      }
    }
    return null;
  }
  const COMPANY_RE = /(?<![\p{L}\d])(s\.?\s?r\.?\s?l\.?|s\.?\s?a\.?|p\.?f\.?a\.?|i\.\s?i\.?|II|I\.F\.|s\.?n\.?c\.?|gmbh|ltd|llc)(?![\p{L}\d])/iu;
  const SELLER_KEYS = /furnizor|vanzator|prestator|emitent|supplier|seller|vendor/;
  const BUYER_KEYS = /cumparator|client|beneficiar|cumparatorul|buyer|bill\s*to/;
  function cleanName(s) {
    s = s.split(" | ")[0];
    const cut = s.replace(/\s+\S*:\s.*$/, ""); if (cut.trim().length >= 3) s = cut;
    s = s.replace(/\s+(cump[aă]r[aă]tor(ul)?|client|beneficiar|buyer)\b.*$/i, "");
    return s.replace(/^\s*(furnizor(ul)?|v[aâ]nz[aă]tor(ul)?|prestator(ul)?|emitent|supplier|seller|vendor|denumire|nume)\s*[:.-]?\s*/i, "")
      .replace(/\s*(cif|cui|c\.u\.i|cod fiscal|reg\.?\s*com|nr\.?\s*ord|j\d{2}\/).*$/i, "")
      .replace(/[|;:,\-\s]+$/, "").replace(/(?<![A-Z])\.$/, "").replace(/\s+/g, " ").trim().slice(0, 80);
  }
  function findSupplier(lines, folded, known) {
    // 1) A supplier already used in the app, if its name appears in the document.
    const text = " " + folded.join(" ").replace(/[^a-z0-9]+/g, " ") + " ";
    const hit = known.map(n => ({ n, k: fold(n).replace(/[^a-z0-9]+/g, " ").trim() })).filter(x => x.k.length >= 4 && text.includes(` ${x.k} `)).sort((a, b) => b.k.length - a.k.length)[0];
    if (hit) return { name: hit.n, known: true };
    // 2) The line after a "Furnizor / Vânzător" label.
    for (let i = 0; i < folded.length; i++) {
      if (!SELLER_KEYS.test(folded[i])) continue;
      const after = cleanName(lines[i].replace(/^.*?(furnizor(ul)?|v[aâ]nz[aă]tor(ul)?|prestator(ul)?|emitent|supplier|seller|vendor)\s*[:.-]?/i, ""));
      if (after.length >= 3 && /[a-z]/i.test(after) && !BUYER_KEYS.test(fold(after))) return { name: after.split(/\s{2,}| cumparator| client/i)[0] };
      for (let k = 1; k <= 2 && i + k < lines.length; k++) { const n = cleanName(lines[i + k]); if (n.length >= 3 && /[a-z]/i.test(n) && !/^(cif|cui|reg|adresa|sediu)/i.test(n)) return { name: n }; }
    }
    // 3) First company-looking line before the buyer section.
    const buyerAt = folded.findIndex(fl => BUYER_KEYS.test(fl));
    const companies = lines.map((l, i) => ({ l, i })).filter(x => COMPANY_RE.test(x.l) && !BUYER_KEYS.test(folded[x.i]));
    const pick = companies.find(x => buyerAt < 0 || x.i < buyerAt) || companies[0];
    if (pick) { const m = pick.l.match(new RegExp(`^(.*?${COMPANY_RE.source})`, "iu")); return { name: cleanName(m ? m[1] : pick.l) }; }
    // 4) Receipts: the merchant is usually on the first text line.
    const first = lines.find(l => /[a-z]{3}/i.test(l) && !/bon|fiscal|chitant|factur/i.test(l));
    return first ? { name: cleanName(first), weak: true } : null;
  }

  function extractLocal(text, ctx) {
    const lines = String(text).split(/\r?\n/).map(l => l.replace(/\s+/g, " ").trim()).filter(Boolean);
    const folded = lines.map(fold);
    const total = findTotal(lines, folded);
    const sup = findSupplier(lines, folded, ctx.beneficiaries || []);
    return {
      amount: total ? Math.round(total.amount * 100) / 100 : null,
      currency: total ? findCurrency(lines, folded, total.line) : null,
      date: findDate(folded),
      beneficiary: sup?.name || null,
      invoiceNumber: findInvoiceNumber(lines, folded),
      description: null, category: null,
      uncertain: [...(total && !total.sure ? ["amount"] : []), ...(sup?.weak ? ["beneficiary"] : [])]
    };
  }

  // ---------- Claude AI extraction (optional) ----------
  async function extractWithClaude(file, kind, localText, ctx) {
    let block;
    if (kind === "pdf") block = { type: "document", source: { type: "base64", media_type: "application/pdf", data: toBase64(await file.arrayBuffer()) } };
    else if (kind === "image") { const c = await imageToCanvas(file, CLAUDE_IMAGE_MAX_SIDE); block = { type: "image", source: { type: "base64", media_type: "image/jpeg", data: toBase64(await (await canvasToBlob(c, "image/jpeg", 0.88)).arrayBuffer()) } }; }
    else block = { type: "text", text: `Conținutul documentului „${file.name}”:\n\n${String(localText).slice(0, 60000)}` };
    const prompt = [
      "Extrage datele plății din acest document (factură, bon fiscal, chitanță, proformă sau ordin de plată), pentru evidența cheltuielilor de construcție a unei case în România.",
      "Reguli: beneficiarul plății este furnizorul care a emis documentul, NU cumpărătorul. Suma este totalul de plată, inclusiv TVA. Data este data emiterii, nu scadența. Scrie descrierea în română, scurt (max. 80 de caractere), ce s-a cumpărat sau ce lucrare s-a făcut.",
      "Dacă furnizorul corespunde unuia din beneficiarii existenți, folosește exact numele din listă. Alege categoria doar dintre categoriile existente; dacă niciuna nu se potrivește, lasă null. Pentru orice câmp care nu apare în document, folosește null.",
      `Categorii existente: ${JSON.stringify(ctx.categories || [])}`,
      `Beneficiari existenți: ${JSON.stringify((ctx.beneficiaries || []).slice(0, 200))}`
    ].join("\n");
    const nullable = t => ({ type: [t, "null"] });
    const body = {
      model: ctx.model || "claude-haiku-5-5", max_tokens: 1024,
      tools: [{ name: "record_payment", description: "Înregistrează datele plății extrase din document.", input_schema: { type: "object", properties: {
        amount: { ...nullable("number"), description: "Totalul de plată, inclusiv TVA" },
        currency: { type: ["string", "null"], enum: ["RON", "EUR", null] },
        date: { ...nullable("string"), description: "Data emiterii, format YYYY-MM-DD" },
        beneficiary: { ...nullable("string"), description: "Furnizorul / emitentul documentului" },
        invoice_number: { ...nullable("string"), description: "Seria și numărul documentului" },
        description: nullable("string"),
        category: { ...nullable("string"), description: "Una dintre categoriile existente sau null" }
      }, required: ["amount", "currency", "date", "beneficiary", "invoice_number", "description", "category"] } }],
      tool_choice: { type: "tool", name: "record_payment" },
      messages: [{ role: "user", content: [block, { type: "text", text: prompt }] }]
    };
    let r;
    try {
      r = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers: { "content-type": "application/json", "x-api-key": ctx.apiKey, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" }, body: JSON.stringify(body) });
    } catch { throw new Error("Claude nu a putut fi contactat (verifică conexiunea)."); }
    if (!r.ok) {
      let msg = ""; try { msg = (await r.json())?.error?.message || ""; } catch {}
      if (r.status === 401) throw new Error("Cheia API Anthropic nu este validă.");
      if (r.status === 429 || r.status === 529) throw new Error("Claude este ocupat momentan.");
      throw new Error(`Claude a răspuns cu eroare ${r.status}${msg ? `: ${msg}` : ""}.`);
    }
    const data = await r.json(), out = data.content?.find(b => b.type === "tool_use")?.input;
    if (!out) throw new Error("Claude nu a returnat date.");
    const iso = /^\d{4}-\d{2}-\d{2}$/.test(out.date || "") ? out.date : null;
    const amount = Number(out.amount);
    return {
      amount: amount > 0 ? Math.round(amount * 100) / 100 : null,
      currency: out.currency === "EUR" || out.currency === "RON" ? out.currency : null,
      date: iso, beneficiary: out.beneficiary || null, invoiceNumber: out.invoice_number || null,
      description: out.description || null, category: out.category || null, uncertain: []
    };
  }

  async function testClaudeKey(apiKey, model) {
    const r = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" }, body: JSON.stringify({ model, max_tokens: 5, messages: [{ role: "user", content: "Răspunde cu OK." }] }) }).catch(() => null);
    if (!r) throw new Error("Claude nu a putut fi contactat.");
    if (r.status === 401) throw new Error("Cheia API nu este validă.");
    if (!r.ok) { let m = ""; try { m = (await r.json())?.error?.message || ""; } catch {} throw new Error(`Eroare ${r.status}${m ? `: ${m}` : ""}`); }
    return true;
  }

  // ---------- main entry ----------
  async function readDocument(file, opts = {}) {
    const onProgress = opts.onProgress || (() => {});
    const kind = kindOf(file);
    if (kind === "doc") throw new Error("Fișierele .doc (Word vechi) nu sunt suportate. Salvează documentul ca .docx sau PDF.");
    if (kind === "unknown") throw new Error("Tip de fișier nesuportat. Folosește PDF, Word (.docx) sau o imagine.");
    if (file.size > 30 * 1024 * 1024) throw new Error("Fișierul este prea mare (maxim 30 MB).");
    const useClaude = opts.method === "claude" && opts.apiKey;
    let text = "", ocr = false, warning = "";
    // Word text is needed for Claude too; PDFs and images go to Claude directly.
    if (!useClaude || kind === "docx") {
      onProgress(kind === "image" ? "Se pregătește recunoașterea textului…" : "Se citește documentul…");
      const buf = kind === "image" ? null : await file.arrayBuffer();
      ({ text, ocr } = kind === "pdf" ? await pdfText(buf, onProgress) : kind === "docx" ? await docxText(buf) : await imageText(file, onProgress));
    }
    if (useClaude) {
      onProgress("Claude citește documentul…");
      try { return { fields: await extractWithClaude(file, kind, text, opts), text, method: "claude", ocr }; }
      catch (e) {
        warning = `${e.message} Am folosit citirea locală.`;
        if (!text) { onProgress("Se citește documentul local…"); ({ text, ocr } = kind === "pdf" ? await pdfText(await file.arrayBuffer(), onProgress) : await imageText(file, onProgress)); }
      }
    }
    return { fields: extractLocal(text, opts), text, method: "local", ocr, warning };
  }

  window.DocReader = { readDocument, testClaudeKey, extractLocal, parseAmount };
})();
