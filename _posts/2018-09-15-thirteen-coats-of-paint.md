---
layout: post
title: "Thirteen Coats of Paint"
subtitle: "HTB Poison, where a file-loading form reads your own web logs back to you, and a password buried under thirteen layers of base64 ends up opening every lock on the box"
date: 2018-09-15 12:00:00 +0000
description: "A form that loads any file you name, a password wrapped in thirteen layers of base64, and a root VNC session hiding behind localhost."
image: /assets/og/thirteen-coats-of-paint.png
tags: [hackthebox, writeup]
---

Poison is a box about a thing that reads files out loud without ever asking who is listening. The front page is a small form that politely offers to load a PHP script for you, and it means any script, including ones you never intended it to find. From there the whole machine unspools in a straight line. You point the form at its own web log, you write a command into that log by lying about your browser, and the form reads your command back to itself and runs it. Then you find a password that someone wrapped in thirteen layers of base64 thinking that counted as hiding it, and that one password walks you through SSH, through a locked zip, and finally into a VNC session that has been running as root on localhost the entire time, sitting in the dark waiting for anyone who knew it was there.

```
        P O I S O N
        ===========
        browse.php?file=   "name a file, i'll load it"
                |
                v
        point it at my own access log.
        write a command into the log by faking my browser.
        then ask the form to load the log,
        and it runs what i wrote.
                |
                v
        one password, painted over 13 times,
        unlocks ssh, a zip, and a root desktop
        that was never listening to the outside world.
                                            毒
```

## 0x01 · the loading dock

Two ports answer, and the banner already smells of something off the beaten path.

```
PORT   STATE SERVICE VERSION
22/tcp open  ssh     OpenSSH 7.2 (FreeBSD 20161230)
80/tcp open  http    Apache httpd 2.4.29 ((FreeBSD) PHP/5.6.32)
```

That `(FreeBSD)` tag matters more than it looks. Most boxes are Linux, and your muscle memory for Linux paths and Linux binaries is going to misfire here. FreeBSD keeps its logs in different places and ships a leaner set of command-line tools, so half the reflexes you lean on will hit a wall. Hold that thought, because it shapes every step that follows.

The website is a single form titled like a developer test harness. It offers to load a PHP file for you and even names a few it already knows about: `ini.php`, `info.php`, `listfiles.php`, `phpinfo.php`. The request looks like `browse.php?file=ini.php`. Any time a web app loads a file based on a value you control, your ears should prick up. The page is not describing that file. It is including it, and including a file means reading it, and sometimes running it.

## 0x02 · the form that loads anything

The form lists four files because the author wanted you to load those four files. The vulnerability is that it never bothered to enforce the list. Hand it a name that is not on the menu and it loads that too. Start with the file it advertises that you were not meant to read.

```
http://10.10.10.84/browse.php?file=listfiles.php
```

That returns a directory listing, and sitting in it is a file the menu never mentioned: `pwdbackup.txt`. Picture a coat-check window where the attendant will fetch any coat by ticket number, except the attendant never checks that the number is yours, or even that it belongs to a coat at all. You can ask for the spare key drawer and they will cheerfully walk over and bring it to the counter. The form was built to load four scripts. It will load anything with a name.

```
http://10.10.10.84/browse.php?file=pwdbackup.txt
```

The file is a paragraph of warning text followed by a base64 blob, with a note bragging that the password is safe because it has been encoded many times. That is the moment to grin. Encoding is not encryption. Base64 is a costume, not a lock. Anyone can take the costume off, and they left the dressing room door open.

## 0x03 · thirteen coats of paint

The blob is base64, and decoding it once gives you more base64. Decode that and you get more still. Someone ran the encoder thirteen times and treated each pass like another deadbolt. It is not. It is thirteen coats of the same thin paint, and a one-line loop scrapes all of them off in a second.

```
$ data=$(cat pwd.b64)
$ for i in $(seq 1 13); do data=$(echo "$data" | tr -d ' ' | base64 -d); done
$ echo "$data"
Charix!2#4%6&8(0
```

A password falls out the bottom: `Charix!2#4%6&8(0`. Note the name baked into it. That is almost certainly a username too, and on this box it is. Keep the whole thing. A password with no lock in front of it is just a word, but this box has three locks coming and this is the key to all of them.

## 0x04 · poisoning the log

The form will load any file, so point it at a file the server itself keeps writing to: the Apache access log. On FreeBSD that lives at `/var/log/httpd-access.log`. Every request you make gets a line written there, and one of the things logged verbatim is your `User-Agent` string, the little label your browser uses to introduce itself.

Here is the trick. The server trusts that label enough to write it into the log, but the log is a `.php` file as far as the form is concerned, because the form runs whatever it loads. So you write PHP into your own User-Agent, the server faithfully records it, and then you ask the form to load the log. The form executes the line you planted. This is log poisoning, and it is the same family of bug as the file-loading flaw above, just folded back on itself.

Think of it like signing a guest book at a front desk where, at the end of the day, a clerk reads every line of the book aloud, and anything that sounds like an instruction gets done. So instead of writing your name you write an order. The clerk does not know the difference between a name and a command. They just read the line.

Send one request whose User-Agent carries a tiny PHP payload, described here rather than printed:

```
GET /browse.php?file=ini.php HTTP/1.1
Host: 10.10.10.84
User-Agent: <?php [ one-line webshell: run the c request parameter ] ?>
```

