---
layout: post
title: "The Blog That Kept a Diary"
subtitle: "HTB Blunder, where a to-do list names the user, a forged header beats the lockout, an old install gets left in the basement, and a minus sign becomes root"
date: 2020-10-24 12:00:00 +0000
description: "A blog confesses its own user in a to-do file, a spoofed header sidesteps the login lockout, and a forgotten old copy of the CMS hands over the password that walks straight to root through one missing minus sign."
image: /assets/og/the-blog-that-kept-a-diary.png
tags: [hackthebox, writeup]
---

Blunder is named after the kind of mistake nobody thinks they make. Not a zero-day, not a memory corruption magic trick, just a blog that wrote its own secrets into a public file and a server that never cleaned out the old version of itself before it shipped. Every step here is somebody being a little too honest, a little too lazy, or a little too clever. A to-do list tells you the username. A login page meant to stop guessing forgets which guesser it is talking to. A copy of the site nobody deleted hands over a reused password. And right at the end, a sudo rule built to keep you out of root has a hole shaped exactly like a minus sign. You do not force this box. You read it like a diary somebody left open on the table.

```
        B L U N D E R
        =============
        /todo.txt   "remember to lock out fergus, fix the old CMS"
                    |
        login lockout?  "too many tries from your IP"
        forge the IP each time  →  it never counts to three
                    |
        upload a .php as an image. it stays in /tmp.
        turn off the rewrite rule. visit it. shell.
                    |
        an old copy of the site still has the password.
        sudo -u#-1  →  the minus sign is root.
                                            錯
```

## 0x01 · the storefront

Two ports answer, and the box is almost shy about it. A quick `nmap -sC -sV` gives you SSH that will not let you in yet and a single web server.

```
PORT   STATE SERVICE VERSION
21/tcp closed ftp
22/tcp closed ssh
80/tcp open   http    Apache httpd 2.4.41 ((Ubuntu))
```

So everything lives on port 80. The front page is a personal blog, the kind a hobbyist stands up in an afternoon, and the interesting part is not what it shows you but what it admits to. A little directory and file hunting turns up two things worth their weight. There is an `/admin/` login that belongs to Bludit, a flat-file CMS that stores its whole world in PHP files instead of a database. And there is a stray `/todo.txt` sitting in the web root, readable by anyone who asks.

That to-do file is the first blunder. It reads like a sticky note the developer never meant to publish, and it names a user, **fergus**, and frets about an out-of-date CMS that still needs upgrading. Picture a shopkeeper who tapes their closing checklist to the inside of the front window. To them it faces in. To everyone on the sidewalk it faces out. The note was for the staff. The street can read it too.

## 0x02 · pinning the version

Before you attack the login you want to know exactly which Bludit you are facing, because the bugs here are version-specific and guessing wastes a day. Bludit does not print its version on a banner, so you read it sideways. It bundles the TinyMCE text editor, and editors carry their own version files. Pull the metadata for the bundled editor.

```
$ curl -s http://10.10.10.191/bl-plugins/tinymce/plugins/.../metadata.json | grep version
"version": "5.0.8"
```

That TinyMCE build maps to **Bludit 3.9.2**. The next Bludit release, 3.10.0, shipped a newer editor and quietly patched the two holes we are about to walk through. Think of it like reading the date code stamped on a tire to learn the model year of a car nobody will tell you the year of. The badge was filed off, but the parts have their own birthdays. 3.9.2 it is, and 3.9.2 is exactly the version that bleeds.

## 0x03 · the lockout that could not count

Now the login. We have a username, fergus, and we need a password. Bludit 3.9.2 has a brute-force protection that, on paper, should make password guessing pointless. After a handful of failed logins it locks further attempts. The blunder is in *how* it decides who is attempting.

To be friendly to people behind shared connections, the lockout keys off the visitor's IP address, and it trusts the `X-Forwarded-For` header to learn that address. That header is something the client sends. So the very value the server uses to decide "this is the same guesser, lock them out" is a value the guesser gets to write. Change it on every request and the server believes a fresh stranger shows up each time, none of them ever reaching the limit.

