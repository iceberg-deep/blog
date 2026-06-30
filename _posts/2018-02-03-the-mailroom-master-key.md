---
layout: post
title: "The Mailroom Master Key"
subtitle: "HTB SolidState, where a mail server with a factory password lets you reset anyone's inbox, read the door code out of a welcome email, and ride a root cron job home"
date: 2018-02-03 12:00:00 +0000
description: "A mail server still wearing its factory password lets you reset every inbox, read an SSH password out of a welcome email, escape a toy shell, and ride a root cron job to the crown."
image: /assets/og/the-mailroom-master-key.png
tags: [hackthebox, writeup]
---

SolidState is a building with a mailroom, and the mailroom never changed its lock. The admin console for the mail server still answers to the password it shipped with from the factory, and once you are inside that console you are not reading mail, you are the postmaster. You reset anybody's mailbox password to whatever you like, open their inbox, and there, sitting in a welcome email a real person actually sent, is a plaintext SSH password. You walk in the front door with it, land in a toy shell built to keep you boxed in, step over the box in a single move, and then notice a script that root runs on a timer and that anyone on the system is allowed to rewrite. None of it is a memory-corruption magic trick. The whole box is a chain of doors that were each held open by a small, human shortcut.

```
        S O L I D S T A T E   M A I L
        ============================
        :4555  "remote admin"   login: root / root
                       |              (factory password, never changed)
                       v
        you are the postmaster now.
        setpassword mindy ******   ->   open her inbox on :110
                       |
                       v
        a welcome email, written by a human:
            "username: mindy   pass: ********"
                       |
                       v
        ssh in. land in rbash, a shell with the doors painted on.
        step over it. then a root cron job runs a file
        that the whole world is allowed to edit.
                                                    鍵
```

## 0x01 · the lobby

`nmap -sC -sV` paints a mail host wearing a web page as a hat. Six ports answer, and four of them are the same daemon.

```
PORT     STATE SERVICE  VERSION
22/tcp   open  ssh      OpenSSH 7.4p1 Debian
25/tcp   open  smtp     JAMES smtpd 2.3.2
80/tcp   open  http     Apache httpd 2.4.25
110/tcp  open  pop3     JAMES pop3d 2.3.2
119/tcp  open  nntp     JAMES nntpd
4555/tcp open  rsip     JAMES Remote Admin 2.3.2
```

Read it like an address book. SMTP sends mail, POP3 hands it back, NNTP is the news desk nobody reads, and the loud one is `4555`, a remote administration port for Apache James. James is a Java mail server, and `2.3.2` is a specific, ancient build with a specific, ancient reputation. The web page on 80 is a corporate brochure with nothing to click. The mail stack is the box. Everything interesting on SolidState is a letter waiting in a drawer.

## 0x02 · the lock that was never changed

Port 4555 is the James Remote Administration Tool, a plaintext console for managing the mail server. You reach it with nothing fancier than netcat.

```
$ nc 10.10.10.51 4555
JAMES Remote Administration Tool 2.3.2
Please enter your login and password
Login id:
root
Password:
root
Welcome root. HELP for a list of commands
```

That is the entire first hurdle. The username is `root`, the password is `root`, and those are the credentials James ships with out of the box. Think of it like a brand-new filing cabinet that comes with a key taped to the side and a note that says "change this," and the office never peeled the note off. The lock is real. It was simply never set to anything but the factory default, so the master key is printed in the manual.

Inside the console you are not a guest, you are the administrator of the mail system. List the tenants.

```
root@solidstate:~# listusers
Existing accounts 5
user: james
user: thomas
user: john
user: mindy
user: mailadmin
```

Five mailboxes, and you hold the postmaster's pen.

## 0x03 · resetting the tenants

James gives the admin a `setpassword` command, meant for the honest case where a user forgets their password and the admin has to help. The console never asks why you want to do this, because the whole point of an admin tool is that the admin is already trusted. You are standing in the admin's shoes wearing the admin's default key, so the tool does exactly what it is told. Reset every mailbox to a password you choose.

```
root@solidstate:~# setpassword mindy iceberg123
Password for mindy reset
root@solidstate:~# setpassword john iceberg123
Password for john reset
```

Picture a hotel where you have walked into the manager's office and picked up the master rekeying machine. You are not picking locks one by one. You are simply re-cutting every guest's key to a shape you already hold, then strolling the hallway trying doors. Now switch hats from postmaster to reader. POP3 on port 110 hands back mail for any account once you can authenticate, and you just set the password yourself.

```
$ telnet 10.10.10.51 110
+OK solidstate POP3 server
USER mindy
+OK
PASS iceberg123
+OK Welcome mindy
LIST
+OK 2 1810
1 729
2 1081
RETR 2
```

The second message is a welcome note from one human to another, the kind of email an admin sends a new hire so they can get started. It is friendly, it is helpful, and it is a disaster.

```
Hi mindy,

Welcome to Solid State Security. ... Your account login is below:

username: mindy
pass: P@55W0rd1!2@

Please reset your password ... access is restricted at the moment,
ask your supervisor about adding commands.
```

A real password, typed in plaintext, mailed across a system where the front-desk lock was the manual's example. The welcome email is the hinge. Everything before it was paperwork. This is the key.

## 0x04 · a shell with the doors painted on

SSH in as `mindy` with the password from the email. You get a prompt, and the prompt immediately starts saying no.

