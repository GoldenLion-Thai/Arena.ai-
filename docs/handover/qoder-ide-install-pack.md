# Handover Pack — Qoder.ai IDE

**Purpose:** install / upgrade Coolify on the MERC-OS Oracle Cloud estate, expose a working
URL to the operator's laptop, and set up Windows 11 access.

**Audience:** an IDE agent with shell access. Everything needed is in this file.

**Contains no secrets.** No keys, passwords, tokens or OCIDs. Credentials live in
Vaultwarden; supply them at runtime.

Generated 2026-09-15. Verify anything time-sensitive before acting on it.

---

## 0. Non-negotiable constraints

Break any of these and you will destroy infrastructure or lock the operator out again.

| # | Rule | Why |
|---|---|---|
| 1 | **Never `terminate` an OCI instance. Use `stop`.** | Terminating releases Always Free capacity that may be impossible to reclaim. The operator lost a server this way on 2026-09-14. |
| 2 | **SSH is key-only. Never enable `PasswordAuthentication`.** | Standing rule across the estate. |
| 3 | **The OCI SSH user is `ubuntu`, not `root`.** | Hostinger boxes are `root`; OCI boxes are `ubuntu`. Wrong user looks like a broken key. |
| 4 | **Do not reinstall Coolify over the existing install.** | It holds live configuration and databases. Reinstalling destroys them. Upgrade in place. |
| 5 | **Take a backup or snapshot before any change.** | OCI boot volumes cannot be shrunk, and a broken Coolify is not trivially reversible. |
| 6 | **Do not resize, replace or delete the 200 GB boot volume.** | Pending a decision once real usage and a verified backup exist. |
| 7 | **Do not paste secrets into chat, logs or commits.** | Env var *names* only, never values. |
| 8 | **Ask before anything destructive or irreversible.** | Stop and confirm rather than proceeding on a reasonable guess. |

---

## 1. The estate as it stands (verified 2026-09-15)

| id | Provider | Public IP | SSH user | OS | Arch | State |
|---|---|---|---|---|---|---|
| `kami-vps-1` (a.k.a. kami-VPS-asci) | Oracle Cloud, `VM.Standard.A1.Flex` 4 OCPU / 24 GB | `132.145.57.78` | `ubuntu` | Ubuntu 24.04.5 | aarch64 | RUNNING, Coolify 4.1.2 live |
| `asci-vps-1` | Hostinger KVM 4 | `72.61.203.79` | `root` | Ubuntu 24.04.5 | x86_64 | RUNNING, edge + MCP + mail |
| `asci-vps-2` | Oracle Cloud, Always Free | ⬜ unknown | `ubuntu` | ⬜ | ⬜ | Not yet located |
| `asci-vps-3` | Oracle Cloud, Always Free | ⬜ unknown | `ubuntu` | ⬜ | ⬜ | Not yet located |

**kami-vps-1 already runs Coolify.** Ten containers, all healthy:

`coolify` (4.1.2) · `coolify-proxy` (Traefik 3.6) · `coolify-db` (Postgres 15) ·
`coolify-redis` (Redis 7) · `coolify-realtime` · `coolify-sentinel` · `kami-vaultwarden` ·
`kami-postgres` (pgvector 16) · `kami-redis` · `portainer_agent`

Disk: 8.7 G of 193 G used (5%). RAM: 1.2 Gi of 23 Gi. No swap.

---

## 2. ⚠️ Ambiguity to resolve before starting — do not skip

The brief says *"install kami-VPS-asci Coolify OS OCI FreeForever, upgraded"*. Coolify is
**already installed and healthy** on `kami-vps-1`. So the instruction has two readings:

| Reading | What it means | Risk |
|---|---|---|
| **A — upgrade in place** (recommended) | Bring the existing Coolify 4.1.2 to current on `kami-vps-1` | Low. Preserves all data. |
| **B — fresh install elsewhere** | Install Coolify on `asci-vps-2` or `asci-vps-3` | Neither host is located yet; both are almost certainly `E2.1.Micro` (1 GB RAM), which is **below Coolify's minimum** |

