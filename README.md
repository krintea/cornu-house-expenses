# Cheltuieli construcție casă

Aplicație web statică (GitHub Pages) pentru evidența plăților la construcția casei: categorii și subcategorii, bugete pe categorie, conversie RON/EUR, raport PDF și backup.

## Cum funcționează
- **Datele stau în browser** (`localStorage`). Nu există server. Fă backup regulat: aplicația afișează un avertisment când ultimul backup e vechi sau au fost multe modificări de atunci.
- **Backup:** Google Drive (o singură copie în spațiul privat al aplicației, scope `drive.appdata`), fișier JSON sau CSV.
- **Curs EUR → RON:** la plăți noi se încearcă cursul BNR; dacă browserul nu îl poate accesa (BNR nu permite de obicei cereri din alte site-uri), se folosește cursul BCE prin [Frankfurter](https://frankfurter.dev). Cursul poate fi introdus manual. La editarea unei plăți cursul salvat nu se schimbă automat.
- **Moduri de calcul:** curs de referință unic (setat în Setări) sau cursul salvat pe fiecare plată.
- **Bugete:** în RON, setate pe fiecare categorie (Categorii → Buget).

## Structură
| Fișier | Rol |
|---|---|
| `index.html` | Structura paginii și stilurile |
| `app.js` | Logica aplicației (schema de date v2, cu migrare automată din v1) |
| `vendor/` | jsPDF 2.5.2 și jsPDF-AutoTable 3.8.4 (MIT), găzduite local |
| `fonts/` | Roboto Regular/Bold, subset latin + diacritice românești (SIL OFL), pentru PDF |

## Dezvoltare locală
```
python3 -m http.server 8000
```
apoi deschide http://localhost:8000. (Fonturile PDF nu se încarcă din `file://`; în acel caz PDF-ul folosește un font fără diacritice.)

## Format date (v2)
`{ version, categories: [{ id, name, sortOrder, budget, subcategories: [{ id, name }] }], payments: [{ id, date, beneficiary, description, categoryId, subcategoryId, originalAmount, originalCurrency, exchangeRate, amountRON, amountEUR, invoiceNumber, notes, rateSource, rateDate, createdAt, updatedAt }], settings: { referenceRate, reportTitle, reportSubtitle, rateMode } }`

Importurile (JSON sau Drive) sunt validate complet înainte de a înlocui datele, iar orice înlocuire poate fi anulată imediat.
