---
layout: post
title: "The Names in the Photographs"
subtitle: "HTB Absolute, where six faces on a homepage become six usernames, and the only way in is to stop asking with NTLM"
date: 2023-06-03 12:00:00 +0000
description: "Absolute turns a stock-photo homepage into a roster of real names, then forces you to attack a domain that refuses every NTLM handshake and only speaks Kerberos."
image: /assets/og/the-names-in-the-photographs.png
tags: [hackthebox, writeup]
---

Absolute is a domain that does not trust the front door, the back door, or the handshake you have used your whole career. It opens with a website full of smiling stock-photo people, and the first move is to notice that those people have names, and the names are baked into the image files where the photographer left them. From six faces you build six usernames. From the usernames you Kerberos-roast a password out of thin air. And then the box does the thing that makes it Insane: it turns off NTLM for every human account, so every tool you reach for that whispers a hash instead of a ticket bounces off a wall marked ACCOUNT_RESTRICTION. You do not break Absolute by finding one clever bug. You break it by learning to speak Kerberos all the way down, and then by relaying a ticket the machine account never meant to hand you.

```
        A B S O L U T E
        ===============
        a homepage of strangers     →  exif → six real names
                |
        names → usernames → AS-REP   →  one account forgot to ask for a password
                |
        NTLM?  "ACCOUNT_RESTRICTION"  ← the whole domain only speaks kerberos
                |
        a ticket, relayed to ldap,
        becomes the machine's own crown.
                                            絶
```

## 0x01 · the doormat

`nmap` returns the unmistakable shape of a domain controller pretending to be a website. DNS, Kerberos, LDAP, SMB, WinRM, and a lonely IIS server on 80.

```
PORT     STATE SERVICE       VERSION
53/tcp   open  domain
80/tcp   open  http          Microsoft IIS httpd 10.0
88/tcp   open  kerberos-sec
389/tcp  open  ldap          Microsoft Windows Active Directory
445/tcp  open  microsoft-ds
636/tcp  open  ssl/ldap
5985/tcp open  http          Microsoft HTTPAPI httpd 2.0 (WinRM)
```

Two tells matter before you touch the web app. The Kerberos port answering on 88 means the real authentication for this network happens in tickets, not passwords on the wire. And the clock is off by roughly seven hours, which matters more than it sounds, because Kerberos is paranoid about time. A ticket is stamped with a moment, and if your watch and the server's watch disagree by more than five minutes, the server throws the ticket out as a replay. Picture a nightclub that only honors a stamp on your hand if it was inked in the last five minutes. Show up with yesterday's stamp and the bouncer waves you off. So the very first command on Absolute is not an exploit, it is `ntpdate` or `faketime`, syncing your clock to the box so the domain will even talk to you.

## 0x02 · the names in the photographs

The website is a slideshow of hero images, `hero_1.jpg` through `hero_6.jpg`, stock photos of confident people in an office. There is nothing to click. The content is the metadata. Pull the EXIF out of each image with `exiftool` and the Author field is filled in.

```
$ exiftool hero_*.jpg | grep -i author
Author    : James Roberts
Author    : Michael Chaffrey
Author    : Donald Klay
Author    : Sarah Osvald
Author    : Jeffer Robinson
Author    : Nicole Smith
```

Six full names. A domain does not log people in by their full name, though, it logs them in by an account name, and you do not yet know the convention. So you generate every plausible shape with `username-anarchy` (jroberts, james.roberts, j.roberts, robertsj, and so on) and then ask the domain itself which ones are real. `kerbrute userenum` does this without a single password, because Kerberos leaks the truth for free. Ask the KDC for a ticket for a username, and it answers differently for an account that exists than for one that does not. Think of it like knocking on doors in a hallway and listening to the echo. A real apartment sounds hollow, an empty wall sounds solid, and you never had to pick a lock to map the floor.

```
$ kerbrute userenum -d absolute.htb --dc 10.10.11.181 names.txt
[+] VALID USERNAME: j.roberts@absolute.htb
[+] VALID USERNAME: d.klay@absolute.htb
[+] VALID USERNAME: s.osvald@absolute.htb
...
```

The convention is `[first initial].[lastname]`. Six photos became six confirmed accounts.

## 0x03 · the account that forgot to ask

