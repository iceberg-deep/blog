---
layout: post
title: "The Password That Refused to Die"
subtitle: "HTB Cascade, where four passwords fall like dominoes through LDAP, a registry blob, and a homebrew crypto binary, and the last one was dug out of the trash"
date: 2020-08-01 12:00:00 +0000
description: "A medium Windows box that is really a four-link credential chain, ending with an admin password recovered from a deleted account in the AD Recycle Bin."
image: /assets/og/the-password-that-refused-to-die.png
tags: [hackthebox, writeup]
---

Cascade is a domain that never threw anything away. Every step forward is a password somebody left lying somewhere they thought was safe, and the whole box is one long chain of those: a name in a directory listing leaks the first, a registry export coughs up the second, a hand-rolled crypto binary surrenders the third, and the fourth, the one that opens the kingdom, gets fished out of a user that was supposedly deleted months ago. Nobody on Cascade gets hacked in the action-movie sense. They just kept secrets in places that remember, and an old account that should have been ash still had a heartbeat. The name is the lesson. Each credential pours into the next like water down a flight of stairs, and the last drop lands in the Administrator's lap.

```
        C A S C A D E
        =============
        ldap  →  a base64 word taped under the desk     r.thompson
                   |
        smb   →  a VNC registry export, 8 bytes of "secret"   s.smith
                   |
        .exe  →  a homemade lock with the key printed on it   arksvc
                   |
        trash →  a deleted admin, still warm           administrator
                   |
                   v
        nothing was ever really erased.
                                            灰
```

## 0x01 · the directory that talks

`nmap` reads like a domain controller reciting its job description. DNS, Kerberos, the RPC mess, LDAP on 389 and again on the global-catalog ports, SMB, and WinRM up on 5985.

```
PORT     STATE SERVICE       VERSION
53/tcp   open  domain
88/tcp   open  kerberos-sec
135/tcp  open  msrpc
139/tcp  open  netbios-ssn
389/tcp  open  ldap          Active Directory LDAP (Domain: cascade.local)
445/tcp  open  microsoft-ds
636/tcp  open  ldapssl
5985/tcp open  http          Microsoft HTTPAPI (WinRM)
```

No web port at all, which on a Windows box is a quiet way of telling you the whole game lives in the directory and the file shares. So you talk to LDAP first. Active Directory will, by default, let an anonymous stranger read big swaths of the directory tree, and `ldapsearch` is how you ask.

Picture LDAP as the office phone book, except this phone book also lists everyone's job title, their group memberships, and occasionally a sticky note someone never should have stapled to their entry. You walk in, say you are nobody in particular, and start reading.

```
$ ldapsearch -x -H ldap://10.10.10.182 -b "DC=cascade,DC=local" "(objectClass=user)"
```

Buried in the dump for the user `r.thompson` is a field that does not belong in a directory at all, a custom attribute named `cascadeLegacyPwd`:

```
cascadeLegacyPwd: clk0bjVldmE=
```

That trailing equals sign is base64 wearing a name tag. Decode it and a password falls out.

```
$ echo 'clk0bjVldmE=' | base64 -d
rY4n5eva
```

Base64 is not encryption. It is encryption's harmless cousin, a way to write bytes using only keyboard-safe characters, like spelling a word in NATO phonetic so it survives a bad phone line. Anyone who hears "Alpha Bravo" can turn it back into "AB" instantly. Storing a password in base64 is storing it in plaintext with a thin coat of paint. The first domino: `r.thompson:rY4n5eva`.

## 0x02 · the share that kept the receipts

Those credentials do not get you a shell, but they get you onto SMB, and Cascade's file shares are where this domain keeps every receipt it ever printed.

```
$ smbmap -u r.thompson -p rY4n5eva -H 10.10.10.182
```

The `Data` share is the interesting one. Spelunking through it turns up a folder structure that reads like an IT department's dirty laundry, and two things matter. First, an HTML meeting-notes file that mentions a `TempAdmin` account created with the same password as the real administrator. Hold that thread. Second, sitting in `s.smith`'s temp directory, a file named `VNC Install.reg`, a Windows registry export from when somebody installed TightVNC.

A `.reg` file is just a text snapshot of registry keys, the kind you double-click to import settings. This one carries the TightVNC server config, and TightVNC, like a lot of remote-desktop tools, stores its connection password right there in the registry.

```
[HKEY_LOCAL_MACHINE\SOFTWARE\TightVNC\Server]
"Password"=hex:6b,cf,2a,4b,6e,5a,ca,0f
```

Eight bytes that the software calls a secret. They are not.

## 0x03 · the lock with the key printed on the box

TightVNC does not hash that password. It encrypts it with DES, using a key that is hard-coded into the software and identical on every TightVNC install on Earth. The key is not a secret. It shipped inside the binary, the same fixed value for everyone, which means decrypting this blob requires no cracking at all, just the publicly known key and a DES call.