**Recommendation: Reading A.** A fresh install on a 1 GB micro instance will fail — Coolify
needs substantially more than that. And reinstalling over the working install on
`kami-vps-1` would destroy its databases and configuration.

**Confirm the intended reading with the operator before proceeding.**

### On "Free Forever, upgraded"

The tenancy is **upgraded to Pay As You Go** while running Always Free resources. Note that
"free forever" is not the same as "free": the operator is billed roughly **£8.15/month** for
block-volume storage because the 200 GB volume is charged despite the Always Free allowance.
Upgrading the account is what makes A1 capacity obtainable — it does not make storage
complimentary.

---

## 3. Pre-flight — all must pass

Run from OCI Cloud Shell or the operator's Windows 11 PC.

```bash
# reachability
ssh -i ~/.ssh/kami_vps -o IdentitiesOnly=yes ubuntu@132.145.57.78 'echo OK'

# confirm you are on the right host
hostname                       # must print kami-vps-1
df -h /                        # must show ~193G with ~8.7G used
docker ps --format 'table {{.Names}}\t{{.Status}}'   # 10 containers, all healthy
```

First connection should present ECDSA fingerprint
`SHA256:ctjfO828VB8O6gBGd8nUXChZo4MMQftXfhLeEIta0DU`. Verify it.

**If any check fails, stop.** Do not proceed on an unverified host.

### Outstanding issues on this host — these are known, do not "fix" them blindly

- ⚠️ **Reboot pending** since 2026-09-15 (`*** System restart required ***`). Do this
  *before* the Coolify upgrade, since the upgrade may itself want a restart.
- ⚠️ Port `111` (rpcbind) listening on `0.0.0.0` — check whether anything needs it.
- ⚠️ DNS A records still point at the **old** IP `130.162.187.135`. They must be repointed
  to `132.145.57.78` before any hostname-based URL will work.

---

## 4. Step 1 — snapshot, then reboot

In OCI Console, take a boot volume backup of `kami-vps-1` first. Then:

```bash
docker ps --format '{{.Names}} {{.Status}}' > ~/pre-reboot.txt
sudo reboot
# wait ~60s, reconnect
docker ps --format '{{.Names}} {{.Status}}' > ~/post-reboot.txt
diff ~/pre-reboot.txt ~/post-reboot.txt
```

All ten containers must be back. If any is missing, investigate before continuing.

---

## 5. Step 2 — upgrade Coolify in place

Coolify's own upgrade script handles backup and migration. Run as `ubuntu`:

```bash
curl -fsSL https://cdn.coollabs.io/coolify/install.sh | bash
```

Then verify:

```bash
docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}'
docker logs coolify --tail 50
```

Coolify's dashboard is on **port 8000**. Confirm it answers:

```bash
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8000/api/v1/version
```

Expect `200`. **If the upgrade fails, restore from the snapshot taken in Step 1** — do not
attempt a manual repair of Coolify's databases.

---

## 6. Step 3 — a real URL for the laptop

`http://132.145.57.78:8000` works today but is IP-based and unencrypted. Two proper options.

### Option A — Cloudflare Tunnel (recommended)

Serves a real hostname over HTTPS with **no inbound ports opened** on the instance. This
sidesteps the fact that Cloudflare's proxy only forwards a fixed set of ports, and it keeps
Coolify off the public internet entirely.

Requires the `ascendant-ai.uk` Cloudflare zone (already in use for this estate).

```bash
# on kami-vps-1
curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg \
  | sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null
echo 'deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main' \
  | sudo tee /etc/apt/sources.list.d/cloudflared.list
sudo apt update && sudo apt install -y cloudflared

cloudflared tunnel login
cloudflared tunnel create coolify
cloudflared tunnel route dns coolify coolify.ascendant-ai.uk
```

Then a config at `/etc/cloudflared/config.yml`:

```yaml
tunnel: coolify
credentials-file: /root/.cloudflared/<TUNNEL-ID>.json
ingress:
  - hostname: coolify.ascendant-ai.uk
    service: http://localhost:8000
  - service: http_status:404
```

```bash
sudo cloudflared service install
sudo systemctl enable --now cloudflared
```

