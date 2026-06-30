---
layout: post
title: "The Box That Leaked Its Own Keys"
subtitle: "HTB Pandora, where a chatty monitoring port whispers a password, a stale console forges its own admin, and a backup tool trusts a word it should have spelled out in full"
date: 2022-05-28 12:00:00 +0000
description: "An over-sharing SNMP port hands you a password, a vulnerable Pandora FMS console forges its own admin session, and a SUID backup tool that trusts a bare word called tar finishes the climb to root."
image: /assets/og/the-box-that-leaked-its-own-keys.png
tags: [hackthebox, writeup]
---

Pandora is a box about things that talk too much. A monitoring service that answers a stranger and reads the running processes aloud, password and all. A management console two versions past the patch that quietly forges its own admin. And a backup tool, owned by root, that trusts a single bare word and never asks where it came from. Nothing here is a memory-corruption magic trick. Every step is something on the box volunteering a secret it was supposed to keep, and us standing close enough to catch it. The name is the spoiler. Open the box and everything inside spills out.

```
        P A N D O R A
        =============
        udp/161  snmp  )))  "you there?"
                       (((  "yes, and here's what i'm running:
                             host_check -u daniel -p HotelBabylon23"
                        |
                        v
        ssh in. tunnel to the console nobody meant to expose.
        the console forges its own admin. a shell falls out as matt.
                        |
                        v
        a root-owned backup tool says the word `tar`
        without saying which one. so we answer for it.
                                            匣
```

## 0x01 · the three open doors

`nmap` comes back almost rude in its brevity. Two TCP ports, and a UDP port that most scans skip and most defenders forget.

```
PORT    STATE SERVICE VERSION
22/tcp  open  ssh     OpenSSH 8.2p1 Ubuntu 4ubuntu0.4
80/tcp  open  http    Apache httpd 2.4.41 ((Ubuntu))
161/udp open  snmp    SNMPv1
```

The website on 80 is a tidy brochure with nothing to click and nothing to break. SSH wants a credential we do not have yet. The interesting one is the quiet UDP port, 161, running SNMP. Picture a building intercom that anyone on the street can buzz, and the system was set up so it answers every buzz with a full readout of who is inside and what they are doing. That is SNMP with the default community string `public`, which is less a password than a polite cough.

## 0x02 · the port that read its diary aloud

SNMP is the Simple Network Management Protocol, a way for a machine to report its own health to a monitoring server. Disk space, uptime, the list of running processes. Useful internally. A confession booth when it answers strangers. Walk it with `snmpwalk`, asking for the process table, and the box reads its diary out loud.

```
$ snmpwalk -v 2c -c public 10.10.11.136 1.3.6.1.2.1.25.4.2.1.5
...
HOST-RESOURCES-MIB::hrSWRunParameters.1234 = STRING: "-u daniel -p HotelBabylon23"
```

There it is, sitting in a process argument. Some service runs `host_check -u daniel -p HotelBabylon23`, and SNMP dutifully reports the whole command line, password and all. The lesson is older than SNMP itself. A password passed on a command line is not a secret. It is a billboard, because every process on the box can read another process's arguments, and here the billboard got mailed to the whole street. Think of it like writing your PIN on the outside of the envelope so the mail carrier can double-check it for you. Helpful. Catastrophic.

`daniel` reuses that password on SSH, which is the small lazy hinge the whole front half of the box swings on.

```
$ sshpass -p 'HotelBabylon23' ssh daniel@10.10.11.136
daniel@pandora:~$ id
uid=1000(daniel) gid=1000(daniel) groups=1000(daniel)
```

## 0x03 · the console behind the curtain

Daniel is a low user with no flag in his home and no obvious power. So we look at what the box runs only for itself. A quick check of listening sockets shows a service bound to localhost that never appears in the `nmap` from outside.

