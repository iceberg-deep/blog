---
layout: post
title: "The Box That Talked Too Much"
subtitle: "HTB Pit, where a chatty SNMP daemon names the hidden web app, then runs your script as root when nobody told it to stop"
date: 2021-10-02 12:00:00 +0000
description: "A talkative SNMP daemon leaks a hidden web app, an upload form runs your code, and the same daemon hands you root because it executes scripts on command."
image: /assets/og/the-box-that-talked-too-much.png
tags: [hackthebox, writeup]
---

Pit is a box that cannot keep a secret, and then a box that follows instructions a little too eagerly. The whole machine turns on one chatty service running quietly on a UDP port most people forget to scan. Ask it nicely and it reads you its own diary out loud, including the exact path to a web app nobody linked from the front page. That app has an upload form that runs whatever you feed it, so you get a foothold the moment you know where to look. SELinux then slaps your reverse shell out of the air, which is the most interesting thing on the box, because it forces you to win without the usual trick. And the way back up to root is the same loose-lipped daemon from the start, now wearing a second hat, running a script you wrote because somebody told it to and never told it to stop.

```
        P I T
        =====
        udp/161  snmp  "ask me anything"
              |
              v
        "the web app lives at /var/www/.../seeddms,
         the admin is michelle, and oh, the db
         password is right here in settings.xml"
              |
              v
        upload form runs your code. selinux pins
        the reverse shell to the mat. you walk in
        the front door instead, with michelle's key.
              |
              v
        snmp also runs scripts as root on request.
        you write the script. you make the request.
                                            坑
```

## 0x01 · the three doors and the open window

The TCP scan is short and tells you almost nothing.

```
# nmap -p- --min-rate 10000 10.10.10.241
PORT     STATE SERVICE
22/tcp   open  ssh
80/tcp   open  http      nginx 1.14.1
9090/tcp open  ssl       Cockpit / CentOS Web Console
```

Three ports, and two of them are login prompts you have no credentials for. The TLS certificate on 9090 leaks a hostname, `dms-pit.htb`, which is the first crumb. But the real door is not on TCP at all. SNMP, the Simple Network Management Protocol, lives on UDP 161, and UDP scans get skipped constantly because they are slow and most people are in a hurry. Run the one scan everyone forgets.

```
# nmap -sU --top-ports 20 10.10.10.241
161/udp open  snmp
```

There it is. SNMP is the protocol network gear uses to report its own health, how much memory is free, which disks are full, what is running. Think of it like the back of a server's name badge, the part that lists every department it works in and where its desk is. It was built for an era when the only people on the network were the people who owned it, so by default it answers to a password that is, no joke, the word `public`.

## 0x02 · the daemon that read its diary aloud

`snmpwalk` reads every value the daemon will surrender. The `public` community string is the default read password, and Pit never changed it.

```
# snmpwalk -v1 -c public 10.10.10.241 .  > snmpwalk-full
```

The dump is enormous, thousands of lines, and buried in it are the things that matter. The hostname is `pit.htb`. The OS is CentOS 8. There is a local user named `michelle`. And the disk inventory hands you a path you would never have guessed by fuzzing.

```
HOST-RESOURCES-MIB::hrStorageDescr = STRING: /var/www/html/seeddms51x/seeddms
```

That single line is the box. SNMP just told you there is a copy of SeedDMS, a document management web app, sitting at a path nothing on port 80 links to. Picture asking a building's facilities computer how full the storage closets are, and it answers by reading you the floor plan, including the room marked "do not enter." You did not break in. The building described itself to a stranger.

Two more values in the same dump are worth circling. The daemon advertises an "extend" entry called `monitoring` pointing at a script. Hold that. It pays out at the very end.

```
NET-SNMP-EXTEND-MIB::nsExtendCommand."monitoring" = STRING: /usr/bin/monitor
```

## 0x03 · the upload form that ran your code

