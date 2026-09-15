# Standard Operating Procedures

Numbered, repeatable procedures. Each states when to use it, the exact steps, and how to
know it worked. Keep them short enough to follow at 3am.

Conventions: commands assume you are in the repo root and `scripts/merc` is on the
PATH or called as `./scripts/merc`.

---

## SOP-01 — Connect to a host

**When:** any time you need a shell.

```bash
./scripts/merc status all        # is it actually reachable?
./scripts/merc connect <id>      # uses the recorded user, IP and key
```

**It worked when** the prompt hostname matches the `label` in `merc hosts`.

**If it fails:**

| Symptom | Cause | Fix |
|---|---|---|
| `Permission denied (publickey)` | wrong user | OCI is `ubuntu`, Hostinger is `root` |
| `Permission denied (publickey)` | wrong/missing key | check `IdentityFile` path exists |
| `Connection timed out` | provider firewall or host down | SOP-06 |
| `Host key verification failed` | host rebuilt | remove the stale line: `ssh-keygen -R <IP>` |

---

## SOP-02 — Run a health audit

**When:** before any change; after any incident; monthly as routine.

```bash
./scripts/merc audit <id>
# or
./scripts/merc audit all
```

Reports land in `reports/`. For a host the CLI cannot reach (unknown key, password auth):

```bash
curl -fsSL -o vps-healthcheck-readonly.sh \
  https://raw.githubusercontent.com/GoldenLion-Thai/Arena.ai-/arena/01a0a1c6-arena-ai/scripts/vps-healthcheck-readonly.sh \
  && chmod 700 vps-healthcheck-readonly.sh \
  && AUDIT_LABEL=<id> ./vps-healthcheck-readonly.sh
```

**It worked when** 15 sections plus the provider checklist are present and the report
ends with `END OF AUDIT`.

**Read, in this order:** §3 disk · §4 pending updates · §7 Docker (unhealthy/exited) ·
§12 SSH posture · §13 instability · §15 provider checklist.

---

## SOP-03 — Patch a host

**When:** the audit shows pending updates, or monthly.

```bash
sudo apt update
sudo apt upgrade -y
sudo apt autoremove -y
```

Type these. Do not paste — bracketed paste prefixes them with `^[[200~` and the shell
reports `sudo: command not found`.

**It worked when** the MOTD says `0 updates can be applied immediately.`

**Then:** look for `*** System restart required ***` at login. If present, SOP-04.

**Sequencing for a fleet:** patch `asci-vps-1` (edge) and `kami-vps-1` (platform) on
different days. Never patch every node at once.

---

## SOP-04 — Reboot safely

**When:** `*** System restart required ***` is showing, or a kernel update landed.

1. Record what is running: `docker ps --format 'table {{.Names}}\t{{.Status}}' > ~/pre-reboot.txt`
2. Reboot: `sudo reboot`
3. Wait ~60s, reconnect.
4. Compare: `docker ps --format 'table {{.Names}}\t{{.Status}}' > ~/post-reboot.txt && diff ~/pre-reboot.txt ~/post-reboot.txt`
5. Re-run the audit.

**It worked when** every container that was `Up` before is `Up` again.

⚠️ **Outstanding on `kami-vps-1`:** a reboot has been pending since 2026-09-15.

---

## SOP-05 — Recover SSH access to an OCI host (`kami-vps-1`)

**When:** key lost or `Permission denied` with no other route.

Preferred, if the key still exists anywhere: copy the public key to the instance metadata
on a **new** launch (cloud-init injects it — this is what actually worked).

If the instance was terminated and only the volume survives:

```bash
oci compute instance launch \
  --compartment-id "<tenancy OCID>" \
  --availability-domain "CqyW:UK-LONDON-1-AD-1" \
  --display-name "kami-VPS-1" \
  --shape "VM.Standard.A1.Flex" \
  --shape-config '{"ocpus":4,"memoryInGBs":24}' \
  --source-details '{"sourceType":"bootVolume","bootVolumeId":"<volume OCID>"}' \
  --subnet-id "<subnet OCID>" \
  --ssh-authorized-keys-file ~/.ssh/kami_vps.pub \
  --assign-public-ip true
```