```
$ ssh mindy@10.10.10.51
mindy@solidstate:~$ id
-rbash: id: command not found
mindy@solidstate:~$ cd /
-rbash: cd: restricted
```

This is `rbash`, the restricted Bourne shell. It is bash with a leash. You cannot `cd`, you cannot run a command with a slash in its name, you cannot change your `PATH`, and most of the useful binaries are simply not on the short list you are allowed to reach. Think of it like one of those toddler play kitchens where the oven door is painted on the cabinet. It looks like a kitchen, it has knobs, and not one of them turns. The user note even warned you, in that same welcome email: access is restricted, ask a supervisor about adding commands.

The trick is that the leash is attached to the shell, not to your account, and you get to pick the shell. When you ask SSH for an interactive session, it launches whatever login shell the server assigned, which is `rbash`. But SSH will also run a command you name for you, with a real terminal, before any restricted shell ever starts. Ask it to run plain `bash`.

```
$ ssh mindy@10.10.10.51 -t "bash --noprofile"
mindy@solidstate:~$ id
uid=1001(mindy) gid=1001(mindy) groups=1001(mindy)
mindy@solidstate:~$ export PATH=/usr/bin:/bin:$PATH
```

The `-t` forces a real TTY and the named command runs ahead of the cage. You walked around the painted door instead of trying to open it. `user.txt` is now readable in mindy's home.

```
mindy@solidstate:~$ cat user.txt
████████████████████████████████
```

## 0x05 · the file the whole world may rewrite

Now you are mindy in a real shell, which is a foothold and nothing more. Look for things that run as someone more important than you. A quiet way to watch what the system does on its own is `pspy`, a tool that lists processes as they spawn without needing root, so you can see scheduled jobs fire.

```
mindy@solidstate:~$ ./pspy64
... CMD: UID=0    PID=1106   | /bin/sh -c python /opt/tmp.py
... CMD: UID=0    PID=1107   | python /opt/tmp.py
```

`UID=0` is root, and root is running `/opt/tmp.py` on a schedule, every few minutes, from cron. Now look at the file itself.

```
mindy@solidstate:~$ ls -la /opt/tmp.py
-rwxrwxrwx 1 root root 105 ... /opt/tmp.py
mindy@solidstate:~$ cat /opt/tmp.py
#!/usr/bin/env python
import os
import sys
try:
    os.system('rm -r /tmp/* ')
except:
    sys.exit()
```

Read the permission string slowly. `-rwxrwxrwx`. Owned by root, and writable by everyone, including mindy. The script is a harmless little janitor that empties `/tmp`, but the part that matters is not what it does, it is who runs it and who is allowed to edit it. Root runs it. Anyone can rewrite it. Those two facts should never live in the same file.

Picture a night watchman who, every few minutes, walks the building reading a clipboard out loud and doing whatever it says, and the clipboard hangs on a public hook by the door where any passerby can scribble on it. The watchman is loyal and powerful and completely literal. You do not need to overpower him. You just add a line to his clipboard. Append a payload that calls home, then wait for the next pass.

```
mindy@solidstate:~$ cat >> /opt/tmp.py << 'EOF'
[ python one-liner: spawn a bash reverse shell back to 10.10.14.4 on 443 ]
EOF
```

Start a listener, and within a few minutes the cron fires, root reads the clipboard, and the watchman calls you.

```
$ nc -lvnp 443
connect to [10.10.14.4] from 10.10.10.51
# id
uid=0(root) gid=0(root) groups=0(root)
# cat /root/root.txt
████████████████████████████████
```

## 0x06 · the honest caveat

It is easy to file SolidState under "old box, default password, nothing to learn," and the specific James build here is genuinely a fossil. But none of the four moves were exotic, and that is the unsettling part. Each one was a normal feature being trusted a little past where the trust was earned.

The factory password is the loudest mistake and the most common one in real life. A default credential is not a weak password, it is a *published* password, printed in a manual and indexed by every search engine on Earth. The reset-anyone power was working exactly as designed, because an admin tool assumes the admin is already who they say they are, and the only thing standing between a stranger and that assumption was a lock left on its example setting. The plaintext password in the welcome email is the kind of helpful, human shortcut that ships in every onboarding process ever written, and it survives precisely because it feels like good service.

The two I would actually lose sleep over are the last two, because nothing about them is a bug. `rbash` is not broken when you walk around it. A restricted shell is a speed bump, never a wall, and treating it like a wall is the real flaw. And the cron job is the scariest of all, because every line of it works perfectly. A root-owned script that the world can write is not a vulnerability in code, it is a vulnerability in a permission, one stray `chmod 777` that turned a janitor into a master key. You cannot patch your way out of that. Read the leak, doubt the leash, and check who is allowed to edit the files your most powerful user runs.

## 0x07 · outro

```
the mailroom lock still wore its factory key,
so you became the postmaster and reset every drawer.
a welcome letter handed you the password to the door.
the cage shell had its doors painted on, so you stepped around them.
and root read a clipboard the whole world was allowed to write.

four open doors, none of them forced. each one held from the inside.

change the default. doubt the leash. mind who can edit root's chores. wear black.

                                                            EOF
```

---

*HTB: SolidState, retired 27 Jan 2018. A medium Linux box that is really a lecture on default credentials and misplaced trust wearing a mail server costume. The factory key still opens the cabinet in a lab and nowhere you don't own.*