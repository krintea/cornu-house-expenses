#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
PROJECT=cornu-house-expenses
REGION=europe-west1
SERVICE=cornu-document-analysis
RUNTIME_SA="cornu-document-ai@${PROJECT}.iam.gserviceaccount.com"
BUILD_SA="cornu-document-build@${PROJECT}.iam.gserviceaccount.com"
CLIENT_ID=747739289103-ue9lu57vkjs2vl632q7865njklo3nkm2.apps.googleusercontent.com
if [[ "${1:-}" != '--apply-after-billing-approval' ]]; then
  cat <<'PLAN'
PLAN ONLY: no Google Cloud commands have been run.
Project: cornu-house-expenses. Cloud Run region: europe-west1.
Enable: Vertex AI, Cloud Run, Cloud Build, Artifact Registry, IAM APIs.
Create dedicated runtime and build identities, without downloadable keys.
Grant runtime Vertex AI User; grant build Cloud Run Builder.
Deploy source with 0 minimum / 1 maximum instances, 1 CPU, 512 MiB.
Cloud Run ingress is reachable, but /analyze requires a verified Google ID token
for the existing OAuth client AND a server-side allowed Google subject.
No document bucket, database, Gemini API key, Drive permissions, or stored documents.
Analysis is initially disabled on both backend and frontend.
Billable resources: builds, container storage, Cloud Run requests/compute, Gemini usage.
Limits reduce usage; they are NOT a hard monetary cap. Google budgets only alert.
To apply AFTER explicit user approval:
  export ALLOWED_GOOGLE_SUBS='<verified Google subject ID>'
  bash scripts/deploy.sh --apply-after-billing-approval
PLAN
  exit 0
fi
: "${ALLOWED_GOOGLE_SUBS:?Set verified Google subject IDs, comma-separated, privately in this shell}"
if [[ ! "$ALLOWED_GOOGLE_SUBS" =~ ^[0-9]+(,[0-9]+)*$ ]]; then
  echo 'Use numeric, verified Google sub IDs, not email addresses.' >&2; exit 1
fi
command -v gcloud >/dev/null
# Billing must already be linked by the project owner; this script never links a billing account.
if [[ "$(gcloud billing projects describe "$PROJECT" --format='value(billingEnabled)')" != 'True' ]]; then
  echo 'Project billing is not linked. Stop: the owner must approve and link billing.' >&2; exit 1
fi
gcloud services enable aiplatform.googleapis.com run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com iam.googleapis.com --project="$PROJECT"
for NAME in cornu-document-ai cornu-document-build; do
  if ! gcloud iam service-accounts describe "$NAME@$PROJECT.iam.gserviceaccount.com" --project="$PROJECT" >/dev/null 2>&1; then
    gcloud iam service-accounts create "$NAME" --project="$PROJECT"
  fi
done
gcloud projects add-iam-policy-binding "$PROJECT" --member="serviceAccount:$RUNTIME_SA" --role=roles/aiplatform.user --condition=None >/dev/null
gcloud projects add-iam-policy-binding "$PROJECT" --member="serviceAccount:$BUILD_SA" --role=roles/run.builder --condition=None >/dev/null
ENV_FILE="$(mktemp)"
chmod 600 "$ENV_FILE"
trap 'rm -f "$ENV_FILE"' EXIT
# Subjects are private deployment configuration, never committed to this public repository.
cat > "$ENV_FILE" <<EOF
GOOGLE_CLOUD_PROJECT: "$PROJECT"
GOOGLE_CLIENT_ID: "$CLIENT_ID"
ALLOWED_GOOGLE_SUBS: "$ALLOWED_GOOGLE_SUBS"
ALLOWED_ORIGIN: "https://krintea.github.io"
VERTEX_LOCATION: "$REGION"
GEMINI_MODEL: "${GEMINI_MODEL:-gemini-2.5-flash}"
ANALYSIS_ENABLED: "false"
EOF
gcloud run deploy "$SERVICE" --project="$PROJECT" --region="$REGION" \
  --source=backend --service-account="$RUNTIME_SA" \
  --build-service-account="projects/$PROJECT/serviceAccounts/$BUILD_SA" \
  --no-invoker-iam-check --ingress=all --min=0 --max=1 \
  --cpu=1 --memory=512Mi --concurrency=4 --timeout=100 --cpu-throttling \
  --env-vars-file="$ENV_FILE" --quiet
URL="$(gcloud run services describe "$SERVICE" --project="$PROJECT" --region="$REGION" --format='value(status.url)')"
echo "Deployed with analysis OFF: $URL"
echo 'Follow DEPLOYMENT.md for authentication, model smoke tests, and frontend activation.'
