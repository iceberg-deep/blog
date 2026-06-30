---
layout: post
title: "The Year on the Lock"
subtitle: "HTB Netmon, where an anonymous FTP login hands you the whole disk and a year-old backup password opens the monitor that runs as SYSTEM"
date: 2019-07-06 12:00:00 +0000
description: "Anonymous FTP gives you the entire C: drive, a stale backup leaks a 2018 password, and changing one digit lets you walk into a monitoring tool that runs commands as SYSTEM."
image: /assets/og/the-year-on-the-lock.png
tags: [hackthebox, writeup]
---

Netmon is one of the shortest boxes the platform ever shipped, and it is short for a reason worth sitting with. The front door is an FTP server that lets anyone in with no password and then, instead of dropping you in some quiet upload folder, drops you at the root of the C: drive with the whole machine spread out underneath you. The user flag is just sitting there. The root flag takes one more move, and that move is not an exploit so much as a guess. A monitoring tool keeps a backup of its own config, the backup holds the admin password from last year, and last year's password ends in `2018`. Somebody rotated it the laziest way a human can rotate a password. They changed the year. So you change the year too, log into a tool that runs whatever you tell it as SYSTEM, and the box is over. The whole thing is a story about secrets that were never really hidden and a lock whose combination was a calendar.

```
        N E T M O N
        ===========
        ftp 21 :  "name?"   anonymous    "password?"   (anything)
                       |
                       v
            you are standing at C:\  with the lights on
                       |
        a backup whispers:  PrTg@dmin2018
        you whisper back:   PrTg@dmin2019
                       |
                       v
        the monitor that watches everything
        will run anything. as system.
                                            鍵
```

## 0x01 · the open lobby

`nmap -sC -sV` comes back unmistakably Windows, and the very first line is the tell.

```
PORT     STATE SERVICE       VERSION
21/tcp   open  ftp           Microsoft ftpd
80/tcp   open  http          Indy httpd (PRTG bandwidth monitor)
135/tcp  open  msrpc         Microsoft Windows RPC
139/tcp  open  netbios-ssn
445/tcp  open  microsoft-ds
5985/tcp open  http          Microsoft HTTPAPI httpd 2.0 (WinRM)
```

FTP up front, a web service that announces itself as PRTG Network Monitor on 80, and WinRM on 5985 waiting in the back for whenever you have a credential to throw at it. Read the shape of this. The interesting work is going to be the FTP server and the monitoring tool, and the two of them are going to talk to each other in a way neither was supposed to.

## 0x02 · the door with no name

The Microsoft FTP banner says `Anonymous access allowed`, which is the network equivalent of a hotel leaving the front desk unmanned with the room keys on the counter. You log in with the username `anonymous` and any password at all, because nobody is checking.

```
# ftp 10.10.10.152
Name: anonymous
Password: anything
230 User logged in.
ftp> ls
01-25-19  11:35PM       <DIR>          Program Files
02-03-19  12:18AM       <DIR>          Users
02-25-19  10:15PM                  797 user.txt
```

Look at what `ls` returns. Not a sandboxed share. `Program Files`. `Users`. The FTP root has been pointed at `C:\` itself, so the anonymous session is browsing the actual operating system. Think of it like a coat-check that, instead of handing you your own coat, walks you into the manager's office, the staff lockers, and the basement, all on the same ticket. The user flag is a single download away in the public folder.

```
ftp> get Users/Public/user.txt
ftp> !cat user.txt
████████████████████████████████
```

That is the entire user half of the box. A flag should never be reachable by a login that has no password and no name, and here it is, because one toggle in the FTP config was set to "everyone" and one path was set to the top of the disk.

## 0x03 · the backup that talked

Anonymous read access to all of C: is not just a flag delivery service. It is a search warrant for the whole filesystem, and the obvious thing to search for is the configuration of that PRTG tool on port 80. Paessler stores its settings under ProgramData, and crucially it keeps backup copies of that config right beside the live one.

```
ftp> cd "ProgramData/Paessler/PRTG Network Monitor"
ftp> ls
"PRTG Configuration.dat"
"PRTG Configuration.old"
"PRTG Configuration.old.bak"
```

The live config is `.dat`. The `.old.bak` is an older snapshot the software wrote and then forgot to guard. Pull it down and read the part where PRTG stashes the administrator login. Picture a safe with a perfect combination lock, and taped to the bottom of the safe is a sticky note listing every combination it has ever used. The current one is hidden. The old one is right there in plain text.

```
ftp> get "PRTG Configuration.old.bak"
ftp> !grep -A1 -i dbpassword "PRTG Configuration.old.bak"
        <dbpassword>
          <![CDATA[PrTg@dmin2018]]>
        </dbpassword>
