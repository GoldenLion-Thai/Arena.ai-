# KAMi-VPS-1 — SSH Access Recovery (corrected runbook)

**Instance:** `kami-VPS-1` · **Region:** `uk-london-1` · **AD-1 / FD-3`
**Public IP:** `130.162.187.135` · **Private IP:** `10.0.0.62` · **Username:** `ubuntu`
**Image:** `Canonical-Ubuntu-24.04-aarch64-2026.03.31-0` · **Shape:** `VM.Standard.A1.Flex` (4 OCPU / 24 GB)
**Boot volume:** `kami-VPS-1 (Boot Volume)`, 200 GB

```
Instance OCID : <redacted — kept in ~/.kami-recovery/env, not in this repo>
Boot vol OCID : <redacted — kept in ~/.kami-recovery/env, not in this repo>
```

Status: instance is **Running**, CPU/memory metrics show ~0% — consistent with a live-but-quiet node.
SSH with `~/.ssh/kami_vps` returns `Permission denied (publickey)`. That key was generated **13 Sep 2026**
in Cloud Shell; the instance was **launched 5 May 2026** with a *different* key. Your key was never on the
server — that is the whole problem, and it is fixable.

---

## 1. Answering your last question first

> "Is it these? …where do I launch the serial stream?"

Yes — you found the right control. It is:

```
Compute > Instances > kami-VPS-1 > (OS Management tab, scroll down)
Console connection  →  Launch Cloud Shell connection
```

**But stop there. Do not spend another attempt on it.** On your instance the serial-console/GRUB route
cannot work, for two independent reasons:

1. **Stock Ubuntu cloud images hide the GRUB menu.** OCI/Canonical Ubuntu images ship
   `/etc/default/grub.d/50-cloudimg-settings.cfg` with `GRUB_TIMEOUT=0` and `GRUB_TIMEOUT_STYLE=hidden`.
   There is no menu to interrupt — tapping Up Arrow / Esc / Shift does nothing, because the timeout is
   zero, not "hidden but interruptible". OCI admins hit this exact wall on Ubuntu instances: the GRUB2
   menu is not shown via serial console, SSH, VNC or Cloud Shell
   ([reference](https://medium.com/@hiteshgondalia/oci-compute-vm-console-connection-to-access-the-ubuntu-instance-in-single-user-mode-533e280b109f)).
   You cannot edit `grub.cfg` to fix that, because editing it requires the root access you are trying to get.
2. **Even a working serial console only gives you a login prompt** — and you have no password. You asked
   for a password; there isn't one. OCI does not set a default password for cloud users. A password can
   only be created *from inside the machine*, which is the thing you cannot reach. That is a closed loop.

There is a third reason to skip GRUB even if the menu appeared: you would be hand-typing a **738-character**
key into a laggy serial terminal, where one wrong character silently produces a key that always fails.

So every previous instruction that ended in "press Ctrl+X and paste your key" was a dead end. That is why
nothing worked. Not your fault.

## 2. Two other things to settle

**Cloud Shell is not your VPS.** The prompt `kamonwansi@cloudshell:~` is Oracle's managed admin container
(Oracle Linux 8.10, hostname `777bfd78dd01`). If you were on the server it would read `ubuntu@kami-vps-1:~$`.
Cloud Shell has no `sudo` and cannot mount your instance's disks — the `sudo: No such file or directory`
errors were expected, not a fault. Cloud Shell's job here is only to be a *launch pad* for SSH.

**Do NOT enable password SSH.** Editing `sshd_config` to `PasswordAuthentication yes` and restarting SSH
(a) needs the root access you don't have, and (b) would expose a password login to the entire internet on a
server that hosts client data. We regain access with your key, and only afterwards — if you still want it —
we set a local console-recovery password while leaving network SSH key-only.

## 3. The route that actually works

Oracle's own documented procedure for a Linux instance you cannot log in to: **stop the instance, detach
its boot volume, attach that volume to a helper VM as a data volume, edit `authorized_keys`, reattach.**
([OCI: Recovering a Linux boot volume](https://docs.oracle.com/en-us/iaas/Content/Block/Tasks/recoveringlinuxbootvolume.htm))
([OCI: Attaching a boot volume](https://docs.oracle.com/en-us/iaas/Content/Block/Tasks/attach-compute-boot-volume-attachment.htm))

No data is touched: Docker volumes, `/opt`, configs, containers and databases all live on that boot volume
and are simply carried across. **Stop only — never Terminate, and never tick "delete boot volume".**

**Downtime:** roughly 20–40 minutes. **Insurance:** step 0 gives you a rollback point.

### Run it one confirmed step at a time (recommended)

`oci-recover-access.sh` is deliberately split into small phases. Each state-changing
one prints what it is about to do and waits for you to type `yes` before doing it.
Nothing runs on autopilot.

```bash
bash oci-recover-access.sh plan       # read-only: what would happen
bash oci-recover-access.sh status     # read-only: where you are right now
bash oci-recover-access.sh backup     # safety net; instance stays RUNNING
bash oci-recover-access.sh helper     # create OR adopt kami-helper, print its IP

