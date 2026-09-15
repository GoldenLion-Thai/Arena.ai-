# SOT — Fleet Inventory (Single Source of Truth)

Everything here is **observed**, not assumed. Anything marked `UNKNOWN` or `⬜` is a real
gap, not an oversight to be glossed over. Update this file the moment a fact changes —
it is the document every other runbook defers to.

**No secrets in this file.** Keys, passwords and tokens belong in Vaultwarden
(`docs/vault-credentials.md`). Key *paths* are recorded here; key *contents* never.

Last updated: 2026-09-15

---

## 1. `kami-vps-1` — Oracle Cloud platform node ✅ LIVE

| Field | Value |
|---|---|
| Display name | `kami-VPS-1` (called "kami-VPS-asci" in hand-off messages) |
| Provider | Oracle Cloud Infrastructure |
| Region / AD / FD | `uk-london-1` / AD-1 / FD-3 |
| Shape | `VM.Standard.A1.Flex` — **4 OCPU / 24 GB RAM** |
| CPU | 3.0 GHz Ampere® Altra™, `aarch64` |
| Boot volume | 200 GB (193 GiB usable) — **8.7 GB used (4.5%)** |
| Public IP | `132.145.57.78` ⚠️ **changed 2026-09-15 on rebuild** |
| Private IP | `10.0.0.76` (`enp0s6`) |
| OS | Ubuntu **24.04.5** LTS (upgraded from 24.04.4 on 2026-09-15) |
| Kernel | `6.17.0-1020-oracle` |
| SSH user | `ubuntu` |
| Auth | key-only, `kami_vps` RSA. `PasswordAuthentication no` |
| Host key | `SHA256:ctjfO828VB8O6gBGd8nUXChZo4MMQftXfhLeEIta0DU` (ECDSA) — changed on rebuild |
| Repos | docker, tailscale |
| Zombie processes | 1 (benign) |

**Containers (all healthy as of 2026-09-15 00:55)**

| Container | Role | Ports |
|---|---|---|
| `coolify` | platform | 8000, 8443, 9000, 8080 |
| `coolify-proxy` | edge proxy | 80, 443 (tcp+udp), 8080 |
| `coolify-db` | Postgres | 5432 |
| `coolify-redis` | cache | 6379 |
| `coolify-realtime` | websockets | 6001–6002 |
| `coolify-sentinel` | monitoring | — |
| `kami-vaultwarden` | password vault | 80 |
| `kami-postgres` | app database | 5432 |
| `kami-redis` | app cache | 6379 |
| `portainer_agent` | container UI | 9001 |

**State / actions**
- ⚠️ **REBOOT PENDING** — `*** System restart required ***` after the 2026-09-15 upgrade.
- ✅ 45 updates applied, 0 remaining. `autoremove` cleared `libfwupd2 libgusb2 libslirp0 slirp4netns`.
- ⬜ DNS A records still need repointing from the old IP to `132.145.57.78`.
- ⬜ Confirm the terminated `kami-helper` left no orphaned boot volume.
- Cost: compute £0; storage ~**£8.15/month** incl. VAT. Not free-tier-free — the invoices prove it.

---

## 2. `asci-vps-1` — Hostinger edge node ✅ LIVE

| Field | Value |
|---|---|
| Hostname | `ASCi-VPS-1` (panel label "ASCI-VPS-1 \| core") |
| Provider | Hostinger |
| Plan | **KVM 4** — 4 vCPU AMD EPYC / 16 GB RAM / 200 GB NVMe |
| Architecture | `x86_64` |
| Public IP | `72.61.203.79` ✅ verified 2026-09-15 |
| IPv6 | `2a02:4780:f:27::1` |
| Interface | `eth0` |
| OS | Ubuntu **24.04.5** LTS |
| Kernel | `6.8.0-139-generic` |
| SSH user | **`root`** ⚠️ (Hostinger default — differs from the OCI box) |
| Auth | ⬜ not yet confirmed (key or password) |
| Disk | 192.69 GB — **44.9% used (~86.5 GB)** |
| Memory / load | 9% / 0.43 / 207 processes |
| Ubuntu Pro / ESM | **enabled** |
| Host key | ⬜ not yet recorded |

**Installed stack (inferred from apt sources — confirm with the audit)**

| Component | Evidence |
|---|---|
| **Caddy** | `dl.cloudsmith.io/public/caddy/stable` repo present |
| **Docker** | `download.docker.com/linux/ubuntu` repo present |
| **Node.js 20** | `deb.nodesource.com/node_20.x` repo present |
| **Tailscale** | `pkgs.tailscale.com` repo present |
| Mirrors | `archive.ubuntu.com`, `mirrors.ukfast.co.uk`, ESM apps+infra |

**State / actions**
- ⚠️ **2 pending updates, both security updates.**
- ⬜ Run the full audit to confirm which services actually run.
- ⬜ Record the SSH auth method and host key.
- ⬜ Confirm hPanel firewall rules (a **second** firewall layer the guest cannot see).
- ⬜ Confirm automated snapshots are on in hPanel.
- ⬜ Check renewal price and date — Hostinger intro pricing ≠ renewal pricing.

---

## 3. `asci-vps-2` ⬜ NOT YET REACHED

| Field | Value |
|---|---|
| Provider | Hostinger — **in a separate account of its own** |
| Plan | ⬜ unknown |
| Public IP | ⬜ **UNKNOWN** |
| SSH user | ⬜ likely `root` |
| Auth | ⬜ unknown |
| OS | ⬜ unknown |

**Why it's unreachable from here:** the OCI Cloud Shell used for `kami-vps-1` is bound to
the OCI tenancy and cannot enumerate another provider's account. Finding this host means
logging into that other Hostinger account, or connecting directly to its IP from a machine
holding its key.

**To discover it:** Hostinger hPanel → VPS → the server's Overview tab shows the public IP.

---

## 4. `asci-vps-3` ⬜ NOT YET CONFIRMED TO EXIST

| Field | Value |
|---|---|
| Provider | ⬜ unknown |
| Plan | ⬜ unknown |
| Public IP | ⬜ **UNKNOWN** |
| SSH user | ⬜ unknown |

Do not add this host to monitoring, Terminus or DNS until it has been confirmed. A
placeholder entry is fine; an invented IP is not.

---

## 5. Retired / transient

| Name | Fate |
|---|---|
| `kami-helper` | Hostinger? No — OCI `VM.Standard.E2.1.Micro`, 1/1, AD-1/FD-3, `132.145.60.213`. Temporary key-injection helper. **Terminated 2026-09-15.** Verify its boot volume was released. |
| `kami-VPS-1` (original) | Created 2026-05-05, **terminated 2026-09-14** (against the "stop, never terminate" rule). Its 200 GB boot volume survived and now backs the current instance. Old IP `130.162.187.135` is gone. |

---

## 6. Fleet-wide facts

| | Value |
|---|---|
| Hosts known | 4 (2 live & verified, 2 undiscovered) |
| Architectures | `aarch64` (kami-vps-1), `x86_64` (asci-vps-1) — **not interchangeable for binaries** |
| Default SSH users | `ubuntu` on OCI, `root` on Hostinger ⚠️ |
| Shared tooling | Docker, Tailscale on both known hosts |
| Naming scheme | `GRiD-OS.<env>.<node>.<class>.<item>` — see `vault-credentials.md` |
| Machine inventory | `fleet/inventory.conf` (read by `scripts/grid-os`) |
