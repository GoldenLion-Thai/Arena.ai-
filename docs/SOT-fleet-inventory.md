# SOT — Fleet Inventory (Single Source of Truth)

Everything here is **observed** from an audit run on the host, not assumed. Anything marked
`UNKNOWN` or `⬜` is a real gap. Update this file the moment a fact changes — every other
runbook defers to it.

**No secrets in this file.** Keys, passwords and tokens belong in Vaultwarden
(`docs/vault-credentials.md`). Key *paths* are recorded here; key *contents* never.

Last updated: 2026-09-15 (audits ran 02:36 UTC on both live hosts)

---

## 0. Estate owner and identity

| Field | Value |
|---|---|
| Operator | **Warren** |
| Contact | `mercenary.thai97@gmail.com` |
| Scope | Personal — household, family, finances, property — plus the MERC-OS venture |
| Venture | **MERC-OS** — the infrastructure layer behind an autonomous app and bot factory |
| Recorded | 2026-09-15, at the operator's explicit direction |

⚠️ That email address is in a **shared git repository** because the operator asked for it
after being warned. It is a login identity rather than a secret, but it is personal data —
remove it if this repo's audience ever widens. Passwords, recovery codes and financial
details must **never** be added here; see `personal-organiser.md`.

**Estate naming:** `MERC-OS`. Earlier documents used `GRiD-OS`; that name is retired, and
`grid-os` survives only as a compatibility shim for the CLI. `une` / `uge` remain as
component references (`asci-vps-une-core-01` is a real container).

---

## 1. `kami-vps-1` — Oracle Cloud platform node ✅ LIVE

| Field | Value |
|---|---|
| Display name | `kami-VPS-1` (called "kami-VPS-asci" in hand-off messages) ⚠️ rename candidate |
| Provider | Oracle Cloud Infrastructure |
| Region / AD / FD | `uk-london-1` / AD-1 / FD-3 |
| Shape | `VM.Standard.A1.Flex` — **4 OCPU / 24 GB RAM** |
| CPU | 4× **Neoverse-N1**, `aarch64` |
| RAM | 23 Gi total · 1.2 Gi used · 22 Gi available |
| **Swap** | **none** ⚠️ (Hostinger box has 4 Gi — inconsistent) |
| Disk | `sda` 200 G → `sda1` 199 G ext4 `/` · `sda15` 99 M vfat `/boot/efi` · `sda16` 923 M ext4 `/boot` |
| Disk used | **8.7 G / 193 G (5%)** — 185 G free |
| Public IP | `132.145.57.78` ⚠️ **changed 2026-09-15 on rebuild** |
| Private IP | `10.0.0.76/24` (`enp0s6`) |
| **Tailscale** | **`100.90.39.36`** |
| Docker bridges | `docker0` 10.0.1.1/24 · `br-4a934f5d1072` 10.0.2.1/24 · `br-b1409e56c4a3` 10.0.3.1/24 |
| OS | Ubuntu **24.04.5** LTS (upgraded from 24.04.4 on 2026-09-15) |
| Kernel | `6.17.0-1020-oracle` |
| Uptime at audit | 1 h 48 m |
| SSH user | `ubuntu` |
| Auth | key-only ✅ `PasswordAuthentication no` (`60-cloudimg-settings.conf`) |
| Host key | `SHA256:ctjfO828VB8O6gBGd8nUXChZo4MMQftXfhLeEIta0DU` (ECDSA) |
| Sudo users | `ubuntu` |
| Failed SSH (24 h) | none |
| Packages pending | 0 |
| Zombies | 1 (benign) |
| Docker | 29.8.0, build 88096ef |

**Containers — 10, all healthy**

| Container | Image | Ports |
|---|---|---|
| `coolify` | `coollabsio/coolify:4.1.2` | 8000→8080, 8443, 9000 |
| `coolify-proxy` | `traefik:v3.6` | 80, 443 (tcp+udp), 8080 |
| `coolify-db` | `postgres:15-alpine` | 5432 |
| `coolify-redis` | `redis:7-alpine` | 6379 |
| `coolify-realtime` | `coollabsio/coolify-realtime:1.0.16` | 6001–6002 |
| `coolify-sentinel` | `coollabsio/sentinel:1.0.1` | — |
| `kami-vaultwarden` | `vaultwarden/server:latest` | 80 (internal) |
| `kami-postgres` | `pgvector/pgvector:pg16` | 5432 |
| `kami-redis` | `7aec734b2bb2` | 6379 |
| `portainer_agent` | `portainer/agent:latest` | 9001 |

**Listening ports**
`22` · `80` · `443` · `8000` · `8080` · `9001` · `6001` · `6002` · `111` ⚠️ · `127.0.0.53:53` ·
`127.0.0.54:53` · `100.90.39.36:42176`

⚠️ **Port 111 (`rpcbind`) is listening on 0.0.0.0.** Rarely needed on a web platform node.
Check whether `rpcbind` is required by anything before removing it; if not, remove it.

