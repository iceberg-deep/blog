---
layout: post
title: "The Long Confession"
subtitle: "HTB PivotAPI, where a name buried in a PDF starts a chain of leaked secrets that walks the whole domain one borrowed identity at a time"
date: 2021-11-13 12:00:00 +0000
description: "An insane Windows box that is one long confession, every layer handing up the secret it was told to hide, from a name in a PDF to the LAPS password for administrador."
image: /assets/og/the-long-confession.png
tags: [hackthebox, writeup]
---

PivotAPI is one long confession. Nothing on it is forced. Every layer was handed a secret to keep, and every layer leaked it to the next person who asked politely. It starts with a name accidentally stamped into a PDF, and that name is enough to ask the domain controller for a ticket no password should buy. From there it is a relay race of leaks. A roasted hash becomes a login, a login becomes a download, a download becomes a debugger session that bleeds a database password out of an obfuscated binary, the database becomes a tunnel, the tunnel reaches a password vault, the vault hands over an SSH key, and from inside the domain you reset one account after another until you are standing on the one group that can read the local administrator password straight out of the directory. No memory corruption. No zero-day. Just a dozen doors, each one held open from the inside, each one whispering the combination to the next.

```
        P I V O T A P I
        ===============
        a PDF remembers who made it.
              |  Kaorz
              v
        the DC hands out a ticket nobody paid for  (AS-REP)
              |  crack it -> Roper4155
              v
        a binary, told a secret, says it aloud under a debugger
              |  svc_mssql / #mssql_s3rV1c3!2020
              v
        the database becomes a tunnel becomes a vault becomes a key
              |  reset, reset, reset
              v
        the group that can read the admin password. and it does.
                                                            告
```

## 0x01 · the open door and the stamped name

`nmap` comes back loud and unmistakably a domain controller. FTP and SSH at the bottom, then the whole Active Directory orchestra above them.

```
PORT     STATE SERVICE       VERSION
21/tcp   open  ftp           Microsoft ftpd
22/tcp   open  ssh           OpenSSH for_Windows_8.1
53/tcp   open  domain
88/tcp   open  kerberos-sec
135/tcp  open  msrpc
389/tcp  open  ldap          LicorDeBellota.htb
445/tcp  open  microsoft-ds
1433/tcp open  ms-sql-s      Microsoft SQL Server
```

SSH on a Windows DC is a tell all by itself, and the LDAP banner gives up the domain, `LicorDeBellota.htb`. The FTP allows anonymous login, and inside a `HelpDesk` folder there are PDFs. PDFs are gossips. They carry metadata almost nobody scrubs, and `exiftool` reads it back to you.

```
$ exiftool notes2.pdf
Creator    : Kaorz
Producer   : Microsoft Word
```

There it is. A username, `Kaorz`, left in the document properties like a fingerprint on a wine glass. Think of it like a photo you texted a friend that quietly carries the GPS coordinates of your kitchen. You shared the picture. You did not mean to share the address. The PDF was supposed to be advice from the help desk. It was also a name tag.

## 0x02 · the ticket nobody paid for

A valid username on a domain controller is a lever, because of one specific misconfiguration that lives on too many accounts. Kerberos normally makes you prove who you are before it issues an authentication ticket, a step called pre-authentication. But an account can have that requirement switched off, and when it is, the DC will hand out a ticket encrypted with the user's password to anyone who asks. That ticket is crackable offline. This is AS-REP roasting, and Impacket's `GetNPUsers.py` does the asking.

```
$ GetNPUsers.py -no-pass -dc-ip 10.10.10.240 LicorDeBellota.htb/Kaorz
$krb5asrep$23$Kaorz@LICORDEBELLOTA.HTB:9a8c...
```

Picture a coat check that is supposed to demand your ticket stub before fetching your coat. This one has a broken rule for certain coats, so you walk up, say a name, and the attendant hands you a locked box that only that person's password opens. You did not get in. But now you can sit at home and try every key in the world against the box, quietly, forever.

