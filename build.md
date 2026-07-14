# Build & deploy (Docker Hub → NAS Portainer)

自建 image，部署到 NAS Docker / Portainer。

| Item | Value |
|------|--------|
| Docker Hub | `cooper0688` |
| Image | `cooper0688/understory:latest` |
| NAS arch | `amd64` → build 加 `--platform linux/amd64` |
| Mac | Docker Desktop 需先啟動 |

先前 Stack 若用原作者 `ghcr.io/thecodacus/understory:latest`，換成上面的 image 即可；**volume 名稱保持 `okf-bundle` 可保留既有 memory**。

---

## 總覽

| 步驟 | 做什麼 |
|------|--------|
| 1 | Docker Hub login |
| 2 | Mac 上 `docker build`（amd64） |
| 3 | `docker push` |
| 4 | 改 Portainer stack 的 `image:` |
| 5 | Re-pull & redeploy |

---

## Step 1 — 登入 Docker Hub

```bash
docker login
```

帳號：`cooper0688`。密碼建議用 Docker Hub Access Token（Account Settings → Personal access tokens）。

---

## Step 2 — Build（針對 NAS amd64）

專案根目錄（有 `Dockerfile` 處）：

```bash
cd "/Users/cooperhu/AI Projects/understory"

docker build --platform linux/amd64 \
  -t cooper0688/understory:latest .
```

Mac 是 Apple Silicon 時**必須**加 `--platform linux/amd64`，否則 x86 NAS 跑不起來。

確認：

```bash
docker images cooper0688/understory
```

---

## Step 3 — Push

```bash
docker push cooper0688/understory:latest
```

可到 https://hub.docker.com/r/cooper0688/understory 確認。

---

## Step 4 — 改 Portainer compose

把 stack 的 `image` 從：

```yaml
image: ghcr.io/thecodacus/understory:latest
```

改成：

```yaml
image: cooper0688/understory:latest
```

完整範例（其餘與 `docker-compose.portainer.yml` 對齊）：

```yaml
services:
  understory:
    image: cooper0688/understory:latest
    ports:
      - "3800:3800"
    volumes:
      - okf-bundle:/bundle
    environment:
      BUNDLE_ROOT: /bundle
      LLM_PROVIDER: ${LLM_PROVIDER:-llamacpp}
      LLM_MODEL: ${LLM_MODEL:-}
      ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY:-}
      OPENROUTER_API_KEY: ${OPENROUTER_API_KEY:-}
      LLAMACPP_BASE_URL: ${LLAMACPP_BASE_URL:-http://192.168.1.101:8080}
      LLAMACPP_API_KEY: ${LLAMACPP_API_KEY:-}
      LOCAL_BASE_URL: ${LOCAL_BASE_URL:-}
      GIT_AUTOCOMMIT: ${GIT_AUTOCOMMIT:-false}
    restart: unless-stopped

volumes:
  okf-bundle:
```

Secrets / LLM 設定繼續放 Portainer Environment，不要 bake 進 image。新的 env（例如 `CHAT_*`）也要在 Portainer 補上。

---

## Step 5 — Redeploy

1. Portainer → **Stacks** → understory stack  
2. 套用 `image:` 變更（或貼完整 compose）  
3. 勾 **Re-pull image and redeploy**  
4. **Update the stack**  
5. 開 `http://<NAS-IP>:3800` 確認

---

## 之後每次改 code

```bash
cd "/Users/cooperhu/AI Projects/understory"

docker build --platform linux/amd64 \
  -t cooper0688/understory:latest .

docker push cooper0688/understory:latest
```

再到 Portainer → Update → Re-pull image and redeploy。

可選用日期或 commit tag（例如 `:2026-07-15`）方便 rollback。

---

## 注意事項

1. Portainer「Repository」若仍指向原作者 repo，只會繼續拿 upstream image；要改 `image:` 或改成自己的 compose。
2. 只換 image、不換 volume 名 → OKF memory 通常仍在。
3. 不要把 API key 寫進 Dockerfile / image。

---

## 替代方案（簡述）

- **在 NAS SSH 上 build**：`git pull` 後 `docker build -t understory:local .`，NAS CPU 弱時很慢。
- **Fork + GitHub Actions**：push `main` 走 `.github/workflows/docker.yml` 發到 GHCR；本流程改走 Docker Hub，與該 workflow 無關。
