---
layout: post
title: "The News That Read You Back"
subtitle: "HTB Passage, where a profile picture runs your code, a forgotten CMS hoards everyone's hashes in plain sight, one key opens two doors, and a desktop helper hands out root for free"
date: 2021-03-13 12:00:00 +0000
description: "A profile picture that runs as PHP, a CMS that files everyone's hashes by the front of their name, one SSH key shared between two accounts, and a desktop helper that writes anywhere as root without a password."
image: /assets/og/the-news-that-read-you-back.png
tags: [hackthebox, writeup]
---

Passage is a little news site that never threw anything away. The front page runs an old build of CuteNews, the kind of homemade CMS that lets you sign up, set a profile picture, and post. The trouble is that the profile picture is allowed to be code, the user database is a pile of base64 left where anyone can read it, and the same SSH key got copied into two accounts because copying a key was easier than making two. You climb in through an avatar, read the password hashes the site was supposed to be guarding, walk one key into a second user, and then ask a desktop helper meant for writing USB sticks to please overwrite a system file as root. It does, because nobody ever taught it to say no. Four turns, and not one of them is a memory-corruption magic trick. Every one is a thing that was supposed to be harmless quietly being handed the keys.

```
        P A S S A G E   D A I L Y
        =========================
        upload avatar.php  →  "nice picture"  →  it runs
                 |
        /cdata/users/  →  everyone's hash, filed
                          under the first two letters of their name
                 |
        one ssh key, two doors. paul holds nadav's.
                 |
                 v
        "hey usb helper, copy this file onto /etc/passwd"
        helper: "sure, no password needed."
                                            門
```

## 0x01 · the front desk

Two ports. That is the whole attack surface, and it is refreshingly honest about it.

```
PORT   STATE SERVICE VERSION
22/tcp open  ssh     OpenSSH 7.2p2 Ubuntu 4ubuntu2.8
80/tcp open  http    Apache httpd 2.4.18 ((Ubuntu))
```

`7.2p2` and Apache `2.4.18` both point at Ubuntu 16.04, a release that was already middle-aged when this box was live. SSH is not the way in here, it almost never is, but the version is a tell. Nothing on this host has been freshened in a long while. The website is the thing. It is a tidy little news portal, and the footer gives the game away. It runs CuteNews, a small PHP content manager, and a glance at the source pins the version at 2.1.2. Old software with a name and a version number is an invitation. You go looking for what is already written about it.

## 0x02 · the picture that ran

CuteNews 2.1.2 carries CVE-2019-11447, and it lives in the most innocent feature a website can have. You register a normal account, you go to set your profile picture, and the avatar uploader does not actually check what you handed it. The client-side rule says "images only," but a rule enforced in your own browser is a suggestion you make to yourself. Intercept the upload, rename the file from `.png` to `.php`, and the server files your "picture" in a web-reachable folder and is perfectly willing to run it.

Think of it like a nightclub that scans your ID at the door but lets you write whatever you want on the wristband. The bouncer glances at the wristband later and trusts it completely, because the wristband is "inside" now. The check that mattered happened in a place you controlled.

The clean trick is to hide PHP inside a real image so the file still smells like a picture. Drop the payload into an EXIF comment field, where it rides along as metadata, then give it a `.php` name on the way up.

```
$ exiftool -Comment='<?php [ one-line webshell: run the cmd request parameter ] ?>' iceberg.php.png
$ mv iceberg.php.png iceberg.php
# intercept the avatar upload, swap the extension to .php, send it
```

I am describing that webshell rather than printing it, and that is the actual lesson, not squeamishness. The real string is about a dozen characters, and the moment it touches a disk, any antivirus worth the name quarantines the file as the textbook PHP backdoor it is. The thing is small enough to memorize and dangerous enough to get a file deleted out from under you. Picture it, do not paste it.

The avatar lands at a predictable path under the uploads folder. Visiting it with a `cmd` parameter runs commands as the web user.

```
$ curl 'http://10.10.10.206/CuteNews/uploads/avatar_iceberg.php?cmd=id'
uid=33(www-data) gid=33(www-data) groups=33(www-data)
```

Trade that up for a proper callback and you are on the box.

```
$ nc -lvnp 443
[ bash reverse shell over /dev/tcp back to 10.10.14.4 on 443 ]
www-data@passage:/var/www/html/CuteNews/uploads$ id
uid=33(www-data) gid=33(www-data)
```

## 0x03 · the filing cabinet left open

`www-data` cannot do much, so you do what you always do on a foothold: go read where the app keeps its secrets. CuteNews does not use a real database. It keeps its users as flat files under `/var/www/html/CuteNews/cdata/users/`, and the filing system is almost charming. Each user's record is stored in a file named for the first two characters of the MD5 of their username, and the contents are a PHP object that has been serialized and then base64-encoded.

Base64 is not encryption. It is a costume, not a lock. Think of it like writing a note in a funny alphabet you can buy a decoder ring for at any gas station. It scrambles how the text looks so it can travel safely through systems that choke on odd characters, but anyone can put it back. So you grab every user file, peel off the base64, and the records fall open, each one carrying an email, a username, and a SHA-256 password hash.

```
$ for f in cdata/users/*.php; do tail -n +2 "$f" | base64 -d; echo; done
...
"paul-coles";..."sha256":"e26f3e86d1f8108120723ebe690e5d3d61628f4130076ec6cb43f16f497273cd"
"nadav";...
```

A SHA-256 hash is a one-way fingerprint of a password. You cannot reverse it, but you can guess: hash a dictionary word, see if the fingerprints match, repeat a few billion times a second. Feed Paul's hash to hashcat with a common wordlist and it folds quickly.