```

`PrTg@dmin2018`, for the user `prtgadmin`. Try it against the live web login and it fails, because this is the *old* password from a backup that is over a year stale. But stare at the literal string for a second. Whoever set this did not invent a passphrase. They wrote the product name and bolted the year on the end. People who name a password after the current year almost never reach for a real generator when it is time to rotate it. They reach for next year.

```
prtgadmin : PrTg@dmin2018   →   rejected
prtgadmin : PrTg@dmin2019   →   welcome back
```

One digit. The box was deployed across a year boundary, the password aged forward exactly as predictably as the calendar, and the only secret on the lock was which integer comes after eight.

## 0x04 · the watcher that runs anything

Now you are logged into PRTG as the administrator, and PRTG is the kind of software that was always going to be dangerous once you held its admin cookie. Monitoring tools watch your infrastructure, and to be useful they can react. When a sensor trips, PRTG can fire a notification, and one flavor of notification is "Execute Program," where it launches a script on the host and lets you pass parameters to it. That parameter field is CVE-2018-9276, an authenticated command injection that lives in every PRTG before 18.2.39, and Netmon runs an older build than that.

The bug is the same bone-deep mistake injection always is. PRTG takes the parameter string you type and hands it to a Windows PowerShell context to run, and it does not scrub the characters that mean "and now run this next command too." A lot of punctuation gets filtered, but the semicolon survives, and in PowerShell a semicolon ends one statement and starts another. Think of it like a waiter who reads your order to the kitchen exactly as written. Order "a salad; also set the building on fire" and a careful waiter stops at the semicolon. This waiter reads the whole line aloud, and the kitchen, hearing two complete instructions, does both.

So you build a notification whose parameter is a harmless-looking filename followed by a semicolon and the commands you actually want. The cleanest payload does not even need a reverse shell. It just creates a brand-new local administrator out of thin air.

```
Notification → Execute Program → Parameter field:

  iceberg.txt; net user iceberg P@ssw0rd-iceberg /add ;
               net localgroup administrators iceberg /add
```

Because PRTG's core service runs as SYSTEM, every command after that first semicolon runs as SYSTEM too. Save the notification, then hit the little "Test" button beside it to make PRTG fire immediately rather than waiting on a sensor to trip. The first statement pretends to be the script name PRTG expected. Everything after it is yours, executing with the highest privilege the machine has.

## 0x05 · walking in the front

The injection ran as SYSTEM, so the `iceberg` account you just minted is a full local administrator. You no longer need the bug at all. You have a real Windows credential, and the box left WinRM open on 5985 and SMB on 445 precisely so a credential can be used the boring, legitimate way. Reach for `psexec.py` from Impacket, hand it the account you created, and ask for a shell.

```
# psexec.py iceberg:'P@ssw0rd-iceberg'@10.10.10.152
[*] Requesting shares on 10.10.10.152.....
[*] Found writable share ADMIN$
[*] Opening SVCManager on 10.10.10.152.....
C:\Windows\system32> whoami
nt authority\system
```

`nt authority\system`. Not the admin you forged, but the very top of the Windows privilege model, because `psexec.py` installs its payload as a service and services answer to SYSTEM. The root flag is on the Administrator's desktop, and SYSTEM reads anything.

```
C:\Windows\system32> type C:\Users\Administrator\Desktop\root.txt
████████████████████████████████
```

## 0x06 · the honest caveat

It is easy to read Netmon as a comedy of misconfiguration and move on, and the FTP half really is that. Anonymous login pointed at the C: drive is a checkbox somebody never should have ticked, and it is the sort of thing a config review catches in thirty seconds. Tighten that one toggle and the user flag vanishes from reach. Fine.

The part that should keep you up is the password, because no patch in the world fixes it. `PrTg@dmin2018` becoming `PrTg@dmin2019` is not a bug in any vendor's code. It is a bug in how human beings rotate secrets when the policy says "change your password" and the human hears "increment something small." The leaked backup only mattered because the new secret was a trivial function of the old one. If that rotation had produced anything unrelated to last year's value, the stale `.old.bak` would have been a dead end and the box would have stalled cold. Predictability is the whole vulnerability. An attacker who holds one version of your password and knows you change it lazily does not need to crack the next one. They just need to count.

And the CVE underneath is the same confession every injection makes, the one Lame made with a Samba username and the one a billion web forms make with a search box. A program took a string a person typed and could not tell where the data stopped and the instructions began. PRTG meant that field to be a filename. The semicolon turned it into a sentence with two verbs, and the second verb ran as SYSTEM. The fix is never "filter harder," because there is always one more character. The fix is to stop letting typed text reach the part of the machine that pulls levers.

## 0x07 · outro

```
the door had no name and opened on the whole house.
the safe had a sticky note listing last year's combination.
the new combination was last year's, plus one.

nobody picked a lock here. they read the calendar
and let the monitor that watches everything
run a sentence with a semicolon in it. as system.

count the years. salt the rotation. wear black.

                                                            EOF
```

---

*HTB: Netmon, retired 29 June 2019. An easy Windows box that is really a lecture on lazy rotation and an injection in a tool built to run programs on command. The year on the lock still turns in a lab and nowhere you don't own.*