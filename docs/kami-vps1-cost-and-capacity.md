# KAMi-VPS-1 — Billing reality check and capacity plan

Bottom line: the invoice analysis is **directionally right** (you are paying roughly £8/month and the
compute is currently £0) but **one load-bearing number is wrong and one risk is missing**. Correct those
before you touch anything, because the wrong number inverts the recommendation.

---

## 1. What checks out

- Account is **Pay As You Go**; A1 compute (4 OCPU / 24 GB) shows **£0** in the statements. Keep it.
- Recurring cost is **storage + performance, not compute**: £4.07 + £2.72 = £6.79 net, +20% VAT = **£8.15**.
  (Arithmetic confirmed: 6.79 × 1.2 = 8.148.)
- Boot volumes **cannot be shrunk in place** on OCI — only grown. Getting to a smaller disk means
  build-new + migrate, so it must be planned, not done on a whim.
- Budget + alert-only alarms: yes. And you are right that an automatic stop action is a bad idea —
  stopping the VM would not remove the boot-volume charge anyway.
- Do not terminate the instance while its contents are unknown.

## 2. Correction 1 — the free block-storage allowance is 200 GB, not 100 GB

The Always Free allowance is **200 GB total across boot volumes *and* data volumes**, per account —
[OCI Free Tier limits](https://technoroots.org/insights/oci-free-tier-what-you-actually-get-and-how-not-to-exceed-it-8Srb4),
[Oracle Cloud Always Free Tier](https://grokipedia.com/page/Oracle_Cloud_Always_Free_Tier),
[community confirmation](https://www.reddit.com/r/oraclecloud/comments/1f8pqsm/a_question_about_always_free_limits/).

That changes the picture. Your single 200 GB boot volume should sit **exactly on** the free allowance,
not 100 GB over it. So "reduce the disk to 100 GB" is probably solving the wrong problem. The real
candidates, in order of likelihood:

1. **An orphaned volume.** A boot volume kept when an instance was terminated still bills every month
   and still consumes your 200 GB. This is the single most common cause of this exact charge.
2. **Something else in the tenancy** sharing the 200 GB — a second instance, a data volume, or a
   volume in another compartment/AD.
3. **The performance tier.** Balanced (10 VPU/GB) is the free-tier norm; Higher Performance (20 VPU/GB)
   is chargeable, and would explain the separate £2.72 "Block Volume Performance" line.

Run the audit before you believe any of them:

```bash
bash oci-cost-audit.sh          # lists every volume, its size, its state and what it is attached to
```

It totals your allocated storage against the 200 GB allowance and flags an orphaned volume if one is
attached to nothing.

**One number to confirm in the billing console:** the statements say ~100 GB free was applied, but not
how many GB were *billed*. £4.07 for ~100 GB implies a per-GB rate above Oracle's published block-volume
rate, which usually means the billed quantity is larger than assumed. Confirm with
`Billing & Cost Management → Cost Analysis → Last 30 days → Group by: Service → Group by: Resource`.

## 3. Correction 2 — the A1 allowance changed in June 2026

The analysis treats 4 OCPU / 24 GB as safely free because your invoices show £0. That is true *today*,
but Oracle changed the Ampere A1 Always Free allocation: the cap moved to **2 OCPU / 12 GB**, with PAYG
accounts able to be **charged** for usage above it —
[discussion of the change and Oracle support responses](https://www.reddit.com/r/oraclecloud/comments/1ubk2qy/new_always_free_tier_limits_21june2026_update/).

Practical consequences:

- Do **not** increase CPU/RAM. There is no free headroom above what you have.
- Don't destroy and recreate the VM to "refresh" it — under the new rules a rebuild may land on the
  2/12 cap instead of 4/24.
- Treat the £0 compute line as *currently un-billed*, not *contractually free*. If a future statement
  shows a compute charge, dropping to 2 OCPU / 12 GB is the lever.
- This is a second reason not to terminate and rebuild: you already hold a 4/24 allocation.

## 4. What to do now (in this order)

```bash
# 1. audit — read-only, 2 minutes, tells you what the £6.79 actually is
bash oci-cost-audit.sh

# 2. alarm — alert-only budget, no automatic actions, no server contact
ALERT_EMAIL=you@example.com AMOUNT=12 bash oci-setup-billing-guard.sh

# 3. recovery (unchanged plan) — backup first
bash oci-recover-access.sh plan
bash oci-recover-access.sh backup
bash oci-recover-access.sh full

# 4. only once you are logged in: find out what the disk actually holds
sudo bash kami-disk-audit.sh
```

Steps 1 and 2 are safe **right now** — neither touches the instance, so do them while you are still
locked out rather than waiting.

## 5. Sizing decision — wait for real numbers

Do not pick a target disk size until the disk audit reports actual usage. Then:

| Used on `/` | Recommendation |
|---|---|
| < 30 GB | Rebuild onto a 50–75 GB boot volume; plenty of headroom |
| 30–60 GB | 100 GB boot volume — comfortably inside the 200 GB allowance |
| 60–80 GB | Keep 200 GB, or split: smaller boot volume + a data volume (remember: 200 GB is a *total*) |
| > 80 GB | Do not shrink. Look at what is actually stored before spending effort on the disk at all |

If the audit shows an orphaned volume instead, deleting that is the entire fix — no migration, no
rebuild, no risk to KAMi-VPS-1.

## 6. Still true

- Do not terminate or tick "permanently delete the attached boot volume".
- Do not resize or replace the boot volume until you have: SSH access, a verified backup, and real
  disk-usage numbers.
- Do not enable password SSH.
- Billed block-volume usage is evidence that the account has been consuming storage continuously; it is
  not evidence of what is *on* the disk. Only the health check answers that.
