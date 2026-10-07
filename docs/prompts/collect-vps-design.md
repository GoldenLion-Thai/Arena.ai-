# Prompt: collect the complete VPS design (infra + apps) for every host

Copy everything inside the block below and paste it to an agent that has terminal access
to the target machine(s). It is written to be safe, read-only, and to produce output that
drops straight into this repo's documentation.

---

## ▶ COPY FROM HERE

You are auditing Linux VPS hosts so their **infrastructure and application design** can be
documented. Work on one host at a time. Be thorough and precise.

### Hard rules

1. **Read-only.** Do not install, upgrade, restart, stop, delete, move, or reconfigure
   anything. Do not edit config files. Do not restart services. If something must change,
   say so in a recommendations section — do not do it.
2. **Never output secrets.** No passwords, no private keys, no API tokens, no recovery
   codes, no JWTs, no connection strings with credentials in them.
   For every service, report the **names** of environment variables only, never their
   values — e.g. `POSTGRES_PASSWORD` not the password. If a file is a `.env`, report that it
   exists and list its **key names**, never its contents.
3. **Never guess.** If a value cannot be determined, write `UNKNOWN`. An honest
   `UNKNOWN` is far more useful than a plausible invention. Do not fill gaps with
   assumptions about what "usually" runs.
4. **State your evidence.** For each claim, note the command or file that produced it.
   If you inferred something rather than observing it, label it `INFERRED`.
5. **Say which host you are on** at the top of every section (`hostname`, public IP).

### If you cannot reach a host

Say so explicitly and state exactly what you need: the IP, the SSH user, the key, or
access to the hosting control panel. Do not proceed with another host's data.

### Output format

Return one Markdown section per host using this structure. Keep it factual and compact.

---

**HOST: `<hostname>` / `<public IP>`**

**A. Platform**
- Provider and plan (if knowable from inside; otherwise `UNKNOWN — check the billing panel`)
- Virtualisation (`systemd-detect-virt`), architecture (`uname -m`)
- CPU: cores, model (`lscpu`)
- RAM: total, typical used (`free -h`)
- Swap: size, or `none`
- OS and kernel (`/etc/os-release`, `uname -r`)
- Disk: device layout (`lsblk`), filesystems, size, used, free (`df -hT`)
- Uptime, load average
- Timezone

**B. Network**
- Public IPv4 and IPv6
- All interfaces with addresses (`ip -brief addr`)
- Tailscale: installed? IP assigned? connected? (`tailscale status`)
- Listening ports (`ss -tulpn`) — note for each: port, bind address (0.0.0.0 vs 127.0.0.1
  matters), and what owns it
- Host firewall: which tool (`ufw` / `firewalld` / `nft` / `iptables`) and its rules
- Explicit note: **a provider-level firewall may also exist and is NOT visible from inside
  the machine**

**C. Storage and data locations**
- Docker volumes (`docker volume ls`) and where they live on disk
- Bind-mounted host directories used by containers
- Any non-Docker data directories (`/opt`, `/srv`, `/var/lib/...`)
- Largest directories (`du -h --max-depth=1 -x`)
- Backup directories or scripts, if any
- **Note: provider snapshots are invisible from inside the machine.**

**D. Containers and services — this is the important part**

For **every** container (`docker ps -a`), give:
| Name | Image | Status | Published ports | Restart policy | Networks | Volumes | One-line purpose |

Then:
- `docker inspect` the network mode and any healthcheck
- Compose files: **where they live** (`/opt/...`, `/srv/...`) — report paths and the
  service names defined, **not** file contents
- For each stack, what it is for in plain language

For **non-Docker** services (`systemctl list-units --type=service --state=running`):
- name, what it does, whether it is enabled at boot

**E. Web and proxy layer**
- Is Caddy / nginx / Traefik running? Version?
- Which domains or hostnames are served? (from the config — names only)
- Which upstream does each route to? (container name and port)
- Where do TLS certificates come from, and roughly when do they expire?

**F. Data stores**
- Every database: engine, version, container, volume, which app uses it
- Whether it is exposed publicly or only on a Docker network
- Backup arrangement, if any

**G. Automation, AI and integration**
- n8n / any workflow automation: URL, auth model, whether it is publicly reachable
- Any MCP servers or gateways: name, what they connect to, how they are reached
- Ollama or local models: which models are present (names only)
- Cron jobs and systemd timers

**H. Mail** (only if a mail stack exists)
- Which product (Stalwart / Postfix / others), which ports
- Which domains it serves
- Where mail data is stored
- Whether SPF, DKIM and DMARC records appear to be configured — say `UNKNOWN` if you
  cannot verify DNS from the host

**I. Access and identity**
- SSH users that can log in, and their `authorized_keys` **counts** (never the keys)
- `PasswordAuthentication` **effective value** — get it with `sshd -T`, and if several
  `/etc/ssh/sshd_config.d/*.conf` files disagree, report every one and state which wins
  (files are read in lexical order and the **first** value obtained wins)
- Whether root login is permitted
- Sudo group members
- Where the SSH private keys live for people who administer this box, and whether an
  offline backup of them exists

**J. Risks and recommendations**
Numbered list. For each: what you found, why it matters, what to do about it, and how
urgent (`critical` / `high` / `medium` / `low`). Be direct — if password SSH is on for root
on a public IP, say so in the first line.

**K. Open questions**
What you could not determine, and exactly what is needed to determine it.

---

### Finish with

1. A one-paragraph plain-English summary of what this host actually *is* and what it is for.
2. A table of every host you managed to audit and every one you could not, with the reason.
3. Anything that contradicts what the operator believes — flag it prominently.

## ◀ COPY TO HERE

---

## Notes on using this prompt

- Run it **once per host**. Mixing two hosts in one response is how facts get crossed.
- If the agent has no key for a Hostinger box, the fastest route is the **hPanel browser
  terminal** — it bypasses SSH entirely.
- Paste the result back and it will be folded into `docs/SOT-fleet-inventory.md`.
- The prompt deliberately asks for **effective** `sshd` values rather than the raw config,
  because on `asci-vps-1` three config files disagreed and the raw grep was misleading.