Full detail and the helper-VM fallback: `kami-vps1-ssh-access-recovery.md`.

**Constraints:** must be an **A1.Flex** shape — the volume is `aarch64` and x86 cannot boot
it. The new instance gets a **new public IP**, so update DNS afterwards (SOP-08 step 5).

---

## SOP-06 — Recover SSH access to a Hostinger host

**When:** locked out of `asci-vps-1`, `-2` or `-3`.

1. Log into **hPanel** for the account that owns the host.
2. VPS → the server → **Browser terminal**. This bypasses SSH, keys and both firewalls.
3. Fix the cause:
   ```bash
   mkdir -p ~/.ssh && chmod 700 ~/.ssh
   echo '<public key text>' >> ~/.ssh/authorized_keys
   chmod 600 ~/.ssh/authorized_keys
   ```
4. If it is a firewall issue instead, check **hPanel → Firewall** as well as `ufw` inside
   the guest — they are separate layers and an audit sees only the guest one.

**It worked when** `ssh <id>` connects without a password.

This is dramatically easier than SOP-05. Two minutes versus several hours.

---

## SOP-07 — Verify backups

**When:** monthly. A backup you have not restore-tested is a rumour.

**Inside the guest:**
```bash
systemctl list-timers --all | grep -Ei 'backup|restic|borg|rclone|pg_dump'
```

**At the provider (invisible from inside):**
- Hostinger: hPanel → VPS → **Backups / Snapshots** — confirm a recent restore point exists.
- OCI: `oci bv boot-volume-backup list --compartment-id "<tenancy OCID>"`

**Then actually test one:** restore to a throwaway instance and confirm the data is
readable. Record the date and result in `docs/SOT-fleet-inventory.md`.

---

## SOP-08 — Onboard a new host

1. Get the facts: provider, plan, public IP, SSH user, OS, architecture (`uname -m`).
2. Add a row to `fleet/inventory.conf`. Use `UNKNOWN` rather than a guess.
3. Add the matching section to `docs/SOT-fleet-inventory.md`.
4. Add the host to Terminus (see `terminus-and-ssh-access.md`) and regenerate config:
   `./scripts/merc sshconfig >> ~/.ssh/config`
5. Update DNS A records if the IP changed.
6. Create its Vaultwarden entries using `MERC-OS.<env>.<node>.<class>.<item>`.
7. Run SOP-02 and paste the findings into the SOT.
8. Baseline it against §6 of `vps-fleet-runbook.md`.

---

## SOP-09 — Rotate an SSH key

1. Generate: `ssh-keygen -t ed25519 -f ~/.ssh/<name> -C "<node>-$(date +%Y%m)"`
2. Add the **new public** key to the host *before* removing the old one:
   `ssh-copy-id -i ~/.ssh/<name>.pub <user>@<ip>`
3. **Verify a new session works** with the new key before going further.
4. Remove the old public key from `~/.ssh/authorized_keys` on the host.
5. Update `fleet/inventory.conf`, Terminus, and the Vaultwarden entry.
6. Revoke the old key in Vaultwarden (move it to `05-Recovery`, do not delete immediately).

**Never** remove the old key before the new one is proven. That is how people get locked
out of machines they own.

---

## SOP-10 — Monthly cost and orphan check

**OCI:**
```bash
bash scripts/oci-cost-audit.sh
oci bv boot-volume list --compartment-id "<tenancy OCID>" \
  --query 'data[*].{"Name":"display-name","GB":"size-in-gbs","State":"lifecycle-state"}'
```

You expect exactly **one** volume. Any unattached extra is an orphan billing every month —
delete it.

**Hostinger:** check renewal dates and amounts. Intro pricing is not renewal pricing.

**Alert-only budgets, never automatic stop/terminate** — stopping a VM does not clear
volume charges anyway, so an auto-action saves nothing and can cause an outage.

---

## Change log for this file

| Date | Change |
|---|---|
| 2026-09-15 | Initial ten SOPs. |
