# VPS Fleet Runbook

Single reference for every server in the estate. Originally written for `kami-VPS-1` on
Oracle Cloud, then extended because the fleet also includes Hostinger KVM machines, which
have **different recovery paths, different cost model and different failure modes**.

Read this before touching any server. It contains no keys, no passwords and no OCIDs.

---

## 1. Fleet inventory

**The authoritative inventory now lives in `docs/SOT-fleet-inventory.md`** (human) and
`fleet/inventory.conf` (machine, read by `scripts/grid-os`). This file keeps only the
summary — two places claiming to be the source of truth is how they drift apart.

| # | Name | Provider / plan | Public IP | OS | SSH user | Status |
|---|------|-----------------|-----------|----|----------|--------|
| 1 | `kami-VPS-1` | Oracle Cloud — `VM.Standard.A1.Flex` 4 OCPU / 24 GB, 200 GB | `132.145.57.78` | Ubuntu 24.04.5 aarch64 | `ubuntu` | **LIVE**, verified 2026-09-15. ⚠️ reboot pending |
| 2 | `asci-vps-1` | Hostinger **KVM 4** — 4 vCPU / 16 GB / 200 GB NVMe | `72.61.203.79` ✅ confirmed | Ubuntu 24.04.5 x86_64 | **`root`** | **LIVE**, verified 2026-09-15. ⚠️ 2 security updates pending |
| 3 | `asci-vps-2` | Hostinger **separate account** | ⬜ UNKNOWN | ⬜ | `root` (likely) | ⬜ not reached |
| 4 | `asci-vps-3` | ⬜ | ⬜ UNKNOWN | ⬜ | ⬜ | ⬜ existence unconfirmed |

⬜ = a real gap. Fill it in only when verified; never guess an IP and act on it.

Quick view from the CLI:

```bash
./scripts/grid-os hosts
./scripts/grid-os status all
```

> **Why #3 is different:** `asci-vps-2` was set up in a separate Hostinger account of its
> own. The OCI Cloud Shell used for #1 is locked to the OCI tenancy and cannot see it.
> Auditing it means logging into that other account (or connecting straight to its IP from
> a machine that holds its key).

---

## 1b. Document map

| Need | Document |
|---|---|
| Full specs per host | `SOT-fleet-inventory.md` |
| Step-by-step procedures | `SOP-runbook.md` |
| Terminus, persistent logins, tmux | `terminus-and-ssh-access.md` |
| Vaultwarden layout, naming, placeholders | `vault-credentials.md` |
| Mistakes made and lessons learned | `learning-notes.md` |
| OCI-only deep recovery detail | `kami-vps1-ssh-access-recovery.md` |
| OCI billing analysis | `kami-vps1-cost-and-capacity.md` |

---

## 2. Hostinger KVM 4 — reference

Confirmed across several independent 2025–2026 reviews of the plan:

- **4 vCPU** (AMD EPYC), **16 GB RAM**, **200 GB NVMe**, generous monthly bandwidth
  (sources quote between 4 TB and 16 TB depending on billing term — verify on your invoice)
- Full root access, dedicated IPv4, KVM virtualisation (true isolation, not containers)
- **Browser terminal in hPanel** — see §3, this is the single most important difference
- **Provider-level firewall in hPanel** — a second firewall layer *outside* the guest
- Automated backups/snapshots available (weekly standard, daily on some plans)
- Intro pricing is **not** the renewal price. Note the renewal date and amount.

### Things that behave differently from Oracle Cloud

| | Oracle Cloud | Hostinger KVM |
|---|---|---|
| Console access without a key | Serial console — **effectively unusable** (GRUB hidden, no console password) | **Browser terminal in hPanel — works, use it** |
| Losing the SSH key | Multi-step: boot-volume detach, helper VM, key injection | Log into hPanel, open browser terminal, paste the key in |
| Billing risk | Orphaned boot volumes keep billing after termination | Renewal price jump; unused snapshots |
| Capacity | Always Free A1 shapes can be **unavailable** → rebuild may not get the same size back | Plan is fixed and paid for; resources always available |
| Firewall | Security Lists / NSG + guest firewall | hPanel firewall **+** guest firewall |
| Backups | Manual volume backups | Built-in snapshots in hPanel |

**Consequence:** the elaborate boot-volume recovery that was needed for `kami-VPS-1` is
**not** the playbook for a Hostinger box. On Hostinger, use the browser terminal.

---

## 3. Access paths, in order of preference

1. **SSH with a key** — normal path on every machine.
2. **Hostinger hPanel browser terminal** — the recovery path for #2 and #3. It does not
   depend on the network, the SSH key, or the guest firewall. If SSH is ever locked out on a
   Hostinger box, this is the answer; there is no equivalent escape hatch on OCI.
3. **Oracle Cloud boot-volume rebuild** — the OCI-only last resort. Documented in
   `kami-vps1-ssh-access-recovery.md`. Slow and capacity-dependent.

---

## 4. Running a health audit

The audit is one script that runs on any Linux VPS and produces one comparable report.
It is **read-only**: it restarts nothing, installs nothing, changes no firewall, and reads no
`.env`, credentials or private keys.

### From a machine that already has SSH access