```
$ hashcat -m 18200 kaorz.hash rockyou.txt
$krb5asrep$23$Kaorz@...:Roper4155
```

`Roper4155`. Now Kaorz is not just a name, it is a login. SMB opens up, and the `NETLOGON` share holds a `Restart-OracleService.exe` binary and a couple of saved Outlook messages about a migration from Oracle to MSSQL. The binary is the next confession waiting to happen.

## 0x03 · the binary that talks under the lights

`Restart-OracleService.exe` is a Russian doll. Run it under Procmon and watch it drop a temporary batch file, which carries a base64 blob, which decodes to a second .NET binary that is obfuscated to hide a password it needs in order to do its job. Static analysis is a slog through the obfuscation. So you do the lazy, beautiful thing instead. You let the program decrypt its own secret, and you read it the instant it does.

Load the inner binary in dnSpy, set a breakpoint right after the decryption routine, and step. Think of it like a safe with the combination written on a sticky note that the owner only ever holds up for half a second. You cannot read the sticky note from across the room. But if you freeze time at the exact frame the note is visible, it is right there in plain ink. The debugger is the pause button.

```
// dnSpy, breakpoint after the decrypt call:
plaintext = "#mssql_s3rV1c3!2020"   // svc_mssql
```

The emails told you Oracle became MSSQL, and the service account followed the same naming pattern with the year bumped. `svc_mssql` / `#mssql_s3rV1c3!2020` logs straight into the SQL Server on 1433, and `sa` happens to share the same password.

```
$ mssqlclient.py LicorDeBellota.htb/svc_mssql@10.10.10.240
SQL> SELECT name FROM sys.databases;
```

## 0x04 · the database that became a hallway

Owning the database is not owning the host, but MSSQL is a famously convenient place to stand because it can be talked into doing things the operating system should never let it do. The tool here is mssqlproxy. It abuses the SQL Server's ability to load a CLR assembly and run native code, turning the database connection into a SOCKS proxy that pivots traffic deeper into the box. (The box is named for exactly this move.)

```
$ mssqlclient.py ... -q "EXEC sp_configure 'Ole Automation Procedures', 1; RECONFIGURE;"
$ python mssqlproxy.py -ip 10.10.10.240 -d iceberg -clr ...
[+] SOCKS proxy listening on 127.0.0.1:1337
```

With the proxy up, `proxychains evil-winrm` reaches the WinRM service that was never exposed to the outside, and you get a real shell as `svc_mssql`. Picture a building where the front door is sealed but the vending machine in the lobby has a service hatch wide enough to crawl through. The database was supposed to serve queries. It served as a tunnel instead, because someone left the hatch unlocked.

On that account's desktop sits a KeePass vault, `credentials.kdbx`. Vaults are only as good as their master password, and KeePass master passwords crack offline like anything else.

```
$ keepass2john credentials.kdbx > kp.hash
$ hashcat -m 13400 kp.hash rockyou.txt
...:mahalkita
```

`mahalkita` opens the vault, and inside is an SSH credential for the user `3v4Si0N`, `Gu4nCh3C4NaRi0N!23`. SSH in and `user.txt` is yours.

```
$ ssh 3v4Si0N@10.10.10.240
3v4Si0N@PIVOTAPI C:\> type Desktop\user.txt
████████████████████████████████
```

## 0x05 · resetting your way across the domain

Now you are inside the directory, and the rest of the box is an Active Directory rights problem. BloodHound maps it. Certain accounts hold dangerous control edges over other accounts, the kind that let you change someone's password without knowing their old one. PowerView turns that abstract right into a single command.

```
PS> Set-DomainUserPassword -Identity Dr.Zaiuss -AccountPassword $newpw
PS> Set-DomainUserPassword -Identity superfume -AccountPassword $newpw
```

`3v4Si0N` can reset `Dr.Zaiuss`, who can reset `superfume`, who lands you in the Developers group. Think of it like an office where the night manager can issue anyone a new keycard, and the new hire he issues one to can do the same for the next person down the hall. Nobody stole a key. Each person simply had the authority to mint a fresh one for someone else, and you walked that authority across the whole floor.

