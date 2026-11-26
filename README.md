# Cheltuieli construcție casă

Aplicație web statică (GitHub Pages) pentru evidența plăților la construcția casei: categorii și subcategorii, bugete pe categorie, conversie RON/EUR, raport PDF și backup.

## Cum funcționează
- **Datele stau în browser** (`localStorage`). Nu există server. Fă backup regulat: aplicația afișează un avertisment când ultimul backup e vechi sau au fost multe modificări de atunci.
- **Backup:** Google Drive (o singură copie în spațiul privat al aplicației, scope `drive.appdata`), fișier JSON sau CSV.
- **Salvare automată în Drive** (opțională, Setări): fiecare modificare se trimite în Drive după ~2 secunde. Google cere reconectarea o dată pe sesiune / oră (buton „Conectează Drive”). Dacă copia din Drive a fost schimbată de pe alt dispozitiv, aplicația nu o suprascrie și te întreabă ce păstrezi.
- **Curs EUR → RON:** la plăți noi se încearcă cursul BNR; dacă browserul nu îl poate accesa (BNR nu permite de obicei cereri din alte site-uri), se folosește cursul BCE prin [Frankfurter](https://frankfurter.dev). Cursul poate fi introdus manual. La editarea unei plăți cursul salvat nu se schimbă automat.
- **Citire din documente:** la „Adaugă plată” poți încărca factura/bonul (PDF, .docx, poză). Implicit, citirea se face local în browser (pdf.js, mammoth, OCR tesseract.js în română), fără ca documentul să plece de pe dispozitiv. Opțional (Setări), cu o cheie API Anthropic proprie, documentul e citit de Claude, mai precis și cu descriere și categorie sugerate. Cheia rămâne doar în browser.
- **Moduri de calcul:** curs de referință unic (setat în Setări) sau cursul salvat pe fiecare plată.
- **Bugete:** în RON, setate pe fiecare categorie (Categorii → Buget).

## Structură
| Fișier | Rol |
|---|---|
| `index.html` | Structura paginii și stilurile |
| `app.js` | Logica aplicației (schema de date v2, cu migrare automată din v1) |
| `docreader.js` | Citirea documentelor și extragerea datelor de plată |
| `vendor/` | jsPDF 2.5.2, jsPDF-AutoTable 3.8.4, pdf.js 6.5, mammoth 1.13, tesseract.js 7 + date OCR pentru română (licențe în fiecare folder), găzduite local și încărcate doar la nevoie |
| `fonts/` | Roboto Regular/Bold, subset latin + diacritice românești (SIL OFL), pentru PDF |

## Dezvoltare locală
```
python3 -m http.server 8000
```
apoi deschide http://localhost:8000. (Fonturile PDF nu se încarcă din `file://`; în acel caz PDF-ul folosește un font fără diacritice.)

## Format date (v2)
`{ version, categories: [{ id, name, sortOrder, budget, subcategories: [{ id, name }] }], payments: [{ id, date, beneficiary, description, categoryId, subcategoryId, originalAmount, originalCurrency, exchangeRate, amountRON, amountEUR, invoiceNumber, notes, rateSource, rateDate, createdAt, updatedAt }], settings: { referenceRate, reportTitle, reportSubtitle, rateMode } }`

Importurile (JSON sau Drive) sunt validate complet înainte de a înlocui datele, iar orice înlocuire poate fi anulată imediat.
