# STATUS UPDATE: Instance kami-VPS-asci is Live

> Paste this to any other agent or assistant picking up work on this server.
> It contains no secrets, no OCIDs and no keys.

Please be advised that the instance **kami-VPS-asci** (OCI display name `kami-VPS-1`)
is live and fully operational.

**State**
Running on its original 200 GB boot volume with all data intact.
Ubuntu 24.04.4 LTS aarch64, `VM.Standard.A1.Flex`, 4 OCPU / 24 GB.
Hostname `kami-vps-1`. Disk in use: 8.7 GB of 193 GB (5%).

**Services**
The Docker stack is healthy and active:

| Container | Purpose |
|---|---|
| coolify, coolify-db, coolify-redis, coolify-realtime, coolify-sentinel | Coolify platform |
| coolify-proxy | edge proxy (80/443/8080) |
| kami-vaultwarden | password vault |
| kami-postgres, kami-redis | application data |
| portainer_agent | container management |

**Access**
SSH is **key-only**. Password authentication over the network is disabled and must stay
that way — do not set `PasswordAuthentication yes`, do not restart sshd to make password
login work. Access is the `kami_vps` RSA key with user `ubuntu`.

**Standing rules for anyone working on this box**

1. **Stop, never Terminate.** Terminating costs the instance and any Always Free capacity
   attached to it. Recovery from termination is possible only because the boot volume
   survives — do not rely on that.
2. **No network password SSH.** A local console-recovery password (`sudo passwd ubuntu`)
   is fine; it does not enable network password login.
3. **Do not downsize CPU/RAM.** The 4 OCPU / 24 GB allocation is deliberate. Under the
   June 2026 Always Free change, a rebuild may not be able to get it back.
4. Type commands rather than pasting multi-line blocks — the terminal wraps pastes in
   bracketed-paste markers and the shell then cannot find the command.
5. The public IP changed when the instance was rebuilt. Anything that pointed at the old
   IP (DNS A records, Coolify config, Tailscale, monitoring) needs updating.

**Current follow-ups**

- Confirm the temporary helper VM's boot volume was released and is not billing as an
  orphan (see `kami-vps1-cost-and-capacity.md`, section 5).
- 45 package updates pending, one of them a security update.
