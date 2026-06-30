---
layout: post
title: "A Note You Were Never Meant To Read"
subtitle: "HTB SecNotes, where the username is the injection, a writable share becomes a webshell, and the admin password is hiding in a Linux history file on a Windows box"
date: 2019-01-26 12:00:00 +0000
description: "A notes app where your account name is a query, a file share that runs PHP, and an admin password left behind in a Linux shell living quietly inside Windows."
image: /assets/og/a-note-you-were-never-meant-to-read.png
tags: [hackthebox, writeup]
---

SecNotes is a little web app that promises to keep your secrets safe, which is the first joke. It lets you sign up, log in, and write private notes, and it does almost everything wrong on the way. You register an account whose name is secretly a fragment of a database query, and the moment you log in, the app reads you everyone else's private notes out loud. One of those notes is a password. The password opens a file share you can write to, and that share happens to be the same folder a web server runs scripts out of, so the file you drop becomes the file the server executes. That lands you on the box as a regular user. Then the box does the strangest, most modern thing of all. It turns out this Windows machine has a whole Linux living inside it, and somebody typed the administrator password into that Linux in plain sight, and the shell wrote it down in its diary. We just read the diary.

```
        S E C N O T E S
        ===============
        register:  username = ' or 1='1
                        |
                        v
        login, and the app hands you
        every note ever written, including
        one with an SMB password in it.
                        |
                        v
        a writable share that also runs PHP.
        drop a file, the server runs it.
                        |
                        v
        a linux hiding inside the windows,
        keeping a diary of the admin's password.
                                            秘
```

## 0x01 · the front desk

Three ports answer, and the shape of them tells you the whole story before you knock. IIS on 80, the SMB stack on 445, and a second IIS instance up on 8808.

```
PORT     STATE SERVICE       VERSION
80/tcp   open  http          Microsoft IIS httpd 10.0
445/tcp  open  microsoft-ds  Windows 10 Enterprise 17134
8808/tcp open  http          Microsoft IIS httpd 10.0
```

Two web servers and a file-sharing port. Hold that 8808 in your head. A second web server on an odd port is rarely an accident, and on this box it is the hinge the whole thing swings on. Port 80 redirects you to `login.php`, a tidy little notes application with a sign-up form. The kind of thing that looks harmless and is the opposite.

## 0x02 · the name that was a question

Register an account, log in, and you can write notes that only you can see. That word, "only," is doing a lot of lifting, and it cannot hold the weight. The app stores notes keyed by username, and when it loads your notes it builds a database query by gluing your username straight into the SQL string. Roughly this.

```
SELECT id, title, note FROM posts WHERE username = '<your name>'
```

See the problem. Your username is supposed to be a label, but it gets pasted into a sentence the database will obey. So you do not register as a person. You register as a piece of the query. Sign up with the username `' or 1='1` and let it sit. This is second-order injection, which means the payload does nothing at registration. It waits. It only fires later, when the app trusts the stored name and rebuilds the query around it.

Think of it like writing a fake name on a hotel guest book, except the name you write is "or give this guest every room key." Nobody reads it when you sign in. But the next morning the front desk runs down the book to figure out which room is yours, reads your "name" as an instruction, and hands you the master ring. When you log in as `' or 1='1`, the query becomes `WHERE username = '' or 1='1'`, and `1='1'` is always true, so the database stops filtering by owner and returns every note ever written. The app proudly displays all of them. Other people's private notes, scrolling past, because you named yourself a clause.

One of those notes belongs to a user named tyler, and it reads like a sticky note nobody should ever write.

```
new site to keep notes secure
\\secnotes.htb\new-site
tyler / 92g!mA8BGjOirkL%OG*&
```

There is also a slower, more honest path the box leaves open, an XSRF on the password-change page. The change-password endpoint takes the new password as a plain request and never asks for the old one, and the app has a contact form that mails a link to tyler, who clicks. So you can mail tyler a link that quietly resets his own password to one you picked, then log in as him. Same destination, more steps. The injection just gets there first by reading the note out of the database directly.

## 0x03 · the share that runs what you give it

Those are real credentials, and 445 is open, so try them on the file shares.

```
$ smbmap -H 10.10.10.97 -u tyler -p '92g!mA8BGjOirkL%OG*&'
    Disk          Permissions
    ----          -----------
    c$            NO ACCESS
    IPC$          READ ONLY
    new-site      READ, WRITE
```

`new-site`. Writable. And remember that second web server idling on 8808. A writable folder is just storage until you learn that a web server is configured to serve and execute files out of that exact folder. Here it is, and that changes everything. The share is the document root for the IIS instance on 8808. Anything you write into the share, the server will run when you ask for it by name over HTTP.

Picture a print shop with a self-serve drop box on the back wall. You are allowed to slide papers into the box. What you did not realize is that a clerk on the other side takes every page out of the box and does exactly what it says, no questions, no signature checked. The drop box is the SMB share. The clerk is the web server on 8808. So you slide in a page of instructions.

The instructions are a webshell, the smallest possible bridge between "I can write a file" and "I can run commands." Drop it over SMB.

```
$ smbclient '//10.10.10.97/new-site' -U 'tyler%92g!mA8BGjOirkL%OG*&' \
    -c 'put cmd.php iceberg.php'
```

```php
<?php [ one-line webshell: run the cmd request parameter ] ?>
```