Picture a club with a bouncer who turns people away after three rejections, but instead of remembering faces he just reads the name off whatever sticker you wear. Peel off the sticker, write a new name, and to him you are a person he has never seen. You can knock all night.

A short script handles it. Pull the CSRF token from the login form, set a different `X-Forwarded-For` on every attempt, and feed it a wordlist. The wordlist matters here. A generic rockyou run goes nowhere, but `cewl` scraped against the blog's own prose builds a few hundred candidate words straight out of the author's writing, which is where vanity passwords love to hide.

```
$ cewl -d 3 -m 6 -w words.txt http://10.10.10.191
# then spray, rotating X-Forwarded-For per try:
#   X-Forwarded-For: <something new each request>
#   tokenCSRF=<scraped>&username=fergus&password=<candidate>

[-] fergus : Permission
[-] fergus : Author
[+] fergus : RolandDeschain
```

Sixteen seconds of spraying and fergus falls. The password is **RolandDeschain**, a name pulled from the author's own blog about a book series, which is exactly the kind of word a homemade wordlist catches and a generic one never would.

## 0x04 · the image that was not an image

Logged in as fergus, you have the Bludit admin panel, and Bludit 3.9.2 has a file-upload flaw that turns "post an image" into "run my code." Bludit checks the extension of an uploaded file and rejects anything that is not a real image. The blunder is the *order* of operations. The file is written to a known temporary folder *first*, and only then does the extension check run. When the check fails, Bludit refuses the upload, but it never deletes the file it already wrote.

Think of a mailroom that drops your parcel on the sorting shelf, then checks the label, decides it is not allowed, and stamps it REJECTED, but walks away and leaves the parcel sitting right there on the shelf where anyone can grab it.

So you upload a PHP file pretending to be a picture. The check rejects it. The file is now sitting in `/bl-content/tmp/`. There is one more snag. An `.htaccess` rule in that folder tells Apache not to execute scripts there. But you can upload too, and Apache lets a folder's own `.htaccess` override the parent. Upload a one-line `.htaccess` that simply turns the protection off.

```
# the planted PHP, signed iceberg, sitting in /bl-content/tmp/iceberg.php
<?php [ one-line webshell: run the cmd request parameter ] ?>

# the .htaccess uploaded alongside it
RewriteEngine off
```

I am describing the webshell rather than printing it, and that restraint is the lesson, not modesty. The real thing is shorter than this sentence, and the instant the literal string touches disk any decent scanner quarantines it as malware, which is the funniest possible proof of how loaded a one-line webshell really is. Picture it; do not paste it.

Visit the planted file with a `cmd` parameter and the server runs your commands. Trade up from the webshell to a proper callback.

```
$ curl 'http://10.10.10.191/bl-content/tmp/iceberg.php?cmd=id'
uid=33(www-data) gid=33(www-data) groups=33(www-data)

# [ bash reverse shell over /dev/tcp back to 10.10.14.4 on 443 ]
$ nc -lvnp 443
connect to [10.10.14.4] from 10.10.10.191
www-data@blunder:/$
```

You are on the box as **www-data**, the low-privilege identity the web server wears.

## 0x05 · the basement copy

www-data cannot read the user flag, so you go looking for the next pair of shoes. Bludit keeps its accounts in flat PHP files, and here is the third blunder, the laziest and the most human. The live site lives in one directory, but there is a second, older copy of Bludit sitting right next to it on disk. Somebody upgraded by copying the site to a new folder and never deleted the old one. Read both account databases.

```
www-data@blunder:/$ ls /var/www/
bludit-3.9.2  bludit-3.10.0a

www-data@blunder:/$ cat /var/www/bludit-3.10.0a/bl-content/databases/users.php
...
"hugo": { "nickname":"Hugo",
          "password":"faca404fd5c0a31cf1897b823c695c85cffeb98d", ... }
```

