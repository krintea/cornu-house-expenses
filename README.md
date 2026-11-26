# Cornu House Expenses

Romanian house-payment tracker hosted on GitHub Pages. Manual entry, category totals, PDF/CSV exports and Google Drive app-data backup/restore.

Optional Gemini analysis in **Adaugă plată** accepts PDF, DOCX and JPG/PNG/WEBP documents and suggests payment fields and existing categories. Suggestions are editable and never auto-saved. Gemini is accessed through an allowlisted Google-authenticated Cloud Run backend, using a service identity with no API key in the browser.

Analysis is **disabled pending billing approval and verified deployment**. See [DEPLOYMENT.md](DEPLOYMENT.md) for the exact deployment plan, costs, auth model, tests and activation/rollback steps.
