---
layout: post
title: "A Shell Someone Left in the Front Window"
subtitle: "HTB Bashed, where the developer's own debugging webshell is the front door, and a one-line cron job carries you the rest of the way to root"
date: 2018-05-05 12:00:00 +0000
description: "Bashed is a box you walk into through a tool the developer built to make their own life easier, then climb to root on a cron job that trusts whatever file it finds."
image: /assets/og/a-shell-someone-left-in-the-front-window.png
tags: [hackthebox, writeup]
---

Bashed is a box about a tool someone built to make their own life easier and then forgot to take home. The whole site is a little blog bragging about a slick PHP webshell the author wrote called phpbash, and the punchline is that they left a live copy of it sitting in a folder called `/dev` on the very server you are attacking. You do not exploit anything to get your first foothold. You scroll the developer's own blog, follow the breadcrumb to their debugging tool, and start typing commands into a box they built for exactly that purpose. From there it is two short, lazy hops. A sudo rule that lets the web user become a second account with no password, and a root cron job that runs every Python file it finds in a folder you can write to. Nothing here is a memory-corruption magic trick. Every step is convenience left switched on after the work was done.

```
        B A S H E D
        ===========
        the blog brags:  "i built a webshell!"
        and then left one running in /dev
                   |
                   v
        type commands as www-data, no exploit
                   |
        sudo -l  →  become scriptmanager, no password
                   |
        a root cron eats every *.py in /scripts
        and one of those files is now yours
                                            殻
```

## 0x01 · the only open door

`nmap` comes back almost embarrassingly quiet. One port.

```
# nmap -sC -sV -oA bashed 10.10.10.68
PORT   STATE SERVICE VERSION
80/tcp open  http    Apache httpd 2.4.18 ((Ubuntu))
```

A single web server and nothing else. No SSH to brute, no database hanging out, no second service to pivot through. When a box gives you exactly one door, the entire game is on the other side of that door, so the web app is not a sideshow here. It is the whole show. The landing page is a developer blog, and the top post is the author cheerfully announcing a project of theirs, a PHP webshell named phpbash, complete with a screenshot of it running. Read that twice. The site is not describing a vulnerability. It is advertising the exact tool you are about to use against it.

## 0x02 · the breadcrumb in /dev

When a web app gives you one port and a hint, you map the rest of the site by hand. `gobuster` walks a wordlist against the server and tells you which folders actually exist.

```
# gobuster dir -u http://10.10.10.68 -w directory-list-lowercase-2.3-medium.txt
/images   (Status: 301)
/uploads  (Status: 301)
/php      (Status: 301)
/css      (Status: 301)
/dev      (Status: 301)
/js       (Status: 301)
```

Think of `gobuster` like a courier knocking on every door number on a street and writing down which ones open. Most of these are boring asset folders. The one that matters is `/dev`, because `/dev` has directory listing turned on, so the server just hands you the contents of the folder like an unlocked filing cabinet left in a hallway. Inside are two files: `phpbash.php` and `phpbash.min.php`. The blog post you read in the last section was the menu. This folder is the kitchen, and the door is propped.

## 0x03 · a shell with a nice UI

Open `http://10.10.10.68/dev/phpbash.php` in a browser and you are looking at a terminal. Not a hint of a terminal, not a path to one you have to build. An actual interactive prompt rendered in the page, blinking cursor and all, running every command you type on the server as the web user.

```
www-data@bashed:/var/www/html/dev$ id
uid=33(www-data) gid=33(www-data) groups=33(www-data)
www-data@bashed:/var/www/html/dev$ cat /home/arrexel/user.txt
████████████████████████████████
```

This is the part worth sitting with. A webshell is normally the *prize* at the end of an exploit chain. You find an upload bug or an injection, you sneak a file onto the box, and the reward is a prompt like this one. Bashed skips the entire heist and leaves the prize sitting in the lobby. The developer wrote phpbash to debug their own server, used it, and never deleted it. Picture a locksmith who builds a master key to test the building's locks, then tapes it to the inside of the front window so it is handy next time. Convenient for them, and convenient for the next person who walks past and looks in. The user flag is already yours, read straight out of `arrexel`'s home directory.

The browser shell is clumsy for real work, though. It has no job control, no real interactivity, and it forgets who you are between requests. So trade up to a proper reverse shell, where the box reaches back out to a listener you control and hands you a normal terminal.

```
# nc -lvnp 1235
# then from phpbash, fire:
[ python reverse shell over a socket back to 10.10.14.4 on 1235 ]
```

I am not pasting the literal one-liner, and that restraint is the lesson rather than caution for its own sake. A reverse shell is a few lines of glue that wires the box's input and output to a socket pointed at you, and the moment that exact string lands somewhere it gets flagged as exactly what it is. Picture the plumbing, do not copy the pipe. Catch the connection and you have a real `www-data` shell with the box dialing you instead of the other way around.

