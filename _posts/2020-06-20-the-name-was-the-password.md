---
layout: post
title: "The Name Was the Password"
subtitle: "HTB Monteverde, where a service account uses its own name as its password and the cloud sync tool quietly hoards the domain admin's secret in a local database"
date: 2020-06-20 12:00:00 +0000
description: "A batch account named after its own password, an XML file left in a share, and a cloud sync service that keeps the domain admin's credential in a drawer it can be talked into opening."
image: /assets/og/the-name-was-the-password.png
tags: [hackthebox, writeup]
---

Monteverde is a bank that wired its old basement vault to a brand-new cloud, and forgot that the wire runs both directions. There is no exploit binary here, no overflow, no clever payload. There is a service account so tired of remembering its own password that it just used its own name, a config file left in a share that anyone with a login can read, and a synchronization service whose entire job is to hold a copy of the domain admin's credential where it can reach it on demand. You do not break Monteverde. You ask each layer the obvious question and each layer, being helpful, answers. The last answer it gives you is the keys to the kingdom, because the tool that bridges the on-prem directory and Azure was built to know that secret, and a secret a program can decrypt is a secret you can decrypt too.

```
        M E G A B A N K
        ===============
        rpc:   "who works here?"   →  a list of names
                       |
        spray: name == password?   →  SABatchJobs : SABatchJobs
                       |
        share: an xml left in a drawer  →  mhope's key
                       |
        winrm: a real shell, low and quiet
                       |
        the cloud-sync service keeps the admin's
        password so it can log in for you.
        ask it nicely. it decrypts its own drawer.
                                            鍵
```

## 0x01 · the lobby

`nmap` comes back loud and unmistakably a domain controller. Nineteen ports, the full Active Directory orchestra. DNS on 53, Kerberos on 88, RPC on 135, LDAP on 389, SMB on 445, and WinRM waiting up on 5985.

```
PORT     STATE SERVICE       VERSION
53/tcp   open  domain
88/tcp   open  kerberos-sec
135/tcp  open  msrpc
139/tcp  open  netbios-ssn
389/tcp  open  ldap          Microsoft Windows AD LDAP
445/tcp  open  microsoft-ds
5985/tcp open  http          Microsoft HTTPAPI httpd 2.0 (WinRM)
```

LDAP leaks the domain name on the first handshake. `MEGABANK.LOCAL`. The box is a bank, the box is a domain controller, and the box has WinRM open, which is the tell that matters most. WinRM is the remote-shell door for Windows. If you can ever find a username and password that the box trusts, that port turns them into an interactive prompt. So the whole game from here is simple to state. Find one credential the machine believes.

## 0x02 · the staff directory

Active Directory has an old, generous habit. By default it will tell an anonymous stranger who works at the company. You do not need a login to ask for the employee list, you just need to ask RPC politely.

```
$ rpcclient -U "" -N 10.10.10.172
rpcclient $> querydispinfo
  ... Account: AAD_987d7f2f57d2 ...
  ... Account: dgalanos ...
  ... Account: mhope ...
  ... Account: SABatchJobs ...
  ... Account: svc-ata ...
```

Picture walking into an office lobby and the receptionist, before you have shown a single piece of ID, cheerfully reads you the entire phone directory. Names, departments, everyone. That is null-session RPC enumeration. It is not a bug exactly, it is a default that was reasonable in 1999 and is a gift to an attacker now. Scrape the names into a file. Two of them are interesting on sight. `AAD_987d7f2f57d2` is the account Azure AD Connect creates for itself, which is a flare that says cloud sync lives on this box. And `SABatchJobs` reads like a service account, the kind nobody logs into as a human and nobody picks a careful password for.

## 0x03 · the name that was the key

Now the laziest, most reliable trick in the Windows playbook. People, and especially the people who set up service accounts at 4pm on a Friday, will sometimes set the password to be the username. Not a variation. The literal same string. So you take your list of names and you try each name as its own password.

```
$ crackmapexec smb 10.10.10.172 -u users.txt -p users.txt --continue-on-success
SMB  10.10.10.172  445  MEGABANK  [-] MEGABANK\dgalanos:dgalanos STATUS_LOGON_FAILURE
SMB  10.10.10.172  445  MEGABANK  [-] MEGABANK\mhope:mhope STATUS_LOGON_FAILURE
SMB  10.10.10.172  445  MEGABANK  [+] MEGABANK\SABatchJobs:SABatchJobs
```

There it is. `SABatchJobs : SABatchJobs`. The account is named after its own password, or the password is named after the account, and it does not matter which way you read it because the result is the same. Think of it like a hotel where one room key has the room number stamped on it and the room number written on the lock. Anyone who can read the door can open it. `crackmapexec` is just trying every key against every door fast, and one door was labeled with its own combination.

This account is low and boring, which is exactly what you want for a first foothold. Boring accounts go unwatched.

## 0x04 · the drawer left open

A login, even a humble one, turns SMB from a wall into a filing cabinet. List the shares as `SABatchJobs` and look for anything that should not be readable.

```
$ smbmap -u SABatchJobs -p SABatchJobs -H 10.10.10.172
  users$       READ ONLY
  ...
$ smbclient //10.10.10.172/users$ -U SABatchJobs%SABatchJobs
smb: \> recurse on; ls
  \mhope\azure.xml
smb: \> get mhope\azure.xml
```

A file named `azure.xml` sitting in `mhope`'s folder, and a service account can read it. Open it.

