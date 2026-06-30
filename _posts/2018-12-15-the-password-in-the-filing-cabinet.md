---
layout: post
title: "The Password in the Filing Cabinet"
subtitle: "HTB Active, where a domain controller leaves a service password in a world-readable share and then hands you the keys to Kerberos"
date: 2018-12-15 12:00:00 +0000
description: "A domain controller leaks a service password from an old group policy file, then lets a low user roast the Administrator's ticket straight out of Kerberos."
image: /assets/og/the-password-in-the-filing-cabinet.png
tags: [hackthebox, writeup]
---

Active is a domain controller that filed two secrets in places anyone could read. The first is a service account password, sealed inside an old group policy file with a lock Microsoft itself printed the key to, sitting in a share that needs no login. You pick the lock with a one-liner. The second secret is worse, because it is not a leak at all. It is a feature. Once you hold any valid domain account, Kerberos will cheerfully hand you a ticket encrypted with the Administrator's password, and you carry that ticket home and grind it open offline at your leisure. No exploit binary fires on this box. You read a file the domain left out, then you ask the authentication server a polite question it was built to answer.

```
        A C T I V E   D O M A I N
        =========================
        \\dc\Replication   "come in, no login needed"
              |
              v
        Groups.xml  →  cpassword="edBSH...Vmq"
              the lock whose key Microsoft published
              |
              v
        SVC_TGS in hand. now ask Kerberos:
        "a ticket for the Administrator's service, please"
        it encrypts one with the boss's password and hands it over.
              |
              v
        grind the ticket offline. the domain falls.
                                            鍵
```

## 0x01 · the open drawer

The scan reads like a roll call for a Windows domain controller, and that is exactly what it is. `nmap -sC -sV` lights up the full kerberos-and-LDAP choir.

```
PORT     STATE SERVICE
53/tcp   open  domain
88/tcp   open  kerberos-sec
139/tcp  open  netbios-ssn
389/tcp  open  ldap          Active Directory LDAP, Domain: active.htb
445/tcp  open  microsoft-ds
3268/tcp open  ldap
9389/tcp open  mc-nmf        .NET Message Framing
```

Port 88 is the tell. Kerberos only runs on a domain controller, so the moment you see it you know what you are standing in front of. The LDAP banner even leaks the domain name, `active.htb`, which you note and move on. The first real question on any Windows box is always the same. What can I read over SMB without a password.

```
# smbmap -H 10.10.10.100
Disk            Permissions
----            -----------
ADMIN$          NO ACCESS
C$              NO ACCESS
IPC$            NO ACCESS
NETLOGON        NO ACCESS
Replication     READ ONLY
SYSVOL          NO ACCESS
```

Every share is locked except one. `Replication` is wide open to a null session, no credentials required. Think of a bank where every safe-deposit box is bolted shut except one drawer that anyone off the street can slide open. You do not need to be clever. You just need to be the person who tries the one drawer that was left unlatched.

## 0x02 · the lock with the printed key

Pull everything out of that drawer with a recursive `smbclient` grab. Buried deep in the directory tree, down a SYSVOL-shaped path, sits a file with a famous name.

```
\active.htb\Policies\{31B2F340-...}\MACHINE\Preferences\Groups\Groups.xml
```

`Groups.xml` is a Group Policy Preferences file. Years ago, admins used GPP to set local accounts and passwords across a whole domain at once, and Windows stored the password for those policies right inside this XML, encrypted. Open it and there it is, a field called `cpassword`.

```
<Groups>
  <User name="active.htb\SVC_TGS" ...>
    <Properties ... cpassword="edBSH...long base64 blob...Vmq"
                userName="active.htb\SVC_TGS"/>
  </User>
</Groups>
```

Here is the joke at the heart of it. That password is encrypted with AES, which sounds strong, except in 2012 Microsoft published the encryption key on its own developer site (CVE-2012-1897). Picture a company that sells you a heavy steel padlock and then prints the master key on the side of the box, in every box, for every customer. The lock is real. The key is public. Once the key is public the lock is decoration. A tiny tool called `gpp-decrypt` already has that key baked in, so the whole break is one line.

```
# gpp-decrypt "edBSH...Vmq"
GPPstillStandingStrong2k18
```

That is the password for `SVC_TGS`, a real domain account. Test it, and a share that was bolted shut a minute ago swings open.

```
# smbclient \\\\10.10.10.100\\Users -U active.htb/SVC_TGS%GPPstillStandingStrong2k18
smb: \> get SVC_TGS\Desktop\user.txt
```

```
████████████████████████████████
```

## 0x03 · asking kerberos for the boss

`SVC_TGS` is a nobody. It can read its own files and not much else. But on a Windows domain, being a nobody with a valid password is enough to play a much bigger game, because of how Kerberos works.