```
$ hashcat -m 1400 paul.hash rockyou.txt
e26f3e86...273cd:atlanta1
```

`atlanta1`. And here is the hinge of the whole box. There is a system user named `paul` on this Linux host, the same name as the CMS account, and the password is reused. The hash bled out of a website became a login on the operating system.

```
www-data@passage:/$ su paul
Password: atlanta1
paul@passage:~$ cat user.txt
████████████████████████████████
```

## 0x04 · one key, two doors

Paul is not the admin, so look around Paul's home for the next rung. The `.ssh` directory holds the usual pair, and the public key carries a comment that does not match its owner.

```
paul@passage:~/.ssh$ cat id_rsa.pub
ssh-rsa AAAA...  nadav@passage
```

That comment is a fingerprint of where the key was born. This keypair was generated for `nadav`, and yet here it is sitting in Paul's home directory, with the matching `authorized_keys` accepting it. Somebody set up SSH once, generated a single key, and copied it into both accounts instead of making a fresh one for each. So the private key in Paul's folder is also a valid key for Nadav.

Picture a building where the super cut one master key and gave a copy to two different tenants to save a trip to the locksmith. Now either tenant can stroll into the other's apartment, and neither of them ever agreed to that. A key is only as private as the smallest number of people who hold it.

```
paul@passage:~/.ssh$ ssh -i id_rsa nadav@localhost
nadav@passage:~$ id
uid=1000(nadav) gid=1000(nadav) groups=1000(nadav),27(sudo)
```

Nadav is in the `sudo` group, which on a normal box would just mean "can become root if they type their password." Nadav's password we do not have. We do not need it.

## 0x05 · the helper that never says no

Nadav's session has a desktop stack running underneath it, and that is where the box ends. Ubuntu ships a little background service called USBCreator, the thing that writes an install image onto a USB stick when you click the friendly button in the menu. It exposes itself over D-Bus, the message bus desktop programs use to talk to each other, and it has a method that copies a file from one place to another with root's hands.

Here is the flaw, disclosed by Unit42 in 2019 and quietly patched that June. The service decided that if you belong to the `sudo` group, you must already be trusted, so it skips the password prompt that the rest of the system would demand. But it never checks where you are copying from or to. It will copy any file onto any other file, as root, no questions asked.

Think of D-Bus as the intercom system inside an office building, the way the front desk, the mailroom, and security all call each other. USBCreator is a clerk listening on that intercom whose one job is "burn this image to a stick." Somebody wired that clerk to assume any call coming over the staff line is legitimate, and gave the clerk root's master key for moving files. So you call the clerk on the intercom and say, calmly, "copy this file I wrote over the building's master keyring." The clerk, hearing a staff-line call, does it.

The file that owns the keys to a Linux box is `/etc/passwd`, the list of accounts. You make a copy, append a brand-new root user whose password you choose, and ask the helper to lay your copy down on top of the real one.

```
nadav@passage:~$ cp /etc/passwd /tmp/passwd.new
nadav@passage:~$ openssl passwd -1 iceberg
$1$Hk2X.../...

# append a fresh uid 0 account with that hash
nadav@passage:~$ echo 'iceberg:$1$Hk2X.../...:0:0:pwned:/root:/bin/bash' >> /tmp/passwd.new

# ask the helper to overwrite the real file, as root, no password
nadav@passage:~$ gdbus call --system --dest com.ubuntu.USBCreator \
    --object-path /com/ubuntu/USBCreator \
    --method com.ubuntu.USBCreator.Image /tmp/passwd.new /etc/passwd true
```

That last argument, `true`, is the helper agreeing to clobber the destination. Now `/etc/passwd` has a root account whose password is yours.

```
nadav@passage:~$ su iceberg
Password: iceberg
root@passage:~# id
uid=0(root) gid=0(root) groups=0(root)
root@passage:~# cat /root/root.txt
████████████████████████████████
```

## 0x06 · the honest caveat

It is tempting to read Passage as a museum of old mistakes. The CuteNews bug is patched, the USBCreator hole was closed in 2019, the box runs an Ubuntu that has aged out of support. All true, and all beside the point, because the shape underneath is not dated at all.

Every turn on this box is the same confession told four ways: a thing that was supposed to be inert got treated as trusted. An avatar was supposed to be a picture and got run as code. A user database was supposed to be a secret and got stored in a costume anyone can take off. A private key was supposed to belong to one person and got copied to two. A desktop helper was supposed to write USB sticks and got asked to rewrite the account list, and it could not tell the difference because nobody told it there was one.

The privesc is the part worth losing sleep over. The CuteNews CVE is a date on a patch calendar, the kind of thing an update kills forever. The USBCreator bug is scarier because it shipped green, working exactly as written, and the bug was a decision: trust the `sudo` group so completely that you skip the very check `sudo` exists to enforce. You cannot patch your way out of a design that decided trust on the wrong evidence. That class of mistake gets re-shipped every year in new software, by people who reason that someone already inside the building must be allowed to do anything inside the building. The whole trade is learning to distrust that sentence.

## 0x07 · outro

```
the picture was allowed to be code, so it ran.
the secret was filed where the public could read it.
one key opened two doors because two doors shared a key.
the helper trusted the badge instead of the request,
        and handed root to whoever wore the badge.

four little trusts, none of them earned. that is the box.

doubt the badge. split the key. wear black.

                                                            EOF
```

---

*HTB: Passage, retired 6 Mar 2021. A medium Linux box that is really a lecture on misplaced trust wearing a forgotten CMS, a shared key, and a too-friendly desktop helper. The avatar still runs in a lab and nowhere you don't own.*