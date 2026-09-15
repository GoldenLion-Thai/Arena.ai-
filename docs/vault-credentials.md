# Vaultwarden structure, naming convention and placeholders

**This file contains no secrets and must never contain any.** It is a map of *what* should
exist in the vault and *how* to name it, with placeholders to fill in at the vault itself.

---

## 1. The naming format

```
MERC-OS.<env>.<node>.<class>.<item>
```

| Segment | Meaning | Allowed values |
|---|---|---|
| `MERC-OS` | fixed prefix — the estate | `MERC-OS` |
| `<env>` | environment | `prod`, `stg`, `dev`, `lab` |
| `<node>` | which host, or `fleet` for estate-wide | `kami-vps-1`, `asci-vps-1`, `asci-vps-2`, `asci-vps-3`, `fleet` |
| `<class>` | kind of credential | `ssh`, `panel`, `os`, `db`, `app`, `api`, `net`, `recovery` |
| `<item>` | the specific thing | `privatekey`, `pubkey`, `login`, `root`, `token`, `admin`, `console`, `recoverycodes` |

Examples:

```
MERC-OS.prod.kami-vps-1.ssh.privatekey
MERC-OS.prod.kami-vps-1.panel.login
MERC-OS.prod.asci-vps-1.panel.login
MERC-OS.prod.asci-vps-1.os.root
MERC-OS.prod.kami-vps-1.app.vaultwarden
MERC-OS.fleet.mcp.api.gatewaytoken
```

Why this shape: it sorts correctly in Vaultwarden's list view (everything for one node
groups together), it is unambiguous when read aloud, and it extends cleanly — the `une`
/ `uge` segments you use in MERC-OS-une-uge can be carried as an extra tag or appended to
`<env>` without breaking anything.

**Rule:** the node segment must match the `id` in `fleet/inventory.conf` exactly. One
inventory, one vocabulary.

---

## 2. Folder layout in Vaultwarden

```
MERC-OS/
├── 00-Identity/                  master email, recovery codes, MFA seeds
├── 01-Hosts/
│   ├── asci-vps-1/
│   ├── asci-vps-2/
│   ├── asci-vps-3/
│   └── kami-vps-1/
├── 02-Services/                  Coolify, Vaultwarden, Portainer, Caddy
├── 03-Databases/                 Postgres, Redis
├── 04-API-and-Tokens/            MCP gateway, Tailscale auth keys
└── 05-Recovery/                  console passwords, backup keys, escape hatches
```

Creating the folders first makes the naming scheme self-enforcing.

---

## 3. Item register — create these, fill the placeholders

Placeholders use `[[FILL: …]]`. **Fill them inside Vaultwarden, never in this file.**

### `00-Identity`

| Name (Vaultwarden item) | Type | Fields |
|---|---|---|
| `MERC-OS.fleet.identity.email` | Login | user `[[FILL: primary email]]`, password `[[FILL]]`, TOTP ✅ |
| `MERC-OS.fleet.recovery.recoverycodes` | Secure Note | `[[FILL: codes, one per line]]` |

### `01-Hosts/` — per node, repeat for all four

| Name | Type | Contents |
|---|---|---|
| `MERC-OS.prod.<node>.ssh.privatekey` | **Secure Note** ⚠️ | The **entire** private key block, including `-----BEGIN …-----` and `-----END …-----` lines. Not truncated, no trailing spaces. |
| `MERC-OS.prod.<node>.ssh.pubkey` | Secure Note | Public key text. Low risk, handy for pasting into new hosts. |
| `MERC-OS.prod.<node>.panel.login` | Login | Hostinger hPanel or OCI console login |
| `MERC-OS.prod.<node>.os.root` | Login | Local root/ubuntu password — **console-recovery only**, network password SSH stays off |
| `MERC-OS.prod.<node>.recovery.console` | Secure Note | How to reach this box when SSH is down (see §5) |
| `MERC-OS.prod.<node>.host.facts` | Secure Note | IP, user, host key fingerprint, plan, renewal date |

> **Use Secure Note, not Login, for private keys.** A Login item's password field may
> reflow or truncate long multi-line values. A Secure Note preserves the block verbatim,
> which is exactly what SSH requires.

### `02-Services/`

| Name | Notes |
|---|---|
| `MERC-OS.prod.kami-vps-1.app.coolify` | Coolify dashboard admin |
| `MERC-OS.prod.kami-vps-1.app.vaultwarden` | **This vault.** Admin token + the master password lives here or in `00-Identity` — decide once, document the choice, never store the vault's master password *only* inside the vault. |
| `MERC-OS.prod.kami-vps-1.app.portainer` | Portainer admin |
| `MERC-OS.prod.asci-vps-1.app.caddy` | Caddy admin API if enabled |

### `03-Databases/`

| Name | Notes |
|---|---|
| `MERC-OS.prod.kami-vps-1.db.coolify` | Coolify Postgres |
| `MERC-OS.prod.kami-vps-1.db.kami` | Application Postgres |

### `04-API-and-Tokens/`

| Name | Notes |
|---|---|
| `MERC-OS.fleet.mcp.api.gatewaytoken` | MCP gateway token ⬜ not yet created |
| `MERC-OS.fleet.net.tailscale` | Tailscale auth key / admin console |
| `MERC-OS.fleet.api.oci` | OCI API key + config, if CLI access is ever needed from a new machine |

---

## 4. Known gaps — fill these in

| Node | What's missing |
|---|---|
| `kami-vps-1` | ⬜ local console password via `sudo passwd ubuntu` not yet set |
| `asci-vps-1` | ⬜ SSH auth method unconfirmed; ⬜ host key fingerprint unrecorded; ⬜ root password ⬜ |
| `asci-vps-2` | ⬜ IP, ⬜ plan, ⬜ OS, ⬜ credentials — all unknown |
| `asci-vps-3` | ⬜ existence unconfirmed |

---

## 5. Recovery paths, per node (record in `…recovery.console`)

| Node | If SSH breaks, do this |
|---|---|
| `kami-vps-1` | OCI Cloud Shell → `oci` CLI. **No working console without a key.** Last resort is the boot-volume rebuild documented in `kami-vps1-ssh-access-recovery.md`. Save the key offline — this host has no easy escape hatch. |
| `asci-vps-1` | **Hostinger hPanel → browser terminal.** Works without SSH, without a key, and bypasses both firewalls. This is the good path. |
| `asci-vps-2` | Same, in its own Hostinger account. |
| `asci-vps-3` | Unknown until the host is identified. |

That asymmetry matters: a lost key is a multi-hour project on the OCI box and a
two-minute fix on Hostinger. Budget effort accordingly.

---

## 6. Handling rules

1. Private keys go in the vault **and** in the SSH client. Delete loose `.pem`/`.key`
   files from Downloads and Desktop afterwards.
2. Never paste a private key into a chat, a prompt, a ticket, or a git repo.
3. Rotate any key that has appeared in a chat window — assume it is compromised.
4. The vault's own master password must exist somewhere other than the vault
   (written, sealed, offline) or a lockout is unrecoverable.
5. Re-check one entry every quarter by actually using it. Untested credentials rot.
