# Personal organiser — Warren

A **structure**, deliberately empty of values. This file lives in a git repository, so it
records *what exists, who it is with, and when it needs attention* — and nothing else.

## 🔴 Read this before adding anything

**Never put these in this repository, in a chat, or in any cloud note:**

- Account numbers, sort codes, IBANs, card numbers, CVVs
- Balances, statements, salary or portfolio values
- Passwords, PINs, recovery codes, API tokens
- Passport, driving licence or National Insurance numbers
- Policy numbers, mortgage account numbers
- Full names and dates of birth of family members together in one place

Where things actually belong:

| Kind of thing | Where it goes |
|---|---|
| Credentials, account logins, recovery codes | **Vaultwarden** (`asci-vps-1` or the canonical instance) |
| The financial register (balances, account numbers) | Encrypted store you control, or **paper in a safe** |
| Original documents (deeds, wills, certificates) | Physical safe / solicitor / fireproof box |
| **This repo** | Structure, cadence, checklists, what exists — **never values** |

A repo is a terrible place for money. Anyone with read access to the repo, any future
collaborator, any leaked token, gets everything — permanently, because git history keeps it
even after deletion.

Use the reminder tool for anything with a date:

```bash
merc todo add "Mortgage rate review" -d 2026-12-01 -c finance -p high
merc todo add "Home insurance renewal" -d 2026-11-15 -c household -p med
```

Reminders default to `~/.merc/reminders.tsv` — **outside** the repo, so personal items are
never committed. Check what's due with `merc todo due`.

---

## Categories

Use these with `merc todo -c <category>`:

| Category | Use for |
|---|---|
| `infra` | servers, hosts, network |
| `business` | the app and bot factory, clients, vendors |
| `finance` | banking, investments, tax |
| `household` | home, utilities, vehicles, maintenance |
| `family` | dependants, school, care, key dates |
| `property` | mortgages, tenancies, insurance |
| `personal` | health, admin, documents |
| `health` | appointments, prescriptions, cover |
| `admin` | renewals, subscriptions, general |
| `other` | anything else |

---

## The register — structure only

### Household and family
- [ ] Household members and dependants noted elsewhere (not here)
- [ ] Recurring household obligations, each with a named owner
- [ ] Key dates captured as reminders with `-c family`
- [ ] Vehicles: insurance, MOT/service, tax dates → reminders
- [ ] Pets: vaccinations, insurance renewals → reminders

### Property
For each property — address held privately; here just:
- [ ] Tenure: owned / mortgaged / rented
- [ ] Lender or landlord — **name only**
- [ ] Term end or rate-review date → `-c property` reminder
- [ ] Buildings insurance renewal → reminder
- [ ] Utilities per property, renewal dates → reminders
- [ ] Known upcoming maintenance, with a target season

### Banking and accounts
- [ ] List of institutions and **the purpose of each account** — no numbers
- [ ] Marked which are joint and which are sole
- [ ] Direct debits and standing orders: payee, purpose, cadence → reminders for review
- [ ] Dormant accounts identified for closure
- [ ] Every institution has a recovery path recorded in Vaultwarden

### Loans, credit and mortgages
For each facility — type, lender, purpose, **no balances**:
- [ ] Rate type: fixed / variable / tracker
- [ ] **Term end or rate-review date → reminder, set 90 days early**
- [ ] Early-repayment charges, if any
- [ ] Refinance modelled *before* the maturity date, not after

### Investments
Providers and account types only — **no holdings, no values**:
- [ ] Provider and wrapper type (ISA / GIA / pension / SIPP / other)
- [ ] Contribution schedule and tax-year deadlines → reminders
- [ ] Beneficiaries and expression-of-wish forms reviewed in the last 2 years
- [ ] Fees reviewed annually → reminder

### Bills and subscriptions
- [ ] Every recurring charge: provider, purpose, cadence, renewal date → reminders
- [ ] Reviewed for duplicates and unused services in the last 6 months
- [ ] Auto-renewing-at-a-higher-rate items flagged
- [ ] Cancellation route known for each

### Insurance and protection
Type, insurer, renewal date — **no policy numbers here**:
- [ ] Life cover — appropriate to current dependants?
- [ ] Income protection / critical illness
- [ ] Health or private medical
- [ ] Home and contents
- [ ] Vehicle
- [ ] Travel
- [ ] All renewal dates set as `-c personal` reminders

### Estate and legal
- [ ] Will exists; date; **location recorded in Vaultwarden, not here**
- [ ] Executors named and willing
- [ ] Financial and health powers of attorney in place
- [ ] Guardianship for dependants arranged
- [ ] Original documents physically located and known to at least one other person

### Tax and filings
- [ ] Filing obligations listed with deadlines → reminders
- [ ] Current or behind — recorded honestly
- [ ] Adviser details in Vaultwarden
- [ ] Records retention habit established

### Continuity — the one that matters most
- [ ] **If Warren were unreachable for a month, what breaks first?**
- [ ] Someone else can reach: banking, hosting, the domain registrar, the password vault
- [ ] Vault master password exists somewhere other than the vault (sealed, offline)
- [ ] A written "if something happens" note exists, held by a trusted person

---

## Cadence

| When | Do |
|---|---|
| Weekly | `merc todo due` |
| Monthly | `merc todo list`; review subscriptions; check one credential still works |
| Quarterly | Insurance and utility renewal check; review the risk register |
| Annually | Will and beneficiaries; powers of attorney; mortgage refinance modelling; tax position |
| On any life change | Revisit estate, insurance and beneficiaries |

---

## Reminder quick reference

```bash
merc todo add "text" -d YYYY-MM-DD -p low|med|high|critical -c category
merc todo list                 # open items, soonest first
merc todo list --all           # include completed
merc todo list -c finance      # one category
merc todo due                  # today or overdue
merc todo done <id>            # complete
merc todo rm <id>              # delete
```

For anything with a hard date — renewals, filings, maturities — set the reminder **30–90
days early**. A reminder on the day a rate review expires is too late to act on.
