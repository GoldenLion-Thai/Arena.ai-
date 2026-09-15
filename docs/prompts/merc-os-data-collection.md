# Prompt: MERC-OS data collection (infrastructure + business + personal)

A copy-paste prompt for gathering the full picture of the MERC-OS estate. MERC-OS is the
infrastructure layer behind a larger venture: **an autonomous app and bot factory**.

Two rules govern everything below:

1. **Collect structure, never store values.** Account numbers, balances, statements,
   passwords, API tokens and private keys are **never** written into a git repository or
   pasted into a chat. This prompt asks for *what exists* and *where it lives*, never the
   contents.
2. **`UNKNOWN` beats a guess.** A blank is a to-do; a plausible invention is a future outage.

---

## ▶ COPY FROM HERE

You are helping catalogue everything that makes up **MERC-OS** so it can be documented and
kept current. Work in three passes: **infrastructure**, **business**, **personal**. Do not
mix them — a personal bill and a server invoice look identical once they are out of context.

### Universal rules

- **Read-only on live systems.** Never install, upgrade, restart, delete, or reconfigure
  anything while collecting. If something needs changing, list it under *Recommendations*.
- **No secret values, ever.** Report the **names** of things: variable names, file paths,
  account nicknames, institutions. Never their contents. If a file is a `.env`, say it
  exists and list its **key names only**.
- **Cite evidence** for each claim (command, file, or screen). Mark anything you worked out
  rather than observed as `INFERRED`.
- **Say `UNKNOWN`** when you cannot determine something, then state exactly what you would
  need to determine it.

---

### PASS 1 — INFRASTRUCTURE

Run this per host. State the hostname and public IP at the top of each section.

**Platform**
- Provider, plan, region/datacentre
- Virtualisation, architecture (`uname -m`)
- CPU cores and model · RAM · swap
- OS and kernel (`/etc/os-release`, `uname -r`)
- Disk layout (`lsblk`), filesystems, size used/free (`df -hT`)
- Uptime, load average, timezone

**Network and exposure**
- Public IPv4/IPv6, all interfaces (`ip -brief addr`)
- Tailscale: installed, IP, connected?
- Listening ports (`ss -tulpn`) — for each: port, **bind address** (0.0.0.0 vs 127.0.0.1
  is the difference between internet-facing and internal), and owner
- Host firewall tool and rules
- **Note:** a provider-level firewall may also exist and is invisible from inside the machine

**Data**
- Docker volumes and the host paths behind them
- Bind mounts; non-Docker data directories
- Largest directories
- Backup scripts or directories present
- **Note:** provider snapshots are invisible from inside the machine

**Applications — the important part**

For every container (`docker ps -a`): name, image, status, published ports, restart policy,
networks, volumes, and a one-line plain-English purpose.

Then, for each application or bot:
- What it does, in one sentence a non-technical person would understand
- Who or what calls it (users, other bots, a scheduler, an external webhook)
- What it depends on (databases, APIs, model providers, queues)
- Where its state lives (volume, database, external service)
- How it is reached (domain, port, tunnel, MCP)
- Whether it is internet-facing or internal only
- What it costs to run, if knowable

For non-Docker services (`systemctl list-units --type=service --state=running`): name,
purpose, enabled at boot.

**Web and proxy layer**
- Caddy / nginx / Traefik — version, which domains it serves, upstream per route
- TLS: provider, renewal mechanism, earliest expiry

**Data stores** — engine, version, container, volume, which app uses it, exposed or internal,
backup arrangement.

**Automation and AI**
- n8n or similar: URL, auth model, publicly reachable?
- MCP servers: name, what each connects to, how reached
- Local models (Ollama etc.): model names only, not weights
- Cron jobs and systemd timers

**Mail** (if present) — product, ports, domains served, data location, SPF/DKIM/DMARC
(`UNKNOWN` if DNS cannot be verified from the host).

**Access and identity**
- SSH users, `authorized_keys` **counts** (never the keys)
- **Effective** `PasswordAuthentication` from `sshd -T`. If several
  `/etc/ssh/sshd_config.d/*.conf` files disagree, report every one and say which wins —
  files are read in lexical order and the **first** value obtained wins
- Root login permitted? Sudo group members?
- Whether an offline backup of each admin key exists

**Per host, finish with:** numbered risks (critical/high/medium/low), open questions, and a
one-paragraph plain-English summary of what this host is *for*.

---

