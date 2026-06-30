---
layout: post
title: "The Page That Logged Itself In"
subtitle: "HTB Writeup, where a draft page leaks the CMS, the CMS bleeds its own password, and the staff badge writes the command root runs at the door"
date: 2019-10-19 12:00:00 +0000
description: "A blind SQL injection bleeds an admin hash out of CMS Made Simple, and a group membership lets you write the very command root runs when it greets you at login."
image: /assets/og/the-page-that-logged-itself-in.png
tags: [hackthebox, writeup]
---

Writeup is a box about a page that was never supposed to be read. There is a draft directory the owner forgot to hide, and inside it a content management system old enough to spill its own admin password one careful question at a time. You ask the database a yes-or-no riddle a few thousand times, watch how long it takes to answer, and out of those pauses a hash assembles itself. Crack it, walk in over SSH, and you are a normal user on a tidy Debian box. The climb to root is quieter still. You are wearing a group badge that lets you write into a folder the system trusts, and root, every single time someone knocks on the SSH door, reaches into that folder and runs whatever it finds. So you leave it something. The box does not get broken into so much as politely talked into handing over its own keys, twice.

```
        W R I T E U P
        =============
        robots.txt:  "please don't look in /writeup/"
                     (so you look in /writeup/)
                          |
                          v
        the CMS answers slow for YES, fast for NO.
        you ask it about its own password
        one bit at a time until the hash falls out.
                          |
                          v
        then root opens the door to say hello,
        reads a folder you can write to,
        and runs your note out loud.
                                            稿
```

## 0x01 · the door that scans back

The first thing the box does is flinch. Fire a normal aggressive `nmap` at it and the host stops answering, because there is a defense watching for floods and it slams the shutter when packets arrive too fast. Slow down, throttle the scan, and only two ports admit they exist.

```
PORT   STATE SERVICE VERSION
22/tcp open  ssh     OpenSSH 7.4p1 Debian 10+deb9u6
80/tcp open  http    Apache httpd 2.4.25 ((Debian))
```

Two ports is an honest box. SSH you cannot do anything with yet, so the web server is the whole conversation. The root page is a near-empty notice that the site has a DoS guard installed, which is the box telling on itself about that flinch you already felt. Think of it like a shop with a sign in the window bragging about its new alarm. Useful to know the alarm is there. Even more useful to know the owner is the type who advertises instead of hiding.

## 0x02 · the page marked do-not-read

The tell is in `robots.txt`, the little file a site uses to ask search engines politely to skip certain paths. It is a request, not a wall, and it has the funny property of being a map of exactly what someone wanted hidden.

```
$ curl http://10.10.10.138/robots.txt
User-agent: *
Disallow: /writeup/
```

Picture a hotel hallway where every door is unmarked except one, which has a sticky note reading "nothing valuable in here, do not enter." You are going through that door first. Behind `/writeup/` lives a real site running CMS Made Simple, an older content manager, and the version here predates the patch for a famous database flaw. A quick look at the page source and a version probe pin it under 2.2.10, which is the line where the bug below gets fixed.

## 0x03 · the question you ask ten thousand times

The flaw is CVE-2019-9053, an unauthenticated blind SQL injection in the News module. Let me unpack each of those words, because together they describe a very specific kind of leak.

A SQL injection is what happens when a website builds its database query by gluing your input directly into the command, so that text you typed stops being a value and starts being an instruction. The "blind" part means the page never shows you the answer. It does not print the data. It only behaves differently depending on whether your smuggled question was true or false. Here the difference is time. You append a clause that says, roughly, "if the next character of the admin password hash is an 'a', go to sleep for five seconds, otherwise reply instantly." Then you watch the clock. A slow reply means yes. A fast reply means no.

Think of it like questioning someone through a closed door who is only allowed to either pause or answer immediately. You cannot make them tell you the password outright. But you can ask "does it start with A?" and learn everything from whether they hesitate. Ask enough yes-or-no questions and the secret spells itself out, one letter at a time, purely from the rhythm of the pauses.

Nobody does this by hand. A public exploit script for this exact CVE automates the whole interrogation and the cracking afterward.

```
$ ./cmsms_sqli.py -u http://10.10.10.138/writeup --crack -w /usr/share/wordlists/rockyou.txt
[+] Salt for password found: 5a599ef579066807
[+] Username found: jkr
[+] Email found: jkr@writeup.htb
[+] Password found: 62def4866937f08cc13bab43bb14e6f7
[+] Password cracked: raykayjay9
```

There it is. A username, the salt, the password hash, and because the password was an ordinary word with some numbers stapled on, the script finds it in `rockyou.txt` in seconds. The database confessed its own administrator to a stranger who only ever asked it whether to pause.

## 0x04 · the password that did two jobs

A CMS admin password should only open the CMS. But people reuse one password the way they reuse one house key for every lock they own, and `jkr` is a real Linux user on this machine, not just a web login. So you take the word the database bled and try it at the front door.

```
$ ssh jkr@10.10.10.138
jkr@10.10.10.138's password: raykayjay9
jkr@writeup:~$ id
uid=1000(jkr) gid=1000(jkr) groups=1000(jkr),50(staff)
jkr@writeup:~$ cat user.txt
████████████████████████████████
```

