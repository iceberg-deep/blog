---
layout: writeup
title: "Tell It What You Are"
date: 2020-03-22
description: "JSON is a Windows box built on a .NET app that rebuilds whatever object your login token claims to be. Claim to be a process that runs a command for RCE, then ride SeImpersonatePrivilege through JuicyPotato to SYSTEM."
image: /assets/og/json.png
tags: [hackthebox, deserialization, dotnet, juicypotato, windows, writeup]
---

# Tell It What You Are

**HTB JSON — a .NET app that builds whatever object your login token says it is, so tell it you are a process that runs commands, then ride one privilege to SYSTEM**

JSON taught me how a single trusting line of .NET configuration turns a login token into a remote shell. The whole front half is one idea. The application reads a token, and instead of treating it as data, it rebuilds it into a live .NET object, trusting the token to declare what kind of object it is. Tell it you are the kind of object that launches programs, and it launches one for you. The back half is a Windows classic, a service account holding one privilege too many.

```
        J S O N
        =======
        admin:admin     ->  guess the login, find the token
                   |
        deserialize     ->  the app rebuilds whatever your token claims to be
                   |
        object = run cmd ->  claim to be a process, get code execution
                   |
        web shell       ->  foothold as the app-pool account
                   |
        SeImpersonate   ->  the account allowed to wear other tokens
                   |
        juicypotato     ->  trick a system service into handing over its token
                   |
                   v
        you never beat the auth.
        you told the app what to build, and it built it.
                                                            構
```

## 0x01 · the lobby

The scan is a small, old Windows estate. FileZilla FTP on 21, IIS on 80, SMB on 445, and WinRM on 5985. The banners place it on Windows Server 2012, which matters a great deal later.

```
PORT     STATE SERVICE       VERSION
21/tcp   open  ftp           FileZilla ftpd
80/tcp   open  http          Microsoft IIS 8.5
445/tcp  open  microsoft-ds  Windows Server 2012
5985/tcp open  http          WinRM 2.0
```

The website redirects to a login for some kind of dashboard. A short tour of default credentials lands on `admin:admin`, and the app lets me in.

## 0x02 · the claim ticket

The dashboard itself is mostly empty styling, but the login is the interesting part. Watching the requests, the app authenticates with a token. After login it carries an `OAuth2` cookie, and its `/api/account` endpoint expects a `Bearer` token. The app reads that token on every request to decide who you are.

The question that breaks the box is *how* it reads the token. If the server takes the token and rebuilds it into a .NET object while trusting the token to declare its own type, that is insecure deserialization, and it is one of the most powerful bugs in the .NET world.

## 0x03 · tell it what you are

Here is the idea in one sentence. Safe deserialization reads your data into a known, fixed shape. Insecure deserialization lets *your data* name the shape and then builds it. It is a coat check that, instead of fetching the coat on your ticket, reads your ticket aloud and sews whatever garment the ticket describes. So you describe something dangerous.

.NET ships a well-known building block for exactly this, the `ObjectDataProvider`, an ordinary framework class whose job is to create an object and call a method on it. Point it at the class that starts operating-system processes and hand it the method that launches one, and a feature meant for wiring up UI data turns into a feature that runs `cmd`. I keep the gadget as a description rather than a paste-ready payload, but its shape is:

```
Bearer token (base64) that describes:
  an ObjectDataProvider
    -> create a Process
    -> call Start
    -> with arguments:  cmd /c <my command>
```

Send that as the `Bearer` header to `/api/account`, the app deserializes it, and the command runs as the IIS application-pool account. From there it is the usual two-step. Have the box pull a copy of `nc.exe` from my host into a writable folder, then run it.

```
first token   ->  download nc.exe into a writable spool folder
second token  ->  [ run nc.exe as a reverse shell back to 10.10.14.4:9001 ]
```

A listener catches the foothold, and the user flag is right there.

```
C:\Users\userpool\Desktop> type user.txt
████████████████████████████████
```

## 0x04 · the valet's privilege

The first thing to check on any Windows service shell is the privilege list:

```
C:\> whoami /priv
SeImpersonatePrivilege   Enabled
```

`SeImpersonatePrivilege` is the valet key. It lets an account act in the security context of a token that has been handed to it, which is a normal, necessary thing for service accounts that accept client connections. The abuse is to *make* a high-privileged service hand you its token. On Windows Server 2012, the tool for that is JuicyPotato. It stands up a fake COM server, coaxes a SYSTEM service into authenticating to it, and catches the SYSTEM token mid-handshake.

Picture a valet who is allowed to wear any coat a guest checks with him. JuicyPotato tricks the most important guest in the building, the SYSTEM account, into checking its coat with this valet, and the valet puts it on. With SeImpersonate plus an unpatched 2012, that token becomes a SYSTEM shell:

```
juicypotato  ->  impersonate the SYSTEM token
             ->  [ launch a reverse shell as SYSTEM back to 10.10.14.4 ]
C:\Windows\system32> type C:\Users\Administrator\Desktop\root.txt
████████████████████████████████
```

## 0x05 · the honest caveat

Both halves of JSON are settings, not zero-days. The deserialization bug is one configuration choice, telling the JSON library to honor type information embedded in the data. That single switch turns every token the app reads into an object-construction kit for an attacker. The privilege escalation is an old, well-known pairing, a service account holding `SeImpersonatePrivilege` on a Windows version still vulnerable to the potato family.

The lessons are two of the most repeated in offensive security. Never deserialize untrusted input into typed objects, because "let the data pick the class" is the same sentence as "let the attacker pick the code." And treat `SeImpersonatePrivilege` on a service account as a near-guarantee of SYSTEM on anything that has not been patched and hardened, because for years it has been exactly that. Patch the host, scope the privilege, and parse tokens as data, never as blueprints.

## 0x06 · outro

```
a login you guessed on the second try.
a token the app rebuilt instead of reading.
an object that turned out to be a command.
a valet allowed to wear the coat of anyone who handed it over.

nothing here was a zero-day. it was two settings left too generous.
you never beat the authentication. you told the app what to build, and it obliged.

guess the door. describe the object. wear the system's coat. wear black.

                                                            EOF
```

---

*HTB: JSON — a Medium Windows box retired in March 2020. A .NET insecure-deserialization foothold through a trusting Bearer token, then SeImpersonatePrivilege and JuicyPotato to SYSTEM. Two configuration choices, end to end, and not a single memory-corruption bug in sight.*
