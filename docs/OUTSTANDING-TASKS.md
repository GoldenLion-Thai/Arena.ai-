# Outstanding tasks and naming decision

Prioritised. `🔴 critical` first — those are live exposures, not housekeeping.

---

## 1. Naming — needs your confirmation

### The problem

The OCI box is called three different things: `kami-VPS-1` (OCI display name),
`kami-vps-1` (Linux hostname), and `kami-VPS-asci` (hand-off messages). The Hostinger box
is `ASCi-VPS-1`. That drift is already causing mistakes — an audit run on `kami-vps-1` was
saved under the label `asci-vps-1`.

### Recommendation: decouple `id` from `hostname`

- **`id`** — stable, lowercase, used in `fleet/inventory.conf`, `~/.ssh/config`, the Vaultwarden
  naming scheme, and DNS. Change it deliberately, all at once.
- **`hostname`** — whatever the machine calls itself. Leave it alone for now; changing it
  on a live box touches Coolify, Tailscale machine names, Docker, logs and TLS SANs.

### Proposed canonical ids

| Current id | Proposed id | Linux hostname (unchanged) | Rationale |
|---|---|---|---|
| `kami-vps-1` | **`asci-vps-oci`** | `kami-vps-1` | Same family as the others, but states the provider — it is the only non-Hostinger box |
| `asci-vps-1` | `asci-vps-1` ✅ | `ASCi-VPS-1` | No change |
| `asci-vps-2` | `asci-vps-2` ✅ | unknown | No change |
| `asci-vps-3` | `asci-vps-3` ✅ | unknown | No change |

### Alternatives if you prefer

| Option | Shape | Trade-off |
|---|---|---|
| **A (recommended)** | `asci-vps-oci`, `asci-vps-1`, `-2`, `-3` | Provider is obvious; no renumbering |
| **B** | keep `kami-vps-1`, lowercase everything | Least churn, but the odd-one-out name remains |
| **C** | renumber by role: `asci-vps-1…4` | Tidiest, but `-1` is taken, so four hosts become `-2,-3,-4` + a new `-1` — maximum confusion for minimum gain |

### What actually changes if we apply option A

Cheap and reversible — all inside this repo:
- `fleet/inventory.conf` — the `id` column
- `docs/SOT-fleet-inventory.md`, `SOP-runbook.md`, `vault-credentials.md`, `learning-notes.md`
- `~/.ssh/config` blocks (`merc sshconfig`)
- Vaultwarden item names (`MERC-OS.prod.<node>.…`)
- Terminus host labels

What does **not** change: the Linux hostname, DNS, Coolify, container names, Tailscale.
Nothing on the servers themselves is touched.

**Reply with A, B or C and I'll apply it.**

---

## 2. 🔴 Critical — live exposure

| # | Task | Host | Why |
|---|---|---|---|
| 1 | **Disable password SSH** | `asci-vps-1` | Three config files disagree and `50-cloud-init.conf` wins, so `PasswordAuthentication yes` is live for **root** on a public IP. The SSG hardening in `99-ssg-ssh.conf` is being overridden and never took effect. |
| 2 | **Reboot** | `kami-vps-1` | `*** System restart required ***` since 2026-09-15 — kernel update not yet active. |
| 3 | **Verify n8n auth** | `asci-vps-1` | `asci-vps-moltbot` binds `0.0.0.0:5678`. If no owner account is set, anyone reaching that port can claim the instance. Prefer putting it behind Caddy on 443. |

**Fix for #1** — create a file that sorts *first*:

```
/etc/ssh/sshd_config.d/00-merc-os-hardening.conf
------------------------------------------------
PasswordAuthentication no
PermitRootLogin prohibit-password
```

Then `sudo sshd -t && sudo systemctl reload ssh`, and **verify**:
`sudo sshd -T | grep -Ei '^(passwordauthentication|permitrootlogin)'` → must print
`passwordauthentication no`. Keep your current root shell open until a new session is proven.

---

## 3. 🟠 High — this week

| # | Task | Host |
|---|---|---|
| 4 | **Re-run the full audit** — it was downloaded but Ctrl+C'd before finishing | `asci-vps-1` |
| 5 | Delete or rename the mislabelled report `/home/ubuntu/vps-audit-asci-vps-1-2026-09-15_023757.txt` (it holds kami-vps-1 data) | `kami-vps-1` |
| 6 | Fix Tailscale — `tailscale0` is up but has **no IP assigned** | `asci-vps-1` |
| 7 | Decide which Vaultwarden is canonical — there are now **two** | both |
| 8 | Update DNS A records to the new `132.145.57.78` | `kami-vps-1` |
| 9 | Check for an orphaned boot volume left by the terminated `kami-helper` | OCI |
| 10 | Verify backups/snapshots exist **at the provider** (invisible from inside) | both |
| 11 | Review hPanel firewall rules — the second layer the guest cannot see | `asci-vps-1` |
| 12 | Store both SSH private keys in Vaultwarden as **Secure Notes**, then delete loose copies | local |
| 13 | Note Hostinger renewal date and price (intro ≠ renewal) | `asci-vps-1` |
| 14 | Set a local console-recovery password: `sudo passwd ubuntu` | `kami-vps-1` |

---

## 4. 🟡 Medium — inventory gaps and hygiene

| # | Task |
|---|---|
| 15 | **Find `asci-vps-2`** — separate Hostinger account; hPanel → VPS → Overview shows its IP |
| 16 | **Confirm `asci-vps-3` exists** before adding it to anything |
| 17 | Record the `asci-vps-1` SSH host key fingerprint |
| 18 | Identify listening ports `37789` and `20241` on `asci-vps-1` |
| 19 | Decide on swap: `kami-vps-1` has **0 Gi**, `asci-vps-1` has 4 Gi — make it consistent deliberately |
| 20 | Check whether `rpcbind` on port 111 is needed on `kami-vps-1`; remove it if not |
| 21 | Consider enabling ESM on `kami-vps-1` (it is enabled on `asci-vps-1`) |
| 22 | Add all four hosts to Terminus and install the generated `~/.ssh/config` |
| 23 | Run the collection prompt (`docs/prompts/collect-vps-design.md`) on both live hosts |
| 24 | Confirm the SSH auth method for `asci-vps-1`; upload its key to Cloud Shell as `~/.ssh/asci_vps_1` so `merc audit` works unaided |

---

## 5. 🟢 Later / optional

| # | Task |
|---|---|
| 25 | Install `tmux` on both hosts and standardise session handling |
| 26 | Consider Mosh — only if roaming between networks becomes normal (needs UDP 60000–61000) |
| 27 | Evaluate shrinking the OCI 200 GB volume now real usage is known (**8.7 G**). Boot volumes cannot be shrunk in place — this is build-new-and-migrate, not a quick win |
| 28 | Document the 5 MCP servers (grok, github, xero, ukgov, google) — purpose, auth, how they are reached |
| 29 | Document the Stalwart mail stack: domains, SPF/DKIM/DMARC, data location |
| 30 | Quarterly: pick one credential from the vault and actually use it. Untested credentials rot |

---

## 6. Immediate next commands

On `asci-vps-1` (the script is already downloaded and executable there):

```bash
AUDIT_LABEL=asci-vps-1 AUDIT_PROVIDER="Hostinger KVM 4" ./vps-healthcheck-readonly.sh
```

On `kami-vps-1`:

```bash
rm -f ~/vps-audit-asci-vps-1-2026-09-15_023757.txt   # mislabelled, it's this host's data
AUDIT_LABEL=kami-vps-1 ./vps-healthcheck-readonly.sh
```
