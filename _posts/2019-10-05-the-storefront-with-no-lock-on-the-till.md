---
layout: post
title: "The Storefront With No Lock On the Till"
subtitle: "HTB SwagShop, where a webshop's search box writes its own admin account and a text editor running as root hands over the keys"
date: 2019-10-05 12:00:00 +0000
description: "A Magento shop where the Shoplift SQLi mints you an admin, a deserialization bug turns that admin into a shell, and sudo vi finishes the job as root."
image: /assets/og/the-storefront-with-no-lock-on-the-till.png
tags: [hackthebox, writeup]
---

SwagShop is an online store that forgot to lock its own till. The front page sells Hack The Box merch on an old Magento install, and the whole box is the story of one shopping cart that trusts the wrong stranger three times in a row. First you talk to a reporting page that was supposed to filter products and instead writes a brand new administrator into the database for you. Then you log in as that administrator and feed the admin panel a poisoned object that it unpacks without checking, which runs your command on the server. Then, sitting on the box as the web user, you find that the site's owner left a text editor wired to run as root. None of it is a memory-corruption magic trick. It is a shop where every counter, every drawer, and the manager's office all left their doors swinging, and the box just walks you from one to the next.

```
        S W A G   S H O P
        =================
        search box:  popularity[field_expr]=...
                     "filter the catalog"
                     instead it writes a new manager
                     into the staff list. name: ypwq
                          |
                          v
        admin panel:  here is a wrapped gift
                     it opens the box without looking inside
                     and the box was a command
                          |
                          v
        the office door:  sudo vi /var/www/html/*
                          the editor is root. so are you now.
                                            店
```

## 0x01 · the shop window

Two ports answer, and the box is not trying to look complicated.

```
PORT   STATE SERVICE VERSION
22/tcp open  ssh     OpenSSH 7.2p2 Ubuntu 4ubuntu2.8
80/tcp open  http    Apache httpd 2.4.18 ((Ubuntu))
```

Apache 2.4.18 on Ubuntu 16.04, and SSH you cannot do anything with yet. The website is the whole game, and the website is a Magento storefront selling HTB swag. Magento is a big, old PHP e-commerce platform, the kind of thing a small shop buys once and then never updates because updating it might break checkout, and broken checkout means no money. That instinct, leave the working thing alone, is exactly the soil these boxes grow in.

A quick directory brute fills in the map. `gobuster` against the root finds the parts of a Magento install that matter.

```
$ gobuster dir -u http://10.10.10.140 -w directory-list-2.3-medium.txt -x php
/index.php            (Status: 200)
/app                  (Status: 301)
/admin                (Status: 200)
/includes             (Status: 301)
/media                (Status: 301)
```

`/admin` is the manager's login. `/app` matters more than it looks, because Magento keeps a config file at `/app/etc/local.xml` that holds, among other things, the exact moment the shop was installed. Hold that fact. A timestamp seems like the most boring thing in the world to leak, right up until it becomes the key that signs your forgery later.

## 0x02 · the search box that hires a manager

Old Magento, anything at or below 1.9.0.0, carries a famous chain the security world named Shoplift (CVE-2015-1397 and friends). It is a SQL injection sitting in, of all places, a sales-report grid. There is a parameter called `popularity[field_expr]`, and it was meant to let the admin panel sort products by how popular they are. The page takes that value and pastes it straight into a database query without scrubbing it first.

Here is the move in plain terms. Picture a shop where the form you fill out to request a sales report has a blank line for the date range, and whatever you scribble on that line gets read aloud, word for word, to the person who controls the staff list. Write a normal date and you get a report. Write "the date range, and also add a new manager named ypwq with password 123 and give them the master key" and the clerk reads the whole sentence out loud, and the staff list grows by one. The report page was never supposed to touch the staff list at all. SQL injection is that, exactly that, every time. A box that was built to hold inert text instead reaches into the machinery and pulls a lever.

The public proof-of-concept does precisely this. It fires the injection at the report endpoint and stitches a new administrator account into the `admin_user` table.

```
$ python shoplift.py http://10.10.10.140
WORKED
Check http://10.10.10.140/admin with creds ypwq:123
```

And it works. You walk to `/admin`, type `ypwq` and `123`, and you are standing behind the counter as a full administrator. No password was cracked. The shop wrote the account for you because you asked it to in the one language it could not help but obey.

## 0x03 · the gift box that runs

Being admin in Magento is not a shell. It is a web panel. To turn "I can click around the admin pages" into "I can run a command on the Linux box underneath," you reach for the second bug in the same family of old-Magento sins, the authenticated remote code execution at Exploit-DB 37811.

This one is PHP object injection, which is a fancier cousin of the same disease. PHP can take an object, the bundle of data plus behavior your code passes around, and freeze it into a string of text to store or send. That is serialization. Thawing it back out is deserialization. The bug is that this Magento code thaws out a frozen object that came from the attacker, and when PHP rebuilds certain objects it automatically runs little startup routines attached to them. So if you can hand the server a carefully shaped frozen object, you can choose what runs when it thaws.