Resulting URL: **https://coolify.ascendant-ai.uk**

### Option B — explicit DNS record

Create `coolify.ascendant-ai.uk` → `132.145.57.78`, proxied, with Traefik terminating TLS.

⚠️ **Do not rely on the existing wildcard.** `*.ascendant-ai.uk` currently resolves to
`72.61.203.79` — the **Hostinger** box, not this one. A hostname that "looks right" will
silently point at the wrong server. Any record for `kami-vps-1` must be explicit.

(That wildcard is itself a security finding — it leaks the origin IP and is not proxied. See
`docs/SOT-fleet-inventory.md` §2.)

---

## 7. Step 4 — Windows 11 local PC

Only needed if the operator will administer from the laptop rather than Cloud Shell.

1. **Terminus** — Settings → SSH → Keys → New Key → paste the **entire** private key
   including the `-----BEGIN OPENSSH PRIVATE KEY-----` and `-----END OPENSSH PRIVATE KEY-----`
   lines. Missing delimiters produce `closed with error: end of file` right after
   "Starting SSH key selection".
2. Host entry: Address `132.145.57.78`, Port `22`, Username **`ubuntu`**, Password blank,
   Keep alive `60`.
3. **tmux** on the server so sessions survive disconnects:
   ```bash
   sudo apt install -y tmux
   tmux new -s merc
   # detach: Ctrl+B then D   |   reattach: tmux attach -t merc
   ```
4. Keepalives and multiplexing in `~/.ssh/config` — generate with
   `merc sshconfig` from this repo.

---

## 8. Verification checklist

- [ ] Snapshot of the boot volume exists and is recent
- [ ] Reboot completed; all ten containers healthy
- [ ] Coolify answers `200` on `/api/v1/version`
- [ ] `https://<coolify-host>` loads on the laptop
- [ ] Coolify dashboard shows the existing applications intact
- [ ] DNS A records repointed from `130.162.187.135` to `132.145.57.78`
- [ ] No new ports exposed directly to the internet
- [ ] `merc audit kami-vps-1` run and report archived

---

## 9. Rollback

1. Stop the Coolify containers.
2. Restore the boot volume from the snapshot taken in Step 1.
3. Start the instance and re-run the verification checklist.

Snapshots are the rollback. Do not begin without one.

---

## 10. Explicitly out of scope

- Terminating any instance
- Resizing, replacing or deleting the 200 GB boot volume
- Enabling password SSH
- Reinstalling Coolify over the existing install
- Installing Coolify on a 1 GB `E2.1.Micro` host
- Changing the wildcard DNS record (flagged, not yet authorised)
- Anything on `asci-vps-1` — it has its own unresolved security issues (see
  `docs/OUTSTANDING-TASKS.md`)

---

## 11. Blocking questions for the operator

1. **Reading A or B?** Upgrade in place on `kami-vps-1`, or fresh install elsewhere?
2. **Which hostname** for Coolify? `coolify.ascendant-ai.uk` suggested.
3. Should the dashboard be **tunnel-only** (not reachable on a public port)?

---

## Appendix — supporting documents in this repository

| Document | Contents |
|---|---|
| `docs/SOT-fleet-inventory.md` | Verified specs for every host |
| `docs/SOP-runbook.md` | Ten procedures: patching, reboot, recovery, key rotation |
| `docs/OUTSTANDING-TASKS.md` | Prioritised open items and the naming decision |
| `docs/discover-hosts.md` | How to locate `asci-vps-2` and `asci-vps-3` |
| `docs/terminus-and-ssh-access.md` | Terminus, tmux, persistent sessions |
| `docs/vault-credentials.md` | `MERC-OS.<env>.<node>.<class>.<item>` naming scheme |
| `docs/learning-notes.md` | Mistakes already made, and what they cost |
| `scripts/vps-healthcheck-readonly.sh` | 15-section read-only audit for any Linux host |
| `scripts/oci-find-instances.sh` | Sweep every OCI region and compartment |
| `scripts/merc` | Fleet CLI: `hosts`, `status`, `audit`, `connect`, `reboot`, `probe`, `todo` |