### PASS 2 — BUSINESS (the autonomous app and bot factory)

Structure only — no credentials, no customer data, no contracts pasted in.

**The venture**
- One-paragraph description of what the business does and who it serves
- Legal entity: registered name, number, jurisdiction, status
- Trading names and domains owned

**Products and bots**
- Each product, app or bot: name, purpose, status (idea / building / live / retired)
- Which host it runs on
- Revenue model and whether it currently earns
- Dependencies on third parties (model providers, APIs, marketplaces)

**Money in**
- Revenue streams, billing cadence, payment providers (names only)
- Outstanding invoices, if tracked

**Money out** — the recurring stack. For each: vendor, what it is, amount, cadence,
renewal date, payment method on file, and who can cancel it.
- Hosting and domains
- SaaS subscriptions
- API and model spend (which providers, roughly what shape of spend)
- Contractors and staff
- Insurance, professional services

**Obligations and deadlines**
- Renewals in the next 12 months
- Tax and filing dates
- Contractual commitments, SLAs, notice periods

**Risk register** — single points of failure: one person, one key, one host, one account,
one payment method.

---

### PASS 3 — PERSONAL (for Warren: household, family, finances)

⚠️ **Collect the shape, never the numbers.** For every item below, record *that it exists*,
*who it is with*, and *when it needs attention* — **never** account numbers, sort codes,
balances, card numbers, policy numbers or statements. Those belong in a password manager or
a sealed physical file, never in a repository, a chat, or this document.

**Household and family**
- Household members and dependants (first names or initials only)
- Recurring household obligations and who owns each
- Key dates: birthdays, renewals, school terms, appointments
- Pets, vehicles, and their recurring needs

**Property**
- Properties: owned or rented, occupancy, tenure type
- For each: mortgage or landlord, term end or renewal date, insurance renewal
- Utilities per property and their renewal dates
- Maintenance cycles and known upcoming works

**Banking and accounts**
- Institutions held with, and **the purpose of each account** — no numbers
- Which accounts are joint, which aresole
- Direct debits and standing orders: payee, purpose, amount band, frequency
- Dormant accounts worth closing

**Loans, credit and mortgages**
- Each facility: type, lender, purpose, term end, rate type (fixed/variable), rate-review
  or maturity date
- Whether overpayment or refinancing is worth modelling, and when

**Investments**
- Providers and account types (ISA, GIA, pension, SIPP, crypto exchange) — no holdings,
  no values
- Contribution schedules and any deadlines (e.g. tax-year end)
- Beneficiaries and expression-of-wish forms: are they current?

**Bills and subscriptions**
- Every recurring charge: provider, purpose, cadence, renewal date
- Which are unused and could be cancelled
- Which auto-renew at a higher rate

**Insurance and protection**
- Life, income protection, critical illness, health, home, contents, travel, vehicle
- For each: insurer, renewal date, and whether cover is still appropriate
- Named beneficiaries

**Estate and legal**
- Will: exists? date? where held? executor named?
- Powers of attorney (financial and health): in place?
- Guardianship arrangements for dependants
- Where original documents physically live

**Tax**
- Filing obligations and deadlines
- Whether affairs are currently in order or behind
- Accountant or adviser, if any

**Documents and access**
- Where vital records live (birth certificates, passports, deeds, titles)
- Which accounts have recovery options set, and which do not
- What would happen if one person were unreachable for a month — what breaks first?

---

### Deliverable

Return three clearly separated Markdown sections — **INFRASTRUCTURE**, **BUSINESS**,
**PERSONAL** — each with:
1. The collected facts, with `UNKNOWN` where unknown
2. A numbered risk list with severity
3. Open questions, each stating exactly what is needed to close it

Finish with a **single-page summary**: what MERC-OS is, what runs where, what it costs,
what is at risk, and the five things that most need attention.

## ◀ COPY TO HERE

---

## Guidance for using this prompt

- **Run each pass separately.** Crossing personal and infrastructure data is how sensitive
  details end up in the wrong place.
- Pass 1 can be handed to an agent with terminal access. Passes 2 and 3 are for you, or an
  agent working only from documents you choose to share — **not** one with shell access.
- Paste results into `docs/SOT-fleet-inventory.md` (infrastructure) and
  `docs/personal-organiser.md` (personal structure).
- Anything that came back as `UNKNOWN` becomes a reminder:
  `merc todo add "Find X" -c admin -p high -d YYYY-MM-DD`