Map `dms-pit.htb` to the box in your hosts file and the SeedDMS install loads at `http://dms-pit.htb/seeddms51x/seeddms/`. The version is 5.1.15, and that exact build carries CVE-2019-12744, a remote code execution bug that is barely an exploit at all. It is a file-upload form that forgot to care what you upload.

First you need to be logged in, and SNMP did half that job too. SeedDMS keeps its database credentials in a config file sitting one directory up from the app, world-readable to anyone who knows the path SNMP just leaked.

```
# curl http://dms-pit.htb/seeddms51x/conf/settings.xml | grep -i pass
  dbPass="ied^ieY6xoquu"
```

That is the database password, but on this box it is also michelle's password, because it was reused. One secret, two locks. Log into SeedDMS as `michelle` and the document upload page is wide open.

The vulnerability is that SeedDMS stores uploaded documents on disk under a predictable numbered path and never checks that a `.php` file is not, in fact, PHP. There is an `.htaccess` file meant to block execution in the data folder, but nginx ignores `.htaccess` entirely. It is an Apache thing. So the guard rail was bolted to the wrong wall. Upload a one-line webshell as a document.

```
# the file you upload, conceptually:
<?php [ one-line webshell: run the cmd request parameter ] ?>
```

I am describing that file rather than printing it, and that restraint is the lesson, not caution for its own sake. The literal string is four tokens long and it is the single most quarantined pattern in any antivirus signature set on Earth. Drop the real thing on a disk and a scanner eats it on sight, which is a perfect demonstration of how loud and dangerous a one-line shell actually is. So picture it.

SeedDMS files its uploads under a tidy numbered path, and the document ID is right there in the URL after you upload. Curl the stored copy and pass it a command.

```
# curl 'http://dms-pit.htb/seeddms51x/data/1048576/31/iceberg.php?cmd=id'
uid=992(nginx) gid=988(nginx) context=system_u:system_r:httpd_t:s0
```

You are on the box as `nginx`. Read that `context=` field at the end. That is SELinux, and it is about to ruin the next ten minutes of your life in the most instructive way possible.

## 0x04 · the wall that ate the reverse shell

Every instinct says trade the webshell up for a reverse shell and get an interactive prompt. Every attempt dies.

```
# curl -G 'http://dms-pit.htb/.../iceberg.php' \
    --data-urlencode 'cmd=[ nc reverse shell to 10.10.14.4:443 ]'
Ncat: Permission denied.
```

The binary exists. The command is correct. The connection still never leaves the building. This is SELinux in enforcing mode, and it is the heart of the box. Normal Linux permissions ask "who are you, and do you own this file." SELinux adds a second question that does not care who you are at all. It asks "what is this process allowed to do, by type." The web server runs in a type called `httpd_t`, and the policy for `httpd_t` says, flatly, a web server has no business opening a brand-new outbound socket to a random port. So it does not get to.

Think of it like a hotel keycard that opens your room and the gym, and nothing else, no matter whose name is on it. You can be the manager standing right there with the master key in your pocket, but this card simply was not cut to open the wine cellar, so the door stays shut. The webshell can read files and run local commands all day. It cannot phone home, because phoning home is not on the card.

So you stop fighting the wall and walk around it. You already have michelle's password from the config. Port 9090 is Cockpit, the CentOS web console, which offers a full browser terminal to anyone who can log in. Log in as michelle, open the terminal tab, and you have a real, interactive, SELinux-blessed shell as her, no reverse connection required.

```
[michelle@pit ~]$ id
uid=1000(michelle) ... context=unconfined_u:unconfined_r:unconfined_t:s0
[michelle@pit ~]$ cat user.txt
████████████████████████████████
```

Notice michelle's context is `unconfined_t`. The wall that pinned the web server never applied to her at all. The front door was always the easier way in.

## 0x05 · the daemon's second job

Remember the `monitoring` extend entry SNMP advertised back in section two. Now it cashes out. SNMP on this box is not just a reporter. It is configured to run a local script on demand, the one at `/usr/bin/monitor`, and that script is short and trusting.