Think of it like a vacuum-sealed gift you mail to the shop. The clerk's job is just to put the gift on a shelf, but the shop has a rule that says every package that arrives gets unwrapped and assembled the moment it lands. You build a package that, the instant it is unwrapped, springs up and runs an errand for you. The clerk never decided to run your errand. The unwrapping did it automatically.

The catch is that the package has to be signed with the shop's own install key, and that key is derived from the install date. Which is why `/app/etc/local.xml` mattered all the way back in recon. The exploit reads that date, forges a validly signed object, and ships it.

```
$ curl -s http://10.10.10.140/app/etc/local.xml | grep -i date
<date><![CDATA[Wed, 08 May 2019 07:23:09 +0000]]></date>

$ python 37811.py http://10.10.10.140/index.php/admin/ "id"
$ curl "http://10.10.10.140/iceberg.php?c=id"
uid=33(www-data) gid=33(www-data) groups=33(www-data)
```

The exploit drops a small command-runner on disk. I am signing the dropped file `iceberg.php` rather than printing what goes inside it, and that restraint is the lesson, not laziness. The real payload here is the four-word PHP webshell that has been getting servers owned for fifteen years, and the instant the literal string touches disk any honest antivirus quarantines the file as malware. So picture it instead of pasting it.

```
<?php [ one-line webshell: run the cmd request parameter ] ?>
```

Trade that runner up for a proper reverse shell, [ bash reverse shell over /dev/tcp back to 10.10.14.4 on 443 ], and you land on the box.

```
$ nc -lvnp 443
connect to [10.10.14.4] from (UNKNOWN) [10.10.10.140]
www-data@swagshop:/var/www/html$ cat /home/haris/user.txt
████████████████████████████████
```

`www-data`, the low-privilege account the web server runs as, and `user.txt` sitting in haris's home.

## 0x04 · the office door left open

Now the climb to root, and SwagShop refuses to make it hard. The first thing to check on any Linux box you land on is what the current user is allowed to run as someone else, and `sudo -l` answers that.

```
www-data@swagshop:/var/www/html$ sudo -l
User www-data may run the following commands on swagshop:
    (root) NOPASSWD: /usr/bin/vi /var/www/html/*
```

Read that slowly. The web user can run `vi`, the text editor, as root, with no password, on any file under the web directory. Somebody set that up so the site owner could edit shop files without typing a password every time. It is a convenience. It is also the entire keys to the kingdom, because a text editor is not just a text editor.

`vi` has a feature where, from inside the editor, you can shell out and run a system command without leaving your document. Useful when you are editing and want to quickly check something. But if the editor itself is running as root, then the command it shells out to runs as root as well. GTFOBins, the catalog of exactly these "trusted program does an untrusted thing" tricks, lists vi as a one-liner.

```
www-data@swagshop:/var/www/html$ sudo /usr/bin/vi /var/www/html/iceberg -c ':!/bin/sh'
# id
uid=0(root) gid=0(root) groups=0(root)
# cat /root/root.txt
████████████████████████████████
```

Think of it like handing a contractor the master key so they can repaint the lobby, and the contractor's drill happens to also open the vault. You only meant to let them touch the walls. You handed them root over the whole building. The editor was supposed to edit files. It will just as happily spawn a shell, and it does so wearing the crown you lent it.

## 0x05 · the honest caveat

It is easy to file SwagShop under "ancient Magento, patched years ago, nothing to learn." The specific CVEs are genuinely fixed, and nobody should be running Magento 1.9 in 2026. But the shape of every step here is alive and well. Shoplift is SQL injection, which means a stranger's text got read as a command instead of as data, the single most common serious web bug there has ever been. The object injection is the same confession one layer up, a program trusting attacker-controlled input enough to rebuild it into live code. Neither bug needed a genius. Each one needed a place where the wall between "stuff people type" and "stuff the machine does" had quietly crumbled.

The privesc is the part that should keep an admin awake, because there was no exploit at all. The sudo rule shipped green. Nobody fired a payload at it. A person, trying to make their own life easier, told the system "let the web account edit my shop files as root," and never once pictured that `vi` could be talked into spawning a shell. You cannot patch your way out of that. There is no update that fixes a convenience someone chose on purpose. The fix is the discipline to ask, every single time you grant a power, what else this power quietly includes. A text editor includes a shell. A sudo wildcard includes every file an attacker can create. The drawer you leave unlocked for yourself is unlocked for whoever walks in behind you.

## 0x06 · outro

```
the search box hired a manager because you asked it nicely in sql.
the admin panel ran your errand because it unwrapped a gift without looking.
the editor handed you root because someone lent it the crown to repaint a wall.

three open doors, none of them forced. a shop that trusted every stranger at the counter.

scrub the input. mind the wildcard. wear black.

                                                            EOF
```

---

*HTB: SwagShop, retired 28 Sep 2019. An easy Linux box that is really a tour of misplaced trust, from a self-serve admin account to a text editor wearing root's coat. The shop still sells swag in a lab and nowhere you don't own.*