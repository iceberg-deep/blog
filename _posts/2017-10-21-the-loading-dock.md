---
layout: post
title: "The Loading Dock"
subtitle: "HTB Devel, where anonymous FTP drops files straight into the web root, so you mail yourself a shell and the storefront runs it"
date: 2017-10-21 12:00:00 +0000
description: "Devel is one folder doing two jobs it should never share. The FTP drop box and the live web root are the same directory, so you upload a shell as a guest and the web server runs it. Then an old, unpatched kernel hands you SYSTEM."
image: /assets/og/the-loading-dock.png
tags: [hackthebox, windows, privesc, writeup]
---

Devel is a box about one folder doing two jobs that should never have been the same job. There is an FTP server that lets anyone log in as a guest and drop files, and there is a web server that runs code out of a folder. The twist, the whole box really, is that those two folders are the same folder. So you walk in the unlocked back door, leave a package on the shelf, and the storefront out front hands it to a customer and runs it. After that it is just an old building that never installed the security patch every newer building got, and the master key still works.

```
        D E V E L
        =========
        ftp (anonymous)  --drop-->  C:\inetpub\wwwroot
                                          |
        web (iis)        --runs----  the exact same folder
                                          |
                                          v
        upload a shell as a guest, browse to it, it runs.
        then an old kernel hands over the keys.
                                            庫
```

## 0x01 · two services, one closet

`nmap` is brief. An FTP server on 21 and an IIS web server on 80, both Microsoft, nothing else.

```
PORT   STATE SERVICE VERSION
21/tcp open  ftp     Microsoft ftpd
80/tcp open  http    Microsoft IIS httpd 7.5
```

Two facts jump out when you read those side by side. The FTP banner allows the `anonymous` account, meaning anyone can log in with no real credentials. And the web server is IIS, which runs `.aspx` pages the way Apache runs PHP. Hold those two thoughts next to each other, because the box is the sentence they make when you put them together.

## 0x02 · the loading dock that opens onto the showroom

Log into FTP as anonymous and look around. The files you see are the same files the website serves. The FTP root is `C:\inetpub\wwwroot`, the live web directory. That is the entire vulnerability, and it is worth saying slowly, because it is a configuration mistake people still make in production today.

Picture a shop where the loading dock at the back and the display shelf out front are physically the same shelf. Deliveries get dropped on the dock by anyone who wanders up, and customers at the counter immediately see and use whatever is sitting there. Nobody noticed the dock had no lock, because in their heads the dock and the showroom were different rooms. On Devel they are one room. You can write to it as a guest over FTP, and you can trigger it as code over the web.

So you write a small `.aspx` webshell to the share and then visit it in a browser to run it. IIS will happily execute an aspx file that appeared in its own web root, no questions asked about how it got there.

```
$ ftp 10.10.10.5
Name: anonymous
Password: (anything)
ftp> put iceberg.aspx
ftp> bye

# now just browse to it, and it runs on the server
http://10.10.10.5/iceberg.aspx?cmd=whoami
iis apppool\web
```

I am not pasting the literal aspx webshell, and that is on purpose. It is a few lines of markup that hand a request parameter to the shell, and the moment that exact text touches a disk any antivirus quarantines the file as a backdoor. Picture it rather than paste it. Trade the webshell up for a proper reverse shell, point it at a listener, and you have a foothold as `iis apppool\web`, the limited identity the web server runs as.

## 0x03 · a shell with no power

That foothold cannot do much. `whoami /priv` is nearly empty and the interesting folders are off limits. So you read the one thing that always tells you where you are, the operating system's own version sheet.

```
C:\> systeminfo
OS Name:        Microsoft Windows 7 Enterprise
OS Version:     6.1.7600 N/A Build 7600
System Type:    X86-based PC
Hotfix(s):      N/A
```

Read that like an obituary. Windows 7, build 7600, which is the original 2009 release with no service pack. Thirty-two bit. And the hotfix line says `N/A`, meaning not a single patch has ever been installed. This is not a server someone hardened and you have to outsmart. It is a machine frozen in 2009, and the entire decade of security fixes that came after simply never arrived.

## 0x04 · the building that never got the upgrade

When a kernel is this old and this unpatched, privilege escalation stops being a puzzle and becomes a lookup. You match the build number against the list of public kernel exploits and pick one. Devel famously falls to the afd.sys local privilege bug (MS11-046), among several others that all work because the patches that killed them were never applied.

Think of the kernel as the building's central security office. Every newer building got a notice years ago that one of the master keys had a flaw, and they re-cut their locks. This building threw the notice away. So a key that stopped working everywhere else still opens the manager's office here. You compile the matching exploit for the right architecture, run it from your low-privilege shell, and it walks you straight up to the top.

```
C:\> [ precompiled MS11-046 kernel exploit, run from the iis apppool shell ]
C:\> whoami
nt authority\system
C:\> type C:\Users\Administrator\Desktop\root.txt
████████████████████████████████
C:\> type C:\Users\babis\Desktop\user.txt
████████████████████████████████
```

`nt authority\system` is the very top of a Windows box. Not a user, not an admin, the operating system itself. From a guest FTP login to that, in two moves.

## 0x05 · the honest caveat

Devel is two old mistakes shaking hands. Neither is clever and both are still everywhere. The first is letting an upload directory and an execution directory be the same directory. The lesson generalizes way past this box. Anywhere users can write files and the server will run files, you must make sure those are never the same place, or an attacker uploads logic instead of data and you hand them a shell. Upload folders should be dumb storage that the server refuses to execute, full stop.

The second is patch hygiene, which is boring and which is also why it never gets done. The kernel exploit here is not some artisanal zero-day. It is a years-old, well-documented bug with a years-old, well-documented fix that simply was not installed. Most real-world compromises look exactly like this. Not a genius breaking new ground, just a known hole on a machine nobody updated. The unglamorous defense, drop files where they cannot run and actually install your updates, would have closed this entire box before it opened.

## 0x06 · outro

```
the back door had no lock, and it opened onto the showroom.
you left a package on the shelf and the store sold it to a customer.
the building never installed the patch, so the old key still worked.

an upload folder that runs code is not a folder, it is a shell waiting to happen.

separate write from run. install your updates. wear black.

                                                            EOF
```

---

*HTB: Devel, an easy Windows box from the platform's first year. The cleanest possible lesson in why an upload directory must never be an execution directory, with a free reminder to patch.*