The Developers group opens `C:\Developers\jari`, holding another binary, `restart-mssql.exe`, with its source `program.cs` alongside. Same trick as before, a different secret. Break on the RC4 decryption in dnSpy and read `Jari` / `Cos@Chung@!RPG` out of memory as it appears.

## 0x06 · the group that reads the admin's password

The final stretch is the cleanest abuse of all because it touches a security feature working exactly as designed. `Jari` has `ForceChangePassword` over `Gibdeon`, and `Gibdeon` belongs to Account Operators, a group that can create users and shuffle group memberships. So you mint your own user, sign it iceberg, and slot it into the group that is allowed to read LAPS.

LAPS is Microsoft's fix for the old sin of every machine sharing one local admin password. It sets a unique random password on each box and stashes it in a hidden directory attribute, `ms-mcs-admpwd`, readable only by accounts you bless. The catch is that whoever can edit group membership can bless themselves.

```
PS> New-ADUser -Name bob ...               # via Gibdeon / Account Operators
PS> Add-ADGroupMember "LAPS_Readers" bob
PS> Get-ADComputer PivotAPI -Properties ms-mcs-admpwd | select ms-mcs-admpwd
ms-mcs-admpwd : 7BzS0y089bE250p625Bb
```

Picture a hotel that issues every room a different safe code and keeps the master list in a binder behind the desk, readable only by managers. LAPS is that binder, and it is a genuinely good idea. The flaw here is that one of the doors you already walked through let you promote yourself to manager, and managers get to read the binder. The feature kept its promise. The promise was just made to the wrong list of people.

```
$ evil-winrm -i 10.10.10.240 -u administrador -p 7BzS0y089bE250p625Bb
*Evil-WinRM* PS> type C:\Users\cybervaca\Desktop\root.txt
████████████████████████████████
```

## 0x07 · the honest caveat

It is easy to look at PivotAPI, count the dozen steps, and file it under "insane, contrived, nothing like real life." That is the wrong read. Real compromises look exactly like this. They are almost never one spectacular exploit. They are a long quiet chain of small leaks, each one individually defensible, each one handing the attacker just enough to ask the next question. A name in a PDF. A Kerberos account with one checkbox flipped. A service binary that has to know a password and stores it in a way it can decrypt, which means anyone watching it run can decrypt it too. A password reused with the year bumped. A vault with a weak master key.

The single most important lesson is buried in the binaries. A program that needs a secret at runtime cannot truly hide that secret from someone who controls the machine it runs on. Obfuscation, encryption, base64 wrapped around base64, all of it only raises the cost of watching. Set a breakpoint after the decrypt and the plaintext is right there, because the program itself must eventually hold the cleartext to use it. Anything your code can decrypt, an attacker on that box can decrypt by simply letting your code do the work and reading over its shoulder.

And LAPS is the part worth sitting with, because nothing about it was broken. It is the modern, correct answer to a real problem, and it shipped doing exactly what the manual says. The whole final escalation was just an attacker arriving at a group membership they were never supposed to reach, by walking a path of password resets the directory permitted at every step. You cannot patch your way out of that. The bug is not in LAPS. The bug is the map of who can promote whom, and that map is something only paranoia and a BloodHound run will ever show you.

## 0x08 · outro

```
a PDF remembered a name it should have forgotten.
a ticket came out for a password nobody had yet.
a binary said its secret out loud the moment it was asked to keep it.

then reset by reset, the domain introduced you to yourself
as the one person allowed to read the last password in the building.

twelve doors. not one of them forced.
they were all held open from the inside.

read the metadata. break on the decrypt. map who can crown whom. wear black.

                                                            EOF
```

---

*HTB: PivotAPI, retired 6 Nov 2021. An insane Windows box that is really a lecture on the long chain, every layer leaking the secret it was told to keep, from a name in a PDF to the LAPS password for administrador. The combination was whispered down the line, door to door, all the way to the top.*