```
$ cat azure.xml
  <S N="Password">4n0therD4y@n0th3r$</S>
  <S N="Username">mhope@MEGABANK.LOCAL</S>
```

A password in plaintext, in an XML file, in a share, belonging to a user who is not a service account. Someone was setting up Azure and saved their credentials to disk to make the next step easier, and never deleted the note. Picture a sticky note with the manager's password left inside an unlocked supply closet that the whole staff has a key to. The note was a convenience for one busy afternoon. It is a permanent liability the moment a stranger gets a key to the closet.

## 0x05 · a real shell

`mhope` is a person, and people get the doors service accounts do not. Test the new credential against WinRM.

```
$ crackmapexec winrm 10.10.10.172 -u mhope -p '4n0therD4y@n0th3r$'
HTTP  10.10.10.172  5985  MEGABANK  [+] MEGABANK\mhope:4n0therD4y@n0th3r$ (Pwn3d!)
```

`Pwn3d!` means WinRM will let `mhope` in. `evil-winrm` turns that into an honest interactive PowerShell prompt.

```
$ evil-winrm -i 10.10.10.172 -u mhope -p '4n0therD4y@n0th3r$'
*Evil-WinRM* PS C:\Users\mhope\Documents> type ..\Desktop\user.txt
████████████████████████████████
```

User is done. Now look at what `mhope` is, not just who. Check the group memberships and one line stands out.

```
PS> whoami /groups | findstr /i azure
MEGABANK\Azure Admins
```

`mhope` is in `Azure Admins`. That group exists because `mhope` administers the Azure AD Connect installation, and that installation is the whole reason this box exists.

## 0x06 · the sync service that knew too much

Azure AD Connect is the bridge that keeps your on-prem Active Directory and your cloud Azure tenant in lockstep. To do that job, it has to log into both sides automatically, over and over, forever, with no human typing a password. Which means it has to store those passwords somewhere it can reach them itself. And the account it stores is a privileged one, because syncing identities requires reaching deep into the directory.

Here is the uncomfortable truth at the center of Monteverde. Encryption protects a secret from people who do not have the key. But the sync service must be able to decrypt its own stored credentials on its own, with no human present, or it cannot do its job at 3am. So the key has to live right next to the lock. Think of it like a house that needs to let itself in every night, so it keeps the front-door key under a flowerpot on the porch. The lock is real. The key is right there. Anyone who learns where to look, and who is allowed on the porch, is already inside.

The credentials live in a local database, an `ADSync` instance reachable on `127.0.0.1`. With a shell as a member of `Azure Admins`, you can query it. A short PowerShell routine, the kind published openly as proof of concept, does three things. It pulls the keyset and entropy that seed the decryption. It reads the encrypted configuration blob. And it borrows the sync service's own decryption library to undo the encryption, because the machine ships with everything required to decrypt its own drawer.

```
PS> # query the ADSync localdb for the stored config
PS> SELECT keyset_id, instance_id, entropy FROM mms_server_configuration
PS> SELECT private_configuration_xml, encrypted_configuration
        FROM mms_management_agent WHERE ma_type = 'AD'
PS> # then call the box's own mcrypt key-manager to decrypt
```

The encrypted blob unwraps into a username and a cleartext password.

```
[*] Username: administrator
[*] Password: d0m@in4dminyeah!
```

The sync service was holding the domain administrator's password, in a form it could decrypt at will, and `mhope` had just enough standing to make it perform that decryption out loud.

## 0x07 · the crown

A domain admin password and an open WinRM port need no ceremony. Walk in the front door again, as the administrator this time.

```
$ evil-winrm -i 10.10.10.172 -u administrator -p 'd0m@in4dminyeah!'
*Evil-WinRM* PS C:\Users\Administrator\Documents> whoami
megabank\administrator
PS> type ..\Desktop\root.txt
████████████████████████████████
```

No exploit fired across the whole chain. Every step was a thing the box was designed to do, used against the box.

## 0x08 · the honest caveat

It is easy to read Monteverde as a string of careless humans, and there is some of that. A service account named after its password, a credential file left in a share. Those are mistakes, they get fixed by a policy and a delete key, and they are the loud part of the box. But they are not the part that should keep an architect awake.

The part that should is the last one, because nothing there was a mistake at all. Azure AD Connect is doing exactly what it was built to do. It synchronizes two directories, so it must authenticate to both unattended, so it must store privileged credentials in a form it can recover without a human. That is not a bug you patch. It is the shape of the feature. The moment you build a service that logs in as a privileged account with no person in the loop, you have built a box that keeps a high-value key under its own flowerpot, and anyone who reaches the porch can lift it. The defense is not to encrypt harder, it is to assume that account is as exposed as the service that holds it, and to tier your privileges so the synced account cannot reach the crown. The directory trusted its own plumbing more than it should have. Plumbing that can let itself in can be talked into letting you in.

## 0x09 · outro

```
the receptionist read you the whole staff list.
one name was its own key, and opened a drawer.
the drawer held a note someone meant to throw away.
the note got you a shell, and the shell asked the sync service a question.

the service kept the king's password so it would never have to ask.
so it answered for you, and the king never knew.

mind the service account. mind the flowerpot. wear black.

                                                            EOF
```

---

*HTB: Monteverde, retired 13 June 2020. A medium Windows box that is really a lecture on the cost of automated trust, dressed in a hybrid-cloud costume. The directory kept a key it could always reach, which means so could you.*