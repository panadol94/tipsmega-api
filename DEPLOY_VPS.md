# Deployment Guide: TipsMega Bot (api-mini) to VPS

This guide covers deploying the Telegram Bot (`api-mini`) to a generic VPS using **Coolify** (Recommended) or **Docker Compose**.

## Prerequisites

- A VPS (Ubuntu/Debian recommended).
- A domain name pointing to your VPS IP (e.g., `api.tipsmega.com` or just IP if using IP-based webhook).
- `FIREBASE_SERVICE_ACCOUNT_JSON`: The raw JSON content of your Firebase Admin SDK key.

---

## Option 1: Coolify (Recommended)

If you are using Coolify on your VPS:

1. **Add Resource**:
    - Go to your Project environment.
    - Click **+ New** -> **Application** -> **Public Repository** (or Private if you have one).
    - Repo URL: `https://github.com/Start-Programming-Guild/tipsmega-ui` (or your repo).
    - Build Pack: **Dockerfile**.
    - Base Directory: `/api-mini`.

2. **Environment Variables**:
    - Go to the **Environment Variables** tab of the new application.
    - Copy-paste the content of your local `.env` file.
    - **CRITICAL**: For `FIREBASE_SERVICE_ACCOUNT_JSON`, paste the *entire* JSON string.
        - Ensure it is a single line if your UI behaves oddly, though Coolify usually handles multiline.
        - *Tip*: If you have issues, base64 encode it and decode in code, but the current code expects raw JSON string.

3. **Port Configuration**:
    - In **General** settings, set **Ports Exposes** to `8080`.

4. **Domains**:
    - Set your domain (e.g., `https://bot.yourdomain.com`).
    - Coolify will auto-provision SSL (HTTPS).

5. **Deploy**:
    - Click **Deploy**.

6. **Set Webhook**:
    - Once running, you must tell Telegram to send messages to this new URL.
    - Open your browser or use curl:

      ```bash
      # Format
      https://api.telegram.org/bot<YOUR_BOT_TOKEN>/setWebhook?url=https://bot.yourdomain.com/telegram/webhook

      # Example
      https://api.telegram.org/bot123456:ABC-DEF/setWebhook?url=https://bot.tipsmega.com/telegram/webhook
      ```

---

## Option 2: Manual Docker Compose

1. **Transfer Files**:
    - Copy the `api-mini` folder to your VPS.
    - Or `git clone` your repo on the VPS.

2. **Setup `.env`**:
    - Inside `api-mini`, create a `.env` file.
    - Paste your environment variables.

3. **Run**:

    ```bash
    cd api-mini
    docker compose up -d --build
    ```

4. **Reverse Proxy (Nginx)**:
    - You need HTTPS for Telegram Webhooks.
    - Use Caddy or Nginx + Certbot to proxy port `8080` to `443`.

    *Example Caddyfile:*

    ```text
    bot.yourdomain.com {
        reverse_proxy localhost:8080
    }
    ```

5. **Set Webhook**:
    - Same as Coolify step 6 above.

---

## Troubleshooting

### "Firebase initialized with inline JSON"

If you see this log, your authentication is working. If you see "Failed to parse FIREBASE_SERVICE_ACCOUNT_JSON", check that you pasted the full JSON correctly in the setup.

### Webhook not triggering

- Check bot logs: `docker logs tipsmega-bot`
- Ensure the URL set in `setWebhook` is exactly correct and reachable.
- Telegram **requires** valid SSL (can be self-signed but easier with LetsEncrypt).