With a list of real usernames you run the cheapest attack in Active Directory, AS-REP-Roasting (`GetNPUsers.py`). Normally, before the KDC hands you anything, it makes you prove you are you by encrypting a timestamp with your password. That proof is called pre-authentication. But an account can be configured to skip it, and when one is, the KDC will hand a stranger a chunk of data encrypted with that account's password key, no questions asked. That chunk is crackable offline.

```
$ GetNPUsers.py absolute.htb/ -usersfile valid_users.txt -no-pass -dc-ip 10.10.11.181
$krb5asrep$23$d.klay@ABSOLUTE.HTB:8f1c... (truncated)
```

Only `d.klay` comes back, the account that forgot to require a password proof. Feed the hash to `hashcat` and it falls.

```
$ hashcat -m 18200 dklay.asrep rockyou.txt
...:Darkmoonsky248girl
```

So now you hold `d.klay : Darkmoonsky248girl`. And here is where Absolute slams the first door. Try to use those creds the normal way, with an NTLM-flavored tool, and the box spits back `STATUS_ACCOUNT_RESTRICTION`. The account is in the Protected Users group, a hardening feature that forbids NTLM entirely. Picture a company that has banned the fax machine. Your password is correct, but the only fax line into the building is dead, and the front desk only accepts couriered, time-stamped envelopes. That courier is Kerberos. So you stop faxing. `kinit d.klay` requests a real ticket-granting ticket, drops it into a `ccache` file, and from here every tool runs with `KRB5CCNAME` pointed at that ticket.

## 0x04 · the secret in the description field

Authenticated by ticket, you read LDAP, the domain's giant address book. Run `crackmapexec ldap` with Kerberos and dump the user objects, paying attention to the description field, the little free-text note an admin scribbles next to an account. People put terrible things there.

```
$ KRB5CCNAME=d.klay.ccache crackmapexec ldap dc.absolute.htb -k --use-kcache --users
svc_smb    Will be un-restricted, password: AbsoluteSMBService123!
```

An administrator typed a service account's password into a comment box, the way someone tapes the alarm code to the monitor so the night cleaner can find it. `svc_smb : AbsoluteSMBService123!`. Same drill, `kinit` for a fresh ticket, because NTLM is still off.

## 0x05 · the binary that phoned home

`svc_smb` can read a share called `\\dc\Shared`, and inside sit two files that do not belong on a production DC, a Nim compiler script and a compiled `test.exe`. Static analysis of a Nim binary is a headache. So you do the lazy, correct thing instead. You run it in a sandbox and watch what it says out loud. Fire up `Wireshark`, launch the binary, and wait. After a delay the program reaches across the network and tries to bind to LDAP, and because it is using cleartext on 389, its credentials are sitting naked in the packet capture.

```
bindRequest  name: mlovegod  authentication: simple
              password: AbsoluteLDAP2022!
```

Think of it like a robot that has a key taped to its back, and every thirty seconds it walks over to a locked door and reads the key number out loud before trying it. You did not have to pick the robot apart. You just had to stand in the hallway and listen. The username in the packet is the raw `mlovegod`, but you already know this domain's shape, so the real account is `m.lovegod : AbsoluteLDAP2022!`.

## 0x06 · writing your own way in

`m.lovegod` is the pivot. Run the graph through `BloodHound` and the path lights up: this account holds `GenericWrite` over a group called Network Audit, and that group eventually reaches an account named `winrm_user`, who is allowed to log in remotely. `GenericWrite` is the right to edit an object's attributes, and in modern AD that is almost as good as owning it, because of a feature called Shadow Credentials.

Here is the idea in plain terms. Kerberos can authenticate you with a certificate instead of a password, and the list of certificates an account trusts lives in an attribute on that account. If you can write that attribute, you can staple your own certificate onto someone else's identity and then log in as them with a key only you hold. Picture being able to add your own photo to someone else's employee badge file. The next time the scanner sees your face, it cheerfully prints their name.

The chain is mechanical. Use `dacledit.py` to grant yourself rights, `net rpc group addmem` to slot into Network Audit, then `certipy shadow auto` to forge the key credential onto `winrm_user`.

```
$ certipy shadow auto -u m.lovegod@absolute.htb -k -target dc.absolute.htb \
    -account winrm_user
[*] Adding Key Credential...
[*] Authenticating and saving ccache to 'winrm_user.ccache'
```