One word, two locks. The same secret that ran a web panel now runs a shell. And notice the very last thing that `id` prints, because it is the entire second half of the box. Group 50, `staff`.

## 0x05 · the badge that writes to a trusted shelf

Most groups on a Linux box are decorative. The `staff` group is not, because of one specific, easy-to-miss privilege. On a Debian system, members of `staff` can write into `/usr/local/bin` and `/usr/local/sbin`. Those folders sound boring. They are anything but, because of where they sit in the system's search order.

When any program asks the system to run a command by name, the system walks through a list of folders called the `PATH`, in order, and runs the first matching file it finds. On this box `/usr/local/bin` sits at the very front of that list, ahead of the normal system folders. So if you place a program there with the same name as a real system command, yours is the one that gets found first. You are not editing the real command. You are slipping a forgery onto the shelf the system checks before it ever reaches the genuine one.

To know which name to forge, you watch what root does when nobody is looking. A small tool called `pspy` lists processes without needing root, by polling the process table fast enough to catch short-lived commands. Leave it running and trigger an event, and the secret routine shows itself.

```
jkr@writeup:~$ ./pspy64
...
CMD: UID=0  PID=...  | run-parts --lsbsysinit /etc/update-motd.d
CMD: UID=0  PID=...  | sh -c /usr/bin/env -i PATH=/usr/local/sbin:/usr/local/bin:... run-parts ...
```

Every time someone logs in over SSH, root runs `run-parts`, the little helper that executes the scripts behind the login banner. And it runs it by name, through that same `PATH`, with `/usr/local/bin` first. Picture a butler who, the instant any guest rings the bell, walks to a particular shelf and reads aloud whatever note is sitting there, no questions asked. You have the key to that shelf. So you write a note.

## 0x06 · the note root reads at the door

You drop your own `run-parts` into `/usr/local/bin`. It does not need to be clever. It needs to do one durable thing, because login sessions come and go but a copy of the shell with the right bit set is forever.

```
jkr@writeup:~$ cat > /usr/local/bin/run-parts <<'EOF'
#!/bin/bash
[ make a root-owned copy of bash named iceberg and set its SUID bit ]
EOF
jkr@writeup:~$ chmod +x /usr/local/bin/run-parts
```

The payload copies the shell to a new name and turns on the SUID bit, the flag that makes a program run with the powers of its owner rather than whoever launched it. Since root makes the copy, the copy is owned by root, and SUID means anyone who runs it gets root's authority for the length of that run. Now you simply ring the bell yourself by opening a second SSH session. Root answers the door, walks to the shelf, finds your forged `run-parts` before the real one, and runs it. A heartbeat later your root-owned shell is waiting.

```
jkr@writeup:~$ ls -la /bin/iceberg
-rwsr-xr-x 1 root root 1113504 Oct 12 14:22 /bin/iceberg
jkr@writeup:~$ /bin/iceberg -p
iceberg-3.2# id
uid=1000(jkr) gid=1000(jkr) euid=0(root) groups=...
iceberg-3.2# cat /root/root.txt
████████████████████████████████
```

The `-p` matters. Bash normally drops borrowed privileges on startup as a safety habit, and `-p` tells it to keep them, so the effective user ID stays at zero. No exploit fired. Root simply did its ordinary, friendly job of greeting a visitor, and the greeting was a command you got to write.

## 0x07 · the honest caveat

It is easy to read Writeup as two old bugs and move on, but only one of the two moves is actually a bug. The SQL injection is a real flaw with a real patch, and CMS Made Simple closed it years ago. Update past 2.2.10 and that door is welded shut. Fine.

The privilege escalation is the part that should keep you up, because nothing on that side was unpatched, exploited, or broken. Every piece behaved exactly as documented. The `staff` group is supposed to be able to write to `/usr/local/bin`. That folder is supposed to come first in the `PATH` so local tools override system ones. Root running `run-parts` at login is a normal, intended courtesy. Each gear was healthy. The failure was in how they meshed: a user who could write to an early-`PATH` folder, plus a root process that resolved a command name through that `PATH` at a moment the user controlled. Nobody made a mistake you can point to in a changelog. They made an arrangement, and the arrangement handed out root.

That is the lesson under the costume. Injection is the headline, but credential reuse is what turned a web hash into a shell, and a trusted-folder write is what turned a normal login into root. You cannot patch your way out of any of the three. You audit them. Who can write where the system looks first. Which password is doing more than one job. What a privileged process runs by name instead of by full path. Reachability and trust, not exotic exploits, are what actually carry this box.

## 0x08 · outro

```
the page you were told to ignore was the whole map.
the database answered slow for yes and gave up its own admin.
the password opened a second lock because it was lazy.
then root came to the door, read your note off the shelf,
        and ran it without ever asking who left it.

one bug had a patch. the rest just had permissions.
only one of those gets fixed by updating.

read the robots file. mind the path. wear black.

                                                            EOF
```

---

*HTB: Writeup, retired 12 Oct 2019. An easy Linux box that is really a lesson in trusted folders and reused words, wearing a blind-injection costume. The CMS still bleeds its hash in a lab and nowhere you don't own.*