```
[michelle@pit ~]$ cat /usr/bin/monitor
#!/bin/bash
for script in /usr/local/monitoring/check*sh ; do
    /bin/bash $script
done
```

It loops over every file in `/usr/local/monitoring` whose name starts with `check` and ends in `sh`, and runs it. And the snmpd daemon that calls this script runs as root. So anything dropped in that folder runs as root the next time someone walks the SNMP tree. The only question is whether you can write to the folder, and the normal permissions say no, the directory belongs to root.

But SELinux is not the only thing on this box bolting extra rules onto plain Unix permissions. Check the ACL, the access control list, which can grant one specific user rights the group and owner bits do not show.

```
[michelle@pit ~]$ getfacl /usr/local/monitoring
# file: usr/local/monitoring
user::rwx
user:michelle:-wx
group::rwx
```

There it is. `user:michelle:-wx`. Michelle, specifically, can write into and execute from the root-owned monitoring folder. Picture a locked tip jar bolted to the counter that everyone can see but nobody can reach into, except there is a slot cut in the lid with one cashier's name engraved beside it. The jar is sealed. The slot has your name on it. So you post a note through it.

Write a `check` script that does something useful for root. The cleanest move is to plant your own SSH key in root's `authorized_keys`, then walk in the front door as root.

```
[michelle@pit ~]$ echo 'echo "ssh-ed25519 AAAA...iceberg" >> /root/.ssh/authorized_keys' \
    > /usr/local/monitoring/check_iceberg.sh
```

The file sits there inert until someone asks SNMP for the monitoring data. So you ask. From your own machine, walk the extend tree, which triggers `/usr/bin/monitor`, which runs your script as root.

```
# snmpwalk -v1 -c public 10.10.10.241 NET-SNMP-EXTEND-MIB::nsExtendObjects
```

A moment later your key is in root's file. SSH in.

```
# ssh -i iceberg_ed25519 root@10.10.10.241
[root@pit ~]# id
uid=0(root) gid=0(root) ... context=unconfined_u:unconfined_r:unconfined_t:s0
[root@pit ~]# cat root.txt
████████████████████████████████
```

The same service that read you the floor plan in section two just ran your code as root in section five. It was helpful at both ends.

## 0x06 · the honest caveat

Nothing on Pit is a memory-corruption magic trick or a zero-day. Every single step is a service doing exactly what it was configured to do, for someone who was never supposed to be asking. SNMP answering to `public` is not a bug. It is a default that made sense in 1990 when the network was a locked room, and makes no sense now that the network is the entire planet. The upload form running PHP is a missing check that a single line of allow-list could have caught. The reused database password is one person's tired afternoon. The root privesc is a convenience script wired to a network-reachable trigger with a write slot left open by an ACL someone probably set "just for testing."

The piece worth keeping is the SELinux act, because it is the one thing on the box that worked. Enforcing mode caught the reverse shell mid-leap and threw it back, and it did so without knowing or caring that the web server had been compromised. That is the whole point of the thing. Ordinary permissions trust a process to behave because of who launched it. SELinux assumes the process is already lying and pens it into the smallest yard that still lets it do its actual job. It did not save the box, because the box had three other unlocked doors, but it changed how the box had to be solved, and a defender who runs enforcing mode buys exactly that, an attacker who has to work harder and gets caught more. You cannot patch a reused password or an over-eager SNMP config with SELinux. But the day a real intrusion happens, the wall that ate the reverse shell is the wall you will be glad you built.

## 0x07 · outro

```
the daemon read its diary to a stranger.
the upload form ran a sentence as if it were code.
the wall caught the shell, so you used the door.
then the daemon ran your script as root, because you asked.

a service that answers anyone will answer the wrong one.
a trigger reachable over the network is a trigger anyone can pull.

mute the chatter. allow-list the upload. wear black.

                                                            EOF
```

---

*HTB: Pit, retired 25 Sep 2021. A medium Linux box that is really a lecture on a service too willing to talk and too willing to obey, with SELinux as the one adult in the room. The SNMP string is still `public` in the lab and nowhere you don't own.*