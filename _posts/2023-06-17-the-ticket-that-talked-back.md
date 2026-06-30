---
layout: post
title: "The Ticket That Talked Back"
subtitle: "HTB Soccer, where a default password opens a file manager, a match ticket leaks the database one yes-or-no answer at a time, and a logging tool runs your Python as root"
date: 2023-06-17 12:00:00 +0000
description: "A factory password, a ticket validator that answers true or false, and a stats tool that loads any Python it finds. Three doors nobody bothered to lock."
image: /assets/og/the-ticket-that-talked-back.png
tags: [hackthebox, writeup]
---

Soccer is a box about things that answer when they should keep their mouth shut. A file manager left wearing its factory password lets you drop a file on disk and run it. A ticket validator that only ever says yes or no turns out to be reading straight from the database, and if you ask the right yes-or-no questions in the right order you can spell a password out of it one letter at a time. Then a humble system-stats tool, handed root by a sloppy permission rule, loads any Python file with the right name and runs it without a second thought. Nothing here is a memory-corruption magic trick. Every step is a thing that was built to be helpful, talking to a stranger as if it were a friend.

```
        S O C C E R   F C
        =================
        /tiny   →  admin / admin@123   "come on in"
                   drop a file. it runs.
                        |
                        v
        the ticket gate only nods or shakes its head,
        but it nods from the database. ask it 5000
        times and it spells out a password.
                        |
                        v
        doas lets a logger run as root.
        the logger loads any plugin it finds.
        you write the plugin.
                                            門
```

## 0x01 · the locker room

Three ports answer, and the third one is the odd sock in the drawer. A standard `nmap -sC -sV` lays it out.

```
PORT     STATE SERVICE  VERSION
22/tcp   open  ssh      OpenSSH 8.2p1 Ubuntu 4ubuntu0.5
80/tcp   open  http     nginx 1.18.0 (Ubuntu)
9091/tcp open  unknown  (a websocket server, banner won't say)
```

Twenty-two and eighty are the usual furniture. Port 9091 is the tell. It speaks but it will not introduce itself, and a banner that refuses to name the protocol is almost always something hand-rolled, which on a box this size means something hand-rolled badly. Park it. The web server on 80 is the front door, so knock there first.

The site is a tidy soccer-club page with nothing clickable that matters, so you brute the paths. `feroxbuster` against the root turns up a directory nobody meant to leave in the lobby.

```
$ feroxbuster -u http://soccer.htb -w /usr/share/wordlists/dirb/common.txt
200   GET    /tiny
301   GET    /tiny/uploads
```

## 0x02 · the factory password

`/tiny` is **Tiny File Manager**, an open-source PHP app that does exactly what the name says. It manages files in a browser. Useful tool. The problem is not the tool. The problem is that this install still answers to the password it shipped with from the factory, `admin / admin@123`, the one printed in the project's own README for everyone on Earth to read.

Think of it like a new combination lock that comes set to 0-0-0-0 in the box, and the store clerk bolts it to the front gate without ever spinning the dial to something new. The combination is not a secret. It is on the packaging. Log in as `admin` and you own the file manager, which means you own a directory the web server will happily execute.

A file manager that lets you write into a web-served folder is a loaded gun pointed at the floor. You upload a tiny PHP file and the server runs it as code the moment you ask for it by name.

```
$ cat iceberg.php
<?php [ one-line webshell: run the cmd request parameter ] ?>

$ curl http://soccer.htb/tiny/uploads/iceberg.php -d 'cmd=id'
uid=33(www-data) gid=33(www-data) groups=33(www-data)
```

I am describing that webshell in brackets instead of printing it, and that bracket is the lesson, not caution for its own sake. The real thing is one short line, and the instant that exact string touches a disk any antivirus worth the name quarantines it as malware, which is a darkly funny proof of how dangerous four words can be. Picture it, do not paste it. Trade the webshell up for a proper callback and you are on the box.

```
$ curl http://soccer.htb/tiny/uploads/iceberg.php \
    --data-urlencode 'cmd=[ bash reverse shell over /dev/tcp back to 10.10.14.4 on 443 ]'
# on the listener:
www-data@soccer:~$ id
uid=33(www-data) ...
```

## 0x03 · the second stadium

`www-data` is a janitor account, so you look around for the next door. The nginx config is the map.

```
www-data@soccer:~$ cat /etc/nginx/sites-enabled/*
server {
    server_name soc-player.soccer.htb;
    location / { proxy_pass http://localhost:3000; }
}
```

There is a whole second site you never saw, `soc-player.soccer.htb`, hidden behind a name your browser was never told. A virtual host is a single server pretending to be several websites, deciding which one to show you based on the name you ask for. Picture a stadium with one entrance but two completely separate arenas inside, and the usher sends you left or right purely by which arena you say out loud. Ask for the wrong name and you never even learn the other one exists. Add the name to your hosts file and the second arena opens.

```
$ echo '10.10.11.194 soccer.htb soc-player.soccer.htb' | sudo tee -a /etc/hosts
```

This site is an Express app with login, signup, and a feature that checks whether a match ticket is valid. The ticket check is the interesting part, because it does not talk over normal HTTP. It talks over that mystery websocket on 9091, sending a little packet like `{"id":"1234"}` and getting back one of two answers. Ticket exists, or ticket does not exist.

## 0x04 · the gate that nods