**State / actions**
- ⚠️ **REBOOT PENDING** since 2026-09-15 (`*** System restart required ***`).
- ✅ 45 updates applied; `autoremove` cleared `libfwupd2 libgusb2 libslirp0 slirp4netns`.
- ⬜ No swap configured — decide deliberately (add 2–4 Gi, or accept it).
- ⬜ DNS A records still need repointing to `132.145.57.78`.
- ⬜ Confirm the terminated `kami-helper` left no orphaned boot volume.
- 🧹 **A stray report exists at `/home/ubuntu/vps-audit-asci-vps-1-2026-09-15_023757.txt`** —
  it is mislabelled: it was generated on this host with `AUDIT_LABEL=asci-vps-1` by mistake.
  Its contents are kami-vps-1's. Delete or rename it so it cannot be mistaken later.
- Cost: compute £0; storage ~**£8.15/month** incl. VAT.

---

## 2. `asci-vps-1` — Hostinger edge + MCP node ✅ LIVE

| Field | Value |
|---|---|
| Hostname | `ASCi-VPS-1` (panel label "ASCI-VPS-1 \| core") |
| Provider | Hostinger |
| Plan | **KVM 4** — confirmed ✅ **upgraded from KVM 2**; live values match KVM 4 |
| CPU | 4× **AMD EPYC 9354P 32-Core** (BIOS `pc-i440fx-11.0 @ 2.0 GHz`), `x86_64` |
| RAM | 15 Gi total · 1.6 Gi used · 13 Gi available |
| **Swap** | **4.0 Gi** ✅ |
| Disk | `sda` 200 G → `sda1` 199 G ext4 `/` · `sda15` 106 M vfat `/boot/efi` · `sda16` 913 M ext4 `/boot` · `sr0` |
| Disk used | **87 G / 193 G (45%)** — 107 G free |
| Public IPv4 | `72.61.203.79/24` (`eth0`) ✅ confirmed |
| Public IPv6 | `2a02:4780:f:27::1/48` |
| **Tailscale** | interface present, **no IP assigned** ⚠️ (`tailscale0` has only a link-local address) |
| Docker bridges | `docker0` 172.17.0.1/16 · `br-2040aebd476a` 172.20/16 · `br-23f26676f766` 172.21/16 · `br-e5f55f08fda8` 172.27/16 · `br-0fe165886715` 172.29/16 |
| OS | Ubuntu **24.04.5** LTS |
| Kernel | `6.8.0-139-generic` |
| Uptime at audit | 11 h 37 m |
| SSH user | **`root`** |
| Ubuntu Pro / ESM | **enabled** ✅ |
| Sudo users | `ubuntu` |
| Failed SSH (24 h) | none |
| Packages pending | 0 (nginx security update applied 2026-09-15) |
| Docker | 29.8.0, build 88096ef |

**Containers — 13, all up ~12 h**

| Container | Image | Exposed | Role |
|---|---|---|---|
| `asci-vps-mcp-grok` | `python:3.11-slim` | — | MCP server |
| `asci-vps-mcp-github` | `python:3.11-slim` | — | MCP server |
| `asci-vps-mcp-xero` | `python:3.11-slim` | — | MCP server |
| `asci-vps-mcp-ukgov` | `python:3.11-slim` | — | MCP server |
| `asci-vps-mcp-google` | `python:3.11-slim` | — | MCP server |
| `asci-vps-moltbot` | `n8nio/n8n:latest` | **0.0.0.0:5678** ⚠️ | automation |
| `asci-vps-stalwart` | `stalwartlabs/stalwart:latest` | 25/465/993/995/4190/8080 | **mail server** |
| `asci-vps-postgres-mail` | `postgres:16-alpine` | 5432 | mail DB |
| `asci-vps-postgres-01` | `postgres:15-alpine` | 5432 | app DB |
| `asci-vps-vault-01` | `vaultwarden/server:latest` | `127.0.0.1:8181` | **2nd vault instance** |
| `asci-vps-une-core-01` | `node:20-alpine` | `127.0.0.1:3001` | une/uge core |
| `asci-vps-portainer-01` | `portainer/portainer-ce:2.39.0` | — | container UI |
| `factory-factory-gateway-1` | `nginx:1.29-alpine` | `127.0.0.1:8000` | internal gateway |

**Listening ports**
`22` · `80` · `443` · **`5678` (0.0.0.0)** ⚠️ · `20241` · `11434` (Ollama, localhost) ·
`127.0.0.1:3001` · `127.0.0.1:8000` · `127.0.0.1:8181` · `127.0.0.1:7878/7881` ·
`*:25` · `*:465` · `*:993` · `*:995` · `*:4190` · `*:8080` · `*:37789`

Mail ports (25/465/993/995/4190) are expected for Stalwart. `37789` and `20241` are
unidentified — confirm what they belong to.

