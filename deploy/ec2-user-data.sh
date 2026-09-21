#!/bin/bash
set -euxo pipefail
dnf install -y docker
systemctl enable --now docker
docker network create web || true
mkdir -p /opt/ecoroute
cat > /opt/ecoroute/Caddyfile <<'CADDY'
xpert-ecoroute.duckdns.org {
    encode gzip
    reverse_proxy ecoroute:8000
}
CADDY
docker run -d --name caddy --restart unless-stopped --network web -p 80:80 -p 443:443 -v /opt/ecoroute/Caddyfile:/etc/caddy/Caddyfile:ro -v caddy-data:/data -v caddy-config:/config caddy:2
cat > /opt/ecoroute/deploy.sh <<'DEPLOY'
#!/bin/bash
set -euo pipefail
IMAGE="$1"
aws ecr get-login-password --region ap-northeast-2 | docker login --username AWS --password-stdin "${IMAGE%%/*}"
docker pull "$IMAGE"
docker rm -f ecoroute 2>/dev/null || true
docker run -d --name ecoroute --restart unless-stopped --network web -v ecoroute-data:/app/data/db -e ECOROUTE_DB_PATH=/app/data/db/ecoroute.db -e ECOROUTE_SECURE_COOKIE=1 "$IMAGE"
for i in $(seq 1 90); do
  if docker exec ecoroute python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/api/regions', timeout=5)" 2>/dev/null; then
    echo "Deployed $IMAGE"
    docker image prune -af >/dev/null || true
    exit 0
  fi
  sleep 2
done
docker logs --tail 100 ecoroute
exit 1
DEPLOY
chmod +x /opt/ecoroute/deploy.sh
