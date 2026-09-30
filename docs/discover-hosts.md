# Finding the missing hosts — `asci-vps-2` and `asci-vps-3`

Two of the four slots in `fleet/inventory.conf` are placeholders. This is how to fill them,
or to establish that one of them never existed.

**Rule for this exercise:** a host is only added once its IP is *observed*, never inferred.
An invented IP is worse than a blank, because everything downstream — DNS, monitoring,
recovery procedures — will quietly trust it.

---

## 1. Where each host is believed to be

> **Corrected 2026-09-15.** Both were previously assumed to be Hostinger in a separate
> account. The operator has confirmed both are **Oracle Cloud Always Free** instances.
> The Hostinger route below is kept only as a fallback.

| Host | Location | Why it is invisible |
|---|---|---|
| `asci-vps-2` | **Oracle Cloud**, Always Free | The OCI console shows one **region** and one **compartment** at a time — an instance in another region never appears |
| `asci-vps-3` | **Oracle Cloud**, Always Free | Same, and it may additionally be **STOPPED**, in which case it has no public IP at all |

### The one command to run first

From OCI Cloud Shell:

```bash
bash scripts/oci-find-instances.sh
```

It lists every subscribed region, every compartment, and every instance in each — with
region, state, shape, public IP, availability domain and creation date. Add
`INCLUDE_VOLUMES=1` to also total boot volumes against the 200 GB Always Free allowance.

Expect one of three outcomes:

| Outcome | What it means | Next step |
|---|---|---|
| Both listed, with IPs | Found | `merc probe <IP>`, then add to the inventory |
| Listed but IP shows `-` | Present but **STOPPED** | Start the instance, re-run to read the IP |
| Not listed | They are in a **different OCI tenancy** | Sign in with that account's credentials and sweep again |

### If they are in another OCI tenancy

Log into OCI with the other account's credentials, open Cloud Shell there, and run the same
sweep. The script reads the tenancy from `TENANCY_OCID`, or derives it from the current
session if unset.

---

## 1b. Fallback: the Hostinger route (only if the sweep finds nothing)

### Public recon has already been tried — here is what it established

On 2026-09-15 I ran the external recon route as far as it goes. Recording it so nobody
repeats it:

| Finding | Detail |
|---|---|
| Confirmed domains | `ascendant-ai.uk` and `kinetic-ai.uk` — both on Cloudflare |
| Mail origin | `mail.ascendant-ai.uk` → `72.61.203.79` (asci-vps-1), confirmed by PTR |
| **Wildcard** | `*.ascendant-ai.uk` resolves to `72.61.203.79` for *any* name, **unproxied** |
| Not theirs | `ascendant-ai.com` is parked on Afternic; `merc-os.ai` and `kinetic-ai.ai` are NXDOMAIN |
| Former site | `shopfrontgroup.co.uk` was on that IP until 2026-05-01, now NXDOMAIN |
| **`asci-vps-2`** | **No DNS footprint found. Not discoverable this way.** |

The wildcard is the reason subdomain hunting cannot work here: every name returns the same
address, so a hit on `vps2.ascendant-ai.uk` is meaningless. I confirmed this by resolving a
deliberately random hostname and getting the same IP back.

That wildcard is also a security finding in its own right — it publishes the origin IP that
the Cloudflare-proxied apex is supposed to hide. See `SOT-fleet-inventory.md` §2.

**So `asci-vps-2` must come from the account, the billing record, or the welcome email.**
Everything below is the account-and-evidence route.

---

## 3. Finding `asci-vps-3` — the indirect routes

There is no known account for it, so search for the *evidence* a server leaves behind.
In rough order of how quickly they pay off:

**Email** — search your mailboxes for:
- `welcome`, `your VPS`, `server ready`, `root password`, `SSH key`
- `invoice`, `receipt`, `payment confirmation`
- The hostnames `asci-vps-3`, `vps-3`, or partial matches

Providers send a welcome email for every server, and a monthly invoice forever after. The
inbox is usually the fastest way to rediscover a forgotten host.

**Money** — bank and card statements:
- Recurring charges from Hostinger, Hetzner, DigitalOcean, Vultr, Linode, OVH, Contabo, AWS,
  Oracle, or any registrar
- A charge with no known server attached to it **is** a server you have forgotten
- Note the merchant name and the amount; that narrows the provider immediately

**DNS** — if the host ever served anything:
```bash
dig +short A <your-domain>
dig +short AAAA <your-domain>
```
Check every domain and subdomain you own. An A record pointing at an IP you don't recognise
is a strong lead. Cross-check the IP against `merc probe`.

**Registrar** — the account that holds your domains often lists nameservers or glue records
pointing at infrastructure you've forgotten.

**Tailscale admin** — `login.tailscale.com` → Machines. Every machine ever joined appears
here with its name and last-seen date, even if powered off. This is one of the most reliable
inventories you already have, and it works across providers.

**Vaultwarden** — search both vault instances for old host entries, IPs, or credentials you
saved and forgot.

**Old notes, chats and screenshots** — you've found IPs this way before.

---

## 4. If it turns out `asci-vps-3` does not exist

That is a perfectly good answer — and better than a guess. Remove the row from
`fleet/inventory.conf`, delete the section from `SOT-fleet-inventory.md`, and note in
`learning-notes.md` that the estate is three hosts, not four.

Do this rather than leaving a phantom entry. A placeholder that outlives its usefulness
becomes a fact people start to believe.

---

## 5. Onboarding checklist

Run once per discovered host. Full procedure: **SOP-08** in `SOP-runbook.md`.

1. [ ] Observe: provider, plan, public IPv4/IPv6, SSH user, OS, `uname -m`
2. [ ] Verify it is yours (`merc probe`, then log in)
3. [ ] Add a row to `fleet/inventory.conf` — `UNKNOWN` for anything not yet confirmed
4. [ ] Add a section to `SOT-fleet-inventory.md`
5. [ ] Add to Terminus; regenerate `merc sshconfig`
6. [ ] Update DNS if the IP changed
7. [ ] Create Vaultwarden entries using `MERC-OS.<env>.<node>.<class>.<item>`
8. [ ] Run the audit: `merc audit <id>`, or the curl one-liner if no key is available
9. [ ] Check the **provider-level** firewall and snapshots (invisible from inside)
10. [ ] Baseline it against §6 of `vps-fleet-runbook.md`
11. [ ] Add reminders for its renewal date and any recurring obligations

---

## 6. The curl one-liner for a host you can only reach by browser terminal

```bash
curl -fsSL -o vps-healthcheck-readonly.sh \
  https://raw.githubusercontent.com/GoldenLion-Thai/Arena.ai-/arena/01a0a1c6-arena-ai/scripts/vps-healthcheck-readonly.sh \
  && chmod 700 vps-healthcheck-readonly.sh \
  && AUDIT_LABEL=<id> AUDIT_PROVIDER="<provider and plan>" ./vps-healthcheck-readonly.sh
```

Works in Hostinger's hPanel browser terminal, bypassing SSH entirely.
