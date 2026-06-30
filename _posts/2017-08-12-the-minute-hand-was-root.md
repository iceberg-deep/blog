---
layout: post
title: "The Minute Hand Was Root"
subtitle: "HTB Cronos, where a zone transfer hands you a hidden door, a tired SQL query lets you walk past the lock, and a clock that runs as root reads a file you are allowed to write"
date: 2017-08-12 12:00:00 +0000
description: "A DNS server that lists its own secrets, a login form that believes a lie, and a root cron job pointed at a file you can edit."
image: /assets/og/the-minute-hand-was-root.png
tags: [hackthebox, writeup]
---

Cronos is named for time, and time is exactly the thing that betrays it. The box runs its own DNS server, and that server will read you its whole address book if you ask the right way, which is how you learn about a hidden admin panel that the front page never mentions. The login form behind that panel believes a sentence that is mostly punctuation. Past it sits a little network tool that pastes your input straight into a shell command, and one shell later you are www-data, standing in front of a wall. The wall has a clock on it. Every sixty seconds, on the minute, root walks up and runs a PHP file that you are allowed to edit. You do not break that last door. You write your name on a file and wait for the clock to read it aloud.

```
        C R O N O S
        ===========
        dig axfr  →  "here is every name i know"
                          admin.cronos.htb  (the door not on the menu)
                     |
        login:  ' or 1=1-- -      the lock believes a lie
                     |
        net tool:  ;[ your command here ]    pasted into a shell
                     |
                     v
        * * * * *  root  php /var/www/laravel/artisan
        the clock reads a file you can write. every minute.
                                            時
```

## 0x01 · the receptionist who reads the whole book

Three ports answer, and they are calm and modern, not the usual fossil parade.

```
PORT   STATE SERVICE VERSION
22/tcp open  ssh     OpenSSH 7.2p2 Ubuntu 4ubuntu2.1
53/tcp open  domain  ISC BIND 9.10.3-P4 (Ubuntu Linux)
80/tcp open  http    Apache httpd 2.4.18 ((Ubuntu))
```

Port 53 is the one that does not belong. A web box does not usually run its own name server, and a name server that answers from the public internet is a receptionist who might be too helpful. The first thing to learn is what name this machine answers to. A reverse lookup against the host points at `ns1.cronos.htb`, which tells you the base domain is `cronos.htb`. Drop both into your hosts file and you have a name to interrogate.

The thing to try against a friendly DNS server is a zone transfer. A zone transfer was built for one server to hand a full copy of a domain to a backup server, the entire list of names in one shot. It was never meant for strangers. Picture a receptionist whose job is to read the company phone book aloud to the other branch office down the line. If she does not check who is calling, she will read the whole book to anyone who dials. So you dial.

```
$ dig axfr cronos.htb @10.10.10.13
cronos.htb.        IN SOA  cronos.htb. admin.cronos.htb. ...
cronos.htb.        IN NS   ns1.cronos.htb.
cronos.htb.        IN A    10.10.10.13
admin.cronos.htb.  IN A    10.10.10.13
ns1.cronos.htb.    IN A    10.10.10.13
www.cronos.htb.    IN A    10.10.10.13
```

There it is. `admin.cronos.htb`, a name the public website never links and you would never have guessed. The front page at `www.cronos.htb` is just default Laravel documentation, a polite dead end. The receptionist read you the one number that was supposed to be unlisted.

## 0x02 · a lock that believes a lie

Browse to `admin.cronos.htb` and you get a plain login form, username and password, nothing else. No version string to chase, no obvious bug, just a box asking who you are. So you lie to it in the oldest dialect there is.

Under the hood, a login form usually builds a database question out of what you typed, something shaped like this:

```
SELECT id FROM users WHERE username = '$user' AND password = '$pass'
```

The danger is that your input gets pasted directly inside those quotes, with no separation between what you wrote and what the query means. Think of it like a fill-in-the-blank form where the blank is not fenced off. You are supposed to write a name in the blank, but if you write a name and then a brand-new instruction, the machine reads the instruction too because nobody drew a line at the edge of the box. Type a username of `' or 1=1-- -` and the quote closes the name early, `or 1=1` makes the condition always true, and `-- -` comments out the password check entirely. The query stops asking whether you are allowed in and starts asking whether one equals one, which it always does.

```
username:  ' or 1=1-- -
password:  anything
→ logged in
```

The lock did not break. It read a sentence that was mostly punctuation and decided the sentence was true.

## 0x03 · a tool that runs your words

Inside, the panel is a single feature called Net Tool v0.1, a dropdown with `ping` and `traceroute` and a box for a host. You pick an action, type an address, and the page runs the network command and shows you the output. Catch the request in a proxy and the shape of the thing is obvious.

```
POST /  HTTP/1.1
command=ping+-c+1&host=10.10.14.4
```

The server is taking `command`, gluing a space and your `host` onto the end, and handing the whole string to a shell to execute. That is the entire vulnerability. The shell does not know where the intended command stops and your input begins. It just runs the line. Picture a kitchen ticket that reads "ping table four." The cook does what the ticket says. Now imagine the ticket reads "ping table four; also set the stove on fire." The cook is not malicious and not stupid. The cook just executes every instruction on the ticket, top to bottom, because that is the job, and nobody told the cook that part of the ticket came from a stranger.

A semicolon ends the intended command and starts yours. Confirm code execution first with something boring and harmless.