bash oci-recover-access.sh stop       # STOP (never terminate)
bash oci-recover-access.sh detach     # detach the boot volume
bash oci-recover-access.sh attach     # attach it to the helper as R/W data volume
bash oci-recover-access.sh fix        # append your key, verify, unmount
bash oci-recover-access.sh unattach   # detach it from the helper
bash oci-recover-access.sh reattach   # reattach as the instance's boot volume
bash oci-recover-access.sh start      # start, wait for sshd, first checks

bash oci-recover-access.sh cleanup    # terminate the helper once access is proven
```

`full` runs the same sequence, confirming each step in turn.

If you created `kami-helper` by hand (in the console or with a raw `oci` command),
the `helper` phase **adopts** that VM instead of launching a second one — it looks
it up by name. This matters: a second helper means a second ~50 GB boot disk
counting against the 200 GB Always Free allowance.

You do not need to type any OCID. The script finds `kami-VPS-1` by name, then
reads its boot volume from the instance itself. If that fails (unusual name, or
a second instance), put the identifiers in `~/.kami-recovery/env`:

```bash
echo 'INSTANCE_OCID=ocid1.instance.oc1...'   >  ~/.kami-recovery/env
echo 'BOOT_VOLUME_OCID=ocid1.bootvolume...'  >> ~/.kami-recovery/env
chmod 600 ~/.kami-recovery/env
```

That file is parsed line by line: a leftover placeholder such as
`BOOT_VOLUME_OCID=<paste here>` is reported and ignored rather than crashing the
script (which is what a careless `source` would do).

## Doing all of it through the API instead of clicking

Yes — every step above is an API call, and **OCI Cloud Shell already has the `oci` CLI installed and
authenticated** (no key setup, no local install). This repo ships a driver script,
**`scripts/oci-recover-access.sh`**, that runs the whole sequence for you. Upload it (Cloud Shell
`⋯ → Upload`) or paste it, then:

```bash
chmod +x oci-recover-access.sh
bash oci-recover-access.sh plan      # resolves everything, changes nothing — run this first
bash oci-recover-access.sh backup    # creates the boot-volume backup and waits for AVAILABLE
bash oci-recover-access.sh full      # the whole recovery; prompts before it stops the server
bash oci-recover-access.sh cleanup   # deletes the helper VM once you are back in
```

It is re-runnable, records progress in `~/.kami-recovery/`, and prompts before the one irreversible-
feeling step (stopping the instance). It never terminates anything except the helper VM.

The underlying commands, if you want to do them by hand:

```bash
# stop (never terminate)
oci compute instance action --instance-id <INSTANCE_OCID> --action SOFTSTOP
# find + detach the boot volume attachment
oci compute boot-volume-attachment list --compartment-id <COMPARTMENT_OCID> \
    --availability-domain <AD> --instance-id <INSTANCE_OCID>
