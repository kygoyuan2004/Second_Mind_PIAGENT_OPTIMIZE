#!/usr/bin/env bash
# Run on a fresh Actions VM, with public-image verification authorized by the owner.
set -Eeuo pipefail
: "${RUNNER_TEMP:?Use a disposable runner}"
root=$(mktemp -d "$RUNNER_TEMP/dual-docker.XXXXXXXX")
export DOCKER_CONFIG="$root/anonymous"
mkdir "$DOCKER_CONFIG"
image=ghcr.io/kygoyuan2004/second_mind_piagent_optimize
version=${1:?Pass the public Pi release tag}
digest() { docker buildx imagetools inspect "$1" | awk '$1=="Digest:" && !seen {print $2; seen=1}'; }
v=$(digest "$image:$version")
[[ $v =~ ^sha256:[a-f0-9]{64}$ && "$(digest "$image:latest")" = "$v" ]]
docker buildx imagetools inspect --raw "$image:$version" |
  jq -e '[.manifests[].platform | select(.os == "linux") | .architecture] | unique == ["amd64","arm64"]'
for tag in "$version" latest; do docker pull "$image:$tag"; done
git clone --quiet --depth 1 --branch v0.2.1 https://github.com/kygoyuan2004/Second-Mind.git "$root/claude"
pi=$(cd "$(dirname "$0")/.." && pwd)
# Use the installation defaults, isolated only by the test user's HOME.
export HOME="$root/home" XDG_CONFIG_HOME="$root/home/.config"
mkdir -p "$HOME" "$root/claude-vault/Demo/.obsidian" "$root/pi-vault/Demo/.obsidian"
run() { local app=$1; shift; (cd "$app" && bash ./install.sh "$@"); }
for entry in claude pi; do
  app="$pi"; [[ $entry != claude ]] || app="$root/claude"
  SECOND_MIND_ADMIN_PASSWORD="$(openssl rand -hex 24)" run "$app" init --non-interactive --vault "$root/$entry-vault"
done
a="$XDG_CONFIG_HOME/second-mind"
b="$XDG_CONFIG_HOME/second-mind-pi"
a_id=$(cat "$a/current"); b_id=$(cat "$b/current")
av=$(jq -r .dataVolume "$a/$a_id/instance.json")
bv=$(jq -r .dataVolume "$b/$b_id/instance.json")
test "$av" != "$bv" && test "$a_id" != "$b_id"
test "$(jq -r .port "$a/$a_id/instance.json")" = 8787
test "$(jq -r .port "$b/$b_id/instance.json")" = 8788
cleanup() {
  run "$pi" uninstall || true
  run "$root/claude" uninstall || true
}
trap cleanup EXIT
curl -fsS http://127.0.0.1:8787/health/ready >/dev/null
curl -fsS http://127.0.0.1:8788/health/ready >/dev/null
for spec in "$a_id/$av/claude" "$b_id/$bv/pi"; do
  IFS=/ read -r project volume text <<< "$spec"
  id=$(docker ps -q --filter "label=com.docker.compose.project=$project" --filter label=com.docker.compose.service=app)
  test -n "$id"
  actual=$(docker inspect "$id" | jq -r '.[0].Mounts[] | select(.Destination=="/app/data") | .Name')
  test "$actual" = "$volume"
  docker exec "$id" sh -c 'printf "%s" "$1" > /app/data/edition-check' check "$text"
done
run "$pi" uninstall
curl -fsS http://127.0.0.1:8787/health/ready >/dev/null
run "$root/claude" uninstall
SECOND_MIND_IMAGE="$image:$version" run "$pi" restart
curl -fsS http://127.0.0.1:8788/health/ready >/dev/null
pi_app=$(docker ps -q --filter "label=com.docker.compose.project=$b_id" --filter label=com.docker.compose.service=app)
test "$(docker exec "$pi_app" cat /app/data/edition-check)" = pi
echo "Verified anonymous images $v, separate ports, independent Compose volumes and restarts."