### 🔴 SECURITY FINDING — password SSH is enabled

Three configs disagree:

```
/etc/ssh/sshd_config.d/50-cloud-init.conf:PasswordAuthentication yes
/etc/ssh/sshd_config.d/60-cloudimg-settings.conf:PasswordAuthentication no
/etc/ssh/sshd_config.d/99-ssg-ssh.conf:PasswordAuthentication yes
```

`sshd_config.d/*.conf` is included in **lexical order** and sshd uses the **first value it
obtains** for a keyword. `50-…` sorts before `60-…`, so **`PasswordAuthentication` resolves
to `yes`** — password login is live for **root** on a public IPv4.

The `99-ssg-ssh.conf` file suggests an SSG/CIS hardening profile was applied, but it is
being overridden by the earlier-sorted cloud-init file. The hardening did not take effect.

**Fix (SOP-09 / SOP-03):** set `PasswordAuthentication no` in a file that sorts *first*, e.g.
`/etc/ssh/sshd_config.d/00-merc-os-hardening.conf`, then `sshd -t && systemctl reload ssh`.
**Verify with `sudo sshd -T | grep passwordauthentication` → must print `no`.**
Keep a root shell open until the new session is proven.

### ⚠️ Second finding — n8n exposed on 0.0.0.0:5678

`asci-vps-moltbot` binds `0.0.0.0:5678`, reachable directly from the internet. Confirm it
has an owner account set and strong auth, and prefer putting it behind Caddy on 443 so it
is not serving plain HTTP on a raw port.

**State / actions**
- ✅ nginx security update applied (`1.24.0-2ubuntu7.18`).
- 🔴 Disable password SSH (above).
- ⬜ Confirm n8n authentication and whether 5678 should be public.
- ⬜ **Tailscale has no IP on this host** — `tailscale0` is up but unassigned. Either finish
  `tailscale up` or remove it.
- ⬜ Decide which Vaultwarden is canonical — there are now **two** (`kami-vaultwarden` on
  OCI, `asci-vps-vault-01` here). One vault, or a documented split.
- ⬜ Identify ports `37789` and `20241`.
- ⬜ Record host key fingerprint.
- ⬜ Check hPanel firewall (second layer, invisible from inside) and snapshots.
- ⬜ Note renewal date and price — Hostinger intro pricing ≠ renewal pricing.

---

## 3. `asci-vps-2` ⬜ NOT YET REACHED

| Field | Value |
|---|---|
| Provider | Hostinger — **in a separate account of its own** |
| Plan | ⬜ unknown |
| Public IP | ⬜ **UNKNOWN** |
| SSH user | ⬜ likely `root` |
| OS | ⬜ unknown |

**Why it's unreachable from here:** the OCI Cloud Shell is bound to the OCI tenancy and
cannot enumerate another provider's account. Finding it means logging into that other
Hostinger account (hPanel → VPS → Overview shows the public IP) or connecting directly to
its IP from a machine holding its key.

---

## 4. `asci-vps-3` ⬜ NOT YET CONFIRMED TO EXIST

| Field | Value |
|---|---|
| Provider | ⬜ unknown |
| Plan | ⬜ unknown |
| Public IP | ⬜ **UNKNOWN** |
| SSH user | ⬜ unknown |

Do not add this host to monitoring, Terminus or DNS until confirmed. A placeholder entry is
fine; an invented IP is not.

---

## 5. Retired / transient

| Name | Fate |
|---|---|
| `kami-helper` | OCI `VM.Standard.E2.1.Micro`, 1/1, AD-1/FD-3, `132.145.60.213`. Temporary key-injection helper. **Terminated 2026-09-15.** Verify its boot volume was released. |
| `kami-VPS-1` (original) | Created 2026-05-05, **terminated 2026-09-14** (against the "stop, never terminate" rule). Its 200 GB boot volume survived and now backs the current instance. Old IP `130.162.187.135` is gone. |

---

## 6. Fleet-wide facts

| | Value |
|---|---|
| Hosts known | 4 (2 live & audited, 2 undiscovered) |
| Architectures | `aarch64` (kami-vps-1) and `x86_64` (asci-vps-1) — **binaries are not interchangeable** |
| Default SSH users | `ubuntu` on OCI, `root` on Hostinger ⚠️ |
| Docker | 29.8.0 on both |
| Swap | 0 Gi on OCI, 4 Gi on Hostinger ⚠️ inconsistent |
| Disk used | 8.7 G (5%) on OCI · 87 G (45%) on Hostinger |
| Vaultwarden | **two instances** — decide which is canonical |
| MCP gateway | **5 MCP containers on asci-vps-1**: grok, github, xero, ukgov, google |
| Naming scheme | `MERC-OS.<env>.<node>.<class>.<item>` — see `vault-credentials.md` |
| Machine inventory | `fleet/inventory.conf` (read by `scripts/merc`) |
