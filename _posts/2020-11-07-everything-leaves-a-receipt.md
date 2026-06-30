---
layout: post
title: "Everything Leaves a Receipt"
subtitle: "HTB Fuse, where a print-job log hands you the company's usernames and a password, an expired login is traded for a fresh one, and the right to load a driver becomes the right to be the kernel"
date: 2020-11-07 12:00:00 +0000
description: "Fuse keeps a log of every print job, and that log quietly names every employee and leaks a password. From there it is an expired credential traded for a working one, a service password hidden in a printer's description, and SeLoadDriverPrivilege, the small-sounding right that is really permission to run code as the kernel."
image: /assets/og/everything-leaves-a-receipt.png
tags: [hackthebox, windows, active-directory, writeup]
---

Fuse is a domain controller that keeps the receipts. Somewhere on this network there is a printer, and a web page that logs every job it ever ran, and that log is a confession. It names every employee who ever hit print, and tucked into the job titles is a password somebody used as a temporary default. From there the box is a relay of small trusts. An expired password you are allowed to reset yourself. A service account whose password is sitting in a printer's description field. And at the end, a privilege with a boring name that turns out to mean you get to run code as the operating system itself.

```
        F U S E   ( fabricorp )
        =======================
        print log  →  names everyone + leaks "Fabricorp01"
              |
        spray it  →  correct, but EXPIRED. so reset it yourself.
              |
        rpc / printer descriptions  →  a service account's password
              |
        winrm shell as svc-print
              |
        SeLoadDriverPrivilege  →  load a driver = be the kernel  →  SYSTEM
                                            刷
```

## 0x01 · a company that logs out loud

The scan reads like a domain controller, because it is one. DNS, Kerberos, SMB, LDAP, RPC, WinRM, and a web server.

```
PORT     STATE SERVICE
53/tcp   open  domain
88/tcp   open  kerberos-sec
80/tcp   open  http          Microsoft IIS
135/tcp  open  msrpc
389/tcp  open  ldap          Domain: fabricorp.local
445/tcp  open  microsoft-ds
5985/tcp open  winrm
```

The website on 80 redirects to `fuse.fabricorp.local`, so you add that to your hosts file and visit. It is a print-management portal for Fabricorp, and it is doing the one thing a print server should never do where strangers can read it. It is showing you the log of every print job.

## 0x02 · the shredder bin nobody emptied

Think of a print log as the recycling bin next to the office printer, the one nobody ever empties. Every sheet in it has somebody's name in the header, and every so often one of them is a sticky note with a password on it. Fuse's portal is exactly that bin, except it is a web page and it is sorted by date.

Read the job entries and two things fall out. The first is a roster. Names like `pmerton`, `tlavel`, `sthompson`, `bhult`, `administrator` appear over and over as the owners of jobs. That is your user list, handed over for free. The second is a recurring string in the job titles that is obviously a password, something on the order of `Fabricorp01`, the kind of default an IT person sets and means to make everyone change.

Scrape the page, pull the unique usernames into one file and the candidate passwords into another.

```
$ curl -s http://fuse.fabricorp.local/papercut/logs/html/index.htm | grep -oE '...' > users.txt
$ wc -l users.txt
5 users.txt
```

## 0x03 · the coupon that expired yesterday

Spray the password you found against the users you found.

```
$ crackmapexec smb 10.10.10.193 -u users.txt -p 'Fabricorp01'
SMB  10.10.10.193  [-] fabricorp.local\tlavel:Fabricorp01 STATUS_PASSWORD_MUST_CHANGE
```

That status is not a failure. It is the most useful message on the whole box. `STATUS_PASSWORD_MUST_CHANGE` means the password is correct, but the account is flagged to change it at next logon, so Windows will not let you actually use it yet. Picture a coupon that expired yesterday. The cashier confirms it was real and worth exactly what it says, then tells you they cannot accept it, but they will happily swap it for a fresh one if you fill out the little card. Windows offers the same trade. You can set a new password remotely.

```
$ smbpasswd -r 10.10.10.193 -U tlavel
Old SMB password: Fabricorp01
New SMB password: IcebergPass123!
Password changed for user tlavel
```

Now `tlavel:IcebergPass123!` is a live, working domain credential. An expired secret was never disabled. It was just waiting for someone to renew it, and the renewal desk was open to anyone.

