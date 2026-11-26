# Gemini document analysis — deployment approval gate

Status: implementation prepared; cloud APIs, IAM, billing, model availability and live OAuth have not been verified in this session. No Cloud resources have been changed. Frontend and backend analysis default OFF. Do not enable billable APIs, deploy, or send a document to Gemini before the owner approves billing.

## Architecture and privacy

GitHub Pages hosts the existing application. Google Identity Services supplies a short-lived ID token for analysis, separately from the unchanged `drive.appdata` OAuth flow. The browser sends one document and category IDs/names to `/analyze`; no expense history or Drive token is sent. Backend validates Google's signature, issuer, expiration, client audience and an explicit subject allowlist before parsing a document or calling Gemini. CORS is restricted to `https://krintea.github.io` (origins cannot restrict URL paths).

Cloud Run's IAM invoker check is disabled to permit browser preflights and end-user tokens. **The HTTP service is reachable publicly; analysis is authenticated and authorized inside the application.** This is not an IAM-private endpoint. Unauthenticated requests receive 401; other Google accounts receive 403. The only unauthenticated application endpoint is a content-free health check. If organization policy requires IAM-private services, replace this deployment design with IAP/API Gateway before proceeding.

Runtime uses attached service-account Application Default Credentials for Gemini on Vertex AI; no Gemini API key, client secret, or downloaded service-account key. The existing OAuth client ID is public configuration, not a secret. Only runtime identity receives Vertex AI User; build identity receives Cloud Run Builder. No runtime Drive or storage grants.

Documents are processed in memory, are not saved by this application, and are not included in Drive backups. Image metadata is removed. Google Cloud processing and retention policies still apply; this is not a promise of zero provider retention. No document text, filenames, tokens, model response, or exception details are logged by application code. Google infrastructure can still log request metadata. Do not enable request/response payload logging or caching without a separate privacy review. Abort stops frontend processing; an already-running Gemini request can still finish and incur cost.

## Approval scope

Project `cornu-house-expenses`, region `europe-west1`, Gemini on Vertex AI, Cloud Run, Cloud Build and Artifact Registry. Costs include model input/output tokens, builds, image storage and Cloud Run requests/compute. IAM identities themselves do not require a downloadable secret. Start at zero minimum instances, one maximum instance, 1 CPU, 512 MiB, one active analysis per process, three attempts per minute and twenty per hour per allowed account, 10 MB uploads and 30 PDF pages.

Rate limits are in memory and reset on cold start/redeployment; Cloud Run maximum instances and these limits are **not hard spending caps**. Configure project budgets/alerts and appropriate Vertex quotas after approval. Actual cost depends on document size and use. Review current [Vertex AI pricing](https://cloud.google.com/vertex-ai/generative-ai/pricing), [Cloud Run pricing](https://cloud.google.com/run/pricing), [Cloud Build pricing](https://cloud.google.com/build/pricing) and [Artifact Registry pricing](https://cloud.google.com/artifact-registry/pricing) before approving spending. No dollar estimate or hard cap is claimed.

## After approval

1. Obtain access to the project in an authenticated Google Cloud shell. Confirm billing state, enabled services, existing IAM policies and organization restrictions. Link billing only with owner authorization. Confirm the existing OAuth client has `https://krintea.github.io` as an authorized JavaScript origin and approved users under the current consent configuration. Keep the existing Drive scope and client intact.
2. Obtain each permitted account's Google `sub` from a **server-verified** ID token for the existing client. Use `google.oauth2.id_token.verify_oauth2_token` and the configured audience; never trust a merely decoded JWT or add every signed-in Google user. Store the allowlist privately as Cloud Run configuration; do not commit user identifiers or tokens. Provide the verified numeric subjects as `ALLOWED_GOOGLE_SUBS` in the deployment shell.
3. Review `bash scripts/deploy.sh` (plan only), then run `bash scripts/deploy.sh --apply-after-billing-approval`. It never links a billing account. The deployer needs permission to enable services, create/grant identities, act as runtime/build service accounts, and deploy Cloud Run. Grant narrowly at deployment time if missing; do not use Owner for runtime. This script is prepared but has not been exercised against the real project.
4. Verify the deployed health endpoint and `/analyze`: no bearer → 401, invalid signature/audience/expiry → 401, unauthorized account → 403, allowed identity while disabled → 503, only expected CORS origin allowed. A command-line POST needs `Origin: https://krintea.github.io` too. Test signed Google tokens, not fixture tokens, here.
5. Confirm `gemini-2.5-flash` is available in `europe-west1` for the project. The model is configurable via `GEMINI_MODEL`; no automatic global/region fallback is performed. If unavailable, select a supported regional Gemini model and validate the response schema before activation. Do not silently change data location.
6. Enable the backend only after approval: `gcloud run services update cornu-document-analysis --project=cornu-house-expenses --region=europe-west1 --update-env-vars=ANALYSIS_ENABLED=true`. Run one synthetic invoice through each supported format using the allowed account. No actual bills are necessary for smoke tests. Check correct supplier, total including VAT, original currency, dates, category/subcategory, warnings and no persisted document.
7. Put the **returned and verified** HTTPS Cloud Run URL in `ai-config.js`, set `enabled: true`, and publish that commit to GitHub Pages. Test Google sign-in and a synthetic upload from the real Pages origin. Confirm mobile file selection and PDF/DOCX/JPG/PNG/WEBP, editable suggestions, Undo, cancel, duplicates and manual save. A scan may be wrong; never save without review. Unknown date/currency/category stays blank. Invoice date is not used as payment date; exchange rate is not fabricated.
8. Run the existing Settings → Google Drive test with its disposable probe, then verify backup and restore with a backed-up test dataset. Local automated tests mock Google APIs, so they do not certify live Google Drive access. Keep personal financial data out of this public repository, screenshots and test fixtures.

## Rollback and checks

Set `ANALYSIS_ENABLED=false` server-side to stop new model requests, and set `enabled:false` client-side. Manual payments and Drive continue working. Existing in-flight requests may finish. Revoke the runtime's Vertex AI role or remove the Cloud Run service if permanently retiring it; retain unrelated OAuth and Drive configuration.

Local checks (no Cloud calls):

```sh
python -m venv .venv
.venv/bin/pip install -r backend/requirements.txt pytest==9.2.0
.venv/bin/python -m pytest -q tests/test_backend.py
npm ci --ignore-scripts
npm test
bash -n scripts/deploy.sh
bash scripts/deploy.sh
```

The backend supports text/tables and embedded raster images in DOCX, but does not run macros, fetch external relationships, or execute embedded objects. Complex unsupported documents should be exported to PDF. Tests use fictitious documents only. CI runs tests only and has no Cloud deploy permission or billing trigger.
