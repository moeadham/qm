#!/usr/bin/env bash

set -euo pipefail

# Prepare a disposable Ubuntu host for QM upgrade qualification. This script
# installs only test/build tooling, checks out an exact public Git revision,
# starts an isolated PostgreSQL container, and installs every dependency used by
# the repository CI. It does not copy deployment secrets or production data and
# does not run the tests themselves.

repository_url="${QM_REPOSITORY_URL:-https://github.com/moeadham/qm.git}"
repository_ref="${QM_REF:-upgrade/v0.1.15-staging}"
expected_sha="${QM_EXPECTED_SHA:-}"
workdir="${QM_WORKDIR:-/opt/qm-qualification}"
results_dir="${QM_RESULTS_DIR:-/opt/qm-qualification-results}"
postgres_container="${QM_POSTGRES_CONTAINER:-qm-qualification-postgres}"
postgres_port="${QM_POSTGRES_PORT:-55432}"
terraform_version="${QM_TERRAFORM_VERSION:-1.15.8}"
helm_version="${QM_HELM_VERSION:-3.19.0}"
npm_version="${QM_NPM_VERSION:-11.19.1}"

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run this script as root on a disposable Ubuntu test host." >&2
  exit 1
fi

if ! command -v apt-get >/dev/null 2>&1; then
  echo "This bootstrap currently supports apt-based Ubuntu hosts only." >&2
  exit 1
fi

case "$(uname -m)" in
  x86_64)
    node_arch="x64"
    release_arch="amd64"
    ;;
  aarch64 | arm64)
    node_arch="arm64"
    release_arch="arm64"
    ;;
  *)
    echo "Unsupported architecture: $(uname -m)" >&2
    exit 1
    ;;
esac

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y \
  build-essential \
  ca-certificates \
  curl \
  docker.io \
  git \
  jq \
  lsof \
  python3 \
  unzip \
  xz-utils
systemctl enable --now docker

if [[ -e "${workdir}" && ! -d "${workdir}/.git" ]]; then
  echo "Refusing to replace non-Git path: ${workdir}" >&2
  exit 1
fi

if [[ -d "${workdir}/.git" ]]; then
  if [[ -n "$(git -C "${workdir}" status --porcelain)" ]]; then
    echo "Refusing to update a dirty checkout: ${workdir}" >&2
    exit 1
  fi
  actual_remote="$(git -C "${workdir}" remote get-url origin)"
  if [[ "${actual_remote}" != "${repository_url}" ]]; then
    echo "Checkout origin is ${actual_remote}, expected ${repository_url}" >&2
    exit 1
  fi
else
  mkdir -p "$(dirname "${workdir}")"
  git init "${workdir}"
  git -C "${workdir}" remote add origin "${repository_url}"
fi

git -C "${workdir}" fetch --depth=1 origin "${repository_ref}"
git -C "${workdir}" checkout --detach FETCH_HEAD
actual_sha="$(git -C "${workdir}" rev-parse HEAD)"
if [[ -n "${expected_sha}" && "${actual_sha}" != "${expected_sha}" ]]; then
  echo "Checked out ${actual_sha}, expected ${expected_sha}" >&2
  exit 1
fi

node_version="${QM_NODE_VERSION:-$(tr -d '[:space:]' <"${workdir}/.node-version")}"
node_archive="node-v${node_version}-linux-${node_arch}.tar.xz"
node_base_url="https://nodejs.org/dist/v${node_version}"
temporary_dir="$(mktemp -d)"
trap 'rm -rf "${temporary_dir}"' EXIT

curl -fsSL "${node_base_url}/SHASUMS256.txt" -o "${temporary_dir}/SHASUMS256.txt"
curl -fsSL "${node_base_url}/${node_archive}" -o "${temporary_dir}/${node_archive}"
(
  cd "${temporary_dir}"
  grep " ${node_archive}$" SHASUMS256.txt | sha256sum --check
)
tar -xJf "${temporary_dir}/${node_archive}" -C /usr/local --strip-components=1
npm install --global "npm@${npm_version}"

terraform_archive="terraform_${terraform_version}_linux_${release_arch}.zip"
terraform_base_url="https://releases.hashicorp.com/terraform/${terraform_version}"
curl -fsSL "${terraform_base_url}/terraform_${terraform_version}_SHA256SUMS" \
  -o "${temporary_dir}/terraform_SHA256SUMS"
