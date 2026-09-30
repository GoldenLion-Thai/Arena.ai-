# Terminus setup and persistent logins

Everything needed to reach all four hosts from Terminus on Windows 11, and to stop
sessions dying every time the network blips.

---

## 1. Terminus host entries

Create one host per row. **Password field: leave blank on every one.**

| Field | kami-vps-1 | asci-vps-1 | asci-vps-2 | asci-vps-3 |
|---|---|---|---|---|
| Label | `kami-VPS-1` | `ASCi-VPS-1` | `asci-vps-2` | `asci-vps-3` |
| Address | `132.145.57.78` | `72.61.203.79` | ⬜ unknown | ⬜ unknown |
| Port | `22` | `22` | `22` | `22` |
| Username | `ubuntu` | **`root`** | `root` (likely) | ⬜ |
| Auth | key `kami_vps` | ⬜ key or password | ⬜ | ⬜ |
| Keep alive | `60` | `60` | `60` | `60` |

⚠️ **`ubuntu` vs `root` is the single most common mistake here.** The OCI box uses
`ubuntu`; Hostinger boxes default to `root`. Wrong user = instant `Permission denied`.

### Adding the key in Terminus

Settings → SSH → Keys → **New Key** → paste.

Paste the **entire** block, including the dashed first and last lines:

```
-----BEGIN OPENSSH PRIVATE KEY-----
…body…
-----END OPENSSH PRIVATE KEY-----
```

Omitting the dashed lines is the cause of Terminus failing with
`closed with error: end of file` right after `Starting SSH key selection` — it cannot
parse a key without its delimiters.

---

## 2. Persistent logins — four mechanisms, use the first three

### (a) Keepalives — stops idle NAT/firewall timeouts

Already emitted by `merc sshconfig`. If configuring Terminus by hand, set
**Keep alive / ServerAliveInterval = 60**. A 60-second heartbeat is invisible to
servers and defeats the common 5-minute idle drop.

### (b) `tmux` — a disconnect no longer kills your work

This is the real answer to "log in persistently". The session lives **on the server**;
your terminal is just a window onto it. Close the laptop, reopen it, reattach, and
everything is exactly where you left it.

```bash
# install once per host
sudo apt install -y tmux

# start a named session
tmux new -s grid

# detach (leave it running):  Ctrl+B  then  D
# list sessions:              tmux ls
# reattach:                   tmux attach -t grid
```

Cheat sheet: `Ctrl+B C` new window · `Ctrl+B N`/`P` next/prev · `Ctrl+B %` split vertically ·
`Ctrl+B "` split horizontally · `Ctrl+B D` detach.

Add this to `~/.tmux.conf` for a status line and sane scrolling:

```
set -g mouse on
set -g history-limit 50000
set -g status-bg colour240
```

### (c) Connection multiplexing — instant reconnects

One TCP connection is reused for every subsequent session to the same host. New tabs open
instantly instead of re-handshaking.

```
Host *
    ControlMaster auto
    ControlPath ~/.ssh/sockets/%r@%h-%p
    ControlPersist 10m
```

Create the directory first: `mkdir -p ~/.ssh/sockets && chmod 700 ~/.ssh/sockets`

### (d) Mosh — only if you need roaming

Mosh survives IP changes (train Wi-Fi → phone hotspot). Cost: it needs **UDP ports
60000–61000** open on the host's firewall, and it does not do scrollback or X11.

```bash
sudo apt install -y mosh          # on the server
# then open UDP 60000:61000 in the provider firewall too (hPanel for Hostinger)
```

Recommendation: **tmux + keepalives + multiplexing covers 95% of the need.** Add Mosh
later if you actually roam between networks.

---

## 3. Install the generated config

```bash
# review first
./scripts/merc sshconfig

# then install (check for duplicate Host blocks first!)
./scripts/merc sshconfig >> ~/.ssh/config
chmod 600 ~/.ssh/config
```

After that, `ssh kami-vps-1` and `ssh asci-vps-1` just work from any terminal. Terminus
can also import `~/.ssh/config` rather than re-entering hosts by hand.

---

## 4. Verify a host key before trusting it

First connection to a host shows a fingerprint. Check it matches:

| Host | Expected fingerprint |
|---|---|
| `kami-vps-1` | `SHA256:ctjfO828VB8O6gBGd8nUXChZo4MMQftXfhLeEIta0DU` (ECDSA) |
| `asci-vps-1` | ⬜ record it on first trusted connection |
| `asci-vps-2` | ⬜ |
| `asci-vps-3` | ⬜ |

A changed fingerprint on a host you did not rebuild is a genuine warning sign — stop and
investigate rather than typing `yes`.

---

## 5. Quickest path when a host is unreachable

1. `./scripts/merc status all`
2. Hostinger box down → **hPanel browser terminal** (works regardless of SSH or firewall)
3. OCI box down → check instance state in the console; if it is `STOPPED`, start it —
   do not terminate
4. Still nothing → the provider status page before touching anything