I am describing that payload in brackets rather than pasting the real four words, and that restraint is the lesson, not laziness. The literal string is the textbook PHP webshell, and the instant it lands on a disk any antivirus worth its license quarantines the file, which is a darkly funny proof of how dangerous one short line really is. Picture it, do not paste it.

Now the poison is in the log. Ask the form to load the log and append your command in the `c` parameter the payload reads.

```
http://10.10.10.84/browse.php?file=/var/log/httpd-access.log&c=id

uid=80(www) gid=80(www) groups=80(www)
```

The form read its own log, hit your planted line, and ran it as the web user. Trade that for a proper reverse shell back to your listener, something shaped like `[ reverse shell over the c parameter calling back to 10.10.14.4 on 443 ]`, and you have a foothold as `www`.

## 0x05 · one key, three locks

You do not actually need to climb far from `www`, because you already hold a password and a username from the backup file. SSH straight in as the human.

```
$ ssh charix@10.10.10.84
Password: Charix!2#4%6&8(0
charix@Poison:~ $ id
uid=1000(charix) groups=1000(charix)
charix@Poison:~ $ cat user.txt
████████████████████████████████
```

In charix's home directory sits one out-of-place file: `secret.zip`. A zip with a password is a lock, and we are standing here holding a key that already opened two doors. People reuse passwords like they reuse coffee mugs, and the box is betting you will not even bother trying the obvious. Try it.

```
charix@Poison:~ $ unzip secret.zip
   [secret.zip] secret password: Charix!2#4%6&8(0
  inflating: secret
```

Inside is a tiny binary file called `secret`. It is not text, it is not a flag, and that is the tell. It is a VNC password file.

## 0x06 · the desktop in the dark

Look at what is listening, but listening only to itself.

```
charix@Poison:~ $ sockstat -4 -l
USER     COMMAND    PID   PROTO  LOCAL ADDRESS
root     Xvnc       529   tcp4   127.0.0.1:5901
root     Xvnc       529   tcp4   127.0.0.1:5801
```

VNC, running as root, bound to `127.0.0.1`. That `127.0.0.1` is the whole reason nmap never saw it from outside. The service only answers connections that originate on the box itself, so from the internet it is invisible, and the admin probably called that security. It is not security, it is shyness. Anyone who can get a shell on the host can talk to localhost, and we have a shell.

The problem is your `vncviewer` runs on your machine, not on Poison. So you build a tunnel through SSH that makes Poison's private port look like one of your own. A local forward stitches a port on your laptop straight through the SSH session to the box's loopback.

```
$ ssh -L 5901:127.0.0.1:5901 charix@10.10.10.84
```

Think of it like a pneumatic tube running through your existing SSH pipe. You drop a request into the tube on your end, it travels down the encrypted line you already have open, and it pops out on Poison's side as if a local program had asked. To the VNC server the knock is coming from `127.0.0.1`, which is exactly the only address it trusts. (A dynamic `-D` SOCKS proxy with proxychains gets you to the same place if you prefer a general tunnel over a single forwarded port.)

Now point the viewer at your own forwarded port and feed it the `secret` file as the password. VNC viewers read that file directly, so you never even have to crack it.

```
$ vncviewer 127.0.0.1:5901 -passwd secret
```

A desktop paints itself onto your screen, and the session is root's.

```
# id
uid=0(root) gid=0(root)
# cat /root/root.txt
████████████████████████████████
```

For the curious, the `secret` file decrypts to the plaintext `VNCP@$$!`, but you never needed the plaintext. The file was the key. The lock read it as-is.

## 0x07 · the honest caveat

Poison feels like four separate tricks, but it is really one mistake told four ways, and the mistake is trusting a label. The form trusted that `file` named one of its own scripts. The log poisoning worked because Apache trusted that a `User-Agent` was a harmless description of a browser instead of a possible instruction. Both are the same confession the whole industry keeps making: a program took a value a stranger controlled and treated part of it as a command instead of as inert text. A filename, a browser string, these are envelopes meant to hold text and nothing more. The moment the contents of the envelope reach into the machinery and pull a lever, you have rebuilt the bug.

The base64 is the part worth tattooing somewhere. Thirteen rounds of encoding felt like effort, and effort feels like protection, but encoding hides a secret from absolutely no one. It is reversible by design, in the open, by anyone, with no key. If you can read the blob you can read the secret, full stop. The only thing thirteen passes bought was thirteen seconds of a defender's confidence and a one-line loop on the attacker's side.

And the localhost VNC is the quiet one that should keep an engineer up at night. Nothing about it was unpatched. No CVE, no exploit, no race condition. A root graphical session bound to loopback looked invisible and therefore safe, right up until someone got a shell and remembered that loopback is reachable from inside. Binding to `127.0.0.1` is not access control. It is a curtain, and a tunnel is just someone walking around to the window.

## 0x08 · outro

```
the form loaded any file, because nobody checked the name.
the log ran your line, because a browser label became a command.
the password was painted, not locked, and paint comes off.
and root was sitting at a desktop the whole time,
        certain that facing the wall counted as hiding.

one key for every door. thirteen coats of nothing.
a private port is only private until someone is already inside.

name the file. read the leak. mind the tunnel. wear black.

                                                            EOF
```

---

*HTB: Poison, retired 8 Sep 2018. An easy FreeBSD box that is really a lecture on trusting labels, wearing a file-loading form and thirteen useless coats of base64. The desktop still waits in the dark in a lab and nowhere you don't own.*