I am describing that shell in brackets instead of printing it, and that restraint is the lesson, not the omission. The real thing is a single line, and it is the most copied backdoor on the internet, which is precisely why the moment its literal text touches a disk any half-awake antivirus quarantines the file as malware. The danger is measured in how short it is. So picture it. Then call it.

```
$ curl 'http://10.10.10.97:8808/iceberg.php?cmd=whoami'
secnotes\tyler
```

The clerk read your page and answered. Trade the webshell up for a real reverse shell, point it at your listener, and you land on the box as tyler.

```
$ nc -lvnp 443
connect to [10.10.14.4] from 10.10.10.97
PS C:\> whoami
secnotes\tyler
PS C:\> type C:\Users\tyler\Desktop\user.txt
████████████████████████████████
```

## 0x04 · the linux in the basement

tyler is a normal user. Administrator is the goal, and the path to it is the most charming twist on the box. Poke around tyler's home and you find the fingerprints of WSL, the Windows Subsystem for Linux, an entire Ubuntu userland bolted into Windows so a developer can run bash without leaving the desktop. There is a real `bash.exe` buried in the system folders, and there is a full Linux filesystem sitting under tyler's profile.

Picture a corporate office that built a tiny working apartment in the basement, with its own kitchen and its own rules, connected to the main building by a single door. People go down there to get real work done, away from the polished lobby upstairs. And like anyone in their own kitchen, they get comfortable and careless. The apartment is WSL. We are about to read what got left on the counter.

Linux keeps a diary. Every interactive bash shell appends the commands you typed to a file called `.bash_history`, so your last session is always sitting there in plain text unless you scrub it. On this box that diary lives at a gloriously long Windows path, the Ubuntu root account's home folder, tunneled out through the WSL package directory.

```
PS C:\> type C:\Users\tyler\AppData\Local\Packages\
CanonicalGroupLimited.Ubuntu18.04onWindows_79rhkp1fndgsc\
LocalState\rootfs\root\.bash_history
```

And there, in the history, is the whole game.

```
cd /mnt/c/
smbclient \\\\127.0.0.1\\c$ -U administrator
cat /mnt/c/Users/Administrator/Desktop/root.txt
smbclient -U 'administrator%u6!4ZwgwOM#^OBf#Nwnh' \\127.0.0.1\c$
```

The administrator typed their own password onto a command line inside that basement apartment, and bash wrote it into the diary like it writes everything. The thing people forget about command history is that it is not a log somebody chose to keep. It is the default. The shell is always recording, and a password typed as an argument is a password saved to disk.

## 0x05 · walking in the front door as admin

With `administrator / u6!4ZwgwOM#^OBf#Nwnh`, the climb is over. You do not even need an exploit, just to log in as the person whose password you found. Mount the admin C drive over SMB and read the flag.

```
PS C:\> net use \\127.0.0.1\c$ /user:administrator "u6!4ZwgwOM#^OBf#Nwnh"
The command completed successfully.

PS C:\> type \\127.0.0.1\c$\Users\Administrator\Desktop\root.txt
████████████████████████████████
```

If you want a full interactive shell as administrator rather than a single file read, a remote-exec tool like winexe or psexec takes the same credentials and gives you a clean SYSTEM-adjacent prompt.

```
$ winexe -U '.\administrator%u6!4ZwgwOM#^OBf#Nwnh' //10.10.10.97 cmd.exe
C:\Windows\system32> whoami
secnotes\administrator
```

No memory corruption. No privilege-escalation bug in the strict sense. Just a password the rightful owner handed to a diary, and a reader who knew where the diary was kept.

## 0x06 · the honest caveat

Every door on SecNotes was unlocked from the inside, and each one looked like a feature on the way out. The notes app was not hacked so much as taken at its word. It promised that your username was just a name and your notes were just yours, and it built a database query that quietly broke both promises by treating the name as a sentence. That is injection, the oldest confession in the book, and it does not care that the app was small and modern and HTTPS-pretty. The instant data is allowed to reach into the query and choose what rows come back, it stopped being data.

The webshell step is the same disease wearing different clothes. A file share is supposed to hold files. A web server is supposed to serve them. Wire those two facts together so that the folder you can write to is the folder that gets executed, and "you may store a document here" silently becomes "you may run any program you like." Nobody decided that. It fell out of two reasonable settings sitting next to each other.

But the privesc is the one I would lose sleep over, because nothing was vulnerable. WSL is not a bug. A command history is not a bug. The administrator simply typed a password where a tool could see it, in a comfortable basement shell they assumed nobody would read, and the system did exactly what it was built to do, which was remember. You cannot patch that. A password passed as an argument lands in history, in process lists, in logs, in shell-completion caches, in a dozen places nobody thinks about while they are getting work done. The fix is never a software update. It is the discipline to never type the secret where the machine is taking notes.

## 0x07 · outro

```
the username was a question the database answered honestly.
the share you could write to was the share that ran your code.
the admin's password was sitting in a diary nobody told them they were keeping.

three rooms, none of them forced. each one held open by a habit.

never trust the label. never run the drop box. never type the secret. wear black.

                                                            EOF
```

---

*HTB: SecNotes, retired 19 Jan 2019. A medium Windows box that is really a lecture on second-order injection, a writable share that doubles as a web root, and the quiet danger of a Linux shell keeping notes inside a Windows machine. The diary still reads in a lab and nowhere you don't own.*