curl -fsSL "${terraform_base_url}/${terraform_archive}" \
  -o "${temporary_dir}/${terraform_archive}"
(
  cd "${temporary_dir}"
  grep " ${terraform_archive}$" terraform_SHA256SUMS | sha256sum --check
)
unzip -oq "${temporary_dir}/${terraform_archive}" -d "${temporary_dir}/terraform"
install -m 0755 "${temporary_dir}/terraform/terraform" /usr/local/bin/terraform

helm_archive="helm-v${helm_version}-linux-${release_arch}.tar.gz"
helm_base_url="https://get.helm.sh"
curl -fsSL "${helm_base_url}/${helm_archive}" -o "${temporary_dir}/${helm_archive}"
curl -fsSL "${helm_base_url}/${helm_archive}.sha256sum" \
  -o "${temporary_dir}/${helm_archive}.sha256sum"
(
  cd "${temporary_dir}"
  sha256sum --check "${helm_archive}.sha256sum"
)
tar -xzf "${temporary_dir}/${helm_archive}" -C "${temporary_dir}"
install -m 0755 \
  "${temporary_dir}/linux-${release_arch}/helm" \
  /usr/local/bin/helm

if docker container inspect "${postgres_container}" >/dev/null 2>&1; then
  postgres_image="$(docker container inspect --format '{{.Config.Image}}' "${postgres_container}")"
  if [[ "${postgres_image}" != "pgvector/pgvector:0.8.1-pg16" ]]; then
    echo "Existing ${postgres_container} uses unexpected image ${postgres_image}" >&2
    exit 1
  fi
  docker start "${postgres_container}" >/dev/null
else
  docker run --detach \
    --name "${postgres_container}" \
    --publish "127.0.0.1:${postgres_port}:5432" \
    --env POSTGRES_PASSWORD=postgres \
    --env POSTGRES_DB=qm \
    pgvector/pgvector:0.8.1-pg16 >/dev/null
fi

for _ in $(seq 1 60); do
  if docker exec "${postgres_container}" pg_isready -U postgres -d qm >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
docker exec "${postgres_container}" pg_isready -U postgres -d qm >/dev/null

mkdir -p "${results_dir}"
chmod 0700 "${results_dir}"
test_env="${results_dir}/test-host.env"
cat >"${test_env}" <<EOF
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:${postgres_port}/qm
SWARM_TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:${postgres_port}/qm
MODEL_OVERLAY_TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:${postgres_port}/qm
MEMORABLE_E2E_DB_URL=postgresql://postgres:postgres@127.0.0.1:${postgres_port}/qm
QM_TERRAFORM_BIN=terraform
QM_TEST_TERRAFORM=terraform
EOF
chmod 0600 "${test_env}"

cd "${workdir}"
npm ci --no-audit --no-fund
npm ci --prefix cli --no-audit --no-fund
npm ci --prefix desktop --ignore-scripts --no-audit --no-fund
npm ci --prefix plugins/admin --no-audit --no-fund
npm ci --prefix plugins/auth --no-audit --no-fund
npm ci --prefix plugins/portal --no-audit --no-fund
npm ci --prefix plugins/web-ui --no-audit --no-fund
npm run build:connector-sdk
npm run build --prefix cli

{
  printf 'git_sha=%s\n' "${actual_sha}"
  printf 'node=%s\n' "$(node --version)"
  printf 'npm=%s\n' "$(npm --version)"
  printf 'terraform=%s\n' "$(terraform version -json | jq -r .terraform_version)"
  printf 'helm=%s\n' "$(helm version --short)"
  printf 'docker=%s\n' "$(docker --version)"
  printf 'postgres_image=%s\n' "$(docker container inspect --format '{{.Config.Image}}' "${postgres_container}")"
} >"${results_dir}/environment.txt"

cat <<EOF
QM qualification host is ready.

Checkout: ${workdir}
Revision: ${actual_sha}
Test environment: ${test_env}
Results directory: ${results_dir}

Load the disposable database settings before PostgreSQL-backed checks:
  set -a
  source ${test_env}
  set +a

Use docs/UPSTREAM_MERGE_CHECKLIST.md for the qualification gates.
EOF