## 0x04 · the password written on the equipment

`tlavel` is a normal user, not an administrator, so you keep reading receipts. With valid creds you can ask the domain's own services to describe themselves, and Windows loves to overshare in description fields. Enumerate the printers and the RPC objects, and one of them carries a service account's password right in its comment, the digital equivalent of a sticky label on the side of the machine that says do-not-remove and also here-is-the-password.

```
$ rpcclient -U 'tlavel%IcebergPass123!' 10.10.10.193
rpcclient $> enumprinters
   description: [\\FUSE\HP-MFT01,HP Universal Printing,Please enter your password. <redacted printer-comment password>]
```

That comment hands you `svc-print`'s password. `svc-print` is allowed to log in over WinRM, so you get a real interactive shell.

```
$ evil-winrm -i 10.10.10.193 -u svc-print -p '<password from the printer comment>'
*Evil-WinRM* PS> whoami
fabricorp\svc-print
*Evil-WinRM* PS> type ..\Desktop\user.txt
████████████████████████████████
```

## 0x05 · the right to be the kernel

Run `whoami /priv` on the new shell and one line matters more than the rest.

```
*Evil-WinRM* PS> whoami /priv
SeLoadDriverPrivilege          Load and unload device drivers   Enabled
```

`SeLoadDriverPrivilege` sounds minor, a sysadmin housekeeping permission. It is not minor. A device driver is not a normal program. It runs in the kernel, the deepest and most trusted layer of Windows, with total control over the machine. So the right to load a driver is the right to run code as the kernel itself, which is the same thing as being SYSTEM.

Think of the kernel as the main electrical room of a building, the place where someone can cut power to any floor or override any lock. `SeLoadDriverPrivilege` is a work permit that lets you install any appliance in that room. You do not need to find a flaw in the building. You just bring your own rigged appliance, plug it in, and flip its switch.

The rigged appliance here is a real, validly signed driver called Capcom.sys, famous for a flaw that lets an unprivileged caller run code in kernel space through one of its commands. You write the registry entries that point at it and call the load routine, all of which `SeLoadDriverPrivilege` permits, then trigger its vulnerable command with a small payload.

```
*Evil-WinRM* PS> [ EoPLoadDriver: register a service key pointing at Capcom.sys, then NtLoadDriver ]
*Evil-WinRM* PS> [ trigger Capcom.sys's vulnerable ioctl with a token-stealing payload ]
PS C:\> whoami
nt authority\system
PS C:\> type C:\Users\Administrator\Desktop\root.txt
████████████████████████████████
```

A signed driver is software Windows trusts without a second look, because it carries a real signature. The flaw is that a signature proves who wrote a thing, not that the thing is safe. You did not forge anything. You used a genuine, trusted part in the way its bug allows, because the system checked the badge and never checked the behavior.

## 0x06 · the honest caveat

Fuse is a stack of secrets that were stored where they did not belong. A password does not belong in a print job title. A service account's password does not belong in a printer's public description. None of that is a clever vulnerability. It is information left lying around by people doing their jobs, and an attacker who simply reads everything will always find it. The defense is unglamorous and total. Do not log secrets, and treat every description, comment, and metadata field as if a stranger will read it, because on a domain a stranger usually can.

The end of the box carries the bigger lesson. Windows privileges are not a smooth dial from harmless to dangerous. A handful of them, `SeLoadDriverPrivilege`, `SeImpersonatePrivilege`, `SeDebugPrivilege`, `SeBackupPrivilege`, are quietly equivalent to full control, because each one is a doorway into something the operating system trusts completely. Handing an account one of those to do a small job is the same as making it an administrator with extra steps. Audit who holds them like you would audit who holds the keys, because that is what they are.

## 0x07 · outro

```
the printer kept a log, and the log named everyone.
one password had expired, so they let you mint a new one.
the next password was taped to the equipment.
the last privilege sounded small and meant you owned the kernel.

a print job is not a place to keep a secret. neither is a comment field.

read every receipt. never log a password. audit the quiet privileges. wear black.

                                                            EOF
```

---

*HTB: Fuse, a medium Windows Active Directory box. A relay of secrets stored where strangers can read them, ending on the privilege everyone underestimates, the right to load a driver and therefore to be the kernel. Retirement date is a rough marker until verified.*