```bash
# 1. fetch the audit script
curl -fsSL -o vps-healthcheck-readonly.sh \
  https://raw.githubusercontent.com/GoldenLion-Thai/Arena.ai-/arena/01a0a1c6-arena-ai/scripts/vps-healthcheck-readonly.sh

# 2. copy it to the target (repeat for each server)
scp -i ~/.ssh/kami_vps vps-healthcheck-readonly.sh ubuntu@132.145.57.78:~

# 3. run it with a label so reports from different boxes don't blur together
ssh ubuntu@132.145.57.78 'chmod 700 ~/vps-healthcheck-readonly.sh'
ssh -t ubuntu@132.145.57.78 'AUDIT_LABEL=kami-VPS-1 ~/vps-healthcheck-readonly.sh'
```

For a Hostinger box, substitute its IP and user:

```bash
scp vps-healthcheck-readonly.sh root@<ASCI_IP>:~
ssh -t root@<ASCI_IP> 'AUDIT_LABEL=asci-vps-1 AUDIT_PROVIDER="Hostinger KVM 4" ~/vps-healthcheck-readonly.sh'
```

### If you cannot get the file across

On a Hostinger box, open the hPanel browser terminal and paste:

```bash
curl -fsSL -o vps-healthcheck-readonly.sh \
  https://raw.githubusercontent.com/GoldenLion-Thai/Arena.ai-/arena/01a0a1c6-arena-ai/scripts/vps-healthcheck-readonly.sh \
  && chmod 700 vps-healthcheck-readonly.sh \
  && AUDIT_LABEL=asci-vps-1 ./vps-healthcheck-readonly.sh
```

---

## 5. What the audit covers (15 sections)

1. Identity — OS, kernel, init, timezone
2. CPU, memory, swap, load, top processes
3. Disk, inodes, block devices, largest directories
4. Pending package updates (counts only — simulated, installs nothing)
5. Core services — ssh, docker, fail2ban, firewall daemon, tailscale, nginx, caddy, db
6. Firewall rules **+ a reminder that a second provider-level firewall exists**
7. Docker — engine, resource use, containers, unhealthy/exited, networks, volumes
8. Listening ports (process detail redacted)
9. Platform indicators — Coolify / Traefik / Portainer / Vaultwarden / databases
10. Directory inventory — names and sizes, never contents
11. Backup indicators **+ note that provider snapshots are invisible from inside**
12. SSH posture — `PasswordAuthentication`, `PermitRootLogin`, key **counts**, failed logins
13. Instability — failed units, OOM kills, filesystems over 85%, zombies
14. Local loopback HTTP health checks
15. Provider-specific panel checklist (tick these off by hand)

---

## 6. Standard baseline every server should meet

| Control | Target | Why |
|---|---|---|
| Network password SSH | **disabled** | The only thing standing between a public IP and a botnet |
| Root SSH login | **disabled** | Use a normal user + sudo |
| Key-based auth | enabled | — |
| Host firewall | on, default-deny inbound | Two layers on Hostinger: hPanel **and** guest |
| Automatic security updates | on, or a weekly patch habit | 45 pending updates with 1 security fix was the state on #1 |
| Backups | automated **and** a restore tested | An untested backup is a rumour |
| Offline copy of the SSH key | in the password vault | Losing the key is what caused the week-long lockout |
| DNS A records | point at the **current** IP | It changed when #1 was rebuilt |
| Budget alerts | alert-only, never auto-stop | Auto-stop doesn't clear volume charges |

---

## 7. Known open items

**Urgent (do these first)**

- [ ] **Reboot `kami-vps-1`** — `*** System restart required ***` since 2026-09-15 (SOP-04)
- [ ] **2 security updates pending on `asci-vps-1`** (SOP-03)

**Access and inventory**

- [x] `asci-vps-1` IP confirmed — `72.61.203.79`, hostname `ASCi-VPS-1`, user `root`
- [ ] Confirm SSH auth method for `asci-vps-1` — key or password
- [ ] Record `asci-vps-1` host key fingerprint
- [ ] Locate `asci-vps-2` in its own Hostinger account and record its IP
- [ ] Confirm whether `asci-vps-3` exists at all
- [ ] Run the full audit on `asci-vps-1`, then `-2` and `-3`
- [ ] Add all four hosts to Terminus (SOP-08)

**Platform and cost**

- [ ] Check for an orphaned boot volume left by the terminated `kami-helper` (SOP-10)
- [ ] Update DNS A records to the new `132.145.57.78`
- [ ] Confirm hPanel firewall rules and snapshots on `asci-vps-1`
- [ ] Note Hostinger renewal date and price for `asci-vps-1`
- [ ] Set a local console-recovery password on `kami-vps-1` (`sudo passwd ubuntu`)

**Credentials**

- [ ] Create the Vaultwarden folder structure and items per `vault-credentials.md`
- [ ] Store the `kami_vps` private key as a Secure Note, then delete loose copies
- [ ] Decide where the vault's own master password lives offline

**Optional / later**

- [ ] Install `tmux` on both live hosts and standardise on it
- [ ] Consider Mosh only if roaming between networks becomes normal
- [ ] Evaluate shrinking the 200 GB OCI volume now that real usage is known (8.7 GB) —
      boot volumes cannot be shrunk in place, so this is a build-and-migrate project,
      not a quick win