```
daniel@pandora:~$ ss -tlnp
State   Local Address:Port
LISTEN  127.0.0.1:3306        # mysql
LISTEN  127.0.0.1:80          # a second web server, inside only
```

There is a whole web application living on the loopback interface, deliberately hidden from the internet. The public Apache on the world-facing 80 is the brochure. This inner one is the real machinery. To reach it we borrow daniel's SSH session as a tunnel. Picture SSH as a sealed pneumatic tube run from your desk straight into a locked room. Whatever you drop in your end comes out inside the room, past every wall, because the tube was already trusted to cross them.

```
$ ssh -L 9001:localhost:80 daniel@10.10.11.136
```

Now `http://localhost:9001` on our machine pops out inside the box. What answers is Pandora FMS, an open-source monitoring suite, version `v7.0NG.742`. Two versions matter more than the rest, because two named bugs live in exactly this build.

## 0x04 · a console that forged its own admin

Pandora FMS in this version carries CVE-2021-32099, a SQL injection in `chart_generator.php` reachable through the `session_id` parameter. SQL injection is the same disease that runs through half of this blog. The application builds a database query by gluing your input into a sentence, and if your input is shaped like part of the sentence, the database obeys it as grammar instead of reading it as a name. Here the wound is special, because the table it touches is the one holding everyone's login sessions.

So instead of stealing an existing admin cookie, we write one. The injection lets us forge a session row that claims to belong to the admin account.

```
GET /pandora_console/include/chart_generator.php?session_id=' UNION SELECT '1','2','id_usuario|s:5:"admin";
```

Think of it like a coat-check counter where you can both hand in a ticket and quietly scribble a new ticket stub into the ledger yourself. Write a stub that says coat number one belongs to the manager, hand it back across the counter, and you walk out wearing the manager's coat. We forge the session, set the cookie in the browser, and the console greets us as administrator.

## 0x05 · the shell wearing matt's coat

Admin in Pandora FMS is a loaded position. The same era ships CVE-2020-13851, a command injection in the event-handling code reachable through `ajax.php`, where a `target` field gets passed to the shell with no fence around it. There is also a file manager that will happily host an uploaded file under the web root. Either road ends in our code running on the box. The clean way is the file manager. Drop a tiny PHP file and call it.

```
# uploaded to /pandora_console/images/iceberg.php
<?php [ one-line webshell: run the cmd request parameter ] ?>

$ curl 'http://localhost:9001/pandora_console/images/iceberg.php?cmd=id'
uid=1001(matt) gid=1001(matt) groups=1001(matt)
```

I am describing that webshell in brackets rather than printing it, and that restraint is the point, not squeamishness. The literal one-liner is four words long and is the most copied backdoor on Earth. The instant the real string lands on disk, any antivirus quarantines it as malware, which is the funniest possible proof of how loaded those four words are. Picture it. Do not paste it.

Notice the user. Not daniel. The Pandora console runs under its own account, `matt`, because Apache here is told `AssignUserID matt matt`. So compromising the web app drops us sideways into a different human's shoes. `user.txt` sits in matt's home, ours now.

```
$ cat /home/matt/user.txt
████████████████████████████████
```

## 0x06 · the sandbox that fought back

Here the box throws its one real curveball, and it is worth slowing down for. The natural next move is to hunt for a privilege-escalation path from matt and fire it through the webshell. Do that, and root tools fail with strange permission errors even when they should work. The cause is `mpm-itk`, the Apache module that lets each site run as its own user. This version installs a `seccomp` filter, a kernel-level whitelist of system calls a process is allowed to make, deliberately stripped to block the jump to root. Picture a sandbox with a sign at the gate that reads no growing taller past this line, enforced by the playground itself rather than by any guard. Any shell descended from Apache inherits that sign and cannot escalate, by design.

So we leave the sandbox. From the matt webshell we plant our own SSH key in matt's account and walk back in through the front door, which has no such filter.