A gate that only nods or shakes its head feels safe. It is the opposite of safe, because of *where* it gets the nod from. The validator takes your `id` and drops it straight into a database query with no quoting and no checking, the classic SQL injection wound. It will not print the database to you. But it will tell you, every single time, whether the query found a row.

That yes-or-no is enough to read the entire database, and the technique is called blind SQL injection. You stop asking for data and start asking questions that are secretly *about* the data. "Is the first letter of the admin password greater than M?" The gate nods. "Greater than S?" It shakes its head. "Greater than P?" It nods. Now you know the letter is between Q and S, and a few more nods pin it exactly. Repeat for every character.

Picture a hostage negotiator on a phone with someone who can only tap the receiver, once for yes and twice for no. You cannot ask "what is the password," but you can ask a thousand yes-or-no questions, and a thousand taps spell a sentence. It is slow. It is also unstoppable, and a machine does the asking thousands of times a minute.

You can drive `sqlmap` straight at the websocket so you are not hand-tapping all night.

```
$ sqlmap -u "ws://soc-player.soccer.htb:9091/" \
    --data '{"id":"1234"}' --dbms mysql --batch \
    --level 5 --risk 3 --threads 10 --dump -D soccer_db -T accounts

Database: soccer_db
Table: accounts
+----------+----------------------+-----------------------+
| username | email                | password              |
+----------+----------------------+-----------------------+
| player   | player@player.htb    | PlayerOftheMatch2022  |
+----------+----------------------+-----------------------+
```

A username, and the box reuses the database password as the Linux login password, because of course it does. SSH in.

```
$ ssh player@soccer.htb
player@soccer:~$ cat user.txt
████████████████████████████████
```

## 0x05 · the plugin nobody vetted

`player` is a real user but not root, so you check what they are trusted to run. The first surprise is the tool doing the trusting. Not `sudo`, but `doas`, the leaner cousin from the OpenBSD world, sitting on disk as a SUID binary. Read its config.

```
player@soccer:~$ cat /usr/local/etc/doas.conf
permit nopass player as root cmd /usr/bin/dstat
```

One line. `player` may run `dstat` as root, no password asked. `dstat` is a friendly little tool that prints system stats, CPU and disk and network, the kind of thing you stare at while something compiles. Harmless on its own. The catch is how it grows new features. It loads plugins, and a plugin is just a Python file named `dstat_something.py` sitting in a folder `dstat` happens to check. When you run it, it imports that file and executes whatever is inside, all with the privileges of whoever launched it. Which here is root.

One of the folders it checks, `/usr/local/share/dstat/`, is writable by you. That is the whole game. You write a plugin, `dstat` runs it as root, you walk out wearing the crown.

Think of it like a kitchen where the head chef will cook from any recipe card left in the recipe box, no questions, and the recipe box is bolted to the wall in the hallway where anyone can slip a card in. You do not need to break into the kitchen. You write a recipe that says "give the new guy the keys," drop it in the box, and the chef follows it to the letter.

```
player@soccer:~$ cat > /usr/local/share/dstat/dstat_iceberg.py <<'EOF'
import os
os.system("/bin/bash")
EOF

player@soccer:~$ doas /usr/bin/dstat --iceberg
root@soccer:~# id
uid=0(root) gid=0(root) groups=0(root)
root@soccer:~# cat /root/root.txt
████████████████████████████████
```

The `--iceberg` flag tells `dstat` to load the plugin named `iceberg`, and the plugin's only job is to hand you a shell. No exploit, no overflow, just a trusted program reading a file from a place a stranger could write to.

## 0x06 · the honest caveat

Soccer is easy, and it is easy on purpose, because all three of its doors are the same mistake in three outfits. Each one is a piece of software trusting an input it had no business trusting. The file manager trusted that whoever knew the factory password belonged there. The ticket gate trusted that the `id` you sent was a number and not a sentence. The stats tool trusted that any Python file in its plugin folder was put there by someone allowed to. None of those is a bug in the clever sense. They are all the same confession, repeated. *We assumed the input was friendly.*

The two I would actually lose sleep over are the bookends. Default credentials sound like a beginner gag until you remember they are still, year after year, one of the most common ways real networks fall. Nobody changed the password because the thing worked fine with the old one, and "it works" is the sentence that gets companies breached. And the `doas`-to-`dstat` chain is the scary one precisely because nothing was unpatched. Every program was current. The hole was a config file that handed root to a tool that loads code from a writable folder, a decision a tired admin made in ten seconds to make their monitoring easier. You cannot patch your way out of that. You can only stop trusting inputs that came from somewhere a stranger can reach.

The blind injection deserves a last word too, because it is the one that feels safe and is not. A gate that only nods or shakes its head looks like it gives nothing away. It gives away everything, slowly, because the answer is computed from the secret. Any door whose yes-or-no depends on data you want is a door that leaks that data one bit at a time. Silence is not the same as secrecy.

## 0x07 · outro

```
the lock still wore the combination from the box.
the gate nodded from the vault, so we read the vault in nods.
the logger ran a recipe a stranger left in the drawer.

three doors, three different costumes, one mistake.
each one trusted a voice it never checked.

change the factory key. never trust the nod. wear black.

                                                            EOF
```

---

*HTB: Soccer, retired 10 Jun 2023. An easy Linux box that is really a lecture on trusting your inputs, told three times in three costumes. The ticket still nods in a lab and nowhere you don't own.*