Think of it like a diary with a lock, sold at the store with the warning that every diary in the product line opens with the exact same tiny key. The lock looks like security. It is theater. Anyone who owns one diary can open all of them. A tiny tool like `vncpwd` (or Metasploit's RFB module) holds that universal key and turns the eight bytes back into text.

```
$ vncpwd 6bcf2a4b6e5aca0f
Password: sT333ve2
```

`s.smith` is in the Remote Management Users group, which is the WinRM equivalent of being on the list at the door. So you walk in with Evil-WinRM.

```
$ evil-winrm -u s.smith -p sT333ve2 -i 10.10.10.182
*Evil-WinRM* PS C:\Users\s.smith\Documents> type ..\Desktop\user.txt
████████████████████████████████
```

Second domino down, and `user.txt` is yours. But s.smith is still a normal user, and the trail keeps going.

## 0x04 · the homemade vault

Back in the file shares, under an audit folder s.smith can now reach, sits `Audit.db`, a SQLite database, and next to it a small .NET program called `CascAudit.exe` that was clearly built to read it. Pull the database down and crack it open.

```
$ sqlite3 Audit.db
sqlite> .tables
DeletedUserAudit  Ldap  Misc
sqlite> select * from Ldap;
ArkSvc|BQO5l5Kj9MdErXx6Q6AGOw==|cascade.local
```

There is the `arksvc` account and a password that is plainly not base64-innocent this time. It is a real ciphertext. The question is what locked it, and the answer is sitting right there in the same folder, because the audit program that reads this database has to decrypt the same field to do its job. So the program contains the key. It always does.

Drop `CascAudit.exe` into a .NET decompiler like dnSpy and the logic reads like an open book. .NET compiles to an intermediate bytecode that decompilers can turn almost perfectly back into source, so reversing a C# binary is less like cryptanalysis and more like reading someone's diary in their own handwriting. The `Crypto.DecryptString` method spells out the whole scheme: AES, in CBC mode, with a key hard-coded into the binary.

```
key = "c4scadek3y654321"      // 16 bytes, sitting in plaintext in the .exe
algorithm = AES-CBC
ciphertext = base64-decode("BQO5l5Kj9MdErXx6Q6AGOw==")
```

This is the TightVNC mistake again in a more expensive suit. Whoever wrote this rolled their own little crypto routine and then baked the key directly into the program they shipped. Picture a bank vault with a state-of-the-art door, and the combination engraved on a brass plate bolted to the front of it. The lock is genuinely strong. It does not matter, because the key is standing right next to the lock. Reimplement that `DecryptString` in a few lines of Python, or just feed it back through the program's own logic, and the password resolves.

```
arksvc : w3lc0meFr31nd
```

Third domino. And `arksvc` is where the box gets clever.

## 0x05 · the account that came back

`arksvc` is not an admin. What it is, per `net user arksvc /domain` and the group list, is a member of a group called **AD Recycle Bin**. That sounds like housekeeping. It is the whole endgame.

When Active Directory deletes an object, it often does not vaporize it. It tombstones it, moving the object into a hidden Recycle Bin where, for a window of time, every attribute it carried is still recoverable. Membership in the AD Recycle Bin group is permission to read those ghosts. Remember that meeting note from the share, the one about a `TempAdmin` account created with the administrator's password? TempAdmin was deleted months ago. It is in the trash. And arksvc can read the trash.

Think of it like a company that "shredded" a document by tossing it in a locked recycling bin out back, and then handed you the only key to that bin. The paper was never destroyed. It was just moved somewhere you were not supposed to look, and now you are looking.

```
*Evil-WinRM* PS C:\> Get-ADObject -filter 'isDeleted -eq $true' `
    -includeDeletedObjects -properties *
```

The deleted `TempAdmin` object comes back whole, and it is still wearing the same custom attribute from section one, the one nobody learned their lesson about:

```
cascadeLegacyPwd : YmFDVDNyMWFOMDBkbGVz
```

Base64 again, the very first mistake repeating at the very last step.

```
$ echo 'YmFDVDNyMWFOMDBkbGVz' | base64 -d
baCT3r1aN00dles
```

The meeting note promised that TempAdmin shared the administrator's password. So you try it on the real account.

```
$ evil-winrm -u administrator -p baCT3r1aN00dles -i 10.10.10.182
*Evil-WinRM* PS C:\Users\Administrator\Desktop> type root.txt
████████████████████████████████
```

The fourth and final domino. The password that was supposed to die with TempAdmin in January was still alive in the trash, and it still opened the front door.

## 0x06 · the honest caveat

It is tempting to read Cascade as four separate bugs, but it is really one mistake committed four times by people who thought their hiding spot was good enough. A custom LDAP attribute, a registry export, a SQLite blob, a tombstoned object. Four different drawers, and every single one held a password that the owner believed was either hidden or gone. None of them were.

The two that should keep an admin up at night are the homemade crypto and the Recycle Bin. The base64 and the TightVNC blob are old, dumb, and well known. But CascAudit.exe is the trap a competent shop falls into, because it looks responsible. Someone reached for AES, real encryption, the good stuff, and then undid all of it by shipping the key inside the program that anyone could download and decompile. A secret embedded in a binary you hand to other people is not a secret. It is a delay. Reversing is patient, and the key is not going anywhere.

And the Recycle Bin is the deepest cut, because nothing there was unpatched or exploited. Active Directory did exactly what it was designed to do. It kept a recoverable copy of a deleted account, which is a feature, a lifesaver the day someone fat-fingers a deletion. The failure was upstream and human: a temporary account got the permanent administrator password, and "we'll delete it later" treated deletion like destruction. In AD, deletion is more like moving a box to the basement. If the secret in that box still works, you did not remove the risk. You filed it. Rotate the credential before you delete the account, never after, because the trash remembers longer than you do.

## 0x07 · outro

```
the directory whispered the first word.
the registry handed over the second with a key everyone owns.
the third was locked in a vault whose combination was bolted to the door.
the fourth was buried, and the grave was unlocked.

four passwords, one habit: a secret hidden is not a secret gone.
delete the account if you like. rotate the password first,
        because the basement keeps everything you pretend to throw away.

read the directory. reverse the binary. check the trash. wear black.

                                                            EOF
```

---

*HTB: Cascade, retired 25 Jul 2020. A medium Windows box that is really a four-link credential cascade, ending in an administrator password dug out of a deleted account. Nothing here was ever truly erased.*