```
$ curl 'http://localhost:9001/pandora_console/images/iceberg.php?cmd=mkdir%20-p%20/home/matt/.ssh'
$ curl 'http://localhost:9001/.../iceberg.php?cmd=echo%20[our-ed25519-pubkey]%20>%20/home/matt/.ssh/authorized_keys'

$ ssh -i ./iceberg_key matt@10.10.11.136
matt@pandora:~$ id
uid=1001(matt) gid=1001(matt) groups=1001(matt)
```

Same user, same machine, totally different cage. The webshell was a process born inside the sandbox. The SSH session is a process born free. The lesson rhymes with the rest of the box. How you arrive decides what you are allowed to do, and a restriction bolted to one doorway means nothing if a second doorway stands unlocked beside it.

## 0x07 · the word it forgot to spell out

As matt over real SSH, the privesc is almost gentle. A scan for SUID binaries turns up one that does not belong to the standard set.

```
matt@pandora:~$ find / -perm -4000 2>/dev/null
...
/usr/bin/pandora_backup
```

SUID means the file runs as its owner, root, no matter who launches it. Run it and it tarball-archives the console directory. Pull it apart with `strings` and the flaw is right there in plain sight.

```
matt@pandora:~$ strings /usr/bin/pandora_backup | grep tar
tar -cvf /root/.backup/pandora-backup.tar.gz ...
```

It calls `tar` by its bare name. Not `/usr/bin/tar`, just `tar`. When a program names a command without its full address, the system goes searching down a list of folders called `PATH`, top to bottom, and runs the first match it finds. Think of it like a manager who says fetch me the scissors and trusts whatever lands in his hand, never checking the brand. We control the list. So we put our own folder at the front, drop a thing named `tar` inside that is really a shell, and the root-owned tool fetches our scissors first.

```
matt@pandora:~$ cd /tmp
matt@pandora:/tmp$ printf '#!/bin/bash\nbash -p\n' > tar
matt@pandora:/tmp$ chmod +x tar
matt@pandora:/tmp$ export PATH=/tmp:$PATH
matt@pandora:/tmp$ pandora_backup
matt@pandora:/tmp$ # the root-owned process runs OUR tar
root@pandora:/tmp# id
uid=0(root) gid=0(root) groups=0(root)
root@pandora:/tmp# cat /root/root.txt
████████████████████████████████
```

The backup tool meant to call the real `tar`. It just never said which one, and we answered the question it left open.

## 0x08 · the honest caveat

Pandora is rated easy, and the individual bugs are. But stack them and the box becomes a clean little parable about trust handed to the wrong layer. SNMP trusted that only friendly machines would ever ask, and a password on a command line trusted that no other process would ever read it. The console trusted that a session cookie in its own table was honest. The backup tool trusted that a word like `tar` could only mean the real one. Four different trusts, none of them written down anywhere as a rule, all of them assumed.

The two failures worth losing sleep over are the quiet ones. The SUID path hijack is not a code bug at all, it is a habit. A developer wrote `tar` because `tar` works on their machine, and shipped a root-owned binary that inherits whatever folder an attacker puts in front. You cannot patch that with an update, only with the discipline of spelling out the full path every single time a privileged program calls another. And the mpm-itk sandbox is the inverse lesson, a real defense that did exactly its job and still got walked around, because it guarded one door and the attacker simply used another. A control that protects only the path you imagined is a control that protects nothing. The attacker gets to pick the path.

## 0x09 · outro

```
the port answered a stranger and read its own diary aloud.
the console wrote itself an admin coat and handed it across the counter.
the backup tool said a word without saying which one.

three secrets, none of them stolen. each one was simply left out where we could reach it.

mute the chatty port. spell the path in full. wear black.

                                                            EOF
```

---

*HTB: Pandora, retired 21 May 2022. An easy Linux box that is really a lecture on trust given to the wrong layer, dressed in a monitoring suite that talks too much. The diary still spills in a lab and nowhere you do not own.*