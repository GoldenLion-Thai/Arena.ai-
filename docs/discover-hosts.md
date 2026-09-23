# Finding the missing hosts — `asci-vps-2` and `asci-vps-3`

Two of the four slots in `fleet/inventory.conf` are placeholders. This is how to fill them,
or to establish that one of them never existed.

**Rule for this exercise:** a host is only added once its IP is *observed*, never inferred.
An invented IP is worse than a blank, because everything downstream — DNS, monitoring,
recovery procedures — will quietly trust it.

---

## 1. Where each host is believed to be

| Host | Believed location | Blocker |
|---|---|---|
| `asci-vps-2` | Hostinger, **in a separate account of its own** | The OCI Cloud Shell cannot enumerate another provider's account |
| `asci-vps-3` | Unknown — possibly Hostinger, possibly elsewhere, possibly nonexistent | Nothing on record at all |

---

## 2. Finding `asci-vps-2` — the direct route

Log into **each Hostinger account you hold** (not just the one that owns `asci-vps-1`) and:

1. **hPanel → VPS → your server → Overview** — the public IPv4 is on this page.
2. Note also: plan, datacentre location, OS, and the renewal date.

If you have more than one Hostinger account, check them all. The account list is the whole
search space here.

### Verifying you have the right machine

Before adding it, confirm it is actually yours — a wrong IP added to the inventory will be
trusted by everything downstream.

```bash
merc probe <IP>
```

Returns the SSH banner, a best-guess distro from that banner, reverse DNS, and which common
ports are open. Cross-check against what you expect:

| Expectation | What to look for |
|---|---|
| Ubuntu | banner mentions `Ubuntu` or `Debian` |
| Docker host | ports like `8000`, `8080`, `9000`, `9001`, `3000`, `5678` |
| A mail host | `25`, `465`, `587`, `993`, `995`, `4190` |
| This estate | a hostname resembling `asci-vps-2`, or Tailscale present |

⚠️ **Run `merc probe` from Cloud Shell or your own PC, not from a sandbox or CI runner.**
Behind an egress proxy every port appears open and the result is meaningless.

### Then confirm by logging in

```bash
ssh -i ~/.ssh/<its-key> root@<IP>
```

Once the hostname, OS and user are confirmed, add the row to `fleet/inventory.conf` and
give it a section in `SOT-fleet-inventory.md`.

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
