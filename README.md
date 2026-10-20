# ❀ RedPanel — Minecraft Hosting Panel

Red & white Minecraft hosting panel with falling flowers in the sidebar. Servers run in **Docker** (no KVM needed — works on a normal VPS *or* a Docker-container VPS). A **local node is set up automatically**.

## Install (1 command)

1. Upload these files to the root of your repo: `https://github.com/adityazdomainzz-code/alpine-rail`
   ```
   install.sh
   Dockerfile
   .dockerignore
   .gitignore
   railway/
   panel/
   node/
   README.md
   ```
2. On the VPS (as root):
   ```bash
   curl -fsSL https://raw.githubusercontent.com/adityazdomainzz-code/alpine-rail/main/install.sh -o install.sh
   sudo bash install.sh
   ```
3. Choose how to open the panel:
   - **1) Public IP** → `http://YOUR_IP:8000`
   - **2) Cloudflare Tunnel** → paste a tunnel token, add a Public Hostname pointing to `http://localhost:8000`

`install.sh` clones the repo, checks every file and folder, installs Docker / Node.js / pm2, then starts **Docker → node daemon → panel → tunnel** one by one.

## Features
| User | Admin panel |
|---|---|
| Servers list, Account info | Overview, Nodes (local node ready), Servers (create like Pterodactyl: node + IP:port allocation) |
| Console (live logs + commands, start/stop/restart/kill, CPU/RAM) | User management |
| File manager (edit, upload, drag & drop, rename, delete, download) | Cloudflare (API token + Zone ID) |
| Plugins / mods (Modrinth search + install, upload .jar) | Settings (panel name — admin only) |
| Subdomain (max **2 per user**, A + SRV records) | |
| Version, Software (Fabric, Forge, Purpur, Paper, Spigot), Server logo, MOTD | |

## Ports
- `8000` panel · `8080` node daemon (local only on the main machine) · `25565-25665` Minecraft

## Extra node (another VPS)
```bash
sudo bash install.sh --node-only
```
It prints a Daemon URL + token → Admin → Nodes → Add node.

## Useful commands
```bash
pm2 logs redpanel          # panel logs
pm2 logs redpanel-node     # node logs
pm2 restart redpanel redpanel-node
cd /opt/redpanel/panel && node src/cli.js admin NewPass123 && pm2 restart redpanel   # reset admin
```
Data: `/opt/redpanel/panel/data/db.json` · server files: `/var/lib/redpanel/volumes/<server-id>`

## Two runtimes (auto-detected)
- **Docker mode** – normal VPS: every server is an `itzg/minecraft-server` container.
- **Process mode** – no Docker available (Railway, container VPS without dockerd): Minecraft runs as a plain Java process. The node downloads Paper / Purpur / Fabric / Forge jars itself (Spigot is compiled with BuildTools). `install.sh` switches to this automatically and installs Java.
Force one with `"runtime": "docker"` or `"process"` in `node/config.json`.

## Railway
1. Push this repo to GitHub → Railway → **New project → Deploy from GitHub repo**. The `Dockerfile` is picked up automatically.
2. **Add a Volume** to the service, mount path **`/data`** (otherwise everything is lost on redeploy).
3. Variables: `ADMIN_USERNAME`, `ADMIN_PASSWORD` (optional – if empty a password is printed in the deploy logs on first boot).
4. Settings → Networking → **Generate Domain** (the panel, HTTP) and **TCP Proxy** on port **25565** (Minecraft).
5. Create your server in the panel on allocation **:25565**, then Admin → Servers → ✎ → **Public address** = the TCP proxy `host:port` shown by Railway.

Railway gives one TCP proxy per service, so only one Minecraft server is reachable from outside per Railway service. Railway RAM limits apply to all servers together.

## Cloudflare subdomains
Cloudflare → My Profile → API Tokens → Create token with **Zone · DNS · Edit**. Paste it with the Zone ID in Admin → Cloudflare, click **Test connection**. Players then join with `name.yourdomain.com` (no port needed — SRV record).