oci compute boot-volume-attachment detach --boot-volume-attachment-id <ID> --force
# attach it to the helper as a paravirtualised data volume
oci compute volume-attachment attach-paravirtualized-volume \
    --instance-id <HELPER_OCID> --volume-id <BOOT_VOLUME_OCID>
# ... fix authorized_keys on the helper (step 6), then:
oci compute volume-attachment detach --volume-attachment-id <DATA_ATTACHMENT_ID> --force
oci compute boot-volume-attachment attach --boot-volume-id <BOOT_VOLUME_OCID> \
    --instance-id <INSTANCE_OCID>
oci compute instance action --instance-id <INSTANCE_OCID> --action START
```

### Step 0 — Safety net (5 min, do not skip)

While the instance is still running:

```
OCI Console → ☰ → Storage → Block Storage → Boot Volumes → kami-VPS-1 (Boot Volume)
→ Actions / three-dots → Create boot volume backup → wait until state = AVAILABLE
```

(Or from Cloud Shell: `oci bv boot-volume-backup create --boot-volume-id <OCID-redacted> --display-name "kami-vps1-pre-recovery-$(date +%F)" --type INCREMENTAL`)

If anything at all goes wrong later, you restore this backup and you are exactly where you are now.

### Step 0.5 — Optional 2-minute shortcut (check before accepting downtime)

There is one route with **no downtime at all**: OCI's *Run Command*, which executes a script inside the
instance through the Oracle Cloud Agent, needing no SSH and no open inbound ports
([docs](https://docs.oracle.com/en-us/iaas/Content/Compute/Tasks/runningcommands.htm)). Try it — but do not
count on it: Oracle lists Ubuntu among the **unsupported** platform images for this feature (supported:
Oracle Autonomous Linux, Oracle Linux, CentOS, Windows).

```
kami-VPS-1 → OS Management tab → Oracle Cloud Agent
→ is "Compute Instance Run Command" listed, and is its toggle enabled?
```

If (and only if) it is listed and you can enable it and it reports Running:

```
Resources → Run command → Create command → paste this script:
```

```bash
#!/bin/bash
set -e
sudo mkdir -p /home/ubuntu/.ssh
printf '%s\n' '----- PASTE THE CONTENTS OF ~/.ssh/kami_vps.pub HERE -----' | sudo tee -a /home/ubuntu/.ssh/authorized_keys >/dev/null
sudo chown -R ubuntu:ubuntu /home/ubuntu/.ssh
sudo chmod 700 /home/ubuntu/.ssh
sudo chmod 600 /home/ubuntu/.ssh/authorized_keys
sudo ssh-keygen -l -f /home/ubuntu/.ssh/authorized_keys
```

Exit code `0` and a fingerprint ending `kami-vps-key (RSA)` in the output = done, skip to section 5.
Anything else (plugin absent, `ocarun` lacks sudo, timeout) = ignore it and continue with Step 1.

### Step 1 — Create the helper VM (same AD, same region)

```
Compute → Instances → Create instance
  Name:            kami-helper
  Compartment:     kami-vps-1 (root)
  Placement:       AD-1  ← MUST match the boot volume's AD
  Image:           Canonical Ubuntu 24.04 (any arch — x86 is fine)
  Shape:           VM.Standard.E2.1.Micro (1 OCPU / 1 GB) — always-free-eligible,
                   and avoids A1 "out of capacity" errors in uk-london-1
  Networking:      vcn-20260502-1818, subnet-20260502-1818, assign a public IPv4
  Add SSH key:     "Paste public key" → paste the FULL contents of ~/.ssh/kami_vps.pub
