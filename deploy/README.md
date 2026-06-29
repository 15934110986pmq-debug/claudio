# Claudio Deployment — Cloudflare Tunnel + systemd

Everything scaffolded by P1-#8. You complete two interactive steps and run a few setup commands.

## What's installed
- cloudflared: v2026.5.0 at `/usr/local/bin/cloudflared`
- systemd units: prepared in `deploy/systemd/`, not yet linked
- Tunnel config template: `deploy/cloudflared.config.yml.example`

## Step 1 — Cloudflare login (one-time, ~30s, interactive)

    cloudflared tunnel login

This opens a browser to authorize one of your Cloudflare-managed domains.

## Step 2 — Create the tunnel

    cloudflared tunnel create claudio

Copy the printed Tunnel ID and credentials file path.

## Step 3 — Configure the tunnel

    mkdir -p ~/.cloudflared
    cp deploy/cloudflared.config.yml.example ~/.cloudflared/config.yml
    # Edit ~/.cloudflared/config.yml — replace <TUNNEL_ID>, <HOSTNAME>, <CRED_PATH>

## Step 4 — Point DNS at the tunnel

    cloudflared tunnel route dns claudio claudio.yourdomain.com

## Step 5 — Install user-systemd units

    mkdir -p ~/.config/systemd/user ~/claudio/claudio/logs
    cp deploy/systemd/*.service ~/.config/systemd/user/
    systemctl --user daemon-reload
    systemctl --user enable --now claudio.service
    systemctl --user enable --now cloudflared.service
    # Survive logout:
    loginctl enable-linger $USER

## Verify

    systemctl --user status claudio.service cloudflared.service
    curl https://claudio.yourdomain.com/

## Manual cloudflared install (if scaffold failed)

cloudflared v2026.5.0 was already present at `/usr/local/bin/cloudflared` — no manual install needed.

If you ever need to reinstall or update:

    sudo dpkg -i <(curl -fsSL https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb)

Or without sudo, drop the binary in ~/.local/bin/:

    mkdir -p ~/.local/bin
    curl -fsSL https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o ~/.local/bin/cloudflared
    chmod +x ~/.local/bin/cloudflared
    # Make sure ~/.local/bin is in your PATH
    # Then update ExecStart in deploy/systemd/cloudflared.service accordingly.

## Rollback

    systemctl --user disable --now cloudflared.service claudio.service
    rm ~/.config/systemd/user/{claudio,cloudflared}.service
    cloudflared tunnel delete claudio  # optional, removes from CF dashboard