## 0x04 · the password nobody asked for

`www-data` is a low-privilege nobody, the account a web server runs as so that a hacked website cannot wreck the whole machine. The first thing to ask any Linux foothold is what it is allowed to do as someone more important, and `sudo -l` answers that.

```
www-data@bashed:/$ sudo -l
User www-data may run the following commands on bashed:
    (scriptmanager : scriptmanager) NOPASSWD: ALL
```

Read that line slowly. The web user is permitted to run any command as the user `scriptmanager`, and `NOPASSWD` means it does not even have to prove who it is. `sudo` exists to let the right people borrow more authority when they need it, like a manager who can sign off on a refund a clerk cannot. This rule signs the refund for anyone wearing the clerk's apron, no questions asked. So you put on the apron.

```
www-data@bashed:/$ sudo -u scriptmanager /bin/bash
scriptmanager@bashed:/$ id
uid=1001(scriptmanager) gid=1001(scriptmanager) groups=1001(scriptmanager)
```

No exploit, no password, no clever trick. The box handed you a second identity because a config file said it could. The only question left is why `scriptmanager` matters, and the name is the whole hint.

## 0x05 · the script that ate itself

Walk the filesystem as the new user and one folder stands out, because its ownership is strange. A directory called `/scripts` sits at the root of the disk, and inside it the two files tell a small story.

```
scriptmanager@bashed:/scripts$ ls -la
-rw-r--r-- 1 scriptmanager scriptmanager   58 Dec  4 ... test.py
-rw-r--r-- 1 root          root          12 ... test.txt
```

Look at the mismatch. `test.py` is a Python script owned by `scriptmanager`, which is you. `test.txt` is the *output* of that script, and it is owned by `root`. A file you can edit produces a file owned by the most powerful account on the machine. That only happens one way: something running as root is executing your script on a schedule. That something is `cron`, the Linux task scheduler, and a job in root's crontab walks into `/scripts` every minute and runs every `.py` file it finds.

```
* * * * * cd /scripts; for f in *.py; do python "$f"; done
```

Think of it like a night-shift supervisor with a master key who comes by every minute, picks up any to-do note left on the desk, and carries out the instructions personally, no matter who wrote the note. The supervisor has root's keys. The desk is a folder you can write to. So you leave a note.

You do not even touch `test.py`. You drop a brand-new script beside it, sign it `iceberg` so it is yours and out of the way, and let the loop pick it up.

```
scriptmanager@bashed:/scripts$ cat > iceberg.py <<'EOF'
[ python reverse shell over a socket back to 10.10.14.4 on 443 ]
EOF
```

Again, the payload is bracketed on purpose. It is the same shape of glue from the foothold, just running as a far more dangerous user. Start a listener, wait up to sixty seconds for the cron tick, and the supervisor reads your note in root's voice.

```
# nc -lvnp 443
connect to [10.10.14.4] from (UNKNOWN) [10.10.10.68]
# id
uid=0(root) gid=0(root) groups=0(root)
# cat /root/root.txt
████████████████████████████████
```

## 0x06 · the honest caveat

It is easy to file Bashed under "too easy to count," a box you root in fifteen minutes and never think about again. But the two real lessons here are not easy at all in the wild, because neither one is a bug. They are habits.

The foothold is a debugging tool left in production. phpbash was not malware sneaked onto the box. It was a legitimate thing the developer built for themselves, used during development, and forgot to remove before going live. Every codebase has these. A test endpoint that skips auth, a `/debug` route that dumps environment variables, an admin panel that was supposed to be deleted, a verbose error page that prints the database password. None of them are vulnerabilities in the textbook sense. All of them are doors someone meant to close and didn't, and an attacker reading your own blog will find them faster than your own team will.

The privesc is the same disease in a different organ. The root cron job trusts a folder it does not own. It runs whatever Python it finds there, and the folder is writable by a lower account, so "run my scheduled task" quietly became "run anything anyone drops here, as root." Automation that executes files from a location it does not strictly control is one of the most common privilege-escalation paths there is, precisely because it looks so harmless on the day it is written. The supervisor was only ever supposed to read the developer's own notes. Nobody decided he should read a stranger's. The permissions decided it for him, and permissions do not have judgment. They just do what they were told, forever, at one in the morning when nobody is watching.

## 0x07 · outro

```
the developer built a shell to debug their own box,
then taped it to the inside of the front window.

a sudo rule lent out a second face for free.
a cron job ate a note it should never have read,
and signed the work in root's own hand.

nothing was forced. every door was held open from the inside.
delete the debug tool. mind what your robots trust. wear black.

                                                            EOF
```

---

*HTB: Bashed, retired 4 May 2024. An easy Linux box that is really a lecture on the things we leave running after the work is done, a developer's webshell and a cron job that trusts the wrong folder. The shell still blinks in a lab and nowhere you don't own.*