```
host=127.0.0.1; id
→ uid=33(www-data) gid=33(www-data) groups=33(www-data)
```

It runs as `www-data`. Now trade the proof for a real foothold by stuffing a reverse shell into the same field. I am describing it rather than printing it, on purpose, because a copy-paste shell on disk is the one thing we never ship.

```
host=;[ bash reverse shell over /dev/tcp back to 10.10.14.4 on 443 ]
```

Start a listener, fire the request, and the box calls home.

```
$ nc -lvnp 443
connect to [10.10.14.4] from 10.10.10.13
$ cat /home/noulis/user.txt
████████████████████████████████
```

While you are here, the admin panel keeps its database password in the clear at `/var/www/admin/config.php`, the user `admin` and the string `kEjdbRigfBHUREiNSDs`. It does not buy you root, but it is a tidy reminder that the same app that trusted your login also wrote its keys on the wall.

## 0x04 · the clock that runs as root

`www-data` is a tenant, not the landlord. The climb is the most patient bug on the box, and you find it by reading the schedule. The system-wide crontab at `/etc/crontab` spells out who runs what, and when.

```
$ cat /etc/crontab
* * * * *  root  php /var/www/laravel/artisan schedule:run >> /dev/null 2>&1
```

Read that line slowly. Five stars mean every minute of every hour of every day. The word after them is `root`. So once a minute, forever, root runs the PHP file at `/var/www/laravel/artisan`. The only question left is who is allowed to change that file.

```
$ ls -l /var/www/laravel/artisan
-rwxr-xr-x 1 www-data www-data 1646 Apr  9  2017 artisan
```

The file is owned by `www-data`, and you are `www-data`. The clock on the wall reads a file once a minute, as root, and you hold the pen for that file. The whole privesc is just that mismatch. Think of it like a night watchman who, on the hour, walks to a clipboard and does exactly whatever the top line says, no questions asked. The clipboard hangs in your office. You write the first line. He has the master keys. You do not need to overpower the watchman. You just need to be holding the pen when he makes his round.

So you prepend a payload to the top of the script, above Laravel's own bootstrap code so the script still looks alive, and let the minute hand do the rest. Again, described, not pasted.

```php
<?php
[ reverse shell to 10.10.14.4:443, placed at the head of artisan ]
// ... the original Laravel bootstrap continues below ...
```

Then you start a second listener and you wait. Not long. Within sixty seconds the watchman makes his round, reads your line, and root dials out.

```
$ nc -lvnp 443
connect to [10.10.14.4] from 10.10.10.13
# id
uid=0(root) gid=0(root) groups=0(root)
# cat /root/root.txt
████████████████████████████████
```

No exploit binary, no kernel race. A scheduled job pointed at a file the wrong account could edit, and time delivered the rest.

## 0x05 · the road not taken

It is worth naming the door the box dangles and then locks, because it teaches the same lesson from the other side. This is a Laravel app, and Laravel had a nasty deserialization flaw (CVE-2018-15133) where a known `APP_KEY` lets you forge a signed, encrypted payload the framework will happily unpack and turn into code. The key is even sitting right there in the environment, `base64:+fUFGL45d1YZYlSTc0Sm71wPzJejQN/K6s9bHHihdYE=`. It looks like a shortcut to root by a flashier path.

It is a dead end here, and the reason is pure plumbing. The exploit needs an endpoint that accepts a POST request, and this app defines exactly one route, a GET on `/` that returns the welcome page. Aim the exploit at it and the server answers `405 Method Not Allowed`, the web equivalent of a locked door with no keyhole. The bug is real and the key is valid, but there is nowhere to push the payload through. Vulnerable is not the same as reachable, and the cron job was always the cleaner way in anyway.

## 0x06 · the honest caveat

None of Cronos is exotic, and that is the point worth holding onto. Three separate doors, and every one of them was a place where a system trusted input it should have fenced off, or trusted an account it should have doubted.

The zone transfer is a configuration left on its factory setting, a name server that answers a copy-the-whole-book request from anyone on earth. Lock it to your real secondaries and the hidden admin panel goes back to being a secret. The SQL injection and the command injection are the same disease in two organs, a query and a shell command, each built by gluing a stranger's text directly into a sentence the machine then obeys. The fix for both is the same fence, the parameter that says this part is data and only data, it does not get to give orders. And the cron job is the quiet one, the one I would lose sleep over, because nothing was unpatched and no exploit ran. A scheduled task ran a file as root, and that file was writable by a web account. The permission did exactly what it was told. You cannot patch your way out of a root job pointed at a tenant's file. You can only notice that the pen and the master key ended up in the same hand.

Cronos is medium not because any single trick is hard, but because you have to walk the whole hallway, and every door is a different flavor of the same confession. Somewhere, something took input from a stranger and treated it as truth.

## 0x07 · outro

```
the receptionist read you the unlisted number.
the lock believed a sentence made of punctuation.
the tool ran the words you wrote on its ticket.
and on the minute, every minute, root read a file you owned.

four doors, none of them forced. each one was held open from the inside.

doubt the input. fence the query. mind the clock. wear black.

                                                            EOF
```

---

*HTB: Cronos, retired 26 May 2017. A medium Linux box that is really a lecture on misplaced trust, from a name server that overshares to a root cron job pointed at a file the wrong account could write. The minute hand still turns in a lab and nowhere you don't own.*