```

In Cloud Shell first, so you have the text to paste:

```bash
cat ~/.ssh/kami_vps.pub
```

Mounting an aarch64 ext4 filesystem on an x86 helper is fine — block volumes are not architecture-bound.

### Step 2 — Verify you can reach the helper (before touching the real server)

```bash
ssh -i ~/.ssh/kami_vps -o IdentitiesOnly=yes ubuntu@<HELPER_PUBLIC_IP>
```

You must land at `ubuntu@kami-helper:~$`. **If this fails, stop and fix it here** — do not proceed to step 3.

### Step 3 — Stop KAMi-VPS-1 (STOP, not terminate)

```
Compute → Instances → kami-VPS-1 → More actions / Actions → Stop
```
Wait until the badge reads **STOPPED**. (Docker/Coolify get a normal SIGTERM shutdown. Nothing is deleted.)

### Step 4 — Detach the boot volume

```
kami-VPS-1 → Resources → Boot volume → three-dots on the right → Detach → confirm
```
Wait until state = **DETACHED**.

### Step 5 — Attach it to the helper as a data volume

```
Compute → Instances → kami-helper → Resources → Attached block volumes → Attach block volume
  Volume attachment type : Paravirtualized   (recommended; no iSCSI commands needed)
  Block volume compartment: kami-vps-1 (root)
  Select volume          : pick from the "Boot Volume" section of the dropdown
                           (it is listed separately from ordinary block volumes)
  Access type            : Read/Write
  → Attach
```
Wait until the volume no longer says **Attaching**.

### Step 6 — Run the fix script on the helper

SSH into the helper, then paste this whole block in one go (it downloads nothing, changes nothing outside
`/mnt/kami_root`, and auto-detects the partition so you never have to guess `/dev/sdb1` vs `/dev/sdb15`):

```bash
cat > ~/add_kami_key.sh <<'SCRIPT_EOF'
#!/usr/bin/env bash
# Append the kami-vps key to /home/ubuntu/.ssh/authorized_keys on an attached KAMi boot volume.
# Run ON THE HELPER INSTANCE. Read-only probe first; writes only to /mnt/kami_root.
set -euo pipefail
TARGET_USER=ubuntu
MOUNT=/mnt/kami_root
PUBKEY='----- PASTE THE CONTENTS OF ~/.ssh/kami_vps.pub HERE -----'

[ "$(id -u)" = 0 ] || { echo "Re-run with: sudo bash $0"; exit 1; }

echo "=== 1. Block devices ==="
lsblk -o NAME,SIZE,TYPE,FSTYPE,LABEL,MOUNTPOINTS

mkdir -p "$MOUNT"
echo
echo "=== 2. Probing partitions for the KAMi root filesystem ==="
ROOT_DEV=""
while read -r dev fstype mountpoint; do
  [ -n "$fstype" ] || continue
  case "$fstype" in vfat|swap|LVM2_member|iso9660) continue ;; esac
  [ -z "$mountpoint" ] || continue
  mount -o ro "$dev" "$MOUNT" 2>/dev/null || continue
  if [ -d "$MOUNT/home/$TARGET_USER" ] && [ -f "$MOUNT/etc/os-release" ]; then
    ROOT_DEV="$dev"; umount "$MOUNT"; echo "FOUND root filesystem: $dev ($fstype)"; break
  fi
  umount "$MOUNT" 2>/dev/null || true
done < <(lsblk -lnpo NAME,FSTYPE,MOUNTPOINTS)

if [ -z "$ROOT_DEV" ]; then
  echo "No root filesystem found automatically."
  echo "If the volume uses LVM: sudo vgchange -ay && sudo lvs, then re-run with the LV path."
  echo "Otherwise run: lsblk -f  and mount the largest ext4 partition manually."
  exit 1
fi

mount "$ROOT_DEV" "$MOUNT"
echo "Mounted $ROOT_DEV at $MOUNT"
grep -E '^PRETTY_NAME' "$MOUNT/etc/os-release" || true

UID_=$(awk -F: -v u="$TARGET_USER" '$1==u{print $3}' "$MOUNT/etc/passwd")
GID_=$(awk -F: -v u="$TARGET_USER" '$1==u{print $4}' "$MOUNT/etc/passwd")
[ -n "${UID_:-}" ] || { echo "user $TARGET_USER not found on the volume"; exit 1; }

