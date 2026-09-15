# Learning notes

Running log. Newest at the bottom. Written to be read cold, months later, by someone
who has forgotten all of this. Append with `./scripts/grid-os note "…"`.

---

## 2026-09-15 02:20 — Fleet CLI built

`scripts/grid-os` is now the front door: `hosts`, `status`, `audit`, `connect`,
`sshconfig`, `note`, `sot`. It reads `fleet/inventory.conf`, which is the machine-readable
twin of `docs/SOT-fleet-inventory.md`.

---

## 2026-09-15 02:20 — A bare TCP connect is not proof a host is up

**Learned the hard way.** `grid-os status` first used
`timeout 4 bash -c 'exec 3<>/dev/tcp/IP/22'` and reported `kami-vps-1` and `asci-vps-1`
both **UP**. That was wrong.

Suspicion: the sandbox sits behind an egress proxy that *accepts every outbound TCP
connection* and only resets it once data is sent. Tested by connecting to
`192.0.2.1` and `203.0.113.5` — reserved TEST-NET ranges that can never be live. Both
reported "OPEN". Confirmed by writing data and getting `ECONNRESET` from real and dead
IPs alike.

**Fix:** `probe_ssh()` now requires a genuine `SSH-2.0-…` banner before declaring a host
UP, and reports `INDETERMINATE` when the current network cannot verify anything. It also
prints a hint telling you to run it from Cloud Shell or your own PC instead.

**General lesson:** a check that cannot produce a negative result is not a check. Always
validate a probe against something you *know* is off before trusting a positive.

---

## 2026-09-15 02:05 — Two hosts, two default users

`kami-vps-1` (OCI) → `ubuntu`. `asci-vps-1` (Hostinger) → `root`. Getting this wrong
produces `Permission denied (publickey)` that looks like a broken key but is just the
wrong username. Recorded per host in the inventory so it is never guessed again.

---

## 2026-09-15 01:50 — OCI recovery, what actually worked

The instance had been terminated; only its 200 GB boot volume survived. One command
restored it:

```bash
oci compute instance launch … --source-details '{"sourceType":"bootVolume","bootVolumeId":"<OCID>"}'
```

Key findings:

- `--source-boot-volume-id` **is not a real OCI CLI flag.** Advice to use it produces a
  usage error that reads like a permissions problem. The parameter is `--source-details`,
  and the discriminator inside the JSON is `sourceType` (some CLI versions want `type`).
- **cloud-init did inject the key** on first boot of the new instance. The elaborate
  helper-VM, detach, mount, inject-key dance was never needed. Keep it as a fallback only.
- Reusing the existing volume means **no new disk and no new charge.**
- The host key **changed** (`AC9LZ…` → `ctjfO…`) because the new instance regenerates its
  SSH host keys. Evidence the disk was original: `Last login: Mon May 11 2026`, hostname
  `kami-vps-1`, 8.7 GB in use, and the Coolify stack back up.
- Architecture matters: the volume holds `aarch64` Ubuntu, so the replacement **must** be
  an A1.Flex shape. An x86 shape cannot boot it.

---

## 2026-09-15 01:30 — "sudo: command not found" was never true

Pasted input arrived wrapped in `^[[200~ … ~` (bracketed paste markers). The shell then
looked for a command literally named `^[[200~sudo`. **The command was fine.**
Type it, or paste one line at a time. Also why nano's `Ctrl+O` opens an upload dialog in
the browser — it is intercepted. Use heredocs or the file manager instead.

---

## 2026-09-15 00:40 — Billing: do not accept "it's within the free tier"

Advice was given that 200 GB sits inside OCI's Always Free allowance so the cost is zero.
The user's own invoices contradict that: £4.07 storage + £2.72 performance = £6.79 net,
**£8.15/month with VAT**, every month. Whatever the free allowance is doing in that
tenancy, it is not zeroing the storage line.

**Lesson:** invoice beats assumption. When a cost claim and a bill disagree, the bill wins.

---

## 2026-09-14 — Terminating is not reversible, but volumes usually survive

`kami-VPS-1` was terminated against the standing "stop, never terminate" rule. The VM and
its ephemeral IP vanished immediately; the 200 GB boot volume survived in `AVAILABLE`
state and made full recovery possible.

**Two follow-on lessons:**
- Terminating does **not** reliably delete the boot volume — which is good for recovery
  and bad for billing. Always check for orphans afterwards.
- On OCI, Always Free A1 capacity is not guaranteed. A rebuild can lose the 4 OCPU / 24 GB
  allocation permanently. On Hostinger, the plan is paid for and always available.
  That asymmetry should shape where critical workloads live.

---

## Standing gotchas

- Never put `<PLACEHOLDER>` in a command — `<` and `>` are shell redirection and produce
  `syntax error near unexpected token 'newline'`.
- Never merge two `oci` commands on one line — the CLI parses the second as arguments to
  the first.
- Never paste full `oci` JSON into a chat — it contains public keys, OCIDs, private IPs.
- Hostinger has **two** firewalls: hPanel's (outside the VM) and the guest's. Auditing
  one tells you nothing about the other. OCI likewise: Security Lists plus the guest.
- Provider snapshots are invisible from inside a VM. "No backups found" in an audit does
  **not** mean no backups exist.

## 2026-09-15 02:34

fleet docs scaffolded: SOT, SOPs, vault naming, terminus, learning notes