That ccache is a Kerberos ticket for `winrm_user`, and `winrm_user` sits in Remote Management Users. `evil-winrm` with the ticket drops you onto the box.

```
$ KRB5CCNAME=winrm_user.ccache evil-winrm -i dc.absolute.htb -r absolute.htb
*Evil-WinRM* PS C:\Users\winrm_user\Desktop> type user.txt
████████████████████████████████
```

## 0x07 · relaying the machine's own ticket

`winrm_user` is a guest in their own house. No useful privileges. The way up is the box's marquee flaw, a Kerberos relay, and it works only because Absolute is missing the October 2022 patch and ships with LDAP signing off by default.

Relaying is forwarding. When some process on the box authenticates, it produces a Kerberos ticket aimed at a service. If you can sit in the middle and catch that authentication, you can forward it to LDAP and act with the authority of whoever (or whatever) just authenticated. The local trick is to coerce a high-privilege component into authenticating to a port you control. You compile `KrbRelay`, find the right COM CLSID for the OS build, and because you need an interactive token rather than a WinRM stub, you relaunch through `RunasCs` signed as iceberg.

```
PS> .\RunasCs-iceberg.exe m.lovegod 'AbsoluteLDAP2022!' -d absolute.htb -l 9 \
      ".\KrbRelay.exe -spn ldap/dc.absolute.htb -clsid <clsid> \
       -add-groupmember administrators winrm_user"
[+] Relaying to LDAP...
[+] Added winrm_user to administrators
```

The variant `KrbRelayUp` does the same dance but targets the machine account, stapling a shadow credential onto `DC$` itself. Picture a security guard who, mid-yawn, hands his master key to the next person who taps his shoulder, never checking whose shoulder it was. You tapped. With `Rubeus asktgt` you trade that credential for a ticket as the domain controller's own computer account.

## 0x08 · the keys to everything

A domain controller's machine account is allowed to replicate the directory, which is the polite name for "ask for every password hash in the domain." With the `DC$` ticket you run a DCSync.

```
$ secretsdump.py -k -no-pass dc.absolute.htb -just-dc-user administrator
administrator:500:aad3b...:1f4a6093623653f6488d5aa24c75f2ea:::
```

The Administrator account is not in Protected Users, so its NTLM hash is finally useful, and a pass-the-hash with `evil-winrm` walks you straight in.

```
$ evil-winrm -i dc.absolute.htb -u administrator -H 1f4a6093623653f6488d5aa24c75f2ea
*Evil-WinRM* PS C:\Users\Administrator\Desktop> type root.txt
████████████████████████████████
```

## 0x09 · the honest caveat

Absolute is rated Insane and the rating is honest, but not because any single step is exotic. It is Insane because it refuses to let you fall back on the lazy reflex. The whole industry quietly relies on NTLM, on tools that pass a hash, on the comfortable assumption that a correct password is a working password. This box turns NTLM off for the people who matter and leaves it on only for the machine accounts you are not supposed to reach, and suddenly half your muscle memory throws errors. The lesson the defenders wanted to teach is real: Protected Users and Kerberos-only auth genuinely raise the cost of an intrusion. An attacker who only knows how to spray hashes is dead in the water on the front lawn.

But notice what carried the box anyway, and it was never a memory-corruption trick. It was a name left in a photo, a password typed into a comment box, a service account's secret broadcast in cleartext by its own binary, and a relay that exists because one patch was missing and one signing flag was off. Every one of those is a human decision, not a software defect. You can force the whole domain to speak Kerberos and still lose it, because the hardening protects the protocol, not the habit of writing the secret down where the wrong person reads it. The strongest lock on Earth is worthless if the combination is taped to the inside of a door anyone can open.

## 0x0a · outro

```
the strangers in the photos had names.
the names had accounts. one account forgot its password.
the domain refused every handshake but one, and we learned to speak it.

then a ticket nobody guarded was relayed into a crown.

speak kerberos. read the metadata. never write the secret down. wear black.

                                                            EOF
```

---

*HTB: Absolute, retired 27 May 2023. An insane Windows box that is really a lecture on living without NTLM, where six stock photos become a domain takeover and the last mile is a Kerberos ticket relayed into the machine's own authority.*