A new user, **hugo**, appears in the leftover install, with his password stored as a bare SHA-1 hash and no salt. Unsalted SHA-1 of a common password is barely a lock at all. A lookup service cracks it on sight.

```
faca404fd5c0a31cf1897b823c695c85cffeb98d  →  Password120
```

And here is the quiet hinge the whole box turns on. That password was for the *web* account hugo, in a copy of the site nobody is even using. But people reuse passwords like they reuse coffee mugs, and the same word is the Linux login for the system user named hugo. Same key, two very different doors.

```
www-data@blunder:/$ su hugo
Password: Password120
hugo@blunder:~$ cat user.txt
████████████████████████████████
```

The password leaked out of a dead copy of the website and walked straight into a live system account, because one person typed the same word twice.

## 0x06 · the minus sign that was root

hugo is a normal user, so check what he is permitted to run with elevated rights. The `sudo -l` output is almost a tease.

```
hugo@blunder:~$ sudo -l
User hugo may run the following commands on blunder:
    (ALL, !root) /bin/bash
```

Read that rule carefully, because it is trying to be clever and failing. It says hugo may run `/bin/bash` as **any** user **except** root. The `!root` is a fence built specifically to stop the one thing you want. The blunder is not in the rule. It is in the version of sudo enforcing it.

```
hugo@blunder:~$ sudo --version
Sudo version 1.8.25p1
```

That sudo carries **CVE-2019-14287**. When you ask to run a command as a user by numeric ID, sudo converts the number to a user. The fence checks the *name* you asked for, but the conversion of the ID **-1** comes back as **0**, and user 0 is root. So you never name root, you name minus one, and sudo cheerfully resolves your way past its own fence. Picture a guest list that bans one specific name, but the doorman lets in anyone holding a numbered ticket and never notices that ticket number minus-one prints out as the owner's own badge. You did not break the rule. You stepped through a gap the rule could not see.

```
hugo@blunder:~$ sudo -u#-1 /bin/bash
root@blunder:/home/hugo# id
uid=0(root) gid=0(root) groups=0(root)
root@blunder:/home/hugo# cat /root/root.txt
████████████████████████████████
```

A fence that bans root by name, defeated by never saying the name.

## 0x07 · the honest caveat

Nothing on Blunder is exotic, and that is the entire point of the box. Four ordinary mistakes, stacked, and each one looked harmless alone. The to-do file was meant for the team and faced the wrong way. The lockout was real protection that trusted the attacker to honestly report their own identity, which is no protection at all. The upload check ran a half-second too late and left the rejected file lying in a folder you could reach. And the old copy of the CMS was just clutter nobody bothered to sweep out, except clutter on a web server is not clutter, it is a second front door with the original key still in it.

The two I would actually lose sleep over are the leftover install and the password reuse, because neither one is a bug you can patch. No `apt upgrade` deletes a folder you forgot you copied. No security advisory fixes a person who uses the same password for a throwaway blog account and their system login. You can patch sudo, and you should, but the chain that got us to hugo was pure housekeeping and pure human habit. The CVE at the end is a date on a calendar. The blunders in the middle are a mindset, and a mindset does not have a patch Tuesday. Sweep the basement. Never type the same secret twice. Trust nothing the client gets to write, including the client's own name.

## 0x08 · outro

```
the blog wrote its user into a note and left the note in the window.
the lockout asked the guesser to please report himself, and believed him.
an old copy of the site still held the password, so the new one died with it.
a fence banned root by name, and you simply never said the name.

four blunders, none of them a zero-day. each one was a door held open from the inside.

read the note. sweep the basement. never type the secret twice. wear black.

                                                            EOF
```

---

*HTB: Blunder, retired 17 Oct 2020. An easy Linux box that is really a lecture on housekeeping and reused secrets, with a one-character sudo bypass for dessert. The to-do list still names the user in a lab and nowhere you don't own.*