Here is the shape of it without the jargon. Kerberos is the domain's ticket booth. When you want to use a service, you ask the booth for a ticket, and the booth hands you one that is sealed with the password of whatever account runs that service. You are meant to carry the sealed ticket to the service, which can open it because it knows its own password. The catch is that the booth does not care why you are asking. Any account in good standing can request a ticket for any service. And once that sealed ticket is in your hands, nothing stops you from walking off and trying to grind the seal open at home, guessing the service password offline for as long as you like. That grind is Kerberoasting.

Picture the ticket booth at a train station. You ask for a ticket to a private executive car, and the clerk, not paid to ask questions, prints one and locks it with the executive's personal combination. You were never going to ride that car. You just wanted the locked ticket so you could sit at home and try combinations against it until it pops, with nobody watching and no alarm to trip.

So you ask. Impacket's `GetUserSPNs.py` queries the domain for every account that runs a service, then requests a ticket for each one.

```
# GetUserSPNs.py -request -dc-ip 10.10.10.100 active.htb/SVC_TGS \
    -save -outputfile tgs.iceberg
ServicePrincipalName    Name           MemberOf
----------------------  -------------  -----------------------------
active/CIFS:445         Administrator  CN=Group Policy Creator Owners
```

Read the right-hand column and your pulse jumps. The service account here is the **Administrator**. The domain just offered to seal a ticket with the most powerful password on the network and hand it straight to a low user who asked nicely.

## 0x04 · the grind

The file `tgs.iceberg` now holds a Kerberos TGS hash, which is just the sealed ticket in a form a cracker understands. None of this touches the box anymore. The domain controller has no idea what happens next, because the next part happens entirely on your own machine, offline, where there is no lockout and no log.

Feed it to hashcat in mode 13100, the one built for exactly this kind of ticket, with a wordlist.

```
# hashcat -m 13100 tgs.iceberg /usr/share/wordlists/rockyou.txt
$krb5tgs$23$*Administrator$ACTIVE.HTB$active/CIFS~445*$...:Ticketmaster1968
```

The seal pops, and there it is in plain text. `Ticketmaster1968` is the Administrator's password. A common word and a year, the kind of thing a person picks because it is easy to remember, which is also exactly what a wordlist is full of. The strongest account on the domain was guarded by the weakest possible habit.

## 0x05 · walking in as the domain

With the Administrator password you stop sneaking and start the front door. Impacket's `psexec.py` authenticates as Administrator and drops you a shell as the highest authority a Windows machine has.

```
# psexec.py active.htb/Administrator@10.10.10.100
[*] Found writable share ADMIN$
[*] Opening SVCManager on 10.10.10.100.....
C:\> whoami
nt authority\system
```

`nt authority\system` is not a user. It is the machine itself, the account the operating system runs as, and on a domain controller that means you now own the domain and everyone in it. The last flag is a formality.

```
C:\> type C:\Users\Administrator\Desktop\root.txt
████████████████████████████████
```

## 0x06 · the honest caveat

It is easy to read Active as a museum piece. GPP cpassword was killed by a patch in 2014, and any admin who left a `Groups.xml` like this on a live domain in 2026 would be committing malpractice. Fair. But notice that only the first half of this box is a patchable bug. The second half is not broken at all.

Kerberoasting is not a vulnerability. It is Kerberos doing precisely what Kerberos was designed to do, handing out service tickets to authenticated users. There is no patch for it because there is nothing to fix in the code. The only defense is on the human side of the keyboard, and it is brutally simple. Service accounts get long random passwords, the kind no wordlist will ever hold, so that even when an attacker walks off with the sealed ticket the offline grind never ends. The whole domain on this box fell not because Kerberos failed but because `Ticketmaster1968` was a password a person could remember and a cracker could guess. The bug bought the first credential. A bad password choice handed over the crown.

And sit with the first share for a second too. The entire chain only started because one drawer was readable without a login. Null-session access to a domain controller share is not exotic, it is a checkbox someone forgot, and it is the single most reliable opening move against a Windows network. The most dangerous door in any building is the one nobody remembered to lock, because nobody remembers to check it either.

## 0x07 · outro

```
the domain filed a password in a drawer it never locked,
sealed with a key its own vendor printed for the world.

then the ticket booth, doing its honest job,
handed a stranger a ticket sealed with the master's name,
and the stranger took it home and guessed the rest.

one half was a missing patch. one half was a weak word.
only one of them gets fixed on a tuesday.

try the unlocked drawer. lengthen the secret. wear black.

                                                            EOF
```

---

*HTB: Active, retired 8 Dec 2018. An easy Windows domain controller that is really a lecture on two things a network leaves lying out, an old policy file and a roastable ticket. The cpassword lock still opens in a lab and nowhere you don't own.*