SSHDIR="$MOUNT/home/$TARGET_USER/.ssh"
AK="$SSHDIR/authorized_keys"
mkdir -p "$SSHDIR"
[ -f "$AK" ] || : > "$AK"
cp -a "$AK" "$AK.bak.$(date +%Y%m%d%H%M%S)"

KEY_BLOB=$(printf '%s' "$PUBKEY" | awk '{print $1" "$2}')
if grep -qF "$KEY_BLOB" "$AK"; then
  echo "Key already present — nothing appended."
else
  printf '\n%s\n' "$PUBKEY" >> "$AK"
  echo "Key appended."
fi

chown -R "$UID_:$GID_" "$SSHDIR"
chmod 700 "$SSHDIR"
chmod 600 "$AK"

echo
echo "=== 3. Verification ==="
ls -l "$SSHDIR"
echo "Fingerprint of your key (must match:  see below):"
printf '%s\n' "$PUBKEY" > /tmp/kami_added.pub
ssh-keygen -l -f /tmp/kami_added.pub
rm -f /tmp/kami_added.pub
echo "Keys now authorised on the volume:"
ssh-keygen -l -f "$AK"
echo
echo "DONE. Now run:  sudo umount $MOUNT"
SCRIPT_EOF

sudo bash ~/add_kami_key.sh
```

Expected: it finds the root partition (likely `/dev/sdb1`), prints `FOUND root filesystem`, appends the key,
and shows a fingerprint line ending in `kami-vps-key (RSA)`.

**Your key's fingerprint is (verified, computed from the 737-byte public key you pasted):**

```
4096 SHA256:MMFsTUBgix+BoPICvpiySeA++HKCkm/DZhaKuNKgW0o kami-vps-key (RSA)
```

Cross-check it any time from Cloud Shell with `ssh-keygen -l -f ~/.ssh/kami_vps.pub`. If the fingerprint the
script prints differs from this, stop — the key text got mangled in transit, and a mangled key fails forever.

The identical script is committed in this repo as **`scripts/add_kami_key.sh`** if you prefer to download and
upload it instead of pasting a heredoc.

> **Paste trouble?** Your browser is swallowing `Ctrl+O` (and nano is fighting you). Do not use nano at all —
> the heredoc above avoids it. Multi-line paste into Cloud Shell: use `Ctrl+Shift+V`, right-click → Paste,
> or write the block to a `.sh` file in Notepad and use Cloud Shell's **⋯ → Upload** button, then
> `scp -i ~/.ssh/kami_vps add_kami_key.sh ubuntu@<HELPER_IP>:~/`.

### Step 7 — Unmount and detach

On the helper:

```bash
sudo sync
sudo umount /mnt/kami_root
lsblk   # confirm the volume is no longer mounted
```

Then in the Console: `kami-helper → Resources → Attached block volumes → three-dots → Detach`.
Wait until it is **DETACHED** before the next step — this is what protects the filesystem.

### Step 8 — Reattach it as the boot volume of the original instance

This is the one step people get stuck on. Do it from the **boot volume's** page, not the instance's:

```
☰ → Storage → Block Storage → Boot Volumes → kami-VPS-1 (Boot Volume)
→ Resources / "Attached instances" → Attach
→ choose the instance: kami-VPS-1 (or paste its OCID) → Attach
→ wait until state = ATTACHED
```

CLI equivalent (from Cloud Shell):

```bash
oci compute boot-volume-attachment attach \
  --boot-volume-id <OCID-redacted> \
  --instance-id   <OCID-redacted>
