# Docker deployment

This deployment uses the host Docker daemon through its Unix socket. It does not start a nested Docker daemon and does not require privileged mode.

From the repository root:

```bash
cp deploy/.env.example deploy/.env
openssl rand -hex 32
docker compose --env-file deploy/.env -f deploy/docker-compose.yml up --build -d
curl http://localhost:8080/health
```

The socket path can be changed with `DOCKER_SOCKET`. The path inside the container remains `/var/run/docker.sock`, which is configured through `MINICOMPUTER_BACKEND_ENDPOINT`.

The container can control the Docker daemon represented by the mounted socket. Protect the API with a strong JWT secret and restrict access to port 8080 at the network boundary.

For a daemonless smoke test, set `MINICOMPUTER_BACKEND=mock` and omit the socket mount. The production Compose file selects the Docker backend explicitly.