```

Note: a detached boot volume can only be reattached as the boot volume of an instance; you cannot accidentally
attach it as a data volume from here.

### Step 9 — Start and test

```
Compute → Instances → kami-VPS-1 → Start → wait for RUNNING
```

Then from Cloud Shell:

```bash
ssh -i ~/.ssh/kami_vps -o IdentitiesOnly=yes ubuntu@130.162.187.135
```

You should get `ubuntu@kami-vps-1:~$`. The host key fingerprint should still be
`SHA256:AC9LZvHBYBD6Fq1pV19mPiBV/24O9edXq8+AjPqJwPc` — identical to before, which proves you are talking to
the same machine and not a substitute.

---

## 3.1 — "Is there anything on it? Can I just delete it and make a new one?"

**You cannot currently answer "is there anything on it", and that is exactly why you shouldn't delete it.**
The console's 0% CPU / 0.00 load is a point-in-time metric taken while you were locked out. A quiet
server can still hold Docker volumes, a Coolify install and its database, Traefik TLS certificates,
`/opt` and `/srv` source trees, Tailscale identity, cron backups and access history. The Grid-OS handover
claims Coolify/Traefik/Postgres/Redis/Tailscale on this node — unverified, but unverified is not the same
as empty.

Deleting is easy and irreversible; ticking **"Permanently delete the attached boot volume"** erases the
only copy. Two things also bite on a rebuild:

- A new instance gets a **new public IP**. The current ephemeral IP `130.162.187.135` cannot be moved to
  it, so any DNS, webhook or client config pointing at it breaks.
- You would be rebuilding an A1.Flex 4 OCPU / 24 GB node; capacity in `uk-london-1` AD-1 is not guaranteed.

If you conclude after the health check that you want a clean node anyway, use **replace, not destroy**:

```text
boot-volume backup  →  build new node  →  verify  →  migrate selected assets
      →  stop (not terminate) the old node  →  terminate it only after sign-off
```

Stopping an instance you keep costs only the boot volume; terminating it with its disk costs you the
evidence. So: **back up first, recover second, decide third.** The recovery is ~20 minutes of waiting; the
deletion is forever.

## 4. If a step fails

| Symptom | Meaning | Action |
|---|---|---|
| Can't SSH to the *helper* in step 2 | Key or security list | Fix before step 3. Check the subnet security list allows ingress TCP/22 from your source. |
| "Out of capacity" creating the helper | A1 capacity | Use `VM.Standard.E2.1.Micro` (x86), or try again — never scale down the real instance. |
| Script finds no root partition | LVM or unusual layout | `sudo lsblk -f`; if LVM: `sudo vgchange -ay`; then mount the LV manually and repeat the file edits. |
| Detach in step 7 stuck | Volume still mounted | `sudo lsof /mnt/kami_root` / `sudo fuser -m /mnt/kami_root`, then `sudo umount` again. |
| Instance won't boot after step 9 | Volume not fully attached | Confirm state = ATTACHED and the instance's Boot volume section lists it; then Stop + Start once more. |
| Anything else | Rollback | Restore the step-0 backup to a new boot volume and attach it. Data is intact. |

## 5. Once you are in — first three commands

```bash
echo "HOST=$(hostname)"; echo "USER=$(id -un)"; grep PRETTY_NAME /etc/os-release
docker ps --format 'table {{.Names}}\t{{.Status}}'
df -h /
```

Then, before anything else changes on this box:

```bash
# 1. Prove the key works from a second, independent session before closing the first.
# 2. Set a local console-recovery password (useful next time; does NOT enable network password SSH):
sudo passwd ubuntu
# 3. Confirm SSH remains key-only:
sudo sshd -T | grep -Ei '^(passwordauthentication|permitrootlogin|pubkeyauthentication)'
```

Expected: `passwordauthentication no`, `pubkeyauthentication yes`.

## 6. Where the keys should live afterwards

- Private key `kami_vps` → your password manager (Vaultwarden) or `C:\Users\<you>\.ssh\`, permissions 600.
- The Cloud Shell copy is convenient but Cloud Shell is ephemeral — do not treat it as the only copy.
- Delete the helper instance (`kami-helper`) once step 9 succeeds; keep the boot volume backup for a few days.
- Delete the console connection you created, if you made one (`Console connection → three-dots → Delete`).
